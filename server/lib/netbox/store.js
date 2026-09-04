/**
 * Scan storage.
 *
 * A JSON file per scan, plus a small index. Deliberately not a database yet:
 * there is no query load here (one rack, a handful of scans), and a native
 * SQLite build is one more thing that can fail on a fresh machine. When scan
 * volume justifies it, this module is the only thing that changes.
 *
 * Everything lives under server/data/, which is gitignored — scans are
 * photographs of customer infrastructure and must not end up in a repo.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RT_DATA_DIR
  || path.join(__dirname, '..', 'data');
const SCANS_DIR = path.join(DATA_DIR, 'scans');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const INDEX = path.join(DATA_DIR, 'index.json');

function init() {
  for (const d of [DATA_DIR, SCANS_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(INDEX)) fs.writeFileSync(INDEX, JSON.stringify({ nextId: 1, scans: [] }, null, 2));
}

const readIndex = () => JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const writeIndex = (ix) => fs.writeFileSync(INDEX, JSON.stringify(ix, null, 2));

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Create a scan record. `payload` is whatever the stage produced so far. */
function addScan({ rackId, source, imagePath = null, payload = {},
                   imageHash = null, rackName = null, siteName = null }) {
  init();
  const ix = readIndex();
  const id = ix.nextId++;
  const rec = {
    id, rackId, source, imagePath,
    // Kept on the index, not just in the payload, so a similarity search does
    // not have to open every scan file.
    imageHash, rackName, siteName,
    createdAt: nowIso(),
    stages: {},
  };
  ix.scans.unshift(rec);
  writeIndex(ix);
  fs.writeFileSync(path.join(SCANS_DIR, `${id}.json`), JSON.stringify(payload, null, 2));
  return rec;
}

/** Bits that differ between two dHashes. Kept here so the store has no deps. */
function ham(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * The most visually similar earlier scan to a fingerprint, or null. Only scans
 * that actually finished detection count, so a half-finished or pending scan is
 * never offered as "the rack you scanned before".
 */
function findSimilarScan(imageHash, { excludeId = null } = {}) {
  if (!imageHash) return null;
  const ix = readIndex();
  let best = null;
  for (const s of ix.scans) {
    if (!s.imageHash || s.id === Number(excludeId)) continue;
    if (!(s.stages && s.stages.detect && s.stages.detect.status === 'ok')) continue;
    const sim = 1 - ham(imageHash, s.imageHash) / 64;
    if (!best || sim > best.similarity) best = { ...s, similarity: sim };
  }
  return best;
}

/** Every completed scan for one rack, newest first. */
function scansForRack(rackId) {
  const ix = readIndex();
  return ix.scans.filter((s) => s.rackId === rackId);
}

const listScans = () => (fs.existsSync(INDEX) ? readIndex().scans : []);

function getScan(id) {
  if (!fs.existsSync(INDEX)) return null;
  const rec = readIndex().scans.find((s) => s.id === Number(id));
  if (!rec) return null;
  const file = path.join(SCANS_DIR, `${rec.id}.json`);
  const payload = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...rec, payload };
}

/**
 * Delete a scan and everything it owns.
 *
 * That is four things, and missing any one of them leaves the disk holding a
 * photograph of a customer's rack that the application no longer lists: the
 * index entry, the payload JSON, the engine's output directory, and the
 * uploaded image itself.
 *
 * The image path is checked against UPLOADS_DIR before it is unlinked. The
 * index is a plain JSON file on disk, so it is an input like any other; a path
 * in it that points outside the upload directory is not a scan we wrote and is
 * not ours to delete.
 *
 * Switch credentials are scoped to a rack, not to a scan, and a rack usually
 * has several scans. Deleting one scan does not touch them.
 */
function deleteScan(id) {
  if (!fs.existsSync(INDEX)) return null;
  const ix = readIndex();
  const i = ix.scans.findIndex((s) => s.id === Number(id));
  if (i === -1) return null;

  const [rec] = ix.scans.splice(i, 1);
  writeIndex(ix);   // de-list first: a half-deleted scan must not still appear

  const drop = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };
  drop(path.join(SCANS_DIR, `${rec.id}.json`));
  drop(path.join(SCANS_DIR, `${rec.id}-cv`));

  if (rec.imagePath) {
    const abs = path.resolve(rec.imagePath);
    if (abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) drop(abs);
  }
  return rec;
}

function setPayload(id, payload) {
  init();
  fs.writeFileSync(path.join(SCANS_DIR, `${Number(id)}.json`), JSON.stringify(payload, null, 2));
}

/**
 * Record what a stage did. Kept per scan so the UI can show real history
 * rather than the last thing that happened.
 */
function recordStage(id, stage, status, detail = '') {
  init();
  const ix = readIndex();
  const rec = ix.scans.find((s) => s.id === Number(id));
  if (!rec) return null;
  rec.stages[stage] = { status, detail, ranAt: nowIso() };
  writeIndex(ix);
  return rec.stages[stage];
}

module.exports = {
  init, addScan, listScans, getScan, setPayload, recordStage, deleteScan,
  findSimilarScan, scansForRack,
  DATA_DIR, SCANS_DIR, UPLOADS_DIR,
};
