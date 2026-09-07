/**
 * What a person typed about a device, folded into the snapshot.
 *
 * The Switches tab lets someone correct a switch's make and model by hand, and
 * the server keeps that under outputs/<rackId>/device_overrides.json keyed by
 * the "U04"-style position. Until now only the Switch Information page read
 * it back: the Report and the Network page kept saying "Unidentified Switch"
 * for a device whose owner had already named it. A person's own word about a
 * box in front of them outranks a camera's guess, so it is applied here, the
 * same way a declared unmanaged switch is.
 */
const fs = require('fs');
const path = require('path');
const { Evidence, observed, Manufacturer, DeviceType } = require('./model');

const DEFAULT_OUTPUTS = path.join(__dirname, '..', '..', '..', 'outputs');
const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The overrides for a rack: { 'U04': { make, model, firmware } }, or {}. */
function read(rackId, outputsDir = DEFAULT_OUTPUTS) {
  if (!/^RK-[A-Za-z0-9]{4,32}$/.test(String(rackId || ''))) return {};
  const file = path.join(outputsDir, rackId, 'device_overrides.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** "U04" → 4; "u4" → 4; 4 → 4; anything else → null. */
function unitOf(key) {
  const m = /^\s*U?0*(\d{1,3})\s*$/i.exec(String(key));
  return m ? Number(m[1]) : null;
}

/**
 * Put the entered make/model onto the device at that U. Mutates and returns
 * the snapshot. A make alone re-points the existing type at that maker; a
 * model creates (or reuses) a type for it.
 */
function applyTo(snapshot, rackId, { outputsDir } = {}) {
  if (!snapshot || !Array.isArray(snapshot.devices)) return snapshot;
  const overrides = read(rackId, outputsDir);
  const keys = Object.keys(overrides);
  if (!keys.length) return snapshot;

  const byPos = new Map(snapshot.devices.filter((d) => d.position != null).map((d) => [Number(d.position), d]));
  snapshot.manufacturers = snapshot.manufacturers || [];
  snapshot.deviceTypes = snapshot.deviceTypes || [];
  const mfrUids = new Set(snapshot.manufacturers.map((m) => m.uid));
  const typeUids = new Set(snapshot.deviceTypes.map((t) => t.uid));

  for (const key of keys) {
    const o = overrides[key] || {};
    const make = String(o.make || '').trim();
    const model = String(o.model || '').trim();
    if (!make && !model) continue;
    const u = unitOf(key);
    const dev = u != null ? byPos.get(u) : null;
    if (!dev) continue;

    let mfrUid = null;
    if (make) {
      mfrUid = `mfr:${slug(make)}`;
      if (!mfrUids.has(mfrUid)) {
        snapshot.manufacturers.push(Manufacturer(observed(mfrUid, Evidence.MANUAL), { name: make, slug: slug(make) }));
        mfrUids.add(mfrUid);
      }
    }
    if (model) {
      const typeUid = `dtype:${slug(model)}`;
      if (!typeUids.has(typeUid)) {
        const existing = snapshot.deviceTypes.find((t) => t.uid === dev.deviceTypeUid);
        snapshot.deviceTypes.push(DeviceType(observed(typeUid, Evidence.MANUAL), {
          manufacturerUid: mfrUid || existing?.manufacturerUid || '',
          model, slug: slug(model), uHeight: existing?.uHeight || 1,
        }));
        typeUids.add(typeUid);
      } else if (mfrUid) {
        const t = snapshot.deviceTypes.find((x) => x.uid === typeUid);
        if (t && !t.manufacturerUid) t.manufacturerUid = mfrUid;
      }
      dev.deviceTypeUid = typeUid;
    } else if (mfrUid) {
      const t = snapshot.deviceTypes.find((x) => x.uid === dev.deviceTypeUid);
      if (t) t.manufacturerUid = mfrUid;
    }
    dev.provenance = { ...(dev.provenance || {}), entered: { make: make || null, model: model || null } };
  }
  return snapshot;
}

module.exports = { read, applyTo, unitOf };
