#!/usr/bin/env node
/**
 * Adopt scan folders that nobody owns, using the identity already inside them.
 *
 * The counterpart to scripts/reconcile-racks.js. That script REPORTS the two
 * drift directions and heals only one of them ("owner row, no folder"). The
 * other direction — "folder, no owner" — it deliberately hands to
 * lib/orphan_gc.js, whose only remedy is deletion.
 *
 * Deletion is the wrong remedy when the folder is a real scan that simply never
 * got claimed. Every rack folder carries scan_meta.json with the userId and
 * tenantId of whoever ran it, so the ownership is not unknown — it was just
 * never written to auth.db. Claiming happens in /api/analyze as a separate,
 * non-atomic step from writing the folder, so any scan predating that step, or
 * taken while the tenant was unresolved, has a folder and no row.
 *
 * Two things go wrong for those racks, and both look like bugs to a tester:
 *   1. A member cannot see the scan. /api/scans filters members to racks they
 *      claimed, and there is no claim.
 *   2. The daily orphan GC counts the folder as dead weight. With
 *      ORPHAN_GC_APPLY=1 it deletes it, which is also why "the same image was
 *      accepted before and is refused now" — the cached result it used to match
 *      against is gone, so the upload falls through to the quality gates.
 *
 * What it writes, per unowned folder:
 *   rack_owners(tenant_id, rack_id, created_by)     — tenant-level ownership
 *   rack_user_claims(tenant_id, rack_id, user_id)   — per-user history
 *
 * Resolution rules, in order, and it never guesses past them:
 *   - tenantId from scan_meta.json; failing that, the tenant of its userId.
 *   - created_by only when that user still exists — otherwise NULL, which is
 *     allowed and still protects the folder and restores org-level visibility.
 *   - no resolvable tenant at all → SKIPPED and listed. Better an untouched
 *     folder than one filed under the wrong tenant, which would leak a scan
 *     into another customer's history.
 *
 * DRY RUN BY DEFAULT — opens the DB read-only and prints what it would do.
 * Pass --apply to write. Run it on the server, after reading the report.
 *
 *   Preview:  cd server && node scripts/adopt-orphan-racks.js
 *   Apply:    cd server && node scripts/adopt-orphan-racks.js --apply
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { RACK_ID_RE } = require('../lib/rack_access');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.RACKTRACK_AUTH_DB
  || path.join(__dirname, '..', 'data', 'auth.db');
const OUTPUTS_DIR = process.env.RACKTRACK_OUTPUTS
  || path.join(__dirname, '..', '..', 'outputs');

function main() {
  if (!fs.existsSync(DB_PATH))     { console.error(`No database at ${DB_PATH}`); process.exit(1); }
  if (!fs.existsSync(OUTPUTS_DIR)) { console.error(`No outputs at ${OUTPUTS_DIR}`); process.exit(1); }

  const db = new Database(DB_PATH, { readonly: !APPLY });

  // rack_user_claims may not exist yet on a server that has not restarted since
  // the per-user-claims change landed. Create it only when applying.
  if (APPLY) {
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
  }

  const owned = new Set(db.prepare('SELECT rack_id FROM rack_owners').all().map(r => r.rack_id));
  const tenantExists = (id) => !!db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id);
  const userRow = (id) => db.prepare('SELECT id, tenant_id FROM users WHERE id = ?').get(id);

  const folders = fs.readdirSync(OUTPUTS_DIR)
    .filter(n => RACK_ID_RE.test(n))
    .filter(n => { try { return fs.statSync(path.join(OUTPUTS_DIR, n)).isDirectory(); } catch { return false; } })
    .sort();

  const adopt = [], skip = [];
  for (const rackId of folders) {
    if (owned.has(rackId)) continue;

    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(OUTPUTS_DIR, rackId, 'scan_meta.json'), 'utf8')); }
    catch { /* no meta, or unreadable */ }

    const metaUser = Number(meta?.userId) || null;
    const u = metaUser ? userRow(metaUser) : null;

    // Tenant from the scan itself, else the scanner's tenant.
    let tenantId = Number(meta?.tenantId) || null;
    if (!tenantId && u) tenantId = Number(u.tenant_id) || null;

    if (!tenantId || !tenantExists(tenantId)) {
      skip.push({ rackId, why: !meta ? 'no scan_meta.json'
        : !tenantId ? 'no tenantId, and its userId has no tenant'
        : `tenant ${tenantId} no longer exists` });
      continue;
    }
    adopt.push({ rackId, tenantId, userId: u ? u.id : null,
      note: u ? null : (metaUser ? `user ${metaUser} is gone — claiming for the tenant only` : 'no userId recorded') });
  }

  console.log(`\nScan folders:      ${folders.length}`);
  console.log(`Already owned:     ${folders.length - adopt.length - skip.length}`);
  console.log(`Would adopt:       ${adopt.length}`);
  console.log(`Cannot resolve:    ${skip.length}\n`);

  if (adopt.length) {
    console.log('ADOPT');
    for (const a of adopt) {
      console.log(`  ${a.rackId}  tenant=${a.tenantId}  user=${a.userId ?? '(none)'}${a.note ? `   ${a.note}` : ''}`);
    }
    console.log('');
  }
  if (skip.length) {
    console.log('SKIPPED — left untouched rather than filed under a guess');
    for (const s of skip) console.log(`  ${s.rackId}  ${s.why}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('Dry run. Nothing written. Re-run with --apply to record these claims.\n');
    return;
  }

  const insOwner = db.prepare(
    `INSERT OR IGNORE INTO rack_owners (tenant_id, rack_id, created_by) VALUES (?, ?, ?)`);
  const insClaim = db.prepare(
    `INSERT OR IGNORE INTO rack_user_claims (tenant_id, rack_id, user_id) VALUES (?, ?, ?)`);

  let owners = 0, claims = 0;
  db.transaction(() => {
    for (const a of adopt) {
      owners += insOwner.run(a.tenantId, a.rackId, a.userId).changes;
      if (a.userId) claims += insClaim.run(a.tenantId, a.rackId, a.userId).changes;
    }
  })();

  console.log(`Applied: ${owners} ownership row(s), ${claims} per-user claim(s).`);
  console.log('Those folders are now visible to their tenant and are no longer orphan-GC candidates.\n');
}

main();
