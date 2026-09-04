/**
 * Unmanaged switches: declare the boxes no protocol can read.
 *
 * Two ways in, both landing in the same store: add one by hand, or pick a
 * switch-shaped box the camera already found and name it. The candidates route
 * powers the second, listing the detected switches that are neither matched to
 * a managed switch nor already declared.
 */
const express = require('express');
const unmanaged = require('../../lib/netbox/unmanaged');
const store = require('../../lib/netbox/store');

const router = express.Router();

/** The switch boxes in a scan that are still waiting to be named. */
router.get('/candidates', (req, res) => {
  const scan = store.getScan(req.query.scanId);
  if (!scan) return res.status(404).json({ error: 'No scan with that id.' });

  const p = scan.payload || {};
  const base = p.reconciled || p.snapshot;
  if (!base) return res.json({ candidates: [] });

  const matched = new Set(Object.values(p.matches || {}).filter(Boolean));
  const declared = unmanaged.list(scan.rackId);
  const declaredUids = new Set(declared.map((d) => d.deviceUid).filter(Boolean));
  const declaredPos = new Set(declared.map((d) => d.uPosition).filter((u) => u != null));

  const typeOf = (uid) => (base.deviceTypes || []).find((t) => t.uid === uid);
  const mfrName = (uid) => (base.manufacturers || []).find((m) => m.uid === uid)?.name || '';

  // The camera's own pixel box for each device, keyed by rack unit, so the
  // picker can show a crop of the real photo instead of a bare text row.
  const boxByPos = new Map();
  for (const md of ((p.map || {}).devices || [])) {
    const u = md.units && md.units[0] ? Number(String(md.units[0]).replace(/\D/g, '')) : null;
    if (u != null && Array.isArray(md.box)) boxByPos.set(u, md.box);
  }

  const candidates = (base.devices || [])
    .filter((d) => (d.provenance?.cvClass || '') === 'Switch')
    .filter((d) => !matched.has(d.uid))
    .filter((d) => !declaredUids.has(d.uid) && !(d.position != null && declaredPos.has(d.position)))
    .map((d) => {
      const type = typeOf(d.deviceTypeUid);
      const model = type?.model || '';
      return {
        deviceUid: d.uid,
        uPosition: d.position,
        name: d.name,
        box: d.position != null ? (boxByPos.get(d.position) || null) : null,
        ports: (base.interfaces || []).filter((i) => i.deviceUid === d.uid).length,
        // A model the camera already guessed is offered as a default, unless it
        // is the placeholder "Unidentified ..." which is no help to prefill.
        suggestedModel: /^unidentified/i.test(model) ? '' : model,
        suggestedBrand: mfrName(type?.manufacturerUid).replace(/^unknown$/i, ''),
      };
    });

  res.json({ candidates });
});

router.get('/', (req, res) => res.json(unmanaged.list(req.query.rackId)));

router.post('/', (req, res) => {
  const r = unmanaged.add(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(201).json(r.record);
});

router.patch('/:id', (req, res) => {
  const r = unmanaged.update(req.params.id, req.body || {});
  if (r.error) return res.status(r.error.startsWith('No unmanaged') ? 404 : 400).json({ error: r.error });
  res.json(r.record);
});

router.delete('/:id', (req, res) => {
  const r = unmanaged.remove(req.params.id);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

module.exports = router;
