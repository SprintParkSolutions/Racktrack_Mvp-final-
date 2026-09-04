/**
 * Connectors: configure targets, test them, and export a scan to any of them.
 *
 * The Export screen's NetBox path still exists; this is the general road that
 * NetBox, ServiceNow, and a generic REST endpoint all travel. A connector is
 * configured once, then a scan is planned (dry run) or pushed to it.
 */
const express = require('express');
const store = require('../../lib/netbox/store');
const unmanaged = require('../../lib/netbox/unmanaged');
const connectorStore = require('../../lib/netbox/connectorStore');
const registry = require('../../lib/netbox/connectors');

const router = express.Router();

/** The snapshot a scan exports, with hand-declared unmanaged switches folded in. */
function snapshotOf(scanId) {
  const scan = store.getScan(scanId);
  if (!scan) return { error: 'No scan with that id.', status: 404 };
  const snap = (scan.payload && scan.payload.reconciled) || (scan.payload && scan.payload.snapshot);
  if (!snap) return { error: 'This scan has no detection result yet.', status: 409 };
  unmanaged.applyTo(snap, scan.rackId);
  return { snap };
}

// Literal path first, so it is never read as an :id.
router.get('/types', (req, res) => res.json({ types: registry.types() }));

router.get('/', (req, res) => res.json(connectorStore.list()));

router.post('/', (req, res) => {
  const r = connectorStore.add(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(201).json(r.record);
});

router.patch('/:id', (req, res) => {
  const r = connectorStore.update(req.params.id, req.body || {});
  if (r.error) return res.status(r.error.startsWith('No connector') ? 404 : 400).json({ error: r.error });
  res.json(r.record);
});

router.delete('/:id', (req, res) => {
  const r = connectorStore.remove(req.params.id);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const resolved = connectorStore.resolve(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'No connector with that id.' });
  const mod = registry.get(resolved.type);
  try {
    const result = await mod.test(resolved.config);
    connectorStore.recordTest(req.params.id, { ok: result.ok, message: result.message });
    res.json(result);
  } catch (err) {
    connectorStore.recordTest(req.params.id, { ok: false, message: String(err.message) });
    res.status(502).json({ ok: false, message: String(err.message) });
  }
});

router.post('/:id/export/:scanId', async (req, res) => {
  const resolved = connectorStore.resolve(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'No connector with that id.' });
  const got = snapshotOf(req.params.scanId);
  if (got.error) return res.status(got.status).json({ error: got.error });

  const mod = registry.get(resolved.type);
  try {
    const report = await mod.export(got.snap, resolved.config, { apply: Boolean(req.body?.apply) });
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

module.exports = router;
