/**
 * The switch inventory, and the two things you can do with one: prove the
 * login works, and read the switch.
 *
 * Test and read are separate on purpose. A wrong password should come back in
 * a second from a single sysDescr read, not after a full walk of a 48 port
 * switch, and someone entering credentials for four switches wants to know
 * about the typo on the second one before starting the third.
 */
const express = require('express');
const { testSwitch } = require('../../lib/netbox/collect');
const { readSwitch, NO_CREDENTIALS } = require('../../lib/netbox/reader');
const { SnmpError } = require('../../lib/netbox/snmp');
const switches = require('../../lib/netbox/switches');

const router = express.Router();

/**
 * Every SNMP failure is somebody's job, and which one it is decides who gets
 * called. The status codes are chosen so the client can tell "the password is
 * wrong" from "that address is not answering" without reading prose.
 */
function fail(res, err) {
  if (!(err instanceof SnmpError)) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  const status = { auth: 401, config: 400, timeout: 504, network: 504, protocol: 502 }[err.kind] || 500;
  return res.status(status).json({ error: err.message, hint: err.hint || '', kind: err.kind });
}

// Literal paths first, so neither is ever read as an :id.
router.get('/options', (req, res) => res.json(switches.options()));

router.post('/collect-all', async (req, res) => {
  const macTable = Boolean(req.body?.macTable);
  const all = switches.list(req.body?.rackId);
  if (all.length === 0) {
    return res.status(428).json({ error: 'There are no switches to read yet. Add one first.' });
  }

  // One at a time. Fanning out across four switches saves a couple of seconds
  // and costs a burst of simultaneous MIB walks on a customer's network, which
  // is not the first impression this tool should make.
  const results = [];
  for (const sw of all) {
    const r = await readSwitch(sw.id, { macTable });
    results.push({ id: sw.id, label: sw.label, host: sw.host, ok: r.ok, error: r.error || null });
  }
  res.json({ ok: results.filter((r) => r.ok).length, total: results.length, results });
});

router.get('/', (req, res) => res.json(switches.list(req.query.rackId)));

router.post('/', (req, res) => {
  const r = switches.add(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(201).json(r.record);
});

router.patch('/:id', (req, res) => {
  const r = switches.update(req.params.id, req.body || {});
  if (r.error) return res.status(r.error.startsWith('No switch') ? 404 : 400).json({ error: r.error });
  res.json(r.record);
});

router.delete('/:id', (req, res) => {
  const r = switches.remove(req.params.id);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const credentials = switches.credentials(req.params.id);
  if (!credentials) return res.status(428).json(NO_CREDENTIALS);
  try {
    const result = await testSwitch(credentials);
    switches.recordTest(req.params.id, { ok: true, sysName: result.sysName });
    res.json(result);
  } catch (err) {
    switches.recordTest(req.params.id, { ok: false, reason: String(err.message) });
    fail(res, err);
  }
});

router.post('/:id/collect', async (req, res) => {
  if (!switches.find(req.params.id)) return res.status(404).json({ error: 'No switch with that id.' });
  const r = await readSwitch(req.params.id, { macTable: Boolean(req.body?.macTable) });
  if (!r.ok) {
    const status = { credentials: 428, auth: 401, timeout: 504, network: 504, protocol: 502 }[r.kind] || 502;
    return res.status(status).json({ error: r.error, hint: r.hint || '' });
  }
  res.json({ ok: true, data: r.data });
});

/** What the last read returned, without going back to the switch. */
router.get('/:id/data', (req, res) => {
  const data = switches.loadData(req.params.id);
  if (!data) return res.status(404).json({ error: 'This switch has not been read yet.' });
  res.json(data);
});

module.exports = router;
