'use strict';

/**
 * OCR answers, keyed by the image itself.
 *
 * Reading the labels off a rack photograph takes seconds and gives the same
 * answer every time for the same pixels — so paying for it twice is pure
 * waste. Racks already cache their own pass (labels-front.json,
 * ocr_devices.json), but that is per rack: the same photo uploaded again, or
 * scanned as a second rack, or a close-up of the same label taken twice in a
 * row, paid the full cost again.
 *
 * Keyed on the SHA-256 of the file's bytes, so it is the image that is
 * remembered and not the request. A re-encoded or re-cropped photo is a
 * different image and is read again, which is correct: it is different input.
 *
 * On disk under outputs/.ocr-cache, because these answers should survive a
 * restart — the models take longer to load than the cache takes to read — and
 * in memory in front of that. Contents are facts about hardware in a
 * photograph; the cache is not tenant-scoped for the same reason the spec
 * lookup cache is not.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 500;        // per kind; ~a few KB each
const mem = new Map();        // `${kind}:${hash}` -> value

let baseDir = null;
function dirFor(kind) {
  if (!baseDir) return null;
  const d = path.join(baseDir, kind.replace(/[^a-z0-9_-]/gi, ''));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Where the cache lives. Called once at startup with the outputs directory. */
function init(outputsDir) {
  baseDir = path.join(outputsDir, '.ocr-cache');
  try { fs.mkdirSync(baseDir, { recursive: true }); } catch { baseDir = null; }
}

/** The SHA-256 of a file's bytes, or null if it cannot be read. */
function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function get(kind, hash) {
  if (!hash) return null;
  const key = `${kind}:${hash}`;
  if (mem.has(key)) return mem.get(key);
  const d = dirFor(kind);
  if (!d) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(d, `${hash}.json`), 'utf8'));
    mem.set(key, v);
    return v;
  } catch {
    return null;
  }
}

function put(kind, hash, value) {
  if (!hash || value == null) return value;
  mem.set(`${kind}:${hash}`, value);
  const d = dirFor(kind);
  if (!d) return value;
  try {
    fs.writeFileSync(path.join(d, `${hash}.json`), JSON.stringify(value));
    prune(d);
  } catch { /* a cache that cannot write is still a cache that can read */ }
  return value;
}

/** Keep the newest MAX_FILES. Cheap: this runs after a read that took seconds. */
function prune(d) {
  let names;
  try { names = fs.readdirSync(d); } catch { return; }
  if (names.length <= MAX_FILES) return;
  const rows = names.map((n) => {
    try { return { n, t: fs.statSync(path.join(d, n)).mtimeMs }; } catch { return { n, t: 0 }; }
  }).sort((a, b) => b.t - a.t);
  for (const { n } of rows.slice(MAX_FILES)) {
    try { fs.unlinkSync(path.join(d, n)); } catch { /* gone already */ }
  }
}

module.exports = { init, hashFile, get, put };
