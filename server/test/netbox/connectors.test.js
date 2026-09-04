/**
 * The connector framework: the registry, the config store's sealing, and the
 * two connectors we can exercise without a live third-party system — the
 * generic REST connector against a local server, and ServiceNow's row shaping.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate storage before anything that reads DATA_DIR at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-conn-'));
process.env.RT_DATA_DIR = TMP;

const registry = require('../../lib/netbox/connectors');
const connectorStore = require('../../lib/netbox/connectorStore');
const rest = require('../../lib/netbox/connectors/rest');
const servicenow = require('../../lib/netbox/connectors/servicenow');
const model = require('../../lib/netbox/model');

function sampleSnapshot() {
  const snap = model.emptySnapshot('rack:test', '2026-01-01T00:00:00Z');
  snap.manufacturers.push(model.Manufacturer(model.observed('mfr:d-link', model.Evidence.SNMP), { name: 'D-Link', slug: 'd-link' }));
  snap.deviceTypes.push(model.DeviceType(model.observed('dtype:dgs-1210-52', model.Evidence.SNMP),
    { manufacturerUid: 'mfr:d-link', model: 'DGS-1210-52', slug: 'dgs-1210-52', uHeight: 1 }));
  snap.devices.push(model.Device(model.observed('dev:1', model.Evidence.SNMP),
    { name: 'core-sw', deviceTypeUid: 'dtype:dgs-1210-52', serial: 'ABC123',
      customFields: { managementIp: '192.168.1.100' } }));
  return snap;
}

test('the registry exposes the three connector types with their field lists', () => {
  const types = registry.types();
  const byType = Object.fromEntries(types.map((t) => [t.type, t]));
  assert.ok(byType.netbox && byType.rest && byType.servicenow, 'all three present');
  assert.ok(Array.isArray(byType.rest.fields) && byType.rest.fields.some((f) => f.key === 'url'));
});

test('the store seals secrets: a token goes in but never comes back to the client', () => {
  const added = connectorStore.add({ type: 'rest', name: 'CMDB', url: 'https://cmdb.example/import', auth: 'bearer', token: 'super-secret' });
  assert.ok(!added.error, added.error);
  const pub = connectorStore.list().find((c) => c.id === added.record.id);
  assert.equal(pub.config.token, undefined, 'the token is not in the public config');
  assert.equal(pub.has.token, true, 'the client is told a token is held');
  // Opened only for the connector, never for the client.
  const resolved = connectorStore.resolve(added.record.id);
  assert.equal(resolved.config.token, 'super-secret');
});

test('an invalid connector config is refused before it reaches disk', () => {
  const r = connectorStore.add({ type: 'rest', name: 'bad', url: 'not-a-url' });
  assert.ok(r.error, 'a non-URL endpoint is rejected');
});

test('the generic REST connector posts the whole snapshot in bulk mode', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received = JSON.parse(body); res.writeHead(200); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/import`;
  try {
    const report = await rest.export(sampleSnapshot(), { url, auth: 'none', mode: 'bulk' }, { apply: true });
    assert.equal(report.ok, true, JSON.stringify(report.warnings));
    assert.ok(received, 'the endpoint received a body');
    const devices = (received.objects && received.objects.devices) || received.devices;
    assert.equal(devices[0].name, 'core-sw', 'the snapshot arrived intact');
    assert.equal(report.counts.create > 0, true);
  } finally {
    server.close();
  }
});

test('a REST dry run sends nothing and still reports what it would send', async () => {
  const report = await rest.export(sampleSnapshot(), { url: 'http://127.0.0.1:1/never', mode: 'bulk' }, { apply: false });
  assert.equal(report.dryRun, true);
  assert.ok(report.changes.some((c) => c.name === 'core-sw'));
});

test('ServiceNow shapes a device into a CI row with a correlation id', () => {
  const rows = servicenow._rowsFrom(sampleSnapshot());
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.correlation_id, 'dev:1', 'keyed for idempotent re-scan');
  assert.equal(r.name, 'core-sw');
  assert.equal(r.serial_number, 'ABC123');
  assert.equal(r.model_id, 'DGS-1210-52');
  assert.equal(r.manufacturer, 'D-Link');
  assert.equal(r.ip_address, '192.168.1.100');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
