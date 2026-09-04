/**
 * collect.js end to end over a real socket against a toy switch.
 *
 * snmp-loopback.test.js proves the protocol. This proves the layer above it:
 * that entPhysicalTable becomes a model and a serial, that ifTable becomes a
 * port list with the right speed, and that LLDP's three-part row index is
 * unpacked to the right local port. Those are the joins that go wrong
 * silently — a wrong index produces a plausible table rather than an error.
 *
 * The agent holds integer-typed values as integers, because decoding an
 * INTEGER as a string is exactly the bug that would make operStatus render
 * as blank instead of "up".
 */
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway data dir so the test cannot touch a real switches.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mibs-'));
process.env.RT_DATA_DIR = TMP;

const { _internal: b } = require('../../lib/netbox/snmp');
const { pollSwitch, testSwitch, modelFromDescr } = require('../../lib/netbox/collect');

// value, or [value, berTag] for anything that is not an OCTET STRING
const INT = 0x02;
const MIB = {
  '1.3.6.1.2.1.1.1.0': 'RackTrack toy switch, 4 port',
  '1.3.6.1.2.1.1.2.0': ['1.3.6.1.4.1.171.10.76.29', 0x06],
  '1.3.6.1.2.1.1.3.0': [8640000, 0x43],                    // TimeTicks: 1 day
  '1.3.6.1.2.1.1.4.0': 'noc@example.invalid',
  '1.3.6.1.2.1.1.5.0': 'sw-toy-01',
  '1.3.6.1.2.1.1.6.0': 'NT comms cabinet',

  // entPhysicalTable: a chassis (class 3) plus a fan, to prove the chassis
  // row is picked out rather than whichever row happens to come first.
  '1.3.6.1.2.1.47.1.1.1.1.5.1': [3, INT],
  '1.3.6.1.2.1.47.1.1.1.1.11.1': 'QB1A3C0001234',
  '1.3.6.1.2.1.47.1.1.1.1.12.1': 'D-Link',
  '1.3.6.1.2.1.47.1.1.1.1.13.1': 'DGS-1210-52',
  '1.3.6.1.2.1.47.1.1.1.1.5.2': [7, INT],
  '1.3.6.1.2.1.47.1.1.1.1.13.2': 'chassis fan 1',

  // ifTable / ifXTable
  '1.3.6.1.2.1.2.2.1.2.1': 'GigabitEthernet1/0/1',
  '1.3.6.1.2.1.2.2.1.2.2': 'GigabitEthernet1/0/2',
  '1.3.6.1.2.1.2.2.1.5.1': [1000000000, 0x42],
  '1.3.6.1.2.1.2.2.1.5.2': [4294967295, 0x42],   // saturated: 10G reads wrong here
  '1.3.6.1.2.1.2.2.1.3.1': [6, INT],             // ethernetCsmacd
  '1.3.6.1.2.1.2.2.1.3.2': [6, INT],
  '1.3.6.1.2.1.2.2.1.8.1': [1, INT],             // up
  '1.3.6.1.2.1.2.2.1.8.2': [2, INT],             // down
  '1.3.6.1.2.1.31.1.1.1.1.1': 'Gi1/0/1',
  '1.3.6.1.2.1.31.1.1.1.1.2': 'Gi1/0/2',
  '1.3.6.1.2.1.31.1.1.1.15.2': [10000, 0x42],    // ifHighSpeed: the true 10G
  '1.3.6.1.2.1.31.1.1.1.18.1': 'uplink to core',

  // LLDP: index is timeMark.localPortNum.remIndex -> local port 2
  '1.0.8802.1.1.2.1.3.7.1.3.2': 'Gi1/0/2',
  '1.0.8802.1.1.2.1.4.1.1.9.0.2.1': 'core-sw-01',
  '1.0.8802.1.1.2.1.4.1.1.7.0.2.1': 'Gi0/24',
  '1.0.8802.1.1.2.1.4.1.1.8.0.2.1': 'to NT cabinet',

  // Interface extras: MTU and duplex on port 1.
  '1.3.6.1.2.1.2.2.1.4.1': [1500, INT],
  '1.3.6.1.2.1.10.7.2.1.19.1': [3, INT],          // full duplex

  // VLANs.
  '1.3.6.1.2.1.17.7.1.4.3.1.1.1': 'default',
  '1.3.6.1.2.1.17.7.1.4.3.1.1.10': 'servers',
  // PVID: bridge port 1 -> ifIndex 1 (base-port map), PVID 10.
  '1.3.6.1.2.1.17.1.4.1.2.1': [1, INT],
  '1.3.6.1.2.1.17.7.1.4.5.1.1.1': [10, INT],

  // The switch's own IP on ifIndex 1.
  '1.3.6.1.2.1.4.20.1.2.192.168.1.2': [1, INT],
  '1.3.6.1.2.1.4.20.1.3.192.168.1.2': '255.255.255.0',
  // ARP: on ifIndex 1, 192.168.1.50 is at this MAC.
  '1.3.6.1.2.1.4.22.1.2.1.192.168.1.50': 'aa:bb:cc:00:11:22',
};
const KEYS = Object.keys(MIB).sort(cmpOid);

function cmpOid(a, c) {
  const x = a.split('.').map(Number);
  const y = c.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  }
  return 0;
}

function encodeVal(v) {
  if (Array.isArray(v)) {
    const [val, tag] = v;
    if (tag === 0x06) return b.encodeOid(val);
    if (tag === INT || tag === 0x42 || tag === 0x43) return b.encodeInt(tag, val);
  }
  return b.tlv(0x04, Buffer.from(String(v)));
}

function startAgent() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const outer = b.readTLV(msg, 0);
    let p = outer.start;
    p = b.readTLV(msg, p).next;
    p = b.readTLV(msg, p).next;
    const pdu = b.readTLV(msg, p);
    let q = pdu.start;
    const rid = b.readTLV(msg, q); q = rid.next;
    const nonRep = b.readTLV(msg, q); q = nonRep.next;
    const maxRep = b.readTLV(msg, q); q = maxRep.next;
    const list = b.readTLV(msg, q);
    const asked = [];
    let vp = list.start;
    while (vp < list.end) {
      const entry = b.readTLV(msg, vp);
      asked.push(b.decodeOid(b.readTLV(msg, entry.start).value));
      vp = entry.next;
    }

    let answers = [];
    if (pdu.tag === 0xa0) {
      answers = asked.map((oid) => [oid, MIB[oid]]);
    } else {
      const want = pdu.tag === 0xa5 ? b.decodeInt(maxRep.value) : 1;
      let i = KEYS.findIndex((k) => cmpOid(k, asked[0]) > 0);
      while (i >= 0 && i < KEYS.length && answers.length < want) {
        answers.push([KEYS[i], MIB[KEYS[i]]]);
        i += 1;
      }
    }

    const varbinds = answers.map(([oid, val]) => b.tlv(0x30, Buffer.concat([
      b.encodeOid(oid),
      val === undefined ? b.tlv(0x81, Buffer.alloc(0)) : encodeVal(val),
    ])));

    sock.send(b.tlv(0x30, Buffer.concat([
      b.encodeInt(0x02, 1),
      b.tlv(0x04, Buffer.from('public')),
      b.tlv(0xa2, Buffer.concat([
        b.encodeInt(0x02, b.decodeInt(rid.value)),
        b.encodeInt(0x02, 0),
        b.encodeInt(0x02, 0),
        b.tlv(0x30, Buffer.concat(varbinds)),
      ])),
    ])), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(sock)));
}

// The shape store.target() hands over: secrets already in the clear.
const swFor = (agent) => ({
  id: 1, host: '127.0.0.1', port: agent.address().port,
  version: '2c', community: 'public',
});

test('testSwitch reads the system group and names the vendor', async () => {
  const agent = await startAgent();
  try {
    const r = await testSwitch(swFor(agent));
    assert.equal(r.ok, true);
    assert.equal(r.sysName, 'sw-toy-01');
    // sysObjectID 1.3.6.1.4.1.171.* is D-Link's enterprise arc.
    assert.equal(r.vendor, 'D-Link');
  } finally { agent.close(); }
});

test('poll picks the chassis row for model and serial, not the fan', async () => {
  const agent = await startAgent();
  try {
    const d = await pollSwitch(swFor(agent));
    assert.equal(d.chassis.length, 1, 'the fan is class 7, not a chassis');
    assert.equal(d.chassis[0].model, 'DGS-1210-52');
    assert.equal(d.chassis[0].serial, 'QB1A3C0001234');
    assert.equal(d.chassis[0].manufacturer, 'D-Link');
    assert.equal(d.counts.serials, 1);
  } finally { agent.close(); }
});

test('the port list carries names, labels and state', async () => {
  const agent = await startAgent();
  try {
    const d = await pollSwitch(swFor(agent));
    const [one, two] = d.interfaces;

    assert.equal(one.index, 1);
    assert.equal(one.name, 'Gi1/0/1', 'ifName is preferred over ifDescr');
    assert.equal(one.alias, 'uplink to core');
    assert.equal(one.oper, 'up');
    assert.equal(two.oper, 'down');

    assert.equal(d.counts.physicalPorts, 2, 'both are ethernetCsmacd');
    assert.equal(d.counts.portsUp, 1);
  } finally { agent.close(); }
});

test('an LLDP row is attributed to the local port in the middle of its index', async () => {
  const agent = await startAgent();
  try {
    const d = await pollSwitch(swFor(agent));
    assert.equal(d.neighbours.length, 1);
    const n = d.neighbours[0];
    // index is 0.2.1 -> timeMark 0, local port 2, remote index 1. Taking the
    // first or last arc instead would silently attribute the cable elsewhere.
    assert.equal(n.localPortNum, '2');
    assert.equal(n.localPort, 'Gi1/0/2', 'named from lldpLocPortId, not assumed to be ifIndex');
    assert.equal(n.remoteSysName, 'core-sw-01');
    assert.equal(n.remotePort, 'to NT cabinet', 'portDescr is preferred over portId');
  } finally { agent.close(); }
});

test('a switch that does not answer names the host it gave up on', async () => {
  const dead = dgram.createSocket('udp4');
  await new Promise((r) => dead.bind(0, '127.0.0.1', r));
  const sw = {
    id: 2, host: '127.0.0.1', port: dead.address().port,
    version: '2c', community: 'public',
  };
  sw.timeout = 120;
  sw.retries = 0;
  try {
    await testSwitch(sw);
    assert.fail('should not have succeeded');
  } catch (err) {
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /127\.0\.0\.1/);
  } finally { dead.close(); }
});

test('a missing table is reported as a gap, not left as an empty list', async () => {
  const agent = await startAgent();
  try {
    const d = await pollSwitch(swFor(agent));
    // This toy agent does answer LLDP and ENTITY, so neither gap should fire.
    assert.deepEqual(d.gaps, [], 'nothing missing on an agent that answers everything');
    assert.equal(d.system.vendor, 'D-Link');
    assert.ok(d.polledAt, 'stamped when it was read');
  } finally { agent.close(); }
});

test('poll reads VLANs, IP addresses, ARP, and per-port MTU / duplex / PVID', async () => {
  const agent = await startAgent();
  try {
    const d = await pollSwitch(swFor(agent));

    assert.deepEqual(d.vlans, [{ id: 1, name: 'default' }, { id: 10, name: 'servers' }]);

    const one = d.interfaces.find((i) => i.index === 1);
    assert.equal(one.mtu, 1500);
    assert.equal(one.duplex, 'full');
    assert.equal(one.pvid, 10, 'PVID mapped through the bridge-port table to ifIndex 1');

    assert.equal(d.ipAddrs.length, 1);
    assert.deepEqual(d.ipAddrs[0], { ip: '192.168.1.2', ifIndex: 1, mask: '255.255.255.0' });

    assert.equal(d.arp.length, 1);
    assert.equal(d.arp[0].ip, '192.168.1.50');
    assert.equal(d.arp[0].ifIndex, 1);
    assert.equal(d.arp[0].mac, 'aa:bb:cc:00:11:22');

    assert.equal(d.counts.vlans, 2);
    assert.equal(d.counts.ipAddrs, 1);
    assert.equal(d.counts.arp, 1);
  } finally { agent.close(); }
});

test('the model is parsed from sysDescr when ENTITY-MIB gives none', () => {
  // Real-world description strings from switches that leave ENTITY-MIB empty.
  assert.equal(modelFromDescr('D-Link DGS-1210-52 Gigabit Ethernet Switch'), 'DGS-1210-52');
  assert.equal(modelFromDescr('TL-SG2428P 24-Port Gigabit Smart Switch'), 'TL-SG2428P');
  assert.equal(modelFromDescr('DES-1024D Fast Ethernet Switch'), 'DES-1024D');
  assert.match(modelFromDescr('Cisco IOS ... Catalyst 2960X-24 ...'), /Catalyst 2960X-24/i);
  // Nothing recognisable: say nothing rather than grab a wrong token.
  assert.equal(modelFromDescr('Linux 4.9 generic managed switch'), null);
  assert.equal(modelFromDescr(''), null);
  assert.equal(modelFromDescr(null), null);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
