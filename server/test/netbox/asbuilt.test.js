/**
 * The as-built importer, against the real SprintPark document.
 *
 * Two things matter here. First, that the document becomes exactly the set
 * of objects the spec counts, named by the label standard, every one carrying
 * MANUAL evidence and a page reference. Second, that pushing it twice through
 * the writer produces one set of records, using nothing but GET, POST and
 * PATCH. The fake NetBox client below is the whole "server": it hands out ids
 * and stores what it was sent, so a second push has to find its own work.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const model = require('../../lib/netbox/model');
const mapping = require('../../lib/netbox/mapping');
const writer = require('../../lib/netbox/writer');
const { UID_FIELD } = require('../../lib/netbox/netbox');
const { loadAsBuilt, toSnapshot, deviceName, cableLabel, portRef } = require('../../lib/netbox/asbuilt');

// The document itself is not in the repository.
//
// It is a hand transcription of a vendor's as-built PDF — 18 devices, 151
// interfaces, 110 cables — and it belongs to the customer, not to us. Without
// it these assertions have nothing to run against, and the honest thing is to
// say so and skip: inventing a rack with the right counts would turn a real
// test into a test of the fixture we wrote to satisfy it.
//
// Drop the transcription at server/test/asbuilt/office-sprint-rack-01.json and
// every test below runs as written.
const FILE = path.join(__dirname, '..', 'asbuilt', 'office-sprint-rack-01.json');
const HAVE_DOC = fs.existsSync(FILE);
if (!HAVE_DOC) {
  test('as-built import (skipped: office-sprint-rack-01.json is not in the repo)',
    { skip: 'the transcribed as-built document is not checked in' }, () => {});
}
const doc = HAVE_DOC ? loadAsBuilt(FILE) : null;
const { snapshot: snap, held } = HAVE_DOC ? toSnapshot(doc) : { snapshot: null, held: null };

// Every assertion below needs the document; with it absent they do not run.
const runnable = HAVE_DOC ? test : test.skip;

const byUid = (list) => new Map(list.map((o) => [o.uid, o]));
const total = () => model.EXPORT_ORDER.reduce((n, k) => n + snap[k].length, 0);

runnable('the document becomes the expected number of each object', () => {
  assert.equal(snap.rackUid, 'rack:RACK-01');
  assert.equal(snap.sites.length, 1);
  assert.equal(snap.racks.length, 1);
  assert.equal(snap.manufacturers.length, 7);
  assert.equal(snap.deviceTypes.length, 9);
  assert.equal(snap.deviceRoles.length, 6);
  assert.equal(snap.devices.length, 18);
  assert.equal(snap.interfaces.length, 151);
  assert.equal(snap.rearPorts.length, 166);
  assert.equal(snap.frontPorts.length, 166);
  assert.equal(snap.prefixes.length, 2);
  assert.equal(snap.cables.length, 110);
  assert.equal(snap.conflicts.length, 0);
  assert.equal(held.length, doc.held.length, 'held is passed through verbatim');
});

runnable('every object is manual evidence with a provenance naming the document', () => {
  for (const key of model.EXPORT_ORDER) {
    for (const o of snap[key]) {
      assert.equal(o.evidence, 'manual', `${o.uid}`);
      assert.equal(o.provenance.source, doc.source.file, `${o.uid}`);
      assert.equal(typeof o.provenance.ref, 'string', `${o.uid} names its page`);
    }
  }
});

runnable('devices are named by the label standard at the device list positions', () => {
  const byName = new Map(snap.devices.map((d) => [d.name, d]));
  const expected = {
    'RACK-01-U01-PP01': 1, 'RACK-01-U03-CM01': 3, 'RACK-01-U04-PP02': 4, 'RACK-01-U06-CM02': 6,
    'RACK-01-U07-PP03': 7, 'RACK-01-U09-CM03': 9, 'RACK-01-U10-PP04': 10, 'RACK-01-U12-CM04': 12,
    'RACK-01-U13-MSW01': 13, 'RACK-01-U14-CM05': 14, 'RACK-01-U15-SW01': 15, 'RACK-01-U16-CM06': 16,
    'RACK-01-U17-SW02': 17, 'RACK-01-U18-SW03': 18, 'RACK-01-U19-FW01': 19, 'RACK-01-U20-RT01': 20,
  };
  const unpositioned = ['RACK-01-U20-ONT01', 'OS-AP01'];
  assert.deepEqual([...byName.keys()].sort(), [...Object.keys(expected), ...unpositioned].sort());
  for (const [name, pos] of Object.entries(expected)) {
    assert.match(name, /^RACK-01-U\d{2}-[A-Z]+\d{2}$/);
    assert.equal(byName.get(name).position, pos, name);
    assert.equal(byName.get(name).rackUid, 'rack:RACK-01', name);
  }
  // The fibre module shares the router's shelf: in the rack, no position, U kept in the name.
  assert.equal(byName.get('RACK-01-U20-ONT01').position, null);
  assert.equal(byName.get('RACK-01-U20-ONT01').rackUid, 'rack:RACK-01');
  // The AP is on the site, not in the rack.
  assert.equal(byName.get('OS-AP01').rackUid, null);
  // The device list's own names are kept on record, in the description.
  assert.match(byName.get('RACK-01-U13-MSW01').description, /device list name: SW-MAIN-01/);
  assert.match(byName.get('RACK-01-U16-CM06').description, /device list name: Cable Manager5/);
  // A document may still name a device outright; that name wins.
  assert.equal(deviceName(doc, { key: 'X01', u: 7, name: 'AS-TYPED' }), 'AS-TYPED');
  assert.equal(deviceName(doc, { key: 'X01', u: 7 }), 'RACK-01-U07-X01');
  assert.equal(deviceName(doc, { key: 'X01', u: null }), 'OS-X01');
});

runnable('every cable end resolves to a port of the right kind', () => {
  const ifs = byUid(snap.interfaces);
  const fps = byUid(snap.frontPorts);
  for (const c of snap.cables) {
    for (const end of [c.a, c.b]) {
      if (end.objectType === 'dcim.interface') assert.ok(ifs.has(end.uid), `${c.uid}: ${end.uid}`);
      else if (end.objectType === 'dcim.frontport') assert.ok(fps.has(end.uid), `${c.uid}: ${end.uid}`);
      else assert.fail(`${c.uid}: unexpected objectType ${end.objectType}`);
    }
  }
  const fwToMain = snap.cables.filter((c) =>
    [c.a.uid, c.b.uid].some((u) => u.includes(':FW01:'))
    && [c.a.uid, c.b.uid].some((u) => u.includes(':MSW01:')));
  assert.equal(fwToMain.length, 1, 'one LAN-bridge cable, on the port the document lists first');
  assert.equal(fwToMain[0].a.uid, 'if:RACK-01:FW01:Port5');
  assert.equal(fwToMain[0].status, 'planned', 'asserted by the document, port not yet confirmed');
  assert.equal(mapping.BY_FIELD.cables.payload(fwToMain[0], () => 1).status, 'planned');
  assert.equal(mapping.BY_FIELD.cables.payload(snap.cables[0], () => 1).status, 'connected', 'manual evidence is otherwise connected');
  assert.ok(held.some((h) => h.id === 'fw-lan-bridge'));
  // Every firewall connection the document lists is now a cable.
  const fwPorts = snap.cables.flatMap((c) => [c.a.uid, c.b.uid]).filter((u) => u.startsWith('if:RACK-01:FW01:')).map((u) => u.split(':').pop()).sort();
  assert.deepEqual(fwPorts, ['Port3', 'Port4', 'Port5', 'Port8']);
});

runnable('cable labels follow U{uu}:{port} / U{uu}:{port}', () => {
  const find = (aKey, aPort) => snap.cables.find((c) => c.a.uid === `if:RACK-01:${aKey}:${aPort}`);
  assert.equal(find('MSW01', '7').label, 'U13:07 / U01:1A');
  assert.equal(find('MSW01', '1').label, 'U13:01 / U15:24');
  // Sophos names its ports Port3 and prints 3; the label reads what is printed.
  assert.equal(find('RT01', '1').label, 'U20:01 / U19:03');
  assert.equal(find('FW01', 'Port8').label, 'U19:08 / AP01:01', 'no U, so the key stands in');
  assert.equal(find('ONT01', '1').label, 'ONT01:01 / U19:04', 'shares U20 with RT01, so the key stands in');
  for (const c of snap.cables) assert.ok(c.label.length <= 100, c.label);
  assert.equal(portRef(doc, ['NOPE', 'ETH']), 'NOPE:ETH', 'no U, so the key stands in');
  assert.equal(cableLabel(doc, { a: ['SW01', '24'], b: ['MSW01', '1'] }), 'U15:24 / U13:01');
  assert.equal(snap.cables[0].type, '', 'category not stated, so not set');
});

runnable('front ports point at a rear port on the same device', () => {
  const rps = byUid(snap.rearPorts);
  for (const fp of snap.frontPorts) {
    const rp = rps.get(fp.rearPortUid);
    assert.ok(rp, `${fp.uid} -> ${fp.rearPortUid}`);
    assert.equal(rp.deviceUid, fp.deviceUid);
    assert.equal(rp.name, fp.name);
  }
  const count = (key) => snap.frontPorts.filter((fp) => fp.deviceUid === `dev:RACK-01:${key}`).length;
  assert.equal(count('PP01'), 48);
  assert.equal(count('PP04'), 22);
});

runnable('the rack and prefixes carry the new descriptive fields', () => {
  const [rack] = snap.racks;
  assert.equal(rack.uHeight, 24);
  assert.match(rack.description, /24U/);
  assert.match(rack.comments, /PDU/);
  assert.match(snap.prefixes[0].description, /LAN/);
});

runnable('every payload builds from the constructors without throwing', () => {
  const ref = () => 1;
  for (const spec of mapping.orderedSpecs()) {
    for (const o of snap[spec.field]) {
      const p = mapping.withUid(spec.payload(o, ref), o.uid, o.customFields || {});
      assert.equal(p.custom_fields[UID_FIELD], o.uid);
    }
  }
});

/**
 * An in-memory NetBox. Stores exactly the payload it was sent, which is what
 * makes the idempotency check honest: the writer's diff has to read its own
 * output back and find nothing to do.
 */
function fakeNetBox() {
  const store = new Map();   // endpoint -> [objects]
  const methods = [];
  let nextId = 1;
  let field = null;
  const rows = (ep) => { if (!store.has(ep)) store.set(ep, []); return store.get(ep); };
  return {
    url: 'http://fake.invalid',
    methods,
    async get(p, params) { methods.push('GET'); return { results: [] }; },
    async post(p, body) {
      methods.push('POST');
      const obj = { id: nextId, ...body };
      nextId += 1;
      rows(p).push(obj);
      return obj;
    },
    async patch(p, id, body) {
      methods.push('PATCH');
      const obj = rows(p).find((o) => o.id === id);
      Object.assign(obj, body);
      return obj;
    },
    async paginate(p, params) {
      methods.push('GET');
      return rows(p).filter((o) => params.rack_id === undefined || o.rack === params.rack_id);
    },
    async findByUid(ep, uid) {
      methods.push('GET');
      return rows(ep).find((o) => (o.custom_fields || {})[UID_FIELD] === uid) || null;
    },
    async customField() { methods.push('GET'); return field; },
    async ensureCustomField(types) {
      if (!field) { field = { id: 1, object_types: types }; return { action: 'created', field }; }
      return { action: 'present', field };
    },
  };
}

runnable('pushing twice creates once, then does nothing, and never deletes', async () => {
  const nb = fakeNetBox();
  const n = total();

  const first = await writer.push(snap, nb);
  assert.equal(first.counts.create, n, 'everything is new the first time');
  assert.equal(first.counts.fail || 0, 0, JSON.stringify(first.changes.filter((c) => c.action === 'fail')));
  assert.equal(first.counts.skip || 0, 0);

  const second = await writer.push(snap, nb);
  assert.equal(second.counts.noop, n, 'the second push finds its own records');
  assert.equal(second.counts.create || 0, 0);
  assert.equal(second.counts.update || 0, 0);
  assert.equal(second.counts.fail || 0, 0);
  assert.deepEqual(second.orphans, []);

  assert.deepEqual([...new Set(nb.methods)].sort(), ['GET', 'PATCH', 'POST'].filter((m) => nb.methods.includes(m)));
  assert.ok(!nb.methods.includes('DELETE'));
  assert.ok(!('delete' in nb));
});

runnable('a dangling cable end is refused before anything is built', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.cables.push({ a: ['MSW01', '99'], b: ['SW01', '23'], source: 'test', description: '' });
  assert.throws(() => toSnapshot(bad), /MSW01:99/);
});

runnable('two devices overlapping in U are refused', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  const pp02 = bad.devices.find((d) => d.key === 'PP02');
  pp02.position = 2;   // 2U at U2 spans U2-U3; PP01 sits at U1-U2.
  pp02.u = 2;
  assert.throws(() => toSnapshot(bad), /overlap at U2/);
});

runnable('a document without the schema marker or a required list is refused', () => {
  assert.throws(() => loadAsBuilt(path.join(__dirname, '..', 'package.json')), /\$schema/);
});

runnable('a 0U type with a rack position is refused before anything is built', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.deviceTypes.push({ key: 'ap', manufacturer: 'Generic', model: 'AP', uHeight: 0, source: 'test' });
  bad.devices.push({ key: 'AP99', name: 'AP99', u: 21, type: 'ap', role: 'Router', rack: true,
                     position: 21, source: 'test', description: '', interfaces: [] });
  assert.throws(() => toSnapshot(bad), /AP99 is a 0U type .*leave position null/);
});

runnable('a cable with the same port at both ends says so', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.cables.push({ a: ['MSW01', '5'], b: ['MSW01', '5'], source: 'test', description: '' });
  assert.throws(() => toSnapshot(bad), /same port at both ends \(MSW01:5\)/);
});

runnable('a cable whose label would exceed 100 chars is refused', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  const key = 'K'.repeat(60);
  const port = 'P'.repeat(50);
  bad.devices.push({
    key, u: null, type: 'generic-cable-manager', role: 'Cable Manager', rack: false, position: null,
    source: 'test', description: '', interfaces: [{ name: port }],
  });
  bad.cables.push({ a: ['MSW01', '5'], b: [key, port], source: 'test', description: '' });
  assert.throws(() => toSnapshot(bad), /label .* is 120 chars; NetBox allows 100/);
});

runnable('a cable status outside NetBox\'s vocabulary is refused', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.cables[0].status = 'maybe';
  assert.throws(() => toSnapshot(bad), /cable #1 status "maybe" is not one of NetBox's/);
});

runnable('a cable color that is not six hex digits is refused', () => {
  for (const color of ['#2196f3', 'blue']) {
    const bad = JSON.parse(JSON.stringify(doc));
    bad.cables[0].color = color;
    assert.throws(() => toSnapshot(bad), /cable #1 color .* six lower-case hex digits/, color);
  }
});

runnable('a half-U position is refused', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  bad.devices.find((d) => d.key === 'SW03').position = 20.5;
  assert.throws(() => toSnapshot(bad), /SW03 has position 20.5; expected a whole U number/);
});

runnable('a deviceType without a whole-number uHeight is refused', () => {
  const bad = JSON.parse(JSON.stringify(doc));
  delete bad.deviceTypes.find((t) => t.key === 'dgs-1210-52p').uHeight;
  assert.throws(() => toSnapshot(bad), /deviceType dgs-1210-52p has uHeight undefined/);
});

runnable('a rack without a whole-number height is refused, so NetBox never defaults it', () => {
  for (const bad_height of [undefined, '24', 24.5, 0]) {
    const bad = JSON.parse(JSON.stringify(doc));
    if (bad_height === undefined) delete bad.rack.uHeight; else bad.rack.uHeight = bad_height;
    assert.throws(() => toSnapshot(bad), /rack RACK-01 has uHeight/, String(bad_height));
  }
});

runnable('a cable is identified by its near end, so a corrected far end is an update', () => {
  const before = toSnapshot(doc).snapshot.cables.find((c) => c.label === 'U13:07 / U01:1A');
  const fixed = JSON.parse(JSON.stringify(doc));
  fixed.cables.find((c) => c.a[0] === 'MSW01' && c.a[1] === '7').b = ['PP01', '1B'];
  // 1B was cabled from SW01? No: 1B is free in the document, so the swap is legal.
  const after = toSnapshot(fixed).snapshot.cables.find((c) => c.uid === before.uid);
  assert.ok(after, 'same uid survives the corrected far end');
  assert.equal(after.label, 'U13:07 / U01:1B');
});

runnable('names and descriptions over NetBox limits are refused before anything is built', () => {
  let bad = JSON.parse(JSON.stringify(doc));
  bad.devices.find((d) => d.key === 'SW03').description = 'x'.repeat(201);
  assert.throws(() => toSnapshot(bad), /device SW03 description is 201 chars/);
  bad = JSON.parse(JSON.stringify(doc));
  bad.devices.find((d) => d.key === 'SW03').name = 'N'.repeat(65);
  assert.throws(() => toSnapshot(bad), /NetBox allows 64/);
});

/**
 * The real client over an in-memory server whose custom-field filter is
 * NetBox's default "loose" (substring) match. That is the behaviour a
 * hand-made racktrack_uid field has, and it makes cf_racktrack_uid=...:1
 * also return ...:10 to ...:19. The second push has to survive it.
 */
function looseNetBox(existingField = null) {
  const { NetBox } = require('../../lib/netbox/netbox');
  const store = new Map();   // path -> [objects]
  const methods = [];
  let nextId = 1;
  const rows = (p) => { if (!store.has(p)) store.set(p, []); return store.get(p); };
  if (existingField) rows('/api/extras/custom-fields/').push(existingField);
  const nb = new NetBox('http://fake.invalid', 'nbt_test');
  nb.methods = methods;
  nb.rows = rows;
  nb.request = async (method, path, body = null, params = null) => {
    methods.push(method);
    if (method === 'GET') {
      const list = rows(path).filter((o) => {
        const want = params && params[`cf_${UID_FIELD}`];
        if (want === undefined) return params?.name === undefined || o.name === params.name;
        return String((o.custom_fields || {})[UID_FIELD] || '').toLowerCase().includes(String(want).toLowerCase());
      });
      return { results: list, next: null };
    }
    if (method === 'POST') {
      const obj = { id: nextId, ...body };
      nextId += 1;
      rows(path).push(obj);
      return obj;
    }
    if (method === 'PATCH') {
      const m = path.match(/^(.*\/)(\d+)\/$/);
      const obj = rows(m[1]).find((o) => o.id === Number(m[2]));
      Object.assign(obj, body);
      return obj;
    }
    throw new Error(`unexpected ${method}`);
  };
  return nb;
}

runnable('a substring-matching uid filter still yields a clean second push', async () => {
  const nb = looseNetBox();
  const n = total();

  const first = await writer.push(snap, nb);
  assert.equal(first.counts.create, n);
  assert.equal(first.counts.fail || 0, 0);
  const [field] = nb.rows('/api/extras/custom-fields/');
  assert.equal(field.filter_logic, 'exact', 'the field is created with exact filtering');

  const second = await writer.push(snap, nb);
  assert.equal(second.counts.noop, n, JSON.stringify(second.changes.filter((c) => c.action !== 'noop').slice(0, 3)));
  assert.equal(second.counts.fail || 0, 0);
  assert.equal(second.counts.skip || 0, 0);
  assert.ok(!nb.methods.includes('DELETE'));
});

runnable('a front port carries its rear port the way NetBox 4.6 wants, and reads back as no change', () => {
  const fp = snap.frontPorts.find((f) => f.name === '1A' && f.deviceUid.endsWith(':PP01'));
  const payload = mapping.BY_FIELD.frontPorts.payload(fp, () => 42);
  assert.deepEqual(payload.rear_ports, [{ position: 1, rear_port: 42, rear_port_position: 1 }]);
  assert.equal(payload.rear_port, undefined, 'the pre-4.6 field is gone; 4.6 ignores it silently');
  // NetBox echoes the rear port nested as an object; that must not read as a diff.
  const echoed = { rear_ports: [{ position: 1, rear_port: { id: 42, name: '1A' }, rear_port_position: 1 }] };
  assert.deepEqual(writer.diff(payload, { ...echoed, device: { id: 42 }, name: "1A", type: { value: "8p8c" }, positions: 1 }).changed, {});
});

runnable('an existing loosely-filtered uid field is switched to exact', async () => {
  const nb = looseNetBox({
    id: 7, name: UID_FIELD, object_types: mapping.objectTypes(),
    filter_logic: { value: 'loose', label: 'Loose' },
  });
  const cf = await nb.ensureCustomField(mapping.objectTypes());
  assert.equal(cf.action, 'widened');
  assert.deepEqual(cf.added, []);
  assert.equal(cf.field.filter_logic, 'exact');
  assert.deepEqual(cf.field.object_types, mapping.objectTypes());
  assert.equal((await nb.ensureCustomField(mapping.objectTypes())).action, 'present');
});
