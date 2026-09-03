/**
 * Tenant isolation, against the REAL queries and a seeded database.
 *
 * Why this file exists: the existing rack_access tests pass a hand-written
 * stub for the tenant store, so they only ever prove the branching is right.
 * Mutation testing showed what that misses — `tenant.rackInOrg` could be
 * replaced with `return true` (every org admin reads every other org's racks)
 * and `tenantOwnsRack` with `return false` (every member locked out), and the
 * whole suite stayed green. `port_history_db.inScope` had no coverage at all.
 *
 * These tests seed a throwaway database, point the real modules at it, and
 * assert BOTH directions — that the right people get in, and the wrong people
 * do not. Asserting only the deny direction is how the earlier suite passed
 * with an empty database where every answer was "no".
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Point the modules at a scratch DB before they are required — both read the
// path at module load.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tenant-'));
const DB_PATH = path.join(DB_DIR, 'auth.db');
process.env.RACKTRACK_AUTH_DB = DB_PATH;

// Two organisations, three Sites, one rack and one switch each.
const ORG_A = 10, ORG_B = 20;
const SITE_A1 = 11, SITE_A2 = 12, SITE_B1 = 21;
const RACK_A1 = 'RK-AAAA1111', RACK_A2 = 'RK-AAAA2222', RACK_B1 = 'RK-BBBB1111';

before(() => {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT, organization_id INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT,
                        tenant_id INTEGER, organization_id INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE rack_owners (id INTEGER PRIMARY KEY AUTOINCREMENT, rack_id TEXT,
                              tenant_id INTEGER, created_by INTEGER,
                              created_at TEXT DEFAULT (datetime('now')));
  `);
  db.prepare('INSERT INTO organizations (id,name) VALUES (?,?)').run(ORG_A, 'Org A');
  db.prepare('INSERT INTO organizations (id,name) VALUES (?,?)').run(ORG_B, 'Org B');
  const t = db.prepare('INSERT INTO tenants (id,name,organization_id) VALUES (?,?,?)');
  t.run(SITE_A1, 'A Site One', ORG_A);
  t.run(SITE_A2, 'A Site Two', ORG_A);
  t.run(SITE_B1, 'B Site One', ORG_B);
  const r = db.prepare('INSERT INTO rack_owners (rack_id,tenant_id,created_by) VALUES (?,?,?)');
  r.run(RACK_A1, SITE_A1, 1);
  r.run(RACK_A2, SITE_A2, 2);
  r.run(RACK_B1, SITE_B1, 3);
  db.close();
});

after(() => { try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const tenant = require('../lib/tenant');
const { canAccessRack } = require('../lib/rack_access');

const OWNER   = { role: 'owner', tenantId: SITE_A1 };
const ADMIN_A = { role: 'org_admin', organizationId: ORG_A, tenantId: SITE_A1 };
const ADMIN_B = { role: 'org_admin', organizationId: ORG_B, tenantId: SITE_B1 };
const MEMBER_A1 = { role: 'member', tenantId: SITE_A1 };
const MEMBER_B1 = { role: 'member', tenantId: SITE_B1 };

test('the real tenantOwnsRack answers YES for a rack the Site owns', () => {
  // The direction the old suite never asserted. With an empty database this
  // fails, which is exactly why `tenantOwnsRack -> return false` survived.
  assert.equal(tenant.tenantOwnsRack(SITE_A1, RACK_A1), true);
  assert.equal(tenant.tenantOwnsRack(SITE_B1, RACK_B1), true);
});

test('the real tenantOwnsRack answers NO across Sites', () => {
  assert.equal(tenant.tenantOwnsRack(SITE_A1, RACK_B1), false);
  assert.equal(tenant.tenantOwnsRack(SITE_B1, RACK_A1), false);
});

test('the real rackInOrg answers YES within an org and NO across orgs', () => {
  // Kills the `rackInOrg -> return true` mutation, which was a cross-org read.
  assert.equal(tenant.rackInOrg(RACK_A1, ORG_A), true);
  assert.equal(tenant.rackInOrg(RACK_A2, ORG_A), true, 'a sibling Site in the same org counts');
  assert.equal(tenant.rackInOrg(RACK_B1, ORG_A), false, 'another org must not match');
  assert.equal(tenant.rackInOrg(RACK_A1, ORG_B), false);
});

test('end to end: an org admin reaches their own org and no further', () => {
  assert.equal(canAccessRack(ADMIN_A, RACK_A1, tenant), true);
  assert.equal(canAccessRack(ADMIN_A, RACK_A2, tenant), true);
  assert.equal(canAccessRack(ADMIN_A, RACK_B1, tenant), false);
  assert.equal(canAccessRack(ADMIN_B, RACK_A1, tenant), false);
});

test('an org_admin stranded outside their org still reaches their own Site', () => {
  // The live case this was written for: a user is created as org_admin of a new
  // organization, but that organization never gets a Site of its own, so the
  // account stays on the legacy default tenant. rackInOrg then matches nothing,
  // and the org_admin branch used to return early — leaving the person who took
  // the scan unable to open it, while a plain member of the same Site could.
  const STRANDED = { role: 'org_admin', organizationId: 999, tenantId: SITE_A1 };
  assert.equal(canAccessRack(STRANDED, RACK_A1, tenant), true,
    'their own Site owns this rack, so they must reach it');
  assert.equal(canAccessRack(STRANDED, RACK_B1, tenant), false,
    'and it must not become a way into another Site');
});

test('end to end: a member reaches only their own Site', () => {
  assert.equal(canAccessRack(MEMBER_A1, RACK_A1, tenant), true);
  assert.equal(canAccessRack(MEMBER_A1, RACK_A2, tenant), false, 'a sibling Site is not theirs');
  assert.equal(canAccessRack(MEMBER_A1, RACK_B1, tenant), false);
  assert.equal(canAccessRack(MEMBER_B1, RACK_B1, tenant), true);
});

test('end to end: the owner reaches every rack', () => {
  for (const rack of [RACK_A1, RACK_A2, RACK_B1]) {
    assert.equal(canAccessRack(OWNER, rack, tenant), true);
  }
});

test('visibleTenantIds: a site_manager gets ONE Site, not the whole org', () => {
  // This granted every Site in the organisation, contradicting every other
  // definition of the role in the codebase. One "add a Site" click away from a
  // cross-Site switch-inventory leak.
  const sm = { role: 'site_manager', organization_id: ORG_A, tenant_id: SITE_A1 };
  assert.deepEqual(tenant.visibleTenantIds(sm), [SITE_A1]);
});

test('visibleTenantIds: owner unrestricted, org admin gets their org, stranger gets nothing', () => {
  assert.equal(tenant.visibleTenantIds(OWNER), null, 'null means no restriction');

  const admin = tenant.visibleTenantIds(ADMIN_A).slice().sort((a, b) => a - b);
  assert.deepEqual(admin, [SITE_A1, SITE_A2]);
  assert.ok(!admin.includes(SITE_B1), 'must not reach the other org');

  assert.deepEqual(tenant.visibleTenantIds({ role: 'member', tenant_id: null }), [],
    'a principal with no Site inherits nothing');
  assert.deepEqual(tenant.visibleTenantIds(null), []);
});

test('a Site-less principal is denied even if the store would say yes', () => {
  // Pins the fail-closed guard itself rather than the store's behaviour. With
  // the real store the guard is redundant (tenantOwnsRack rejects a null id of
  // its own accord), so deleting it changed nothing and the mutation survived.
  // A store that answers "yes" to everything isolates the guard: if it is ever
  // removed, this is the test that notices.
  const permissive = { tenantOwnsRack: () => true, rackInOrg: () => true };

  assert.equal(canAccessRack({ role: 'member', tenantId: null }, RACK_A1, permissive), false);
  assert.equal(canAccessRack({ role: 'member', tenant_id: null }, RACK_A1, permissive), false);
  assert.equal(canAccessRack({ role: 'member' }, RACK_A1, permissive), false);
  assert.equal(canAccessRack({ role: 'member', tenantId: 0 }, RACK_A1, permissive), false);
  // And an org admin with no organisation, for the same reason.
  assert.equal(canAccessRack({ role: 'org_admin', organizationId: null }, RACK_A1, permissive), false);
  // Sanity: the permissive store really would have said yes.
  assert.equal(canAccessRack({ role: 'member', tenantId: SITE_A1 }, RACK_A1, permissive), true);
});

// ── switch inventory scoping ─────────────────────────────────────────
// port_history_db.inScope had no coverage at all: replacing it with
// `return true` re-opened the cross-customer switch-inventory leak and the
// whole suite stayed green.
test('switch inventory is scoped to the caller Sites', () => {
  const portsDb = require('../lib/port_history_db');

  const a1 = portsDb.addDevice({ host: '10.0.0.1', label: 'a1', tenant_id: SITE_A1 });
  const b1 = portsDb.addDevice({ host: '10.0.0.2', label: 'b1', tenant_id: SITE_B1 });
  const orphan = portsDb.addDevice({ host: '10.0.0.3', label: 'orphan' }); // tenant_id NULL

  const idsFor = (scope) => portsDb.listDevices({ scope }).map((d) => d.host).sort();

  // Owner: no restriction, sees everything including the unattributed row.
  assert.deepEqual(idsFor(null), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);

  // A member of Site A1 sees their own switch and nothing else — in
  // particular not the other customer's, and not the unattributed one.
  assert.deepEqual(idsFor([SITE_A1]), ['10.0.0.1']);
  assert.deepEqual(idsFor([SITE_B1]), ['10.0.0.2']);

  // An org admin sees every Site in their org.
  assert.deepEqual(idsFor([SITE_A1, SITE_A2]), ['10.0.0.1']);

  // A stranger and a Site-less principal see nothing.
  assert.deepEqual(idsFor([9999]), []);
  assert.deepEqual(idsFor([]), []);

  // getDevice must apply the same rule, or the list is a fig leaf.
  assert.ok(portsDb.getDevice(a1.id, [SITE_A1]), 'own device must resolve');
  assert.equal(portsDb.getDevice(b1.id, [SITE_A1]), undefined, 'cross-Site device must not');
  assert.equal(portsDb.getDevice(orphan.id, [SITE_A1]), undefined, 'unattributed is owner-only');
  assert.ok(portsDb.getDevice(orphan.id, null), 'owner still sees the unattributed row');
});

test('tenant ids compare by value, not by type', () => {
  // A string id from a JSON body must not silently mean "no access" on one
  // guard while meaning "access" on another — the two-guards-disagree defect.
  assert.equal(canAccessRack({ role: 'member', tenantId: String(SITE_A1) }, RACK_A1, tenant), true);
});
