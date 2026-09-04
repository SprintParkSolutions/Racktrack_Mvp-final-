/**
 * Unmanaged switches: the ones no protocol can read.
 *
 * A managed switch states its own model, ports and neighbours over SNMP. An
 * unmanaged switch has no brain to ask, over any protocol, ever. So the only
 * source for it is a person: they either type it in, or pick the box the camera
 * already found and name it. This is that store.
 *
 * Kept separate from lib/switches.js on purpose. That store is built around
 * credentials and polling, neither of which an unmanaged switch has. Mixing the
 * two would put a "no password stored" warning on a device that can never have
 * one. Here a record is just a plain declaration.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RT_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'unmanaged.json');

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const asInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);

function read() {
  if (!fs.existsSync(FILE)) return { nextId: 1, items: [] };
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, items: [] }; }
}
function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

/**
 * A submitted declaration, cleaned. A name or a model is required so the record
 * is never a blank row; everything else is optional because the person may only
 * know some of it.
 */
function clean(body, existing = null) {
  const brand = str(body.brand ?? existing?.brand);
  const model = str(body.model ?? existing?.model);
  const label = str(body.label ?? existing?.label) || model || 'Unmanaged switch';
  if (!label) return { error: 'Give it a name or a model.' };

  const ports = body.ports === undefined && existing ? existing.ports : asInt(body.ports);
  if (ports !== null && ports !== undefined && (ports < 0 || ports > 1024)) {
    return { error: 'Port count has to be between 0 and 1024.' };
  }
  const uPosition = body.uPosition === undefined && existing ? existing.uPosition : asInt(body.uPosition);

  return { record: {
    label, brand, model,
    ports: ports ?? null,
    uPosition: uPosition ?? null,
    // Set only when the box was picked from a scan, so the overlay can attach to
    // exactly that device rather than guessing by rack position.
    deviceUid: str(body.deviceUid ?? existing?.deviceUid, 200) || null,
  } };
}

const view = (r) => ({ ...r });

function list(rackId) {
  const items = read().items;
  const scoped = rackId ? items.filter((i) => (i.rackId || '') === rackId) : items;
  return scoped.map(view);
}

function add(body) {
  const checked = clean(body);
  if (checked.error) return checked;
  const db = read();
  const id = db.nextId++;
  const rec = { id, rackId: str(body.rackId, 120), ...checked.record, addedAt: nowIso() };
  db.items.push(rec);
  write(db);
  return { record: view(rec) };
}

function update(id, body) {
  const db = read();
  const rec = db.items.find((i) => i.id === Number(id));
  if (!rec) return { error: 'No unmanaged switch with that id.' };
  const checked = clean(body, rec);
  if (checked.error) return checked;
  Object.assign(rec, checked.record);
  if (body.rackId !== undefined) rec.rackId = str(body.rackId, 120);
  write(db);
  return { record: view(rec) };
}

function remove(id) {
  const db = read();
  const before = db.items.length;
  db.items = db.items.filter((i) => i.id !== Number(id));
  if (db.items.length === before) return { error: 'No unmanaged switch with that id.' };
  write(db);
  return { ok: true };
}

// ── overlay onto a scan snapshot ────────────────────────────────────────────
const { Evidence, observed, Manufacturer, DeviceType } = require('./model');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/**
 * Write each declaration onto the camera device it names, so an unmanaged
 * switch carries the brand and model a person gave it instead of "Unidentified".
 *
 * A declaration attaches by deviceUid when it was picked from the scan, else by
 * matching rack position. Mutates the snapshot in place; callers pass the
 * per-request copy from getScan, so this never touches stored data.
 */
function applyTo(snapshot, rackId) {
  if (!snapshot || !Array.isArray(snapshot.devices)) return snapshot;
  const decls = list(rackId);
  if (!decls.length) return snapshot;

  const byUid = new Map(snapshot.devices.map((d) => [d.uid, d]));
  const byPos = new Map(snapshot.devices.filter((d) => d.position != null).map((d) => [d.position, d]));
  snapshot.manufacturers = snapshot.manufacturers || [];
  snapshot.deviceTypes = snapshot.deviceTypes || [];
  const mfrUids = new Set(snapshot.manufacturers.map((m) => m.uid));
  const typeUids = new Set(snapshot.deviceTypes.map((t) => t.uid));

  for (const d of decls) {
    const dev = (d.deviceUid && byUid.get(d.deviceUid)) || (d.uPosition != null && byPos.get(d.uPosition));
    if (!dev) continue;

    let mfrUid = null;
    if (d.brand) {
      mfrUid = `mfr:${slug(d.brand)}`;
      if (!mfrUids.has(mfrUid)) {
        snapshot.manufacturers.push(Manufacturer(observed(mfrUid, Evidence.MANUAL), { name: d.brand, slug: slug(d.brand) }));
        mfrUids.add(mfrUid);
      }
    }

    if (d.model) {
      const typeUid = `dtype:${slug(d.model)}`;
      if (!typeUids.has(typeUid)) {
        const existingType = snapshot.deviceTypes.find((t) => t.uid === dev.deviceTypeUid);
        snapshot.deviceTypes.push(DeviceType(observed(typeUid, Evidence.MANUAL), {
          manufacturerUid: mfrUid || existingType?.manufacturerUid || '',
          model: d.model, slug: slug(d.model), uHeight: existingType?.uHeight || 1,
        }));
        typeUids.add(typeUid);
      }
      dev.deviceTypeUid = typeUid;
    } else if (mfrUid) {
      const t = snapshot.deviceTypes.find((x) => x.uid === dev.deviceTypeUid);
      if (t) t.manufacturerUid = mfrUid;
    }
    dev.evidence = Evidence.MANUAL;
    dev.provenance = { ...(dev.provenance || {}), unmanaged: true };
  }
  return snapshot;
}

module.exports = { list, add, update, remove, applyTo, FILE };
