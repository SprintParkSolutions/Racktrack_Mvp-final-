/**
 * The switch inventory: which boxes can be asked about themselves.
 *
 * A rack holds more than one managed switch and they are not interchangeable.
 * A stack member, a top-of-rack and an out-of-band switch all answer
 * differently and all three matter, so this is a list you add to rather than a
 * single "the switch" setting. Records carry the rack they belong to, so the
 * Network step shows the switches for the rack that was photographed.
 *
 * Credentials are encrypted before they touch the disk (see lib/secrets.js)
 * and never travel back to the client. The UI is told whether one is held, not
 * what it is: a password box can be replaced, never read back.
 */
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const DATA_DIR = process.env.RT_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'switches.json');
const DATA_SUBDIR = path.join(DATA_DIR, 'switch-data');

const VERSIONS = ['v1', 'v2c', 'v3'];
const LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'];
const AUTH_PROTOCOLS = ['md5', 'sha', 'sha256'];
const PRIV_PROTOCOLS = ['des', 'aes'];

const SEALED = { community: 'community', authKey: 'authKey', privKey: 'privKey' };

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function read() {
  if (!fs.existsSync(FILE)) return { nextId: 1, switches: [] };
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, switches: [] }; }
}

function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0600 regardless of what is in it today: the file's permissions should not
  // depend on which switches happen to be configured.
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* a filesystem without modes */ }
}

/** A hostname or an IP address, and nothing that could be anything else. */
function validHost(host) {
  const h = String(host || '').trim();
  if (!h || h.length > 253) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h)) return null;
  return h;
}

/**
 * Check a submitted switch.
 *
 * Errors name one field and say what to do about it, because this form is
 * filled in by someone reading a value off a note from their network admin,
 * and "invalid input" would send them back to the admin rather than to the
 * field they mistyped.
 *
 * An empty password on an edit means "keep the one already stored", which is
 * the only sane behaviour when the stored one cannot be displayed.
 */
function validate(body, existing = null) {
  const out = {};

  const host = validHost(body.host ?? existing?.host);
  if (!host) return { error: 'A management IP address or hostname is required.' };
  out.host = host;

  out.label = String(body.label ?? existing?.label ?? '').trim().slice(0, 80);

  const port = Number(body.port ?? existing?.port ?? 161);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'The port has to be a whole number between 1 and 65535. It is 161 unless your admin says otherwise.' };
  }
  out.port = port;

  const version = String(body.version ?? existing?.version ?? 'v2c');
  if (!VERSIONS.includes(version)) return { error: 'The SNMP version has to be v1, v2c or v3.' };
  out.version = version;

  const secretsOut = {};

  if (version === 'v3') {
    const username = String(body.username ?? existing?.username ?? '').trim();
    if (!username) return { error: 'A username is required for this kind of login.' };
    out.username = username;

    const level = String(body.securityLevel ?? existing?.securityLevel ?? 'authPriv');
    if (!LEVELS.includes(level)) return { error: 'Unknown security level.' };
    out.securityLevel = level;

    const authProtocol = String(body.authProtocol ?? existing?.authProtocol ?? 'sha').toLowerCase();
    if (!AUTH_PROTOCOLS.includes(authProtocol)) return { error: 'The password algorithm has to be MD5, SHA or SHA256.' };
    out.authProtocol = authProtocol;

    const privProtocol = String(body.privProtocol ?? existing?.privProtocol ?? 'aes').toLowerCase();
    if (!PRIV_PROTOCOLS.includes(privProtocol)) return { error: 'The encryption algorithm has to be DES or AES.' };
    out.privProtocol = privProtocol;

    if (level !== 'noAuthNoPriv') {
      const authKey = String(body.authKey || '');
      if (authKey) {
        if (authKey.length < 8) {
          return { error: 'The password has to be at least 8 characters. That is an SNMP rule, not ours.' };
        }
        secretsOut.authKey = authKey;
      } else if (!existing?.authKey) {
        return { error: 'A password is required.' };
      }
    }

    if (level === 'authPriv') {
      const privKey = String(body.privKey || '');
      if (privKey) {
        if (privKey.length < 8) {
          return { error: 'The encryption password has to be at least 8 characters.' };
        }
        secretsOut.privKey = privKey;
      } else if (!existing?.privKey) {
        return { error: 'This switch is set to use encryption, so it needs a second password. '
                      + 'If you were only given one, set "How much is protected" to password only.' };
      }
    }
  } else {
    out.username = '';
    out.securityLevel = '';
    const community = String(body.community || '');
    if (community) {
      secretsOut.community = community;
    } else if (!existing?.community) {
      return { error: 'A community string is required. It is the single word or phrase your admin gave you.' };
    }
  }

  return { record: out, secrets: secretsOut };
}

/** Everything the client is allowed to know. No secret leaves this function. */
function publicView(s) {
  return {
    id: s.id,
    rackId: s.rackId || '',
    label: s.label || s.host,
    host: s.host,
    port: s.port,
    version: s.version,
    username: s.username || '',
    securityLevel: s.securityLevel || '',
    authProtocol: s.authProtocol || null,
    privProtocol: s.privProtocol || null,
    hasCommunity: Boolean(s.community),
    hasAuthKey: Boolean(s.authKey),
    hasPrivKey: Boolean(s.privKey),
    addedAt: s.addedAt,
    lastTest: s.lastTest || null,
    collected: s.collected || null,
  };
}

function list(rackId) {
  const all = read().switches;
  const scoped = rackId ? all.filter((s) => (s.rackId || '') === rackId) : all;
  return scoped.map(publicView);
}

const findRaw = (id) => read().switches.find((s) => s.id === Number(id)) || null;
const find = (id) => { const r = findRaw(id); return r ? publicView(r) : null; };

function add(body) {
  const checked = validate(body);
  if (checked.error) return checked;

  const db = read();
  const id = db.nextId++;
  const rec = {
    id,
    rackId: String(body.rackId || '').trim(),
    ...checked.record,
    addedAt: nowIso(),
    lastTest: null,
    collected: null,
  };
  for (const field of Object.keys(SEALED)) {
    if (checked.secrets[field]) rec[field] = secrets.seal(checked.secrets[field]);
  }
  db.switches.push(rec);
  write(db);
  return { record: publicView(rec) };
}

function update(id, body) {
  const db = read();
  const rec = db.switches.find((s) => s.id === Number(id));
  if (!rec) return { error: 'No switch with that id.' };

  const checked = validate(body, rec);
  if (checked.error) return checked;

  Object.assign(rec, checked.record);
  if (body.rackId !== undefined) rec.rackId = String(body.rackId || '').trim();

  for (const field of Object.keys(SEALED)) {
    if (checked.secrets[field]) rec[field] = secrets.seal(checked.secrets[field]);
  }
  // Changing away from a version means the other version's secret is dead
  // weight. Deleted rather than kept, so a switch moved from v2c to v3 does
  // not leave a community string on disk that nothing will ever use again.
  if (rec.version === 'v3') delete rec.community;
  else { delete rec.authKey; delete rec.privKey; }
  if (rec.securityLevel !== 'authPriv') delete rec.privKey;

  write(db);
  return { record: publicView(rec) };
}

function remove(id) {
  const db = read();
  const before = db.switches.length;
  db.switches = db.switches.filter((s) => s.id !== Number(id));
  if (db.switches.length === before) return { error: 'No switch with that id.' };
  write(db);
  const file = path.join(DATA_SUBDIR, `${Number(id)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true };
}

/**
 * The record with its secrets opened, ready for an SNMP session.
 *
 * Returns null when a required credential cannot be opened, which happens for
 * real when RT_SECRET is rotated. That reads to the UI as "this switch needs
 * its password again", which is the truth and the right next action.
 */
function credentials(id) {
  const rec = findRaw(id);
  if (!rec) return null;
  const target = {
    host: rec.host,
    port: rec.port,
    version: rec.version,
    username: rec.username,
    securityLevel: rec.securityLevel,
    authProtocol: rec.authProtocol,
    privProtocol: rec.privProtocol,
    community: secrets.open(rec.community),
    authKey: secrets.open(rec.authKey),
    privKey: secrets.open(rec.privKey),
  };
  if (rec.version !== 'v3' && !target.community) return null;
  if (rec.version === 'v3' && rec.securityLevel !== 'noAuthNoPriv' && !target.authKey) return null;
  if (rec.version === 'v3' && rec.securityLevel === 'authPriv' && !target.privKey) return null;
  return target;
}

function recordTest(id, result) {
  const db = read();
  const rec = db.switches.find((s) => s.id === Number(id));
  if (!rec) return;
  rec.lastTest = { at: nowIso(), ...result };
  write(db);
}

/**
 * The headline facts from a collection, stored on the switch record.
 *
 * Kept small and separate from the full payload so the list can show what each
 * switch is without loading a few hundred rows of port table per switch.
 */
function recordCollected(id, data) {
  const db = read();
  const rec = db.switches.find((s) => s.id === Number(id));
  if (!rec) return;
  rec.collected = {
    at: data.collectedAt,
    sysName: data.system?.sysName || null,
    identity: data.identity,
    counts: data.counts,
  };
  write(db);
}

function saveData(id, data) {
  fs.mkdirSync(DATA_SUBDIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_SUBDIR, `${Number(id)}.json`), JSON.stringify(data, null, 2));
}

function loadData(id) {
  const file = path.join(DATA_SUBDIR, `${Number(id)}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** What the form's Advanced section offers, so the UI is never out of step. */
const options = () => ({
  versions: VERSIONS,
  securityLevels: LEVELS,
  authProtocols: AUTH_PROTOCOLS,
  privProtocols: PRIV_PROTOCOLS,
  keySource: secrets.keySource(),
});

module.exports = {
  list, find, add, update, remove, credentials,
  recordTest, recordCollected, saveData, loadData, options,
  publicView, FILE,
};
