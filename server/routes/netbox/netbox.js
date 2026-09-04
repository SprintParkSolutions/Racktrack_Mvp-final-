/**
 * Preview and Export: the NetBox end of the chain.
 *
 * Preview reads NetBox and writes nothing. Export writes, and is safe to run
 * twice. Neither ever deletes.
 */
const archiver = require('archiver');
const express = require('express');

const cfg = require('../../lib/netbox/config');
const store = require('../../lib/netbox/store');
const unmanaged = require('../../lib/netbox/unmanaged');
const { NetBox } = require('../../lib/netbox/netbox');
const { plan, push } = require('../../lib/netbox/writer');
const { toCsv, toJson, toMarkdown } = require('../../lib/netbox/files');

const router = express.Router();

const client = () => new NetBox(cfg.NETBOX_URL, cfg.NETBOX_TOKEN);

function snapshotOf(req, res) {
  const scan = store.getScan(req.params.id);
  if (!scan) { res.status(404).json({ error: 'no such scan' }); return null; }
  // Prefer the reconciled snapshot once Review has produced one: it carries the
  // switch model/serial and the LLDP cabling merged onto the camera's layout.
  // Fall back to the raw camera snapshot when reconcile has not been run.
  const snap = (scan.payload && scan.payload.reconciled) || (scan.payload && scan.payload.snapshot);
  if (!snap) {
    res.status(409).json({ error: 'this scan has no detection result yet' });
    return null;
  }
  // Apply hand-declared unmanaged switches so their brand and model export too.
  unmanaged.applyTo(snap, scan.rackId);
  return { scan, snap, reconciled: Boolean(scan.payload.reconciled) };
}

/** Can we reach NetBox, and are we authenticated? */
router.get('/health', async (req, res) => {
  const out = { url: cfg.NETBOX_URL, tokenSet: Boolean(cfg.NETBOX_TOKEN) };
  try {
    const body = await client().status();
    res.json({ ...out, reachable: true, authenticated: true,
               netboxVersion: body['netbox-version'] });
  } catch (err) {
    // A 401/403 still proves NetBox is there — it is the token that is wrong.
    const authIssue = err.status === 401 || err.status === 403;
    res.json({
      ...out,
      reachable: err.status !== 0,
      authenticated: false,
      error: authIssue ? `HTTP ${err.status}. Set NETBOX_TOKEN.` : String(err.message),
    });
  }
});

router.post('/:id/preview', async (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  try {
    const report = await plan(got.snap, client(),
      { ensureField: req.query.ensureField === 'true' });
    store.recordStage(got.scan.id, 'preview', 'ok', countLine(report.counts));
    res.json(report);
  } catch (err) {
    store.recordStage(got.scan.id, 'preview', 'failed', String(err.message).slice(0, 400));
    res.status(502).json({ stage: 'preview', url: cfg.NETBOX_URL,
                           error: err.detail ?? String(err.message) });
  }
});

router.post('/:id/export', async (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  try {
    const report = await push(got.snap, client());
    const status = report.counts.fail ? 'failed' : 'ok';
    store.recordStage(got.scan.id, 'export', status, countLine(report.counts));
    res.json(report);
  } catch (err) {
    store.recordStage(got.scan.id, 'export', 'failed', String(err.message).slice(0, 400));
    res.status(502).json({ stage: 'export', url: cfg.NETBOX_URL,
                           error: err.detail ?? String(err.message) });
  }
});

/** The snapshot as a reviewable file — every value with its evidence. */
router.get('/:id/export.md', (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  const name = (got.scan.rackId || `scan-${got.scan.id}`).replace(/[^A-Za-z0-9_-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
  res.type('text/markdown').send(toMarkdown(got.snap));
});

/**
 * Push the JSON to any HTTP endpoint the operator names. This is the "webhook"
 * path: it lets the scan feed an automation, a CMDB, or a chat channel without
 * RackTrack needing a connector for each. Writes nothing to NetBox.
 */
router.post('/:id/webhook', async (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Enter a full http:// or https:// URL to post the scan to.' });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toJson(got.snap),
      signal: ctrl.signal,
    });
    res.json({ ok: r.ok, status: r.status, statusText: r.statusText });
  } catch (err) {
    res.status(502).json({ error: `Could not reach ${url}: ${err.message}` });
  } finally {
    clearTimeout(timer);
  }
});

router.get('/:id/export.json', (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  const name = got.snap.rackUid.replace(/:/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.json"`);
  res.type('application/json').send(toJson(got.snap));
});

/** NetBox bulk-import CSVs, zipped. The path that needs no API token. */
router.get('/:id/export.csv', (req, res) => {
  const got = snapshotOf(req, res);
  if (!got) return;
  const files = toCsv(got.snap);
  const name = got.snap.rackUid.replace(/:/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-netbox-csv.zip"`);
  res.type('application/zip');
  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('error', (err) => res.status(500).end(String(err.message)));
  zip.pipe(res);
  for (const [file, body] of Object.entries(files)) zip.append(body, { name: file });
  zip.append(
    'NetBox bulk-import CSVs, in dependency order:\n  '
    + Object.keys(files).join('\n  ')
    + '\n\nImport each under its own object type in NetBox (Import > CSV).\n'
    + 'Order matters: a device cannot be created before its device type exists.\n',
    { name: 'README.txt' });
  zip.finalize();
});

const countLine = (counts) =>
  Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(' · ');

module.exports = router;
