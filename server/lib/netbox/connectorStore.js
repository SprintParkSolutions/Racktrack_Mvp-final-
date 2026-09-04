/**
 * Configured connectors: the targets a user has set up to export to.
 *
 * Like the switch store, secrets (tokens, passwords) are sealed before they
 * touch the disk and never travel back to the client — the UI is told a secret
 * is held, not what it is. Which fields are secret is not decided here; it is
 * read from the connector module's own field list, so a new connector needs no
 * change in this file.
 */
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');
const registry = require('./connectors');

const DATA_DIR = process.env.RT_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'connectors.json');
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function read() {
  if (!fs.existsSync(FILE)) return { nextId: 1, items: [] };
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, items: [] }; }
}
function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* filesystem without modes */ }
}

const secretKeys = (type) => (registry.get(type)?.fields || []).filter((f) => f.secret).map((f) => f.key);

/**
 * Split a submitted config into the part stored in the clear and the part
 * sealed, run the connector's own validation over the whole thing first so a
 * bad config never reaches disk.
 */
function shape(type, cfg, existing = null) {
  const mod = registry.get(type);
  if (!mod) return { error: 'Unknown connector type.' };

  const secretSet = new Set(secretKeys(type));
  const clear = {};
  const sealed = { ...(existing?.sealed || {}) };

  for (const [k, v] of Object.entries(cfg || {})) {
    if (k === 'name' || k === 'type') continue;
    if (secretSet.has(k)) {
      if (v) sealed[k] = secrets.seal(String(v));   // empty means "keep the stored one"
    } else {
      clear[k] = v;
    }
  }
  const merged = { ...(existing?.config || {}), ...clear };

  // Validate against the full config, opening secrets so a rule like "password
  // required" sees the stored one on an edit.
  const opened = {};
  for (const k of Object.keys(sealed)) opened[k] = secrets.open(sealed[k]);
  const check = mod.validate ? mod.validate({ ...merged, ...opened }) : { ok: true };
  if (!check.ok) return { error: check.error };

  return { config: merged, sealed };
}

function publicView(rec) {
  const has = {};
  for (const k of secretKeys(rec.type)) has[k] = Boolean(rec.sealed && rec.sealed[k]);
  return { id: rec.id, type: rec.type, name: rec.name, config: rec.config, has, addedAt: rec.addedAt,
           lastTest: rec.lastTest || null };
}

function list() { return read().items.map(publicView); }
const findRaw = (id) => read().items.find((i) => i.id === Number(id)) || null;

function add(body) {
  const type = String(body.type || '');
  const shaped = shape(type, body, null);
  if (shaped.error) return shaped;
  const db = read();
  const id = db.nextId++;
  const rec = { id, type, name: String(body.name || registry.get(type).label).slice(0, 80),
                config: shaped.config, sealed: shaped.sealed, addedAt: nowIso(), lastTest: null };
  db.items.push(rec);
  write(db);
  return { record: publicView(rec) };
}

function update(id, body) {
  const db = read();
  const rec = db.items.find((i) => i.id === Number(id));
  if (!rec) return { error: 'No connector with that id.' };
  const shaped = shape(rec.type, body, rec);
  if (shaped.error) return shaped;
  rec.config = shaped.config;
  rec.sealed = shaped.sealed;
  if (body.name !== undefined) rec.name = String(body.name).slice(0, 80);
  write(db);
  return { record: publicView(rec) };
}

function remove(id) {
  const db = read();
  const before = db.items.length;
  db.items = db.items.filter((i) => i.id !== Number(id));
  if (db.items.length === before) return { error: 'No connector with that id.' };
  write(db);
  return { ok: true };
}

/** The full config with secrets opened, ready to hand a connector module. */
function resolve(id) {
  const rec = findRaw(id);
  if (!rec) return null;
  const cfg = { ...rec.config };
  for (const k of Object.keys(rec.sealed || {})) cfg[k] = secrets.open(rec.sealed[k]);
  return { type: rec.type, name: rec.name, config: cfg };
}

function recordTest(id, result) {
  const db = read();
  const rec = db.items.find((i) => i.id === Number(id));
  if (!rec) return;
  rec.lastTest = { at: nowIso(), ...result };
  write(db);
}

module.exports = { list, add, update, remove, resolve, recordTest, publicView, FILE };
