/**
 * Connection-profile store — per-user encrypted credentials for external
 * data sources (ServiceNow, NetBox, SolarWinds Orion, CA Spectrum,
 * generic SQL, generic REST).
 *
 * One row per saved connection. The actual credentials (instance URL,
 * username, password, API tokens, optional vendor-specific extras) live
 * in an AES-256-GCM blob; only metadata (name, type, created_at, etc.)
 * is queryable in cleartext.
 *
 * Each user can have many profiles and at most one active profile.
 * The active profile is what every CMDB-touching request uses for that
 * user's session. Switching active does not delete the others.
 *
 * Schema (added lazily on first require):
 *   connection_profiles(
 *     id          INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *     name        TEXT    NOT NULL,
 *     type        TEXT    NOT NULL,
 *     secret_blob TEXT    NOT NULL,   -- base64(iv|tag|ciphertext) of JSON
 *     is_active   INTEGER NOT NULL DEFAULT 0,
 *     created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
 *     updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
 *   )
 *
 *   UNIQUE INDEX uq_conn_profiles_active ON connection_profiles(user_id)
 *     WHERE is_active = 1 AND organization_id IS NULL;   -- personal only
 *   UNIQUE INDEX uq_conn_profiles_org_active
 *     ON connection_profiles(organization_id, type)
 *     WHERE is_active = 1 AND organization_id IS NOT NULL; -- per (org, type)
 *
 * Encryption key is shared with the SSH creds store — same AES key file
 * (server/.env.key) or SSH_CREDS_KEY env var. One key, one rotation
 * surface.
 */
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { logger } = require('./observability');
const { encrypt, decrypt } = require('./ssh-creds');

const SERVER_DIR = path.join(__dirname, '..');
const KEY_PATH   = path.join(SERVER_DIR, '.env.key');
const DB_PATH    = path.join(SERVER_DIR, 'data', 'auth.db');

const SUPPORTED_TYPES = new Set([
  'servicenow',
  'netbox',
  'orion',         // SolarWinds Orion / NPM / NCM
  'spectrum',      // CA / DX Spectrum
  'generic_sql',   // user's own DB via SQL connection string
  'generic_rest',  // user's own DB via REST endpoint
]);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS connection_profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    secret_blob TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conn_profiles_user
    ON connection_profiles(user_id);
`);

// ── Org-scoped profiles ───────────────────────────────────────────────
// An org_admin sets these ONCE for the whole organization; every member's
// pipeline uses them, and — like the per-user profiles — the plaintext is
// never readable back through the API (write-only). organization_id is set,
// user_id records which admin last wrote it (for audit only, not scoping).
// The active-uniqueness indexes below reference organization_id, so the
// column must exist before they are (re)built.
(() => {
  const cols = db.prepare(`PRAGMA table_info(connection_profiles)`).all().map(c => c.name);
  if (!cols.includes('organization_id')) {
    db.exec(`ALTER TABLE connection_profiles ADD COLUMN organization_id INTEGER REFERENCES organizations(id)`);
  }
})();

// Active-profile uniqueness lives in TWO distinct scopes that must not bleed
// into each other:
//   • personal profiles (organization_id IS NULL)     — one active PER USER
//   • org profiles      (organization_id IS NOT NULL) — one active PER (org, type)
//
// The historical index was UNIQUE(user_id) WHERE is_active = 1: table-wide on
// user_id with no org scoping. Because an org profile stores the writing admin's
// id in user_id, that single index capped each admin at ONE active profile
// across BOTH scopes at once — a second org profile, or a personal profile
// alongside an org one, tripped a UNIQUE constraint and surfaced as a raw 500.
// Migrate any database still carrying that definition: IF NOT EXISTS cannot
// rewrite an existing index's WHERE clause, so drop the old shape first.
(() => {
  const existing = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_conn_profiles_active'`
  ).get();
  const alreadyScoped = existing && /organization_id\s+IS\s+NULL/i.test(existing.sql || '');
  if (existing && !alreadyScoped) {
    db.exec(`DROP INDEX uq_conn_profiles_active`);
  }
})();
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conn_profiles_org
    ON connection_profiles(organization_id);
  -- one active PERSONAL profile per user (org profiles are excluded here and
  -- constrained per (org, type) by the index below).
  CREATE UNIQUE INDEX IF NOT EXISTS uq_conn_profiles_active
    ON connection_profiles(user_id)
    WHERE is_active = 1 AND organization_id IS NULL;
  -- one active profile per (org, type) so an org can have a live ServiceNow
  -- AND a live SQL source at the same time.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_conn_profiles_org_active
    ON connection_profiles(organization_id, type)
    WHERE is_active = 1 AND organization_id IS NOT NULL;
`);

function loadKey() {
  const envKey = process.env.SSH_CREDS_KEY && process.env.SSH_CREDS_KEY.trim();
  if (envKey) return Buffer.from(envKey, 'hex');
  if (!fs.existsSync(KEY_PATH)) {
    // First-run convenience: generate a key so the store works out of the
    // box. Same pattern auth.js uses for jwt.secret.
    const hex = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_PATH, hex + '\n', { mode: 0o600 });
    logger.info('[connection_profiles] generated new encryption key at .env.key');
    return Buffer.from(hex, 'hex');
  }
  const hex = fs.readFileSync(KEY_PATH, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${KEY_PATH} must contain a 32-byte hex key (64 chars)`);
  }
  return Buffer.from(hex, 'hex');
}

let _key = null;
function getKey() {
  if (!_key) _key = loadKey();
  return _key;
}

// ─── Validation ───────────────────────────────────────────────────────
function validateType(type) {
  if (!SUPPORTED_TYPES.has(type)) {
    throw new Error(`unsupported profile type: ${type}`);
  }
}

function validateSecret(type, secret) {
  if (!secret || typeof secret !== 'object') {
    throw new Error('secret must be an object');
  }
  switch (type) {
    case 'servicenow':
      if (!secret.instance || !secret.user || !secret.password) {
        throw new Error('servicenow profile requires {instance, user, password}');
      }
      break;
    case 'netbox':
      // Either a token, or the login the routes turn into one (see
      // lib/netbox/provision.js). A saved profile always ends up holding
      // the token; the login form never asks for one.
      if (!secret.base_url || !(secret.token || (secret.username && secret.password))) {
        throw new Error('netbox profile requires {base_url, token} or {base_url, username, password}');
      }
      break;
    case 'orion':
      if (!secret.host || !secret.user || !secret.password) {
        throw new Error('orion profile requires {host, user, password}');
      }
      break;
    case 'spectrum':
      if (!secret.base_url || !secret.user || !secret.password) {
        throw new Error('spectrum profile requires {base_url, user, password}');
      }
      break;
    case 'generic_sql':
      if (!secret.connection_string) {
        throw new Error('generic_sql profile requires {connection_string}');
      }
      break;
    case 'generic_rest':
      if (!secret.base_url) {
        throw new Error('generic_rest profile requires {base_url}');
      }
      break;
  }
}

// ─── Public API ───────────────────────────────────────────────────────
function rowToMeta(row) {
  if (!row) return null;
  return {
    id:         row.id,
    name:       row.name,
    type:       row.type,
    is_active:  !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** List metadata only (no secrets) for a user's profiles. */
function list(userId) {
  return db.prepare(
    `SELECT id, name, type, is_active, created_at, updated_at
       FROM connection_profiles
      WHERE user_id = ?
      ORDER BY is_active DESC, updated_at DESC`
  ).all(Number(userId)).map(rowToMeta);
}

/** Get metadata for one profile. Returns null if not found / not owned. */
function get(userId, profileId) {
  const row = db.prepare(
    `SELECT id, name, type, is_active, created_at, updated_at
       FROM connection_profiles
      WHERE user_id = ? AND id = ?`
  ).get(Number(userId), Number(profileId));
  return rowToMeta(row);
}

/** Get the active profile metadata for a user. Null if no active. */
function getActive(userId) {
  const row = db.prepare(
    `SELECT id, name, type, is_active, created_at, updated_at
       FROM connection_profiles
      WHERE user_id = ? AND is_active = 1`
  ).get(Number(userId));
  return rowToMeta(row);
}

/**
 * Get decrypted credentials for one profile. Returns
 *   { id, name, type, secret: {...} }
 * Use sparingly — every call decrypts the blob in memory.
 */
function getWithSecret(userId, profileId) {
  const row = db.prepare(
    `SELECT id, name, type, secret_blob, is_active, created_at, updated_at
       FROM connection_profiles
      WHERE user_id = ? AND id = ?`
  ).get(Number(userId), Number(profileId));
  if (!row) return null;
  let secret;
  try {
    secret = JSON.parse(decrypt(row.secret_blob, getKey()));
  } catch (err) {
    logger.warn(`[connection_profiles] decrypt failed for profile ${row.id}: ${err.message}`);
    return null;
  }
  return {
    id:         row.id,
    name:       row.name,
    type:       row.type,
    is_active:  !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    secret,
  };
}

/**
 * Get decrypted credentials for the user's currently-active profile.
 * Convenience wrapper used by server-side adapters that need to attach
 * creds to a spawned child process or outbound HTTP call.
 */
function getActiveWithSecret(userId) {
  const active = getActive(userId);
  if (!active) return null;
  return getWithSecret(userId, active.id);
}

/**
 * Create a new profile. If `makeActive` is true (default), this becomes
 * the user's active profile and any other active profile is deactivated.
 */
function create(userId, { name, type, secret }, { makeActive = true } = {}) {
  validateType(type);
  validateSecret(type, secret);
  const blob = encrypt(JSON.stringify(secret), getKey());
  const tx = db.transaction(() => {
    if (makeActive) {
      // Only deactivate the user's other PERSONAL profile — org profiles share
      // this admin's user_id but are managed via the *ForOrg API and must not
      // be switched off as a side effect of a personal create.
      db.prepare(
        `UPDATE connection_profiles SET is_active = 0, updated_at = datetime('now')
          WHERE user_id = ? AND is_active = 1 AND organization_id IS NULL`
      ).run(Number(userId));
    }
    const r = db.prepare(
      `INSERT INTO connection_profiles (user_id, name, type, secret_blob, is_active)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      Number(userId),
      String(name || '').trim().slice(0, 120),
      type,
      blob,
      makeActive ? 1 : 0
    );
    return r.lastInsertRowid;
  });
  const id = tx();
  return get(userId, id);
}

/** Patch name and/or secret on an existing profile. */
function update(userId, profileId, { name, secret } = {}) {
  const existing = getWithSecret(userId, profileId);
  if (!existing) return null;

  const nextSecret = secret ? { ...existing.secret, ...secret } : existing.secret;
  if (secret) validateSecret(existing.type, nextSecret);

  const nextName = name !== undefined
    ? String(name || '').trim().slice(0, 120)
    : existing.name;
  const nextBlob = secret
    ? encrypt(JSON.stringify(nextSecret), getKey())
    : null;

  if (nextBlob) {
    db.prepare(
      `UPDATE connection_profiles
          SET name = ?, secret_blob = ?, updated_at = datetime('now')
        WHERE user_id = ? AND id = ?`
    ).run(nextName, nextBlob, Number(userId), Number(profileId));
  } else {
    db.prepare(
      `UPDATE connection_profiles
          SET name = ?, updated_at = datetime('now')
        WHERE user_id = ? AND id = ?`
    ).run(nextName, Number(userId), Number(profileId));
  }
  return get(userId, profileId);
}

/** Make this profile the active one for the user. Deactivates any other. */
function activate(userId, profileId) {
  const owned = db.prepare(
    `SELECT id FROM connection_profiles WHERE user_id = ? AND id = ?`
  ).get(Number(userId), Number(profileId));
  if (!owned) return null;
  const tx = db.transaction(() => {
    // Deactivate only other PERSONAL profiles (organization_id IS NULL); org
    // profiles for the same admin are governed by their own per-(org,type) rule.
    db.prepare(
      `UPDATE connection_profiles SET is_active = 0, updated_at = datetime('now')
        WHERE user_id = ? AND is_active = 1 AND id != ? AND organization_id IS NULL`
    ).run(Number(userId), Number(profileId));
    db.prepare(
      `UPDATE connection_profiles SET is_active = 1, updated_at = datetime('now')
        WHERE user_id = ? AND id = ?`
    ).run(Number(userId), Number(profileId));
  });
  tx();
  return get(userId, profileId);
}

/** Deactivate all PERSONAL profiles for the user (no active connection). */
function deactivateAll(userId) {
  db.prepare(
    `UPDATE connection_profiles SET is_active = 0, updated_at = datetime('now')
      WHERE user_id = ? AND is_active = 1 AND organization_id IS NULL`
  ).run(Number(userId));
}

/** Delete one profile. Returns true if a row was removed. */
function remove(userId, profileId) {
  const r = db.prepare(
    `DELETE FROM connection_profiles WHERE user_id = ? AND id = ?`
  ).run(Number(userId), Number(profileId));
  return r.changes > 0;
}

/**
 * Resolve credentials for a given backend type from the user's active
 * connection profile. Returns null if there is no active profile or if
 * its type doesn't match. There is intentionally NO env/file fallback —
 * the connection profile is the sole source of truth.
 */
function resolveCredsForType(userId, wantType) {
  if (!userId) return null;
  const active = getActiveWithSecret(userId);
  if (active && active.type === wantType) {
    return { source: 'profile', profileId: active.id, type: active.type, secret: active.secret };
  }
  return null;
}

// ─── Org-scoped API (admin-set, org-wide, write-only) ─────────────────
function orgRowToMeta(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, type: row.type,
    is_active: !!row.is_active, created_at: row.created_at, updated_at: row.updated_at,
  };
}

/** List metadata only (no secrets) for an org's connection profiles. */
function listForOrg(orgId) {
  return db.prepare(
    `SELECT id, name, type, is_active, created_at, updated_at
       FROM connection_profiles
      WHERE organization_id = ?
      ORDER BY is_active DESC, type ASC, updated_at DESC`
  ).all(Number(orgId)).map(orgRowToMeta);
}

/** Get one org profile's metadata (no secret). */
function getForOrg(orgId, profileId) {
  const row = db.prepare(
    `SELECT id, name, type, is_active, created_at, updated_at
       FROM connection_profiles WHERE organization_id = ? AND id = ?`
  ).get(Number(orgId), Number(profileId));
  return orgRowToMeta(row);
}

/**
 * Create an org profile. It becomes the active one for its type, replacing any
 * prior active of the same type. adminUserId is recorded for audit only.
 */
function createForOrg(orgId, adminUserId, { name, type, secret }) {
  validateType(type);
  validateSecret(type, secret);
  const blob = encrypt(JSON.stringify(secret), getKey());
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE connection_profiles SET is_active = 0, updated_at = datetime('now')
        WHERE organization_id = ? AND type = ? AND is_active = 1`
    ).run(Number(orgId), type);
    const r = db.prepare(
      `INSERT INTO connection_profiles (user_id, organization_id, name, type, secret_blob, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(Number(adminUserId), Number(orgId), String(name || type).trim().slice(0, 120), type, blob);
    return r.lastInsertRowid;
  });
  return getForOrg(orgId, tx());
}

/** Update name and/or secret on an org profile (merges onto existing secret). */
function updateForOrg(orgId, profileId, adminUserId, { name, secret } = {}) {
  const row = db.prepare(
    `SELECT id, type, secret_blob FROM connection_profiles WHERE organization_id = ? AND id = ?`
  ).get(Number(orgId), Number(profileId));
  if (!row) return null;
  let nextBlob = null;
  if (secret) {
    let existing = {};
    try { existing = JSON.parse(decrypt(row.secret_blob, getKey())); } catch (_) {}
    const merged = { ...existing, ...secret };
    validateSecret(row.type, merged);
    nextBlob = encrypt(JSON.stringify(merged), getKey());
  }
  const nextName = name !== undefined ? String(name || '').trim().slice(0, 120) : undefined;
  if (nextBlob && nextName !== undefined) {
    db.prepare(`UPDATE connection_profiles SET name=?, secret_blob=?, user_id=?, updated_at=datetime('now') WHERE organization_id=? AND id=?`)
      .run(nextName, nextBlob, Number(adminUserId), Number(orgId), Number(profileId));
  } else if (nextBlob) {
    db.prepare(`UPDATE connection_profiles SET secret_blob=?, user_id=?, updated_at=datetime('now') WHERE organization_id=? AND id=?`)
      .run(nextBlob, Number(adminUserId), Number(orgId), Number(profileId));
  } else if (nextName !== undefined) {
    db.prepare(`UPDATE connection_profiles SET name=?, updated_at=datetime('now') WHERE organization_id=? AND id=?`)
      .run(nextName, Number(orgId), Number(profileId));
  }
  return getForOrg(orgId, profileId);
}

/** Delete one org profile. Returns true if a row was removed. */
function removeForOrg(orgId, profileId) {
  const r = db.prepare(`DELETE FROM connection_profiles WHERE organization_id = ? AND id = ?`)
    .run(Number(orgId), Number(profileId));
  return r.changes > 0;
}

/** Decrypt the ORG's active profile of a given type — SERVER-SIDE ONLY. */
function getActiveWithSecretForOrg(orgId, wantType) {
  if (!orgId) return null;
  const row = db.prepare(
    `SELECT id, name, type, secret_blob FROM connection_profiles
      WHERE organization_id = ? AND type = ? AND is_active = 1`
  ).get(Number(orgId), wantType);
  if (!row) return null;
  try {
    return { id: row.id, name: row.name, type: row.type, secret: JSON.parse(decrypt(row.secret_blob, getKey())) };
  } catch (err) {
    logger.warn(`[connection_profiles] org decrypt failed for profile ${row.id}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve creds for a backend type from the ORG's active profile. There is NO
 * env/file fallback — the org profile is the sole source of truth org-wide.
 */
function resolveCredsForOrg(orgId, wantType) {
  const active = getActiveWithSecretForOrg(orgId, wantType);
  if (active) return { source: 'org_profile', profileId: active.id, type: active.type, secret: active.secret };
  return null;
}

module.exports = {
  SUPPORTED_TYPES: Array.from(SUPPORTED_TYPES),
  list,
  get,
  getActive,
  getWithSecret,
  getActiveWithSecret,
  create,
  update,
  activate,
  deactivateAll,
  remove,
  resolveCredsForType,
  // org-scoped
  listForOrg,
  getForOrg,
  createForOrg,
  updateForOrg,
  removeForOrg,
  getActiveWithSecretForOrg,
  resolveCredsForOrg,
};
