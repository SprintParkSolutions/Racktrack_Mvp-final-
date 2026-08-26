/**
 * Tenant ownership helpers.
 *
 * A "rack" in this app is identified by SHA-256(image_bytes), so two
 * tenants who scan the same physical rack get the same RK-id. The output
 * artifacts on disk under `outputs/RK-XXXX/` are shared (efficient — we
 * don't re-run the pipeline). The rack_owners table records which
 * tenants have claimed each rack, so the structured-data API enforces
 * "you can only see racks your tenant has scanned."
 *
 * Schema (created in auth.js migration):
 *   rack_owners(tenant_id INTEGER, rack_id TEXT,
 *               created_by INTEGER, created_at TEXT,
 *               PRIMARY KEY (tenant_id, rack_id))
 *
 * Public API:
 *   claimRack(tenantId, rackId, userId)  — idempotent INSERT OR IGNORE
 *   tenantOwnsRack(tenantId, rackId)     → bool
 *   tenantRackIds(tenantId)              → Set<string>
 *   listRacksForTenant(tenantId, limit)  → [{rack_id, created_at, created_by}]
 *   requireRackOwnership(req, res, next) — Express middleware on
 *                                          routes that take :rackId
 */

const path = require('path');
const Database = require('better-sqlite3');
const { logger } = require('./observability');

// Both this module and lib/port_history_db.js open the auth database at load
// time from a hardcoded path, which made the tenant queries untestable — the
// only way to exercise them was against the developer's real database, so the
// suite ran against whatever happened to be there (usually nothing, where
// every ownership answer is "no"). An env override keeps production behaviour
// identical and gives tests a seeded fixture to assert BOTH directions.
const dbPath = process.env.RACKTRACK_AUTH_DB
  || path.join(__dirname, '..', 'data', 'auth.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Prepared statements (better-sqlite3 caches by SQL text but explicit
// is faster + clearer). Created lazily so this module can be required
// before auth.js has finished its CREATE TABLE.
let _stmtClaim, _stmtOwns, _stmtList, _stmtRackIds, _stmtUserRackIds, _stmtClaimUser;
function _prep() {
  if (_stmtClaim) return;
  _stmtClaim = db.prepare(
    `INSERT OR IGNORE INTO rack_owners (tenant_id, rack_id, created_by)
     VALUES (?, ?, ?)`);
  _stmtOwns = db.prepare(
    `SELECT 1 FROM rack_owners WHERE tenant_id = ? AND rack_id = ?`);
  _stmtList = db.prepare(
    `SELECT rack_id, created_at, created_by FROM rack_owners
     WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`);
  _stmtRackIds = db.prepare(
    `SELECT rack_id FROM rack_owners WHERE tenant_id = ?`);
  // Per-USER claims.
  //
  // rack_owners answers "has this TENANT scanned this rack", and its primary
  // key is (tenant_id, rack_id) — one row per rack, whoever got there first.
  // created_by therefore records only the FIRST person in the tenant to scan
  // it, and claimRack's INSERT OR IGNORE silently discards everyone after.
  //
  // A rack id is SHA-256 of the image bytes, so two members photographing the
  // same rack land on the same id by design. The second member's scan then
  // vanished from their own history: /api/scans filters members by
  // created_by = them, and that row belongs to their colleague. Owners and
  // org_admins never saw it because neither is filtered that way — exactly
  // matching the report that only plain user accounts lose history, and only
  // sometimes.
  //
  // A separate table rather than widening the rack_owners key: that key is a
  // real constraint elsewhere ("one owner row per tenant+rack"), and changing
  // a primary key in SQLite means rebuilding a populated production table.
  // This is additive, and the union below keeps every historical row working.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rack_user_claims (
      tenant_id  INTEGER NOT NULL,
      rack_id    TEXT    NOT NULL,
      user_id    INTEGER NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, rack_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rack_user_claims_user
      ON rack_user_claims(tenant_id, user_id);
  `);
  // Backfill once, so history recorded before this table existed still shows.
  db.exec(`
    INSERT OR IGNORE INTO rack_user_claims (tenant_id, rack_id, user_id, created_at)
    SELECT tenant_id, rack_id, created_by, created_at
      FROM rack_owners WHERE created_by IS NOT NULL
  `);
  _stmtClaimUser = db.prepare(
    `INSERT OR IGNORE INTO rack_user_claims (tenant_id, rack_id, user_id)
     VALUES (?, ?, ?)`);
  // Union of the new per-user claims and the legacy created_by column, so a
  // member keeps everything they could see before plus what they were losing.
  _stmtUserRackIds = db.prepare(
    `SELECT rack_id FROM rack_user_claims WHERE tenant_id = ? AND user_id = ?
     UNION
     SELECT rack_id FROM rack_owners      WHERE tenant_id = ? AND created_by = ?`);
}

/** Record that this tenant has scanned this rack. Idempotent. */
function claimRack(tenantId, rackId, userId = null) {
  if (!tenantId || !rackId) return false;
  _prep();
  const r = _stmtClaim.run(Number(tenantId), String(rackId), userId);
  // Always record the per-user claim, even when the tenant-level row already
  // exists. This is the half that was missing: without it the second member to
  // scan a shared rack id had no claim of their own and lost it from history.
  if (userId) _stmtClaimUser.run(Number(tenantId), String(rackId), Number(userId));
  if (r.changes > 0) {
    logger.info({
      event: 'tenant.rack_claimed',
      tenantId, rackId, userId,
    }, `tenant ${tenantId} claimed rack ${rackId}`);
  }
  return r.changes > 0;
}

/** Is this rack owned by this tenant? */
function tenantOwnsRack(tenantId, rackId) {
  if (!tenantId || !rackId) return false;
  _prep();
  return !!_stmtOwns.get(Number(tenantId), String(rackId));
}

/** All rack ids this tenant owns, as a Set for fast membership checks. */
function tenantRackIds(tenantId) {
  if (!tenantId) return new Set();
  _prep();
  return new Set(_stmtRackIds.all(Number(tenantId)).map(r => r.rack_id));
}

/** Rack ids a specific user claimed within a tenant (rack_owners.created_by).
 *  This is the reliable "the member's own scans" signal — unlike the file-based
 *  scan_meta.userId, which only ever holds the ORIGINAL scanner of a shared
 *  RK-id, so a member's cache-hit scan of an already-scanned image was invisible
 *  to them on the Profile page. */
function tenantUserRackIds(tenantId, userId) {
  if (!tenantId || !userId) return new Set();
  _prep();
  return new Set(_stmtUserRackIds
    .all(Number(tenantId), Number(userId), Number(tenantId), Number(userId))
    .map(r => r.rack_id));
}

/** Recent racks for this tenant (for the rack list endpoint). */
function listRacksForTenant(tenantId, limit = 200) {
  if (!tenantId) return [];
  _prep();
  return _stmtList.all(Number(tenantId), Math.min(Math.max(1, limit), 1000));
}

// ── Organization / platform scope (owner + org-admin visibility) ──────
// Scans are claimed per-Site (tenant), but an org admin manages every Site in
// their org and the owner oversees the whole platform, so both need to see
// racks beyond a single tenant.
let _stmtRackInOrg, _stmtOrgRackIds, _stmtAllRackIds, _stmtOrgForRack;
function _prepOrg() {
  if (_stmtRackInOrg) return;
  _stmtRackInOrg = db.prepare(
    `SELECT 1 FROM rack_owners ro JOIN tenants t ON t.id = ro.tenant_id
      WHERE ro.rack_id = ? AND t.organization_id = ?`);
  _stmtOrgRackIds = db.prepare(
    `SELECT DISTINCT ro.rack_id FROM rack_owners ro
       JOIN tenants t ON t.id = ro.tenant_id
      WHERE t.organization_id = ?`);
  _stmtAllRackIds = db.prepare(`SELECT DISTINCT rack_id FROM rack_owners`);
  _stmtOrgForRack = db.prepare(
    `SELECT t.organization_id AS org FROM rack_owners ro
       JOIN tenants t ON t.id = ro.tenant_id
      WHERE ro.rack_id = ? LIMIT 1`);
}

/** Is this rack owned by any Site in this organization? */
function rackInOrg(rackId, orgId) {
  if (!rackId || !orgId) return false;
  _prepOrg();
  return !!_stmtRackInOrg.get(String(rackId), Number(orgId));
}

/**
 * Site ids visible to a principal, for scoping non-rack resources.
 *
 * Returns null for the platform owner, meaning "no restriction" — callers must
 * distinguish that from `[]`, which means "no Sites at all" and correctly
 * matches nothing. A principal with neither a role that grants breadth nor a
 * Site of their own gets `[]` rather than everything: this fails closed.
 */
function visibleTenantIds(principal) {
  if (!principal) return [];
  const role = principal.role;
  const tenantId = principal.tenantId ?? principal.tenant_id ?? null;
  const orgId = principal.organizationId ?? principal.organization_id ?? null;

  if (role === 'owner') return null;
  // site_manager is deliberately NOT here. It manages ONE Site — auth.js's
  // canAccessSite requires tenant_id === siteId, and rack_access falls it
  // through to its own tenant. Including it granted every Site in the
  // organisation, so the first time an org gained a second Site every site
  // manager in it would have picked up that Site's switch inventory, its
  // per-port state, and the ability to make the server SSH into it.
  if (role === 'org_admin' && orgId) {
    const rows = db.prepare(`SELECT id FROM tenants WHERE organization_id = ?`).all(Number(orgId));
    const ids = rows.map((r) => r.id);
    // An org admin also holds a Site of their own (often the "Default" one),
    // which is not in their org's list but is still theirs.
    if (tenantId && !ids.includes(tenantId)) ids.push(tenantId);
    return ids;
  }
  return tenantId ? [tenantId] : [];
}

/** All rack ids across every Site in this organization. */
function orgRackIds(orgId) {
  if (!orgId) return new Set();
  _prepOrg();
  return new Set(_stmtOrgRackIds.all(Number(orgId)).map(r => r.rack_id));
}

/** The organization id that owns this rack (via its Site), or null. */
function orgForRack(rackId) {
  if (!rackId) return null;
  _prepOrg();
  const row = _stmtOrgForRack.get(String(rackId));
  return row?.org ?? null;
}

/** Every claimed rack id on the platform (owner scope). */
function allRackIds() {
  _prepOrg();
  return new Set(_stmtAllRackIds.all().map(r => r.rack_id));
}

/**
 * Express middleware: gates routes that take a :rackId path param. Must
 * be installed AFTER requireAuth so req.user is available. 404 (not 403)
 * on miss so we don't leak whether the rack exists in another tenant.
 */
function requireRackOwnership(req, res, next) {
  const tenantId = req.user?.tenant_id;
  const rackId = req.params?.rackId;
  if (!tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!rackId) return res.status(400).json({ error: 'rackId required' });
  if (!tenantOwnsRack(tenantId, rackId)) {
    logger.warn({
      event: 'tenant.access_denied',
      tenantId, rackId, userId: req.user.id,
      route: req.path,
    }, `tenant ${tenantId} attempted to access rack ${rackId} (not owned)`);
    // 404 not 403 — don't reveal that the rack exists elsewhere
    return res.status(404).json({ error: 'Rack not found' });
  }
  next();
}

module.exports = {
  claimRack,
  tenantUserRackIds,
  tenantOwnsRack,
  tenantRackIds,
  listRacksForTenant,
  requireRackOwnership,
  rackInOrg,
  visibleTenantIds,
  orgRackIds,
  orgForRack,
  allRackIds,
};
