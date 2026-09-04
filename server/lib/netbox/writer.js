/**
 * The NetBox writer.
 *
 * Four rules decide whether this is deployable. They are implemented here, not
 * described elsewhere and hoped for:
 *
 *   1. IDEMPOTENT.  NetBox has no upsert. Every object carries our uid in the
 *      racktrack_uid custom field; we GET by it, then POST or PATCH. Push the
 *      same scan twice and NetBox holds one clean set of records.
 *   2. DRY-RUN FIRST.  plan() performs no writes and returns the exact diff
 *      push() would apply.
 *   3. NEVER DELETE.  There is no delete path in this module or in the client
 *      it uses. A device that has vanished from a scan is REPORTED for a human
 *      to judge; it is never removed, and not even set offline unless asked.
 *      A tool that removes production records loses all trust the first time
 *      it is wrong, and it will eventually be wrong.
 *   4. CONFIDENCE -> STATUS.  Proven becomes `connected`, camera-only becomes
 *      `planned`, and a CONFLICT is not exported at all — a disagreement is a
 *      finding for review, not a fact to write down.
 */
const { exportable, EXPORT_ORDER } = require('./model');
const { orderedSpecs, objectTypes, withUid } = require('./mapping');
const { UID_FIELD, NetBoxError } = require('./netbox');

/**
 * A reference to an object that will not exist until this push runs.
 * Kept distinct from a real id so the dry-run diff can say "this depends on a
 * create earlier in the plan" instead of inventing a change.
 */
class Pending {
  constructor(label, uid) { this.label = label; this.uid = uid; }
  toString() { return `new:${this.label}:${this.uid}`; }
}
const isPending = (v) => v instanceof Pending;

/**
 * NetBox's value for `key`, flattened to something comparable.
 * It nests foreign keys as {id, ...} and choice fields as {value, label}.
 */
function current(existing, key) {
  const v = existing[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('id' in v) return v.id;
    if ('value' in v) return v.value;
  }
  if (key.endsWith('_terminations') && Array.isArray(v)) {
    return v.map((t) => ({ object_type: t.object_type, object_id: t.object_id }));
  }
  // A front port's rear_ports come back with the rear port nested as {id, ...}.
  if (key === 'rear_ports' && Array.isArray(v)) {
    return v.map((m) => ({
      position: m.position,
      rear_port: m.rear_port && typeof m.rear_port === 'object' ? m.rear_port.id : m.rear_port,
      rear_port_position: m.rear_port_position,
    }));
  }
  return v;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What would change, and what cannot be judged yet.
 * A field whose new value is Pending is not a difference — it is a reference
 * to something this same plan will create. Reporting it would be noise at
 * best and a false positive at worst.
 */
function diff(payload, existing) {
  const changed = {};
  const pending = [];
  for (const [k, next] of Object.entries(payload)) {
    if (k === 'custom_fields' || next === undefined) continue;
    if (isPending(next)) { pending.push(k); continue; }
    // rear_ports nests its reference one level down.
    if (k === 'rear_ports' && Array.isArray(next) && next.some((m) => isPending(m.rear_port))) {
      pending.push(k); continue;
    }
    const old = current(existing, k);
    if ((old === null || old === undefined) && (next === '' || next === null)) continue;
    if (!sameValue(old, next)) changed[k] = { from: old ?? null, to: next };
  }
  return { changed, pending };
}

async function walk(snapshot, client, apply, report) {
  const resolved = new Map();   // our uid -> NetBox id (or Pending)
  const skipped = new Set();    // uids excluded, so dependents can say why
  const failed = new Set();
  const counts = {};
  let rackNetboxId = null;

  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

  for (const spec of orderedSpecs()) {
    for (const obj of snapshot[spec.field] || []) {
      const misses = [];
      const ref = (uid) => {
        if (!uid) return null;
        if (resolved.has(uid)) return resolved.get(uid);
        misses.push(uid);
        return null;
      };

      const name = obj.name || obj.model || obj.label || obj.uid;

      // Rule 4 — a conflict is a finding, not a fact.
      if (!exportable(obj.evidence)) {
        skipped.add(obj.uid);
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'skip',
          reason: `evidence=${obj.evidence}, so it goes to review and never to NetBox`,
        });
        bump('skip');
        continue;
      }

      const payload = withUid(spec.payload(obj, ref), obj.uid, obj.customFields || {});

      if (misses.length) {
        const blockedBy = misses.filter((u) => skipped.has(u) || failed.has(u));
        skipped.add(obj.uid);
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'skip',
          reason: blockedBy.length
            ? `depends on excluded/failed object(s): ${blockedBy.join(', ')}`
            : `unresolved reference(s): ${misses.join(', ')}`,
        });
        bump('skip');
        continue;
      }

      let existing;
      try {
        existing = await client.findByUid(spec.endpoint, obj.uid);
      } catch (err) {
        failed.add(obj.uid);
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'fail',
          reason: `lookup failed: ${JSON.stringify(err.detail ?? err.message)}`,
        });
        bump('fail');
        continue;
      }

      if (existing) {
        const { changed, pending } = diff(payload, existing);
        resolved.set(obj.uid, existing.id);
        if (spec.field === 'racks') rackNetboxId = existing.id;

        if (!Object.keys(changed).length) {
          report.changes.push({
            type: spec.label, uid: obj.uid, name: String(name), action: 'noop',
            netboxId: existing.id, pendingRefs: pending,
          });
          bump('noop');
          continue;
        }
        if (apply) {
          try {
            await client.patch(spec.endpoint, existing.id, payload);
          } catch (err) {
            failed.add(obj.uid);
            report.changes.push({
              type: spec.label, uid: obj.uid, name: String(name), action: 'fail',
              netboxId: existing.id, reason: JSON.stringify(err.detail ?? err.message),
            });
            bump('fail');
            continue;
          }
        }
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'update',
          netboxId: existing.id, diff: changed, pendingRefs: pending,
        });
        bump('update');
        continue;
      }

      // Nothing in NetBox carries this uid — it is a create.
      if (apply) {
        let created;
        try {
          created = await client.post(spec.endpoint, payload);
        } catch (err) {
          failed.add(obj.uid);
          report.changes.push({
            type: spec.label, uid: obj.uid, name: String(name), action: 'fail',
            reason: JSON.stringify(err.detail ?? err.message),
          });
          bump('fail');
          continue;
        }
        resolved.set(obj.uid, created.id);
        if (spec.field === 'racks') rackNetboxId = created.id;
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'create',
          netboxId: created.id,
        });
      } else {
        resolved.set(obj.uid, new Pending(spec.label, obj.uid));
        report.changes.push({
          type: spec.label, uid: obj.uid, name: String(name), action: 'create',
        });
      }
      bump('create');
    }
  }

  report.counts = counts;
  report.orphans = await orphans(snapshot, client, rackNetboxId, report);
  return report;
}

/**
 * Devices NetBox holds for this rack that this scan did not see.
 *
 * Rule 3. These are REPORTED, never deleted. Scoped two ways on purpose: only
 * inside this snapshot's rack, and only objects carrying our own uid — so a
 * device someone else created, or one in another rack, is invisible to this
 * check and can never be touched by it.
 */
async function orphans(snapshot, client, rackNetboxId, report) {
  if (rackNetboxId === null || isPending(rackNetboxId)) return [];
  let present;
  try {
    present = await client.paginate('/api/dcim/devices/', { rack_id: rackNetboxId });
  } catch (err) {
    report.warnings.push(`could not check for orphaned devices: ${err.message}`);
    return [];
  }
  const seen = new Set((snapshot.devices || []).map((d) => d.uid));
  return present.flatMap((d) => {
    const uid = (d.custom_fields || {})[UID_FIELD];
    if (!uid || seen.has(uid)) return [];
    return [{
      netboxId: d.id, name: d.name, uid, status: (d.status || {}).value,
      recommendation: 'Review. It was in a previous scan and is absent from this one. '
                    + 'Not deleted. Set status=offline only after a human checks.',
    }];
  });
}

const newReport = (snapshot, dryRun, client) => ({
  rackUid: snapshot.rackUid, dryRun, netboxUrl: client.url,
  customField: '', changes: [], orphans: [], counts: {}, warnings: [],
});

/**
 * Dry run. Performs no writes and returns exactly what push() would do.
 *
 * ensureField is off by default so a plan really is read-only. The cost is
 * that if the racktrack_uid custom field does not exist yet, nothing can be
 * matched and every object reads as a create — so we say so out loud rather
 * than let the number mislead.
 */
async function plan(snapshot, client, { ensureField = false } = {}) {
  const report = newReport(snapshot, true, client);
  const cf = await client.customField();
  if (!cf) {
    if (ensureField) {
      await client.ensureCustomField(objectTypes());
      report.customField = 'created (schema change made so this diff is accurate)';
    } else {
      report.customField = 'ABSENT';
      report.warnings.push(
        `'${UID_FIELD}' custom field does not exist yet, so nothing can be matched `
        + 'and every object below reads as a create. Export creates it automatically; '
        + 'pass ensureField for an accurate pre-flight diff.');
    }
  } else {
    report.customField = 'present';
  }
  return walk(snapshot, client, false, report);
}

/** Write to NetBox. Idempotent: safe to run on the same scan repeatedly. */
async function push(snapshot, client) {
  const report = newReport(snapshot, false, client);
  const cf = await client.ensureCustomField(objectTypes());
  report.customField = cf.action;
  return walk(snapshot, client, true, report);
}

module.exports = { plan, push, Pending, isPending, diff, current, EXPORT_ORDER, NetBoxError };
