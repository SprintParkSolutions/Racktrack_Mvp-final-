/**
 * Authentication module — SQLite + bcrypt + JWT.
 *
 * Storage:
 *   server/data/auth.db       SQLite database (users + pending_signups)
 *   server/data/jwt.secret    Random 64-byte secret, generated on first run
 *
 * Verification email goes out via SMTP with primary+fallback providers (see
 * mailProviders below — primary is tried first, then the fallback). The 6-digit
 * code is also logged to the server console for debugging. If SMTP isn't
 * configured or the send fails, signup/resend return a 502 — the code is
 * never leaked in the API response.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const audit = require('./audit');
const graphMail = require('./lib/graphMail');
const { logger } = require('./lib/observability');

const dataDir   = path.join(__dirname, 'data');
const dbPath    = path.join(dataDir, 'auth.db');
const secretPath = path.join(dataDir, 'jwt.secret');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── JWT secret (generated once, persisted) ──────────────────
function loadOrCreateSecret() {
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = process.env.JWT_SECRET || loadOrCreateSecret();
const TOKEN_TTL  = process.env.TOKEN_TTL || '30d';
// Asserted on both mint and verify. A token is only accepted if it was issued
// by this service FOR this service.
const JWT_ISSUER   = 'racktrack';
const JWT_AUDIENCE = 'racktrack-app';

// bcrypt work factor. Was 10, which dates from hardware two decades old; 12 is
// the current floor and costs ~4x more per guess to an attacker holding a
// stolen hash. It also costs us ~250ms per login on this hardware, which is
// fine for an endpoint called once a session and is itself a brute-force brake.
// Existing hashes carry their own cost in the string, so old passwords keep
// verifying — they are silently upgraded on next successful sign-in.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

// ── Cookie auth (web) ────────────────────────────────────────
// Browsers get a short-lived access JWT plus a rotating refresh token, both as
// httpOnly cookies, so no credential is reachable from JavaScript. Native
// (Capacitor) keeps the Bearer flow: a custom-scheme deep link cannot set a
// cookie in the app's WebView, and SameSite would not send one from
// capacitor://localhost anyway. requireAuth accepts either.
const ACCESS_TOKEN_EXPIRY  = process.env.ACCESS_TOKEN_EXPIRY  || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || TOKEN_TTL;
const COOKIE_DOMAIN   = process.env.COOKIE_DOMAIN || undefined;
// Secure cookies are the right default, but a `secure` cookie is silently
// dropped by the browser over plain http — which is exactly how local dev and
// a bare-http box are served. Defaulting this to true unconditionally makes
// login look like it succeeds and then behave as though it never happened.
// Explicit env wins; otherwise on in production, off outside it.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE !== 'false'
  : (process.env.NODE_ENV === 'production');
const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || 'lax';
// A refresh that arrives moments after its own rotation is almost always two
// tabs racing, not theft. Anything later is treated as a stolen token.
const REUSE_GRACE_MS = Number(process.env.REFRESH_REUSE_GRACE_MS) || 5000;

function parseExpiryMs(str) {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(str));
  if (!m) throw new Error(`Invalid expiry string: ${str}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

// Refresh tokens are stored hashed. A leaked database backup then yields no
// usable sessions, the same reason passwords are not stored in the clear.
function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

function genRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const ACCESS_COOKIE_OPTS = {
  httpOnly: true, secure: COOKIE_SECURE, sameSite: COOKIE_SAMESITE,
  path: '/', domain: COOKIE_DOMAIN,
};
// Scoped to /api/auth so the long-lived credential is not attached to every
// image, upload and scan request — only to the endpoints that consume it.
const REFRESH_COOKIE_OPTS = {
  httpOnly: true, secure: COOKIE_SECURE, sameSite: COOKIE_SAMESITE,
  path: '/api/auth', domain: COOKIE_DOMAIN,
};

function setAuthCookies(res, accessJwt, refreshPlain) {
  res.cookie('rt_access', accessJwt,
    { ...ACCESS_COOKIE_OPTS, maxAge: parseExpiryMs(ACCESS_TOKEN_EXPIRY) });
  res.cookie('rt_refresh', refreshPlain,
    { ...REFRESH_COOKIE_OPTS, maxAge: parseExpiryMs(REFRESH_TOKEN_EXPIRY) });
}

function clearAuthCookies(res) {
  res.clearCookie('rt_access', ACCESS_COOKIE_OPTS);
  res.clearCookie('rt_refresh', REFRESH_COOKIE_OPTS);
}

// ── Database schema ──────────────────────────────────────────
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pending_signups (
    email           TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    code            TEXT NOT NULL,
    code_expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    email           TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    code_expires_at INTEGER NOT NULL,
    requested_at    INTEGER NOT NULL
  );
  -- Individually revoked sessions, keyed by the token's jti.
  --
  -- users.token_version handles "kill every session for this user"; this table
  -- handles "kill THIS one", which is what signing out on one device means. A
  -- denylist is only viable because the entries expire: a row is needed exactly
  -- as long as the token it revokes would otherwise still verify, so the table
  -- stays proportional to concurrent sessions rather than growing forever.
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti        TEXT    PRIMARY KEY,
    user_id    INTEGER,
    revoked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revoked_tokens_exp ON revoked_tokens(expires_at);

  -- Refresh tokens for the browser session (see "Cookie auth" above).
  --
  -- One row per generation. Rotating mints a new row and marks the old one
  -- revoked with replaced_by_token_id pointing at its successor, so a token
  -- presented after it was rotated away is recognisable as a replay rather
  -- than merely unknown — that chain is what makes reuse detection possible.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL REFERENCES users(id),
    token_hash            TEXT    NOT NULL UNIQUE,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at            INTEGER NOT NULL,
    revoked_at            INTEGER,
    replaced_by_token_id  INTEGER REFERENCES refresh_tokens(id),
    device_info           TEXT,
    ip_address            TEXT,
    last_used_at          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user        ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash        ON refresh_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active ON refresh_tokens(user_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp         ON refresh_tokens(expires_at);
`);

// ── Tenant migration ─────────────────────────────────────────
// Adds tenant_id to users (and the same column to other tables that
// already exist). Idempotent: detects whether the column is already
// there and skips the ALTER if so. On first run, creates a `default`
// tenant and backfills every existing user / audit row into it so the
// app keeps working for legacy data.
function _hasColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}

function _ensureColumn(table, col, ddl) {
  if (!_hasColumn(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Public member-ID prefix by role. owner→OWN, org admin / site manager→ADM,
// everyone else→USR. The ID (e.g. USR-0142) is assigned once and kept stable
// even if the user's role later changes.
function _pubPrefix(role) {
  if (role === 'owner') return 'OWN';
  if (role === 'org_admin' || role === 'site_manager') return 'ADM';
  return 'USR';
}

// Assign the next sequential public_id for a user's role prefix. Idempotent:
// a user who already has one keeps it.
function assignPublicId(userId, role) {
  const existing = db.prepare('SELECT public_id FROM users WHERE id = ?').get(userId);
  if (existing && existing.public_id) return existing.public_id;
  const p = _pubPrefix(role);
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(public_id, 5) AS INTEGER)) AS m
       FROM users WHERE public_id LIKE ?`).get(`${p}-%`);
  const pid = `${p}-${String((row?.m || 0) + 1).padStart(4, '0')}`;
  db.prepare('UPDATE users SET public_id = ? WHERE id = ?').run(pid, userId);
  return pid;
}

(function migrateTenants() {
  // Default tenant exists exactly once
  let defTenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('default');
  if (!defTenant) {
    const r = db.prepare(
      'INSERT INTO tenants (slug, name) VALUES (?, ?)'
    ).run('default', 'Default');
    defTenant = { id: r.lastInsertRowid, slug: 'default', name: 'Default' };
  }
  const defaultTenantId = defTenant.id;

  // users.tenant_id (per-user tenant membership). Default to the
  // `default` tenant for any existing users so they don't get locked out.
  _ensureColumn('users', 'tenant_id',
    'tenant_id INTEGER REFERENCES tenants(id)');
  db.prepare('UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL')
    .run(defaultTenantId);

  // pending_signups.tenant_id — captured at the verify step so a user
  // can sign up into a specific tenant (invite flow later).
  _ensureColumn('pending_signups', 'tenant_id',
    'tenant_id INTEGER REFERENCES tenants(id)');

  // audit_log.tenant_id — every audit row carries the actor's tenant
  // so org-wide audit queries are tenant-scoped.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`).get()) {
    const auditHadTenant = _hasColumn('audit_log', 'tenant_id');
    _ensureColumn('audit_log', 'tenant_id',
      'tenant_id INTEGER REFERENCES tenants(id)');
    // ONE-SHOT backfill: only when we just added the column. This used to run
    // on EVERY boot, so rows written legitimately tenant-less (unauthenticated
    // actors, or actors with no tenant) were re-stamped into the default tenant
    // on the next restart. Once the column exists a NULL tenant_id is a real
    // value, not a missing one — never reclaim it.
    if (!auditHadTenant) {
      db.prepare('UPDATE audit_log SET tenant_id = ? WHERE tenant_id IS NULL')
        .run(defaultTenantId);
    }
    // Index the column we just added: the owner dashboard groups scans by
    // tenant and counts per-org scans every 5s, which scanned the whole
    // audit_log each time because no index was created alongside the ALTER.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_tenant_action
               ON audit_log(tenant_id, action, status)`);
  }

  // rack_owners — many-to-many between tenants and racks. A rack id is
  // a SHA-256 of the source image, so two tenants scanning the same
  // image get the same RK-id; ownership is recorded per-tenant so the
  // shared output dir doesn't leak.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rack_owners (
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
      rack_id     TEXT    NOT NULL,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, rack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rack_owners_rack ON rack_owners(rack_id);
    -- The org members endpoint (GET /api/orgs/:orgId/members) runs a correlated
    -- subquery over rack_owners keyed on created_by per member row; without this
    -- index each subquery was a full table scan.
    CREATE INDEX IF NOT EXISTS idx_rack_owners_created_by ON rack_owners(created_by);
  `);

  // rack_groups — a multi-rack scan: one video upload that produced N
  // best-frames. Each member rack_id still lives independently in the
  // outputs/ dir and the regular rack APIs work on it; the group is
  // just a parent record so the UI can show "this rack was scanned
  // alongside Rack 2 and Rack 3 in the same video".
  db.exec(`
    CREATE TABLE IF NOT EXISTS rack_groups (
      id           TEXT    PRIMARY KEY,
      video_hash   TEXT    NOT NULL,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rack_group_members (
      group_id     TEXT    NOT NULL REFERENCES rack_groups(id) ON DELETE CASCADE,
      rack_id      TEXT    NOT NULL,
      position     INTEGER NOT NULL,
      label        TEXT    NOT NULL,
      device_count INTEGER,
      score        REAL,
      PRIMARY KEY (group_id, rack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rack_group_members_rack
      ON rack_group_members(rack_id);
    CREATE INDEX IF NOT EXISTS idx_rack_groups_tenant_created
      ON rack_groups(tenant_id, created_at DESC);
  `);

  // ── Organizations (parent of "Sites" = tenants) ───────────────
  // Hierarchy: Owner (platform) → Organization (+ Org Admin) → Site
  // (a tenant row) → Users. Racks/scans are per-Site; active learning is
  // shared across the whole Organization.
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Every tenant ("Site") belongs to an organization.
  _ensureColumn('tenants', 'organization_id',
    'organization_id INTEGER REFERENCES organizations(id)');
  // Role governs what a user can do:
  //   'owner'        — platform superadmin (creates orgs + org admins)
  //   'org_admin'    — manages one organization (creates Sites + users)
  //   'site_manager' — manages one Site (adds members, runs scans)
  //   'member'       — regular user within a Site
  _ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'member'");
  // Denormalized org id on users so org-level scoping (incl. active
  // learning) is a single indexed lookup rather than a tenant→org join.
  _ensureColumn('users', 'organization_id',
    'organization_id INTEGER REFERENCES organizations(id)');
  // Soft-disable: a deactivated user keeps their data/history but can't sign in.
  _ensureColumn('users', 'active', 'active INTEGER NOT NULL DEFAULT 1');
  // Profile avatar: index into the client's preset-avatar set (0-based). Null
  // means "not chosen yet" — the client auto-assigns one from the initial.
  _ensureColumn('users', 'avatar', 'avatar INTEGER');
  // Stable per-user public ID (member number), role-prefixed (OWN/ADM/USR).
  // Assigned once and never renumbered. Backfill existing users in id order.
  _ensureColumn('users', 'public_id', 'public_id TEXT');
  // 0 = the user has no password they know: they joined through Google / Apple /
  // Facebook (see socialAuth.js). password_hash is NOT NULL and SQLite can't
  // drop that without rebuilding the table, so those accounts store a hash of
  // random bytes that is thrown away — unguessable, but indistinguishable from
  // a real password at the column level. Hence this flag. Every pre-existing
  // row defaults to 1, which is correct: they all signed up with a password.
  _ensureColumn('users', 'password_set', 'password_set INTEGER NOT NULL DEFAULT 1');
  // Session generation counter. Every token carries the value it was minted
  // against; requireAuth rejects any token whose copy is stale. Incrementing it
  // therefore invalidates EVERY outstanding session for that user at once —
  // which is what has to happen when a password changes, an account is
  // deactivated, or the user asks to be signed out everywhere.
  //
  // Existing rows default to 0 and every token minted from now on carries 0, so
  // sessions issued before this migration keep working. That is deliberate: the
  // alternative logs out every user on deploy.
  _ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  (function backfillPublicIds() {
    const counters = { OWN: 0, ADM: 0, USR: 0 };
    for (const r of db.prepare(
      "SELECT public_id FROM users WHERE public_id IS NOT NULL AND public_id <> ''").all()) {
      const m = String(r.public_id).match(/^(OWN|ADM|USR)-(\d+)$/);
      if (m) counters[m[1]] = Math.max(counters[m[1]], parseInt(m[2], 10));
    }
    const need = db.prepare(
      "SELECT id, role FROM users WHERE public_id IS NULL OR public_id = '' ORDER BY id").all();
    const upd = db.prepare('UPDATE users SET public_id = ? WHERE id = ?');
    db.transaction((rows) => {
      for (const u of rows) {
        const p = _pubPrefix(u.role);
        counters[p] += 1;
        upd.run(`${p}-${String(counters[p]).padStart(4, '0')}`, u.id);
      }
    })(need);
  })();
  // Org lifecycle: owner-created orgs are 'active'; a self-signup creates a
  // 'pending' request the owner must approve before it can add members / scan.
  _ensureColumn('organizations', 'status', "status TEXT NOT NULL DEFAULT 'active'");
  // Invites let an org admin / site manager add people to a specific Site.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      code            TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'member',
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      tenant_id       INTEGER REFERENCES tenants(id),
      invited_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      INTEGER,
      accepted_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
    CREATE INDEX IF NOT EXISTS idx_tenants_org ON tenants(organization_id);
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
  `);

  logger.info({
    event: 'auth.tenant_migration',
    defaultTenantId, defaultTenantSlug: defTenant.slug,
  }, 'tenant + organization schema ready');
})();

// Public so other modules (lib/tenant.js, audit.js) can resolve the
// default tenant when migrating legacy rows.
function getDefaultTenantId() {
  const t = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('default');
  return t?.id;
}

// Tenant CRUD — the bare minimum to support signup. A full tenant
// admin UI (name change, member invite, deletion) is a later add.
function findTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

function _slug(name, fallback) {
  const base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  return `${base}-${crypto.randomBytes(2).toString('hex')}`; // 4-char suffix = unique
}

// A Site is a tenant row that belongs to an organization.
function createTenant(name, organizationId = null) {
  const slug = _slug(name, 'site');
  const r = db.prepare(
    'INSERT INTO tenants (slug, name, organization_id) VALUES (?, ?, ?)'
  ).run(slug, String(name).trim().slice(0, 120), organizationId);
  return { id: r.lastInsertRowid, slug, name, organization_id: organizationId };
}

function createOrganization(name, createdBy = null) {
  const slug = _slug(name, 'org');
  const r = db.prepare(
    'INSERT INTO organizations (slug, name, created_by) VALUES (?, ?, ?)'
  ).run(slug, String(name).trim().slice(0, 120), createdBy);
  return { id: r.lastInsertRowid, slug, name };
}

// ── Validation ───────────────────────────────────────────────
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Public self-signup is limited to Gmail addresses. Deliberately NOT folded
// into EMAIL_RE: password resets, invites and existing staff/owner accounts
// (some on @sprintpark.com) still validate against the general pattern. Only
// the signup path below applies this narrower rule.
const GMAIL_RE    = /@gmail\.com$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// ≥ 8 chars, an upper, a lower, a digit, a special
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a special character';
  return null;
}

// ── Email (nodemailer) with automatic failover ───────────────
// Two providers can be configured; the primary is tried first and, if the send
// errors (auth failure, rate-limit, outage), we automatically retry through the
// fallback — so no single mail provider can block sign-in / reset codes.
//
//   PRIMARY   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
//   FALLBACK  SMTP_FALLBACK_HOST / _PORT / _USER / _PASS / _FROM   (optional)
//
// For Gmail use a 16-char App Password (needs 2-Step Verification). Port 465 =
// SSL, port 587 = STARTTLS (e.g. Brevo / Mailjet / SendGrid).
const _transporters = {};   // cache keyed by env prefix
function buildTransporter(prefix, label) {
  if (prefix in _transporters) return _transporters[prefix];
  const user = process.env[`${prefix}USER`];
  const pass = process.env[`${prefix}PASS`];
  if (!user || !pass) { _transporters[prefix] = false; return false; }
  const host = process.env[`${prefix}HOST`] || 'smtp.gmail.com';
  const port = parseInt(process.env[`${prefix}PORT`], 10) || 465;
  const from = process.env[`${prefix}FROM`] || user;
  const tx = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass: pass.replace(/\s+/g, '') }, // strip spaces from App Passwords
  });
  logger.info(`[auth] ${label} SMTP ready: ${user} via ${host}:${port}`);
  _transporters[prefix] = { tx, from, host, label };
  return _transporters[prefix];
}

// Configured providers in send-order: primary first, then optional fallback.
function mailProviders() {
  const list = [
    buildTransporter('SMTP_', 'primary'),
    buildTransporter('SMTP_FALLBACK_', 'fallback'),
  ].filter(Boolean);
  if (!list.length) {
    logger.warn('[auth] no SMTP configured — verification codes are only logged to the server console (dev mode).');
  }
  return list;
}

// Can this server deliver mail AT ALL right now?
//
// A property of the deployment, not of any one address — which is what makes it
// safe to tell the caller about. The forgot-password endpoint is deliberately
// silent about whether an address is registered, and that silence used to
// swallow a much more basic failure: with no transport configured the demo box
// accepted every reset request, answered 200 and sent nothing, so the user
// stood there waiting for a code that was never going to arrive.
//
// Saying "email is down" leaks nothing about who has an account: the answer is
// identical for a registered address, an unregistered one, and a string nobody
// has ever typed before.
function mailTransportAvailable() {
  try {
    if (graphMail.isConfigured && graphMail.isConfigured()) return true;
  } catch (err) {
    logger.warn(`[auth] graphMail.isConfigured threw: ${err.message}`);
  }
  return mailProviders().length > 0;
}

function emailHtml(code) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0EFF5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:48px 20px;">
    <div style="background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(75,69,160,0.08),0 1px 3px rgba(75,69,160,0.06);">
      <div style="background:linear-gradient(135deg,#5B54B0 0%,#7B75C0 100%);padding:28px 32px;text-align:center;">
        <div style="display:inline-block;font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:#FFFFFF;font-weight:700;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:#FFFFFF;vertical-align:middle;margin-right:10px;margin-bottom:2px;opacity:.85;"></span>RackTrack
        </div>
      </div>
      <div style="padding:40px 36px 36px;text-align:center;">
        <h1 style="margin:0 0 10px;font-size:1.5rem;font-weight:700;color:#1A1A2E;letter-spacing:-0.015em;">Verify your email</h1>
        <p style="margin:0 0 32px;color:#4A4A5A;font-size:.94rem;line-height:1.6;">Enter this code in the app to finish creating your account.<br>It expires in 1 minute.</p>
        <div style="display:inline-block;padding:20px 28px;border-radius:12px;background:#F8F7FB;border:1px solid rgba(200,196,228,0.55);">
          <div style="font-family:'SF Mono','Roboto Mono',Menlo,Consolas,monospace;font-size:2rem;font-weight:700;letter-spacing:.42em;color:#5B54B0;padding-left:.42em;">${code}</div>
        </div>
        <div style="margin:32px auto 0;width:36px;height:2px;background:linear-gradient(90deg,transparent,rgba(91,84,176,0.35),transparent);"></div>
        <p style="margin:24px 0 0;color:#6B6B7A;font-size:.82rem;line-height:1.5;">Didn't request this? You can safely ignore this email — your account stays untouched.</p>
      </div>
    </div>
    <p style="text-align:center;color:#8A8A99;font-size:.74rem;margin-top:22px;letter-spacing:.02em;">Sent automatically by RackTrack — please do not reply.</p>
  </div>
</body></html>`;
}

// Tries the primary provider, then the fallback. Returns true if ANY delivered.
async function sendVerificationEmail(email, code) {
  // NEVER log the code itself. It used to be interpolated into this message,
  // which persists it to the log store — and /api/logs is readable by owners
  // and AUDIT_ADMINS, so anyone with log access could trigger a reset for any
  // account, read the code, and take it over. Log only that a code was sent.
  logger.info({ event: 'auth.code_sent', email }, '[auth] verification code sent');

  // Prefer sending FROM the RackTrack Microsoft 365 mailbox
  // (racktrackteam@sprintpark.com) via Graph, not an employee's Gmail. Falls
  // back to SMTP below if Graph isn't configured or the send fails.
  try {
    const ok = await graphMail.sendGraphMail({
      sender: 'racktrack',
      to: email,
      subject: `Your RackTrack verification code: ${code}`,
      text: `Your RackTrack verification code is ${code}. It expires in 1 minute.`,
      html: emailHtml(code),
    });
    if (ok) return true;
  } catch (err) {
    logger.error(`[auth] Graph verification send failed: ${err.message} — falling back to SMTP`);
  }

  const providers = mailProviders();
  if (!providers.length) return false;
  for (const p of providers) {
    try {
      await p.tx.sendMail({
        from: p.from,
        to: email,
        subject: `Your RackTrack verification code: ${code}`,
        text: `Your RackTrack verification code is ${code}. It expires in 1 minute.`,
        html: emailHtml(code),
      });
      logger.info(`[auth] verification email sent to ${email} via ${p.label} (${p.host})`);
      return true;
    } catch (err) {
      logger.error(`[auth] ${p.label} send to ${email} failed (${p.host}): ${err.message} — trying next provider`);
      // fall through to the next configured provider
    }
  }
  logger.error(`[auth] ALL providers failed to send verification email to ${email}`);
  return false;
}

// Where "Reach a person" / the Contact page delivers. Kept in one place so it
// matches the address the support bot quotes.
const SUPPORT_EMAIL = 'support@racktrack.ai';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Contact-form attachments ────────────────────────────────────────
// A screenshot is the single most useful thing a technician can send with a bug
// report — "the scan looks wrong" and a picture of what it drew are different
// tickets. Held in memory, never written to disk: these are forwarded straight
// into an email and are not scans, so giving them a path under uploads/ would
// mean inventing a retention and access story for them for no reason.
//
// Limits are set by what email actually carries, not by what the phone can
// produce. Five files at 5 MB each with a 10 MB total keeps the message inside
// the range both transports handle; Graph takes the small ones directly and
// anything larger falls through to SMTP.
const CONTACT_MAX_FILES      = 5;
const CONTACT_MAX_FILE_BYTES = 5  * 1024 * 1024;
const CONTACT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

// Screenshots, photos, exported reports, and pasted logs. Everything else is
// refused at the door: the inbox is read by people, and an attachment that
// needs explaining is one nobody opens.
const CONTACT_ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/csv', 'application/json',
]);

const contactUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONTACT_MAX_FILE_BYTES, files: CONTACT_MAX_FILES },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || '').toLowerCase();
    if (CONTACT_ALLOWED_TYPES.has(type)) return cb(null, true);
    // Tagged so the handler answers 400 rather than 500 — picking the wrong
    // file type is a user mistake, not a server fault.
    const err = new Error('Attachments must be an image, PDF, or text file.');
    err.status = 400;
    cb(err, false);
  },
});

// multer surfaces its own limits as errors with a code; turn them into the
// sentence the user needs rather than "Unexpected field" or a 500.
function contactUploadErrorMessage(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE')  return `Each attachment must be under ${CONTACT_MAX_FILE_BYTES / 1024 / 1024} MB.`;
  if (err.code === 'LIMIT_FILE_COUNT') return `Please attach at most ${CONTACT_MAX_FILES} files.`;
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Unexpected attachment field.';
  return err.message || 'Could not read the attachments.';
}

// Support contact form → the support inbox, over the same primary+fallback SMTP
// as verification codes. Reply-To is the sender so support can reply straight
// from their client. Returns true if any provider delivered.
async function sendContactEmail({ fromEmail, fromName, meta, subject, message, attachments }) {
  const files = (attachments || []).filter((a) => a && a.content);
  // Name the attachments in the body too. Mail clients vary in how visibly they
  // surface them, and a screenshot nobody notices is the same as one that was
  // never sent — support needs to know to go looking.
  const fileLine = files.length
    ? `Attachments (${files.length}): ${files.map((f) => f.filename).join(', ')}`
    : '';
  const text = [
    message, '', '——',
    `From: ${fromName || 'Unknown'} <${fromEmail || 'no email'}>`,
    meta || '',
    fileLine,
  ].filter(Boolean).join('\n');
  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a2e;">
    <p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(message)}</p>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
    <p style="color:#6b6b7a;font-size:12px;margin:0;">From: ${escapeHtml(fromName || 'Unknown')} &lt;${escapeHtml(fromEmail || 'no email')}&gt;<br>${escapeHtml(meta || '').replace(/\n/g, '<br>')}${
      fileLine ? `<br>${escapeHtml(fileLine)}` : ''
    }</p>
  </div>`;

  // Prefer the support Microsoft 365 mailbox (support@racktrack.ai) via Graph,
  // Reply-To the sender; fall back to SMTP if Graph isn't configured.
  try {
    const ok = await graphMail.sendGraphMail({
      sender: 'support',
      to: SUPPORT_EMAIL,
      replyTo: fromEmail || undefined,
      subject: subject || 'Support request from the app',
      text, html,
      attachments: files,
    });
    if (ok) return true;
  } catch (err) {
    logger.error(`[auth] Graph contact send failed: ${err.message} — falling back to SMTP`);
  }

  const providers = mailProviders();
  if (!providers.length) return false;
  for (const p of providers) {
    try {
      await p.tx.sendMail({
        from: p.from, to: SUPPORT_EMAIL, replyTo: fromEmail || undefined,
        subject: subject || 'Support request from the app', text, html,
        ...(files.length ? { attachments: files } : {}),
      });
      logger.info(`[auth] contact email delivered to ${SUPPORT_EMAIL} via ${p.label} (${p.host})`);
      return true;
    } catch (err) {
      logger.error(`[auth] ${p.label} contact send failed (${p.host}): ${err.message} — trying next provider`);
    }
  }
  logger.error(`[auth] ALL providers failed to send contact email to ${SUPPORT_EMAIL}`);
  return false;
}

// ── Helpers ──────────────────────────────────────────────────
function genCode() {
  // 6-digit zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function makeToken(user, ttl = TOKEN_TTL) {
  // tenantId baked into the JWT so middleware can read it without a DB
  // round-trip on every request.
  //
  // jti + tv are what make a stateless token revocable:
  //   jti  a unique id for THIS token, so signing out one device can deny
  //        exactly it (revoked_tokens) without touching the user's other
  //        sessions.
  //   tv   the user's token_version at mint time. Bumping the column
  //        invalidates every token ever issued to them in one write — the
  //        lever for a password change, a deactivation, or "sign out
  //        everywhere".
  //
  // iss/aud are asserted on the way back in. They cost nothing and mean a token
  // minted by some other service that happens to share this secret — a future
  // staging box restored from the same backup, say — cannot authenticate here.
  return jwt.sign(
    { sub: user.id, username: user.username, tenantId: user.tenant_id,
      organizationId: user.organization_id || null, role: user.role || 'member',
      tv: Number(user.token_version || 0) },
    JWT_SECRET,
    {
      expiresIn: ttl,
      jwtid: crypto.randomUUID(),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: 'HS256',
    }
  );
}

// Verify an access token to exactly the standard requireAuth applies.
//
// Deliberately not a bare jwt.verify(token, JWT_SECRET): without `algorithms`
// the library honours whatever `alg` the token declares, which is the JWT
// confusion attack requireAuth pins against, and without issuer/audience a
// token minted by any other service sharing this secret would pass. Used by
// app.js's softAuthPayload, which decides tenant scoping on ~25 endpoints —
// it must not be a weaker check than the one guarding the authenticated ones.
function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
    });
    if (isRevoked(payload.jti)) return null;
    const user = db.prepare('SELECT active, token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || user.active === 0) return null;
    if (Number(payload.tv || 0) !== Number(user.token_version || 0)) return null;
    return payload;
  } catch { return null; }
}

// Signs an access JWT and mints/persists a matching refresh-token row. The
// single entry point for every route that starts a session, so none of them
// can drift on token shape or forget to record the refresh row.
function issueTokenPair(user, req) {
  const accessJwt = makeToken(user, ACCESS_TOKEN_EXPIRY);
  const refreshPlain = genRefreshToken();
  const expiresAt = Date.now() + parseExpiryMs(REFRESH_TOKEN_EXPIRY);
  const info = db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `).run(user.id, hashToken(refreshPlain), expiresAt,
    (req && req.headers && req.headers['user-agent']) || null, (req && req.ip) || null);
  return { accessJwt, refreshPlain, refreshId: Number(info.lastInsertRowid) };
}

// Native (Capacitor) has no usable cookie jar for our custom scheme, so it
// still reads a Bearer token out of the response body. Browsers must not get
// one: handing the credential back in JSON would put it right back within
// reach of any script on the page, which is the whole thing cookies fix.
function wantsBodyToken(req) {
  if (String(req.get('X-Client-Platform') || '').toLowerCase() === 'native') return true;
  return /native app/i.test(String(req.get('user-agent') || ''));
}

// The token handed to native in the response body — long-lived, NOT the
// 15-minute access token.
//
// The cookie migration gave native the access JWT, which expires in 15
// minutes. Web survives that because the browser holds the refresh cookie and
// renews silently; native holds no cookie for capacitor://localhost and so
// cannot call /api/auth/refresh at all. The app therefore died a quarter of an
// hour after sign-in, every request 401'd, the refresh it attempted could
// never succeed, and it bounced the user back to the login screen — over and
// over. Testers hit it as an endless sign-in loop.
//
// Native goes back to the long-lived token it carried before cookies existed.
// This is not a downgrade from the new model: it is the model native was
// always on, and it stays revocable through the same jti denylist and
// token_version checks requireAuth already enforces.
function nativeBodyToken(user) {
  return makeToken(user, REFRESH_TOKEN_EXPIRY);
}

// Expired and long-revoked rows serve no purpose — a row is only needed while
// the token it describes could still be presented. Mirrors revokeSweep().
let _lastRefreshSweep = 0;
function refreshSweep() {
  const now = Date.now();
  if (now - _lastRefreshSweep < 60_000) return;
  _lastRefreshSweep = now;
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now);
}

// Deny one specific token. The row only has to outlive the token itself, so it
// carries the token's own exp — see the sweep in revokeSweep().
function revokeToken(payload) {
  if (!payload || !payload.jti) return false;
  db.prepare(`INSERT INTO revoked_tokens (jti, user_id, revoked_at, expires_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(jti) DO NOTHING`)
    .run(String(payload.jti), payload.sub || null, Date.now(),
         (Number(payload.exp) || 0) * 1000 || Date.now() + 30 * 86400_000);
  return true;
}

function isRevoked(jti) {
  if (!jti) return false;
  return !!db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(String(jti));
}

// Invalidate EVERY outstanding session for a user. Called wherever the trust
// behind those sessions changes: password set or reset, deactivation, or an
// explicit "sign out everywhere".
function bumpTokenVersion(userId) {
  db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
    .run(Number(userId));
}

// Expired rows can go: the token they deny no longer verifies on its own.
// Cheap enough to run opportunistically rather than on a timer.
let _lastRevokeSweep = 0;
function revokeSweep() {
  const now = Date.now();
  if (now - _lastRevokeSweep < 60_000) return;
  _lastRevokeSweep = now;
  db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(now);
}

function publicUser(user, tenant = null) {
  // Ensure a stable public ID exists (covers users created before this feature
  // or a moment before the row is serialized).
  let publicId = user.public_id || null;
  if (!publicId && user.id) {
    try { publicId = assignPublicId(user.id, user.role || 'member'); } catch { /* non-fatal */ }
  }
  const out = {
    id: user.id, email: user.email, username: user.username,
    public_id: publicId,
    created_at: user.created_at,
    tenant_id: user.tenant_id,
    role: user.role || 'member',
    organization_id: user.organization_id || null,
    avatar: (user.avatar === null || user.avatar === undefined) ? null : Number(user.avatar),
  };
  if (tenant) {
    out.tenant = { id: tenant.id, slug: tenant.slug, name: tenant.name };
  } else if (user.tenant_id) {
    const t = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?')
                .get(user.tenant_id);
    if (t) out.tenant = t;
  }
  // Attach the organization ("Site" belongs to it) so the client can route
  // to the right console (owner / org-admin / site) after login.
  const orgId = user.organization_id
    || (out.tenant && db.prepare('SELECT organization_id FROM tenants WHERE id = ?')
          .get(out.tenant.id)?.organization_id);
  if (orgId) {
    const org = db.prepare('SELECT id, slug, name, status FROM organizations WHERE id = ?').get(orgId);
    if (org) out.organization = org;
  }
  return out;
}

// Express middleware: attaches req.user when a valid Bearer token is present.
// req.user is the full user row PLUS .tenant ({id, slug, name}) so route
// handlers don't have to look it up themselves.
function requireAuth(req, res, next) {
  // Cookie first (browsers), Bearer second (the native app, which cannot hold
  // a cookie for its custom scheme). Cookie wins when both are present so a
  // stale token left in a browser's localStorage by an older build can't
  // outrank the live session.
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.cookies?.rt_access || bearer;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    // algorithms is pinned explicitly. Without it the library will honour
    // whatever `alg` the token itself declares, which is the classic JWT
    // confusion attack — a forged token asking to be verified as "none", or as
    // RS256 with our HMAC secret treated as a public key.
    //
    // issuer/audience are enforced here to match makeToken.
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    // Individually signed out (one device), or globally invalidated.
    revokeSweep();
    if (isRevoked(payload.jti)) {
      return res.status(401).json({ error: 'Session has been signed out' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    // Deactivation used to be checked ONLY at login, which meant it did almost
    // nothing: the account's existing 30-day token kept working against every
    // endpoint, so removing someone's access did not actually remove it until
    // their token happened to expire. Checked here, it takes effect on the
    // user's very next request.
    if (user.active === 0) {
      return res.status(403).json({
        error: 'This account has been deactivated. Contact your administrator.',
      });
    }

    // Stale generation → the password changed, the account was deactivated and
    // reinstated, or the user signed out everywhere. Tokens minted before this
    // migration carry no `tv` and compare equal to the default 0, so existing
    // sessions survive the deploy rather than all being dropped at once.
    if (Number(payload.tv || 0) !== Number(user.token_version || 0)) {
      return res.status(401).json({ error: 'Session expired — please sign in again' });
    }
    // Defensive: a token issued before tenancy landed won't carry tenantId.
    // Use the user's row value (backfilled to default tenant) instead.
    if (user.tenant_id) {
      const t = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?')
                  .get(user.tenant_id);
      user.tenant = t || null;
    }
    req.user = user;
    // The verified claims, kept for routes that act on THIS token rather than
    // on the user — /api/auth/logout needs the jti to deny exactly this session.
    req.authPayload = payload;

    // Central org-status gate.
    //
    // Self-signup issues a working token immediately with the org left
    // 'pending', and isOrgActive() had only three call sites — /api/analyze
    // plus two site routes — so EVERY other endpoint accepted a token from an
    // unapproved account. The only thing holding those users back was
    // client-side routing (App.jsx:69), which is not a control: the token works
    // perfectly well against curl.
    //
    // /api/auth/* is exempt because PendingApprovalPage polls /api/auth/me to
    // notice the moment an owner approves. Gating that would strand every
    // pending user on a screen that could never advance.
    if (!String(req.originalUrl || '').startsWith('/api/auth/') && orgBlocked(user)) {
      return res.status(403).json({
        error: 'Your organization is awaiting approval',
        org_status: orgStatusOf(user),
      });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Mirrors the client's orgNotActive() (App.jsx:69) exactly, and deliberately:
// owners have no organization, and isOrgActive(null) returns false, so gating
// on isOrgActive alone would lock the owner out of their own platform. A user
// with no organization_id is likewise not gated — there is nothing to check,
// and that's the pre-tenancy shape.
function orgBlocked(user) {
  if (!user) return false;
  if (user.role === 'owner') return false;
  if (!user.organization_id) return false;
  return !isOrgActive(user.organization_id);
}

function orgStatusOf(user) {
  if (!user || !user.organization_id) return null;
  const o = db.prepare('SELECT status FROM organizations WHERE id = ?')
              .get(Number(user.organization_id));
  return o ? o.status : null;
}

// Role gate — runs requireAuth first, then checks req.user.role is allowed.
function requireRole(...roles) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  });
}

// Owner sees any org; an org_admin only their own.
function canManageOrg(user, orgId) {
  if (user.role === 'owner') return true;
  return user.role === 'org_admin' && Number(user.organization_id) === Number(orgId);
}

// Is an organization approved & active? (owner-created = active; a self-signup
// stays 'pending' until the owner approves it — pending/rejected orgs can't
// add members or scan.)
function isOrgActive(orgId) {
  if (!orgId) return false;
  const o = db.prepare('SELECT status FROM organizations WHERE id = ?').get(Number(orgId));
  return !!o && o.status === 'active';
}

// Can this user manage a given Site (add/edit/deactivate its members)?
// owner → any; org_admin → sites in their org; site_manager → their own site.
function canManageSite(user, siteId) {
  if (user.role === 'owner') return true;
  const site = db.prepare('SELECT organization_id FROM tenants WHERE id = ?').get(Number(siteId));
  if (!site) return false;
  if (user.role === 'org_admin') return Number(user.organization_id) === Number(site.organization_id);
  if (user.role === 'site_manager') return Number(user.tenant_id) === Number(siteId);
  return false;
}

// ── Routes ───────────────────────────────────────────────────
// Resolve a scan's original-image URL + device count from the outputs dir, so
// the dashboard can show a thumbnail and how many devices were found.
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');
function scanImageUrl(rackId) {
  for (const ext of ['jpg', 'jpeg', 'png']) {
    if (fs.existsSync(path.join(OUTPUTS_DIR, rackId, `original_image.${ext}`)))
      return `/outputs/${rackId}/original_image.${ext}`;
  }
  return null;
}
function scanDeviceCount(rackId) {
  try {
    const p = path.join(OUTPUTS_DIR, rackId, 'device_unit_map.json');
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(d.devices) ? d.devices.length : 0;
    }
  } catch (_) { /* ignore */ }
  return 0;
}

function registerRoutes(app) {
  // ── Sign up: stage 1 — create pending signup, send code ────
  // Now takes an optional `company` field. If absent / blank, the user
  // joins the `default` tenant (preserves the legacy behavior). If
  // present, the verify step creates a fresh tenant for that company.
  app.post('/api/auth/signup', async (req, res) => {
    const { email, username, password, company } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'invalid email', payload: { email } });
      return res.status(400).json({ error: 'Valid email required' });
    }
    // Account creation is limited to Gmail addresses.
    if (!GMAIL_RE.test(String(email).trim())) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'non-gmail email', payload: { email } });
      return res.status(400).json({ error: 'Please use a @gmail.com email address to create an account.' });
    }
    if (!username || !USERNAME_RE.test(String(username).trim())) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'invalid username', payload: { email, username } });
      return res.status(400).json({ error: 'Username must be 3–32 chars (letters, digits, . _ -)' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: pwErr, payload: { email, username } });
      return res.status(400).json({ error: pwErr });
    }
    // Company name is REQUIRED — every user must belong to a real tenant.
    // Without this, blank-company signups would all collapse into the
    // shared `default` tenant, which is exactly the data-leak multi-
    // tenancy is supposed to prevent.
    const companyNorm = String(company || '').trim().slice(0, 120);
    if (!companyNorm || companyNorm.length < 2) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail',
        error: 'company required', payload: { email, username } });
      return res.status(400).json({ error: 'Company name is required (at least 2 characters)' });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const userNorm  = String(username).trim();

    // Reject if either email or username already maps to a verified user
    const dupEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailNorm);
    if (dupEmail) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'email taken', payload: { email: emailNorm } });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const dupUser = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(userNorm);
    if (dupUser) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'username taken', payload: { username: userNorm } });
      return res.status(409).json({ error: 'That username is taken' });
    }

    const code = genCode();
    const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
    const expiresAt = Date.now() + 60 * 1000; // 1 minute

    // Stash the company name on the pending row so the verify step
    // (which is the only place that actually creates persistent records)
    // has it without re-reading from request input.
    db.prepare(`
      INSERT INTO pending_signups (email, username, password_hash, code, code_expires_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(email) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        code = excluded.code,
        code_expires_at = excluded.code_expires_at,
        tenant_id = NULL
    `).run(emailNorm, userNorm, passwordHash, code, expiresAt);
    // We use a side-channel column (we don't have a `company` column on
    // pending_signups) — easiest is to reuse the `username` row. Add a
    // dedicated `company` column the cheap way: only if pending wasn't
    // already that shape.
    if (!_hasColumn('pending_signups', 'company')) {
      db.exec('ALTER TABLE pending_signups ADD COLUMN company TEXT');
    }
    db.prepare('UPDATE pending_signups SET company = ? WHERE email = ?')
      .run(companyNorm || null, emailNorm);

    const sent = await sendVerificationEmail(emailNorm, code);
    if (!sent) {
      audit.log({ req, action: 'auth.signup.start', status: 'fail', error: 'smtp send failed', payload: { email: emailNorm } });
      return res.status(502).json({ error: 'Could not send verification email — try again in a minute' });
    }
    audit.log({ req, action: 'auth.signup.start', status: 'ok', payload: { email: emailNorm, username: userNorm, company: companyNorm || null } });
    res.json({ ok: true, email: emailNorm, sent: true });
  });

  // ── Sign up: stage 2 — verify code → create user ───────────
  app.post('/api/auth/verify', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    const pending = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(emailNorm);
    if (!pending) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'no pending', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending signup for that email' });
    }
    if (Date.now() > pending.code_expires_at) {
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Verification code has expired — sign up again' });
    }
    if (String(code).trim() !== pending.code) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect verification code' });
    }

    // Final dup check (someone else may have raced us)
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailNorm)) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'email taken (race)', payload: { email: emailNorm } });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(pending.username)) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail', error: 'username taken (race)', payload: { username: pending.username } });
      return res.status(409).json({ error: 'That username is taken' });
    }

    // Every user MUST belong to a real tenant. Signup validates that
    // `company` is non-empty, so a pending row without one means a
    // pre-tenancy client somehow snuck in — refuse and force a fresh
    // signup. The `default` tenant exists only as a backstop for
    // legacy users that pre-date this migration.
    if (!pending.company || !String(pending.company).trim()) {
      audit.log({ req, action: 'auth.signup.verify', status: 'fail',
        error: 'pending row missing company', payload: { email: emailNorm } });
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);
      return res.status(400).json({
        error: 'Signup is missing a company name. Please sign up again.',
      });
    }
    // Self-signup provisions a full Organization → Site → admin, not an orphan
    // tenant: the person registering their company becomes that org's admin,
    // with a default "Main Site" to start scanning into. Additional sites and
    // members are then added from the console (or via invite links).
    // Self-signup is a REQUEST: the org starts 'pending' and can't add members
    // or scan until the platform owner approves it. Owner-created orgs (POST
    // /api/orgs) stay 'active'.
    const org    = createOrganization(pending.company);
    db.prepare("UPDATE organizations SET status = 'pending' WHERE id = ?").run(org.id);
    const tenant = createTenant('Main Site', org.id);

    const result = db.prepare(`
      INSERT INTO users (email, username, password_hash, email_verified,
                         role, organization_id, tenant_id, active)
      VALUES (?, ?, ?, 1, 'org_admin', ?, ?, 1)
    `).run(emailNorm, pending.username, pending.password_hash, org.id, tenant.id);
    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(emailNorm);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    user.tenant = tenant;  // attach so audit + token + response see it
    audit.log({
      req, user, action: 'auth.signup.verify', status: 'ok',
      targetType: 'user', targetId: user.id,
      payload: { tenant_id: tenant.id, tenant_slug: tenant.slug, new_tenant: !!pending.company },
    });
    const { accessJwt, refreshPlain } = issueTokenPair(user, req);
    setAuthCookies(res, accessJwt, refreshPlain);
    res.json({ ok: true, user: publicUser(user, tenant),
      ...(wantsBodyToken(req) ? { token: nativeBodyToken(user) } : {}) });
  });

  // ── Resend verification code ───────────────────────────────
  app.post('/api/auth/resend-code', async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'missing email' });
      return res.status(400).json({ error: 'email required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const pending = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(emailNorm);
    if (!pending) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'no pending', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending signup for that email' });
    }

    const code = genCode();
    const expiresAt = Date.now() + 60 * 1000; // 1 minute
    db.prepare('UPDATE pending_signups SET code = ?, code_expires_at = ? WHERE email = ?')
      .run(code, expiresAt, emailNorm);
    const sent = await sendVerificationEmail(emailNorm, code);
    if (!sent) {
      audit.log({ req, action: 'auth.resend', status: 'fail', error: 'smtp send failed', payload: { email: emailNorm } });
      return res.status(502).json({ error: 'Could not send verification email — try again in a minute' });
    }
    audit.log({ req, action: 'auth.resend', status: 'ok', payload: { email: emailNorm } });
    res.json({ ok: true, sent: true });
  });

  // ── Login: username OR email + password (+ optional tenant) ─
  // Tenant is optional but, when provided, scopes the lookup so that the
  // same username can exist in different orgs without ambiguity (the
  // existing UNIQUE constraint on users.username still applies globally,
  // but the per-tenant scoping prevents one org's user from signing in
  // with another org's stolen credentials if uniqueness is ever relaxed).
  // Match is case-insensitive against tenant name OR slug.
  app.post('/api/auth/login', (req, res) => {
    const { username, password, tenant } = req.body || {};
    if (!username || !password) {
      audit.log({ req, action: 'auth.login', status: 'fail', error: 'missing fields' });
      return res.status(400).json({ error: 'username and password required' });
    }
    const ident = String(username).trim();
    const tenantArg = String(tenant || '').trim();

    // The "Organization" field on the sign-in form is resolved against the
    // org hierarchy in priority order:
    //   1. an organization (name or slug) → match any user in that org. Org
    //      admins have tenant_id = NULL while members also carry a tenant_id,
    //      so we key off organization_id, which every org member has.
    //   2. a Site / tenant (name or slug) → match a user scoped to that Site.
    // Owner accounts sit above every org and sign in with the field left
    // blank (global username lookup — usernames are globally unique).
    let scope = null; // { kind: 'org' | 'tenant', id }
    if (tenantArg) {
      const orgRow = db.prepare(`
        SELECT id FROM organizations
        WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
      `).get(tenantArg, tenantArg);
      if (orgRow) {
        scope = { kind: 'org', id: orgRow.id };
      } else {
        const tenantRow = db.prepare(`
          SELECT id FROM tenants
          WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
        `).get(tenantArg, tenantArg);
        if (tenantRow) scope = { kind: 'tenant', id: tenantRow.id };
      }
      if (!scope) {
        audit.log({ req, action: 'auth.login', status: 'fail',
          error: 'unknown organization', payload: { ident, tenant: tenantArg } });
        return res.status(401).json({ error: 'Invalid organization or credentials' });
      }
    }

    const user = !scope
      ? db.prepare(`SELECT * FROM users WHERE email = ? OR username = ? COLLATE NOCASE`)
          .get(ident.toLowerCase(), ident)
      : scope.kind === 'org'
        ? db.prepare(`
            SELECT * FROM users
            WHERE (email = ? OR username = ? COLLATE NOCASE)
              AND organization_id = ?
          `).get(ident.toLowerCase(), ident, scope.id)
        : db.prepare(`
            SELECT * FROM users
            WHERE (email = ? OR username = ? COLLATE NOCASE)
              AND tenant_id = ?
          `).get(ident.toLowerCase(), ident, scope.id);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      audit.log({ req, action: 'auth.login', status: 'fail',
        error: 'invalid credentials',
        payload: { ident, tenant: tenantArg || null } });
      return res.status(401).json({ error: tenantArg ? 'Invalid organization or credentials' : 'Invalid username or password' });
    }
    if (user.active === 0) {
      audit.log({ req, user, action: 'auth.login', status: 'fail', error: 'deactivated',
        targetType: 'user', targetId: user.id });
      return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
    }

    // Transparent rehash. The password was just proven correct and is in memory
    // for this one moment, so an account still on the old cost-10 hash can be
    // upgraded now — the only point at which that is possible without asking
    // the user to change anything. Deliberately NOT a token_version bump: the
    // credential hasn't changed, only how it's stored, so live sessions stay.
    try {
      if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run(bcrypt.hashSync(password, BCRYPT_COST), user.id);
      }
    } catch (_) { /* unreadable cost — leave the hash alone, sign-in still valid */ }

    audit.log({ req, user, action: 'auth.login', status: 'ok',
      targetType: 'user', targetId: user.id,
      payload: { tenant_id: user.tenant_id } });
    const { accessJwt, refreshPlain } = issueTokenPair(user, req);
    setAuthCookies(res, accessJwt, refreshPlain);
    res.json({ ok: true, user: publicUser(user),
      ...(wantsBodyToken(req) ? { token: nativeBodyToken(user) } : {}) });
  });

  // ── Forgot password — stage 1: request a reset code ─────────
  // Always returns 200 (even when the email is unknown) so attackers can't
  // enumerate registered emails. The code is only created/sent when a user
  // actually exists for that email. 1-minute expiry to match signup.
  app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      audit.log({ req, action: 'auth.forgot_password.start', status: 'fail',
        error: 'invalid email', payload: { email } });
      return res.status(400).json({ error: 'Valid email required' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    // Refuse before writing a reset row when nothing can carry the code. The
    // row would expire in 60s unread, and the user would be staring at a code
    // entry screen for a message that was never sent. Checked for every
    // address, registered or not, so this cannot be used to probe accounts.
    if (!mailTransportAvailable()) {
      logger.error('[auth] forgot-password requested but NO mail transport is configured — nothing was sent');
      audit.log({ req, action: 'auth.forgot_password.start', status: 'fail',
        error: 'no mail transport', payload: { email: emailNorm } });
      return res.status(503).json({
        error: 'We can\'t send email right now, so a reset code can\'t reach you. '
             + 'Please contact support@racktrack.ai and we\'ll reset it for you.',
        code: 'mail_unavailable',
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);

    if (user) {
      const code = genCode();
      const expiresAt = Date.now() + 60 * 1000; // 1 minute
      db.prepare(`
        INSERT INTO password_resets (email, code, code_expires_at, requested_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          code = excluded.code,
          code_expires_at = excluded.code_expires_at,
          requested_at = excluded.requested_at
      `).run(emailNorm, code, expiresAt, Date.now());

      // Reuse the verification email template — same look, different copy
      // would be nicer but for now the user just sees a 6-digit code.
      const sent = await sendVerificationEmail(emailNorm, code);
      audit.log({ req, action: 'auth.forgot_password.start',
        status: sent ? 'ok' : 'partial',
        payload: { email: emailNorm, sent } });
    } else {
      // Don't reveal that the email isn't registered.
      audit.log({ req, action: 'auth.forgot_password.start',
        status: 'ok', payload: { email: emailNorm, sent: false, reason: 'no_user' } });
    }

    // Always 200 with the same shape — silent on existence.
    res.json({ ok: true, email: emailNorm });
  });

  // ── Forgot password — stage 1.5: verify the code WITHOUT consuming it ─
  // The UI uses this after the user enters the 6-digit code, so it can show
  // a "Do you want to change your password?" confirmation step before
  // collecting the new password. The reset row stays in the DB and is
  // consumed by /reset-password later if the user proceeds.
  app.post('/api/auth/verify-reset-code', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.verify', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    audit.log({ req, action: 'auth.forgot_password.verify', status: 'ok',
      payload: { email: emailNorm } });
    res.json({ ok: true });
  });

  // ── Forgot password — alternative stage 2: skip the password change and
  // sign in directly with the OTP. The 6-digit code is treated as proof of
  // identity (the user controls the inbox), so we issue a fresh token
  // without touching password_hash. The reset row is consumed so the same
  // code can't be replayed for another login.
  app.post('/api/auth/login-with-code', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email and code required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
    if (!user) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.login_with_code', status: 'fail',
        error: 'user gone', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No account exists for that email' });
    }

    // Consume the reset row — same code can't be replayed.
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);

    audit.log({ req, user, action: 'auth.forgot_password.login_with_code',
      status: 'ok', targetType: 'user', targetId: user.id });

    const { accessJwt, refreshPlain } = issueTokenPair(user, req);
    setAuthCookies(res, accessJwt, refreshPlain);
    res.json({ ok: true, user: publicUser(user),
      ...(wantsBodyToken(req) ? { token: nativeBodyToken(user) } : {}) });
  });

  // ── Forgot password — stage 2: verify code + set new password ─
  app.post('/api/auth/reset-password', (req, res) => {
    const { email, code, password } = req.body || {};
    if (!email || !code || !password) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'missing fields' });
      return res.status(400).json({ error: 'email, code, and new password required' });
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: pwErr, payload: { email } });
      return res.status(400).json({ error: pwErr });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const reset = db.prepare('SELECT * FROM password_resets WHERE email = ?').get(emailNorm);
    if (!reset) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'no pending reset', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No pending reset for that email — request a new code' });
    }
    if (Date.now() > reset.code_expires_at) {
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'code expired', payload: { email: emailNorm } });
      return res.status(410).json({ error: 'Reset code has expired — request a new one' });
    }
    if (String(code).trim() !== reset.code) {
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'wrong code', payload: { email: emailNorm } });
      return res.status(400).json({ error: 'Incorrect reset code' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
    if (!user) {
      // Pending reset for a user that was deleted between stages.
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);
      audit.log({ req, action: 'auth.forgot_password.reset', status: 'fail',
        error: 'user gone', payload: { email: emailNorm } });
      return res.status(404).json({ error: 'No account exists for that email' });
    }

    const newHash = bcrypt.hashSync(password, BCRYPT_COST);
    // password_set flips to 1 here: this is the supported route for a user who
    // joined through Google/Apple to gain a password. It's safe because it
    // still requires control of the inbox — the emailed code proves that.
    db.prepare('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?')
      .run(newHash, user.id);
    // Changing the password must end every session opened with the OLD one.
    // The whole point of a reset is often that someone else has the account;
    // leaving their 30-day token valid would make the reset cosmetic.
    bumpTokenVersion(user.id);
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(emailNorm);

    audit.log({ req, user, action: 'auth.forgot_password.reset',
      status: 'ok', targetType: 'user', targetId: user.id });

    // Issue a fresh token so the client can sign the user in immediately
    // after they reset — no second login round-trip needed.
    //
    // Re-read first: `user` was loaded BEFORE bumpTokenVersion, so minting from
    // it would stamp the token with the old generation and requireAuth would
    // reject it on the very next request — a reset that appears to succeed and
    // then bounces the user to the login screen.
    const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const { accessJwt, refreshPlain } = issueTokenPair(refreshed, req);
    setAuthCookies(res, accessJwt, refreshPlain);
    res.json({ ok: true, user: publicUser(refreshed),
      ...(wantsBodyToken(req) ? { token: nativeBodyToken(refreshed) } : {}) });
  });

  // ── Whoami ─────────────────────────────────────────────────
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user) });
  });

  // ── Refresh (browser sessions) ─────────────────────────────
  // Trades a valid refresh cookie for a fresh access+refresh pair. Rotating on
  // every use is what limits the damage of a stolen refresh token: the thief
  // and the real user cannot both keep using it, and whichever one presents the
  // superseded copy exposes the theft.
  //
  // Deliberately NOT behind requireAuth — the whole point is that it is reached
  // when the access token has already expired.
  app.post('/api/auth/refresh', (req, res) => {
    const presented = req.cookies?.rt_refresh;
    if (!presented) {
      audit.log({ req, action: 'auth.refresh', status: 'fail', error: 'no_token' });
      return res.status(401).json({ error: 'No refresh token' });
    }
    refreshSweep();
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
                  .get(hashToken(presented));

    if (!row) {
      audit.log({ req, action: 'auth.refresh', status: 'fail', error: 'unknown_token' });
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    if (row.expires_at < Date.now()) {
      audit.log({ req, action: 'auth.refresh', status: 'fail', error: 'expired',
        targetType: 'user', targetId: row.user_id });
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    let graceReuse = false;
    if (row.revoked_at !== null) {
      if (row.replaced_by_token_id === null) {
        // Revoked by an explicit logout rather than by rotation. A deliberate
        // sign-out cannot legitimately race with itself, so no grace applies.
        audit.log({ req, action: 'auth.refresh', status: 'fail', error: 'revoked',
          targetType: 'user', targetId: row.user_id });
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Refresh token revoked' });
      }
      if (Date.now() - row.revoked_at > REUSE_GRACE_MS) {
        // Rotated away, then presented again well afterwards — treat as theft
        // and drop every live session for this user, not just this chain.
        db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
          .run(Date.now(), row.user_id);
        bumpTokenVersion(row.user_id);   // also kills access tokens already minted
        audit.log({ req, action: 'auth.token_reuse_detected', status: 'fail',
          targetType: 'user', targetId: row.user_id,
          payload: { presented_token_id: row.id, elapsed_ms: Date.now() - row.revoked_at } });
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Refresh token reuse detected', code: 'token_reuse' });
      }
      graceReuse = true;   // benign concurrent-tab race — mint a fresh generation
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.active === 0) {
      audit.log({ req, action: 'auth.refresh', status: 'fail', error: 'user_inactive',
        targetType: 'user', targetId: row.user_id });
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Account unavailable' });
    }

    const { accessJwt, refreshPlain, refreshId } = issueTokenPair(user, req);
    // Only the live row is revoked here. Re-stamping revoked_at on a row that
    // was ALREADY rotated away would restart its grace window on every
    // presentation, so a stolen token replayed every few seconds would stay
    // usable forever and never trip the reuse check above.
    if (!graceReuse) {
      db.prepare('UPDATE refresh_tokens SET revoked_at = ?, replaced_by_token_id = ?, last_used_at = ? WHERE id = ?')
        .run(Date.now(), refreshId, Date.now(), row.id);
    } else {
      db.prepare('UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
    }
    setAuthCookies(res, accessJwt, refreshPlain);
    audit.log({ req, user, action: 'auth.refresh', status: 'ok',
      targetType: 'user', targetId: user.id,
      payload: graceReuse ? { grace_reuse: true } : undefined });
    res.json({ ok: true, user: publicUser(user) });
  });

  // ── Sign out (this device) ─────────────────────────────────
  // Logout used to be purely client-side: the app dropped the token from
  // localStorage and that was that. The token itself stayed valid for the rest
  // of its 30 days, so signing out on a shared or lost device protected
  // nothing against anyone who had already copied it. Denying the jti makes the
  // token dead server-side, which is what users assume "sign out" means.
  //
  // Not behind requireAuth: a browser whose 15-minute access token has already
  // expired must still be able to sign out and have its refresh row revoked.
  // Without that, the long-lived half of the session outlives the sign-out.
  app.post('/api/auth/logout', (req, res) => {
    const presented = req.cookies?.rt_refresh;
    if (presented) {
      db.prepare('UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .run(Date.now(), Date.now(), hashToken(presented));
    }
    // Deny this specific access token too, so it cannot be replayed for the
    // remainder of its life. Best-effort: the token may already be expired.
    const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    const token = req.cookies?.rt_access || bearer;
    let uid = null;
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET, {
          algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
        });
        revokeToken(payload);
        uid = payload.sub || null;
      } catch { /* expired or malformed — the refresh row above is what matters */ }
    }
    clearAuthCookies(res);
    audit.log({ req, action: 'auth.logout', status: 'ok',
      targetType: 'user', targetId: uid });
    res.json({ ok: true });
  });

  // ── Sign out everywhere ────────────────────────────────────
  // The lever for "my laptop was stolen". Bumping token_version invalidates
  // every token ever issued to this user in a single write, including the one
  // making this request.
  app.post('/api/auth/logout-all', requireAuth, (req, res) => {
    bumpTokenVersion(req.user.id);
    // token_version only invalidates JWTs. The refresh rows are separate state
    // and would otherwise survive, letting a stolen refresh cookie mint a fresh
    // (now higher-version) access token immediately after "sign out everywhere".
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), req.user.id);
    clearAuthCookies(res);
    audit.log({ req, user: req.user, action: 'auth.logout_all', status: 'ok',
      targetType: 'user', targetId: req.user.id });
    res.json({ ok: true });
  });

  // Set the profile avatar — an index into the client's preset-avatar set.
  app.post('/api/auth/avatar', requireAuth, (req, res) => {
    const idx = Number(req.body?.avatar);
    if (!Number.isInteger(idx) || idx < 0 || idx > 23) {
      return res.status(400).json({ error: 'avatar must be a preset index (0-23)' });
    }
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(idx, req.user.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user: publicUser(fresh) });
  });

  // ── Support contact form ──────────────────────────────────────
  // Sends the user's message to the support inbox with their identity +
  // context attached (and Reply-To set so support can respond). requireAuth:
  // the app is behind login, and it lets us attach who/where without the user
  // retyping it. A short per-user cooldown blocks double-sends and spam. If SMTP
  // isn't configured or the send fails, the client falls back to a mailto: link.
  const _lastContactAt = new Map();

  // The form posts multipart when it carries attachments and JSON when it does
  // not — older builds of the app only ever send JSON. multer ignores anything
  // that is not multipart, and express.json() has already populated req.body in
  // that case, so one handler serves both without a version check.
  const acceptContactAttachments = (req, res, next) => {
    contactUpload.array('attachments', CONTACT_MAX_FILES)(req, res, (err) => {
      if (!err) return next();
      const status = err.status || (err.code ? 400 : 500);
      if (status >= 500) logger.error(`[auth] contact upload failed: ${err.message}`);
      res.status(status).json({ error: contactUploadErrorMessage(err) });
    });
  };

  app.post('/api/support/contact', requireAuth, acceptContactAttachments, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (message.length < 4)    return res.status(400).json({ error: 'Please describe the problem.' });
    if (message.length > 5000) return res.status(400).json({ error: 'That message is too long — please shorten it.' });

    // multer caps each file and the count, but not the sum, and five files just
    // under the individual limit is a message no transport will accept.
    const files = req.files || [];
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    if (totalBytes > CONTACT_MAX_TOTAL_BYTES) {
      return res.status(400).json({
        error: `Attachments total ${(totalBytes / 1024 / 1024).toFixed(1)} MB — please keep them under ${CONTACT_MAX_TOTAL_BYTES / 1024 / 1024} MB.`,
      });
    }

    const now = Date.now();
    if (now - (_lastContactAt.get(req.user.id) || 0) < 15_000) {
      return res.status(429).json({ error: 'Please wait a few seconds before sending again.' });
    }

    const u = req.user;
    const org = u.tenant?.name || '—';
    const context = String(req.body?.context || '').trim();
    const meta =
      `Role: ${u.role || '—'} · Org/Site: ${org} · User id: ${u.id}` +
      (context ? `\nContext: ${context.slice(0, 800)}` : '');

    const sent = await sendContactEmail({
      fromEmail: u.email,
      fromName:  u.username,
      meta,
      subject:   String(req.body?.subject || '').trim() || `Support request from ${u.username || 'a user'}`,
      message,
      // multer already rejected anything outside the allow-list; the filename is
      // the only attacker-influenced field left, and it reaches an email header
      // rather than a filesystem path. Strip the separators and control bytes a
      // client could use to forge a header line, and cap the length.
      attachments: files.map((f) => ({
        filename: String(f.originalname || 'attachment')
           
          .replace(/[\r\n\x00-\x1f\x7f/\\]/g, '_')
          .slice(0, 120) || 'attachment',
        content: f.buffer,
        contentType: f.mimetype,
      })),
    });

    if (!sent) {
      return res.status(502).json({ error: `Could not send right now. Please email ${SUPPORT_EMAIL} directly.`, supportEmail: SUPPORT_EMAIL });
    }
    _lastContactAt.set(u.id, now);
    audit.log({ req, user: u, action: 'support.contact', status: 'ok',
      payload: files.length ? { attachments: files.length, bytes: totalBytes } : undefined });
    res.json({ ok: true, to: SUPPORT_EMAIL });
  });

  // ══════════════════════════════════════════════════════════════
  // Organization workflow:  Owner → Org (+ Admin) → Site → Members
  // ══════════════════════════════════════════════════════════════

  // Owner: list every organization with counts.
  app.get('/api/orgs', requireRole('owner'), (req, res) => {
    const organizations = db.prepare(`
      SELECT o.id, o.slug, o.name, o.created_at,
        (SELECT COUNT(*) FROM tenants t WHERE t.organization_id = o.id) AS site_count,
        (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id)   AS member_count,
        (SELECT username FROM users u WHERE u.organization_id = o.id AND u.role = 'org_admin'
           ORDER BY u.created_at LIMIT 1) AS admin_username
      FROM organizations o ORDER BY o.created_at DESC
    `).all();
    res.json({ ok: true, organizations });
  });

  // Owner: create an organization + its first Org Admin.
  app.post('/api/orgs', requireRole('owner'), (req, res) => {
    const { name, adminUsername, adminEmail, adminPassword } = req.body || {};
    if (!name || !adminUsername || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'name, adminUsername, adminEmail and adminPassword are required' });
    }
    if (!EMAIL_RE.test(String(adminEmail))) return res.status(400).json({ error: 'Invalid admin email' });
    if (!USERNAME_RE.test(String(adminUsername))) return res.status(400).json({ error: 'Admin username must be 3–32 chars (letters, numbers, . _ -)' });
    const pwErr = validatePassword(adminPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const emailN = String(adminEmail).trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(emailN))
      return res.status(409).json({ error: 'That admin email is already registered' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(adminUsername))
      return res.status(409).json({ error: 'That admin username is taken' });

    const out = db.transaction(() => {
      const org = createOrganization(name, req.user.id);
      const hash = bcrypt.hashSync(adminPassword, BCRYPT_COST);
      db.prepare(`INSERT INTO users (email, username, password_hash, email_verified, role, organization_id)
                  VALUES (?, ?, ?, 1, 'org_admin', ?)`)
        .run(emailN, adminUsername, hash, org.id);
      return org;
    })();
    audit.log({ req, user: req.user, action: 'org.create', status: 'ok', targetType: 'organization', targetId: out.id, payload: { name } });
    res.json({ ok: true, organization: out, admin: { username: adminUsername, email: emailN } });
  });

  // Owner/Org-admin: what org am I managing? (console bootstrap)
  app.get('/api/my-org', requireRole('owner', 'org_admin'), (req, res) => {
    if (req.user.role === 'owner') return res.json({ ok: true, owner: true });
    const organization = db.prepare('SELECT id, slug, name, status FROM organizations WHERE id = ?')
                           .get(req.user.organization_id);
    res.json({ ok: true, organization });
  });

  // Owner: organizations awaiting approval (self-signup requests).
  app.get('/api/orgs/pending', requireRole('owner'), (req, res) => {
    const pending = db.prepare(`
      SELECT o.id, o.name, o.slug, o.created_at,
        (SELECT username FROM users u WHERE u.organization_id = o.id AND u.role = 'org_admin' ORDER BY u.created_at LIMIT 1) AS admin_username,
        (SELECT email    FROM users u WHERE u.organization_id = o.id AND u.role = 'org_admin' ORDER BY u.created_at LIMIT 1) AS admin_email
      FROM organizations o WHERE o.status = 'pending' ORDER BY o.created_at DESC
    `).all();
    res.json({ ok: true, pending });
  });

  // Owner: approve a pending organization → active (its admin can now add
  // members and its users can scan).
  app.post('/api/orgs/:orgId/approve', requireRole('owner'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    db.prepare("UPDATE organizations SET status = 'active' WHERE id = ?").run(orgId);
    audit.log({ req, user: req.user, action: 'org.approve', status: 'ok', targetType: 'organization', targetId: orgId });
    res.json({ ok: true });
  });

  // Owner: reject a pending organization request.
  app.post('/api/orgs/:orgId/reject', requireRole('owner'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    db.prepare("UPDATE organizations SET status = 'rejected' WHERE id = ?").run(orgId);
    audit.log({ req, user: req.user, action: 'org.reject', status: 'ok', targetType: 'organization', targetId: orgId });
    res.json({ ok: true });
  });

  // Owner: permanently remove an organization — its members, sites, invites,
  // and the org row — plus clean up references (rack ownership, audit rows).
  // Used to clear stray self-signup orgs from the owner dashboard.
  // Owner: rename an organization and/or change its status (active <-> inactive).
  app.patch('/api/orgs/:orgId', requireRole('owner'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const { name, status } = req.body || {};
    const sets = [], vals = [];
    if (typeof name === 'string' && name.trim()) { sets.push('name = ?'); vals.push(name.trim()); }
    if (typeof status === 'string') {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'status must be "active" or "inactive"' });
      }
      sets.push('status = ?'); vals.push(status);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(orgId);
    db.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    audit.log({ req, user: req.user, action: 'org.update', status: 'ok', targetType: 'organization', targetId: orgId, payload: { name: name || undefined, status: status || undefined } });
    const organization = db.prepare('SELECT id, slug, name, status FROM organizations WHERE id = ?').get(orgId);
    res.json({ ok: true, organization });
  });

  app.delete('/api/orgs/:orgId', requireRole('owner'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const run = db.transaction(() => {
      const tenantIds = db.prepare('SELECT id FROM tenants WHERE organization_id = ?').all(orgId).map(r => r.id);
      const userIds   = db.prepare('SELECT id FROM users WHERE organization_id = ?').all(orgId).map(r => r.id);
      const has = (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      for (const tid of tenantIds) {
        if (has('rack_owners')) db.prepare('DELETE FROM rack_owners WHERE tenant_id = ?').run(tid);
        if (has('rack_groups')) db.prepare('DELETE FROM rack_groups WHERE tenant_id = ?').run(tid);
        try { db.prepare('UPDATE audit_log SET tenant_id = NULL WHERE tenant_id = ?').run(tid); } catch (_) {}
      }
      for (const uid of userIds) {
        try { db.prepare('UPDATE rack_owners SET created_by = NULL WHERE created_by = ?').run(uid); } catch (_) {}
        try { db.prepare('UPDATE invites SET invited_by = NULL WHERE invited_by = ?').run(uid); } catch (_) {}
      }
      const invites = db.prepare('DELETE FROM invites WHERE organization_id = ?').run(orgId).changes;
      const members = db.prepare('DELETE FROM users WHERE organization_id = ?').run(orgId).changes;
      const sites   = db.prepare('DELETE FROM tenants WHERE organization_id = ?').run(orgId).changes;
      db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
      return { members, sites, invites };
    });
    const counts = run();
    audit.log({ req, user: req.user, action: 'org.remove', status: 'ok',
      targetType: 'organization', targetId: orgId,
      payload: { name: org.name, slug: org.slug, ...counts } });
    res.json({ ok: true, removed: { id: orgId, name: org.name, ...counts } });
  });

  // List Sites in an org.
  app.get('/api/orgs/:orgId/sites', requireRole('owner', 'org_admin'), (req, res) => {
    const orgId = Number(req.params.orgId);
    if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
    const sites = db.prepare(`
      SELECT t.id, t.slug, t.name, t.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS member_count
      FROM tenants t WHERE t.organization_id = ? ORDER BY t.created_at DESC
    `).all(orgId);
    res.json({ ok: true, sites });
  });

  // Create a Site in an org.
  app.post('/api/orgs/:orgId/sites', requireRole('owner', 'org_admin'), (req, res) => {
    const orgId = Number(req.params.orgId);
    if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Site name is required' });
    if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(orgId))
      return res.status(404).json({ error: 'Organization not found' });
    const site = createTenant(String(name).trim(), orgId);
    audit.log({ req, user: req.user, action: 'site.create', status: 'ok', targetType: 'site', targetId: site.id, payload: { orgId, name } });
    res.json({ ok: true, site });
  });

  // List members of an org (with their Site).
  app.get('/api/orgs/:orgId/members', requireRole('owner', 'org_admin'), (req, res) => {
    const orgId = Number(req.params.orgId);
    if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
    const members = db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.tenant_id, u.active, u.created_at, t.name AS site_name,
        (SELECT COUNT(*)         FROM rack_owners r WHERE r.created_by = u.id) AS scans,
        (SELECT MAX(created_at)  FROM rack_owners r WHERE r.created_by = u.id) AS last_scan
      FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.organization_id = ? ORDER BY u.created_at DESC
    `).all(orgId);
    res.json({ ok: true, members });
  });

  // Add a member to a Site. Owner / org-admin / site-manager (of that Site).
  app.post('/api/sites/:siteId/members', requireRole('owner', 'org_admin', 'site_manager'), (req, res) => {
    const siteId = Number(req.params.siteId);
    const site = db.prepare('SELECT * FROM tenants WHERE id = ?').get(siteId);
    if (!site || !site.organization_id) return res.status(404).json({ error: 'Site not found' });
    if (!canManageSite(req.user, siteId)) return res.status(403).json({ error: 'Not your site' });
    if (req.user.role !== 'owner' && !isOrgActive(site.organization_id))
      return res.status(403).json({ error: 'Your organization is awaiting owner approval.' });
    const { username, email, password, role } = req.body || {};
    // A site manager can only create plain members, not other managers.
    let memberRole = ['site_manager', 'member'].includes(role) ? role : 'member';
    if (req.user.role === 'site_manager') memberRole = 'member';
    if (!username || !email || !password) return res.status(400).json({ error: 'username, email and password are required' });
    if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Invalid email' });
    if (!USERNAME_RE.test(String(username))) return res.status(400).json({ error: 'Username must be 3–32 chars (letters, numbers, . _ -)' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const emailN = String(email).trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(emailN))
      return res.status(409).json({ error: 'That email is already registered' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username))
      return res.status(409).json({ error: 'That username is taken' });
    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    const r = db.prepare(`INSERT INTO users (email, username, password_hash, email_verified, role, organization_id, tenant_id)
                          VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(emailN, username, hash, memberRole, site.organization_id, siteId);
    audit.log({ req, user: req.user, action: 'member.create', status: 'ok', targetType: 'user', targetId: r.lastInsertRowid, payload: { siteId, role: memberRole } });
    res.json({ ok: true, member: { id: r.lastInsertRowid, username, email: emailN, role: memberRole, site: site.name } });
  });

  // Edit a member's personal info (username / email / role / site / password).
  // Partial update — only the fields present in the body are changed. Owner or
  // the org's admin only; org scoping means an admin can only touch users in
  // their own org, an owner account can never be edited here, and only the
  // owner may edit an org admin.
  app.patch('/api/orgs/:orgId/members/:memberId', requireRole('owner', 'org_admin', 'site_manager'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const memberId = Number(req.params.memberId);

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
    if (!member || member.organization_id !== orgId) return res.status(404).json({ error: 'Member not found' });
    if (member.role === 'owner') return res.status(403).json({ error: 'Cannot edit an owner account' });

    const isSiteMgr = req.user.role === 'site_manager';
    if (isSiteMgr) {
      // A site manager may only manage plain members within their own Site,
      // and only their status (active) or password — not identity/role/site.
      if (Number(member.tenant_id) !== Number(req.user.tenant_id) || member.role !== 'member')
        return res.status(403).json({ error: 'Not a member of your site' });
    } else {
      if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
      if (member.role === 'org_admin' && req.user.role !== 'owner')
        return res.status(403).json({ error: 'Only the owner can edit an organization admin' });
    }

    let { username, email, password, role, siteId, active } = req.body || {};
    if (isSiteMgr) { username = email = role = siteId = undefined; }
    const sets = [];
    const vals = [];

    if (username !== undefined) {
      const u = String(username).trim();
      if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Username must be 3–32 chars (letters, numbers, . _ -)' });
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(u, memberId))
        return res.status(409).json({ error: 'That username is taken' });
      sets.push('username = ?'); vals.push(u);
    }
    if (email !== undefined) {
      const e = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'Invalid email' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(e, memberId))
        return res.status(409).json({ error: 'That email is already registered' });
      sets.push('email = ?'); vals.push(e);
    }
    if (role !== undefined) {
      if (!['site_manager', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be member or site_manager' });
      sets.push('role = ?'); vals.push(role);
    }
    if (siteId !== undefined && siteId !== null && siteId !== '') {
      const site = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(siteId));
      if (!site || site.organization_id !== orgId) return res.status(400).json({ error: 'Invalid site' });
      sets.push('tenant_id = ?'); vals.push(site.id);
    }
    if (password !== undefined && password !== '') {
      const pwErr = validatePassword(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(password, BCRYPT_COST));
      // A member who joined through Google/Apple has password_set = 0; giving
      // them a real password has to clear that, or the profile page keeps
      // offering to "set a password" they already have.
      sets.push('password_set = ?'); vals.push(1);
    }
    if (active !== undefined) {
      sets.push('active = ?'); vals.push(active ? 1 : 0);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // An admin changing someone's password, or deactivating them, has to end
    // that person's existing sessions — otherwise both actions are advisory
    // until their 30-day token happens to expire. requireAuth now refuses a
    // deactivated user outright, but bumping here covers reactivation too: a
    // member switched off and back on gets a clean slate rather than having
    // their pre-deactivation tokens spring back to life.
    const mustInvalidate = (password !== undefined && password !== '') || active !== undefined;

    vals.push(memberId);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (mustInvalidate) bumpTokenVersion(memberId);
    audit.log({ req, user: req.user, action: 'member.update', status: 'ok', targetType: 'user', targetId: memberId, payload: { fields: sets.map(s => s.split(' ')[0]) } });

    const updated = db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.tenant_id, u.active, u.created_at, t.name AS site_name
      FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?
    `).get(memberId);
    res.json({ ok: true, member: updated });
  });

  // Owner / Org-admin / Site-manager: permanently remove a member. Their past
  // scans stay (created_by cleared to NULL) so the scan history isn't lost.
  app.delete('/api/orgs/:orgId/members/:memberId', requireRole('owner', 'org_admin', 'site_manager'), (req, res) => {
    const orgId = Number(req.params.orgId);
    const memberId = Number(req.params.memberId);
    if (memberId === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
    if (!member || member.organization_id !== orgId) return res.status(404).json({ error: 'Member not found' });
    if (member.role === 'owner') return res.status(403).json({ error: 'Cannot remove an owner account' });

    if (req.user.role === 'site_manager') {
      if (Number(member.tenant_id) !== Number(req.user.tenant_id) || member.role !== 'member')
        return res.status(403).json({ error: 'Not a member of your site' });
    } else {
      if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
      if (member.role === 'org_admin' && req.user.role !== 'owner')
        return res.status(403).json({ error: 'Only the owner can remove an organization admin' });
    }

    const tx = db.transaction(() => {
      db.prepare('UPDATE rack_owners SET created_by = NULL WHERE created_by = ?').run(memberId);
      db.prepare('UPDATE invites SET invited_by = NULL WHERE invited_by = ?').run(memberId);
      db.prepare('DELETE FROM users WHERE id = ?').run(memberId);
    });
    try { tx(); }
    catch (e) { logger.error('member.remove failed:', e.message); return res.status(500).json({ error: 'Failed to remove member' }); }
    audit.log({ req, user: req.user, action: 'member.remove', status: 'ok', targetType: 'user', targetId: memberId, payload: { username: member.username } });
    res.json({ ok: true, removed: memberId });
  });

  // ── Invite links ──────────────────────────────────────────────
  // Instead of an admin hand-setting a member's password, they can mint an
  // invite for a Site + role; the invitee opens the link and chooses their
  // own username + password. Owner / org-admin / site-manager (of the Site).
  app.post('/api/sites/:siteId/invites', requireRole('owner', 'org_admin', 'site_manager'), (req, res) => {
    const siteId = Number(req.params.siteId);
    const site = db.prepare('SELECT * FROM tenants WHERE id = ?').get(siteId);
    if (!site || !site.organization_id) return res.status(404).json({ error: 'Site not found' });
    if (!canManageSite(req.user, siteId)) return res.status(403).json({ error: 'Not your site' });
    if (req.user.role !== 'owner' && !isOrgActive(site.organization_id))
      return res.status(403).json({ error: 'Your organization is awaiting owner approval.' });
    const { email, role } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'A valid email is required' });
    let inviteRole = ['site_manager', 'member'].includes(role) ? role : 'member';
    if (req.user.role === 'site_manager') inviteRole = 'member';  // managers invite members only
    const emailN = String(email).trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(emailN))
      return res.status(409).json({ error: 'Someone with that email already has an account' });

    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    db.prepare(`INSERT INTO invites (code, email, role, organization_id, tenant_id, invited_by, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(code, emailN, inviteRole, site.organization_id, siteId, req.user.id, expiresAt);
    audit.log({ req, user: req.user, action: 'invite.create', status: 'ok', payload: { siteId, role: inviteRole, email: emailN } });
    res.json({ ok: true, invite: { code, email: emailN, role: inviteRole, site: site.name, path: `/invite/${code}`, expires_at: expiresAt } });
  });

  // Public: read an invite (for the accept page to show who/what).
  app.get('/api/invites/:code', (req, res) => {
    const inv = db.prepare(`
      SELECT i.*, o.name AS org_name, t.name AS site_name
      FROM invites i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.code = ?`).get(String(req.params.code));
    if (!inv) return res.status(404).json({ ok: false, error: 'Invite not found' });
    if (inv.accepted_at) return res.status(410).json({ ok: false, error: 'This invite has already been used' });
    if (inv.expires_at && Date.now() > inv.expires_at) return res.status(410).json({ ok: false, error: 'This invite has expired' });
    res.json({ ok: true, invite: { email: inv.email, role: inv.role, organization: inv.org_name, site: inv.site_name } });
  });

  // Public: accept an invite — invitee sets their own username + password.
  app.post('/api/invites/:code/accept', (req, res) => {
    const code = String(req.params.code);
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!inv) return res.status(404).json({ error: 'Invite not found' });
    if (inv.accepted_at) return res.status(410).json({ error: 'This invite has already been used' });
    if (inv.expires_at && Date.now() > inv.expires_at) return res.status(410).json({ error: 'This invite has expired' });

    const { username, password } = req.body || {};
    if (!username || !USERNAME_RE.test(String(username).trim()))
      return res.status(400).json({ error: 'Username must be 3–32 chars (letters, numbers, . _ -)' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const uname = String(username).trim();
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(uname))
      return res.status(409).json({ error: 'That username is taken' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(inv.email))
      return res.status(409).json({ error: 'An account already exists for this email' });

    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    const r = db.prepare(`INSERT INTO users (email, username, password_hash, email_verified, role, organization_id, tenant_id, active)
                          VALUES (?, ?, ?, 1, ?, ?, ?, 1)`)
      .run(inv.email, uname, hash, inv.role, inv.organization_id, inv.tenant_id);
    db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE code = ?").run(code);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    audit.log({ req, user, action: 'invite.accept', status: 'ok', targetType: 'user', targetId: user.id, payload: { code } });
    const { accessJwt, refreshPlain } = issueTokenPair(user, req);
    setAuthCookies(res, accessJwt, refreshPlain);
    res.json({ ok: true, user: publicUser(user),
      ...(wantsBodyToken(req) ? { token: nativeBodyToken(user) } : {}) });
  });

  // ── Dashboards ────────────────────────────────────────────────
  // Scans are recorded in rack_owners (one row per tenant+rack claim), so
  // scan counts roll up: site → org → platform. Users come from the users
  // table; "active" users are those who actually recorded a scan.

  // Owner: platform-wide dashboard.
  app.get('/api/dashboard/owner', requireRole('owner'), (req, res) => {
    const totals = {
      organizations: db.prepare('SELECT COUNT(*) c FROM organizations').get().c,
      sites:  db.prepare('SELECT COUNT(*) c FROM tenants WHERE organization_id IS NOT NULL').get().c,
      users:  db.prepare("SELECT COUNT(*) c FROM users WHERE role != 'owner'").get().c,
      scans:  db.prepare('SELECT COUNT(*) c FROM rack_owners').get().c,
    };
    const organizations = db.prepare(`
      SELECT o.id, o.name, o.slug, o.status,
        (SELECT COUNT(*) FROM tenants t WHERE t.organization_id = o.id) AS sites,
        (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id)   AS users,
        (SELECT COUNT(*) FROM rack_owners r
           WHERE r.tenant_id IN (SELECT id FROM tenants WHERE organization_id = o.id)) AS scans
      FROM organizations o ORDER BY scans DESC, o.created_at DESC
    `).all();
    const recentScans = db.prepare(`
      SELECT r.rack_id, r.created_at,
             COALESCE(t.name, '—') AS site,
             COALESCE(o.name, '—') AS org,
             COALESCE(u.username, '—') AS by_user
      FROM rack_owners r
      -- LEFT, not INNER. This join used to drop any scan whose tenant_id was
      -- null or pointed at a deleted site — and owners and admins have no
      -- tenant_id at all, so their own scans never appeared here. The totals
      -- above count rack_owners with no join, so the number was right while
      -- the list below it was short: the owner dashboard quietly failed the
      -- one thing it exists to do, show every scan on the platform.
      LEFT JOIN tenants t ON t.id = r.tenant_id
      LEFT JOIN organizations o ON o.id = t.organization_id
      LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.created_at DESC LIMIT 50
    `).all();
    res.json({ ok: true, totals, organizations, recentScans });
  });

  // Owner / Org-admin: one organization's dashboard.
  app.get('/api/orgs/:orgId/dashboard', requireRole('owner', 'org_admin'), (req, res) => {
    const orgId = Number(req.params.orgId);
    if (!canManageOrg(req.user, orgId)) return res.status(403).json({ error: 'Not your organization' });
    const siteIds = db.prepare('SELECT id FROM tenants WHERE organization_id = ?').all(orgId).map(r => r.id);
    const inList = siteIds.length ? siteIds.join(',') : '0'; // ids are ints → injection-safe
    const totals = {
      sites: siteIds.length,
      users: db.prepare('SELECT COUNT(*) c FROM users WHERE organization_id = ?').get(orgId).c,
      scans: db.prepare(`SELECT COUNT(*) c FROM rack_owners WHERE tenant_id IN (${inList})`).get().c,
      activeUsers: db.prepare(`SELECT COUNT(DISTINCT created_by) c FROM rack_owners WHERE tenant_id IN (${inList}) AND created_by IS NOT NULL`).get().c,
    };
    const sites = db.prepare(`
      SELECT t.id, t.name,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id)          AS users,
        (SELECT COUNT(*) FROM rack_owners r WHERE r.tenant_id = t.id)    AS scans,
        (SELECT MAX(created_at) FROM rack_owners r WHERE r.tenant_id = t.id) AS last_scan
      FROM tenants t WHERE t.organization_id = ? ORDER BY scans DESC, t.created_at DESC
    `).all(orgId);
    const recentScans = db.prepare(`
      SELECT r.rack_id, r.created_at, r.created_by AS by_user_id, t.name AS site, u.username AS by_user
      FROM rack_owners r JOIN tenants t ON t.id = r.tenant_id
      LEFT JOIN users u ON u.id = r.created_by
      WHERE r.tenant_id IN (${inList})
      ORDER BY r.created_at DESC LIMIT 40
    `).all().map(s => ({ ...s, image: scanImageUrl(s.rack_id), devices: scanDeviceCount(s.rack_id) }));
    res.json({ ok: true, totals, sites, recentScans });
  });
}

module.exports = {
  registerRoutes, requireAuth, requireRole, isOrgActive,
  // Exposed for socialAuth.js, which mints sessions for the same users through
  // a different front door and must produce byte-identical tokens and payloads.
  // Kept as an explicit named list rather than exporting the module internals
  // wholesale, so it stays obvious what the social path is allowed to touch.
  db, makeToken, publicUser, assignPublicId, USERNAME_RE,
  // Cookie-session helpers. socialAuth.js sets the same pair after an OAuth
  // round-trip on web, and app.js's softAuthPayload verifies with the same
  // rules requireAuth applies rather than a looser check of its own.
  verifyAccessToken, issueTokenPair, setAuthCookies, clearAuthCookies, wantsBodyToken,
};
