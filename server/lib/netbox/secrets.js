/**
 * Encryption for the switch credentials.
 *
 * These are read-only SNMP logins for live customer switches, sitting on a
 * laptop that goes to site, in the same folder as photographs of the same
 * customer's infrastructure. Plaintext JSON is not a defensible place for
 * them.
 *
 * AES-256-GCM, one key, a fresh nonce per value. GCM rather than CBC because
 * an authentication tag means a tampered file fails loudly instead of
 * decrypting to rubbish that then gets sent to a switch.
 *
 * ── About the key ──────────────────────────────────────────────────────────
 *
 * RT_SECRET is the honest option: the key lives wherever the operator keeps
 * it and never touches this directory.
 *
 * Without it a key is generated once and written next to the data at 0600.
 * That is worth having and worth being precise about: it protects a backup, a
 * copied folder, a synced directory and a stolen disk. It does not protect
 * against someone who can already read this machine as this user, because the
 * key is right there. The UI says exactly that rather than implying more.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RT_DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, '.secret-key');

let cached = null;

function loadKey() {
  if (cached) return cached;

  if (process.env.RT_SECRET) {
    // A passphrase of any length becomes a 32 byte key. Not a KDF with a work
    // factor, because this is not a password database: it protects a file at
    // rest against copying, and the passphrase is machine-set, not chosen by a
    // human under time pressure.
    cached = {
      key: crypto.createHash('sha256').update(process.env.RT_SECRET, 'utf8').digest(),
      source: 'env',
    };
    return cached;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (raw.length === 64) {
      cached = { key: Buffer.from(raw, 'hex'), source: 'file' };
      return cached;
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* a filesystem without modes */ }
  cached = { key, source: 'file' };
  return cached;
}

/** Where the key came from, so the UI can be honest about what it protects. */
const keySource = () => loadKey().source;

/** Returns a self-describing string: version, nonce, tag, ciphertext. */
function seal(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return null;
  const { key } = loadKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'),
    body.toString('base64')].join(':');
}

/**
 * Returns null rather than throwing when a value cannot be opened.
 *
 * A rotated RT_SECRET makes every stored credential undecryptable, and the
 * right behaviour then is for the switch to report "no credentials held" and
 * ask for them again, not for the whole inventory endpoint to 500.
 */
function open(sealed) {
  if (!sealed || typeof sealed !== 'string') return null;
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const { key } = loadKey();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { seal, open, keySource, KEY_FILE };
