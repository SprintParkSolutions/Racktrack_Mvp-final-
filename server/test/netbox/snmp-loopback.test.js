/**
 * End to end over a real UDP socket, against a toy agent that speaks just
 * enough v2c to answer.
 *
 * This is the part unit tests cannot reach: request framing, the socket, the
 * request-id match, and the GETBULK walk's stop condition. The toy agent
 * decodes what it is sent rather than replaying a canned buffer, so a change
 * that breaks the encoder fails here instead of silently passing.
 */
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { Session, _internal: b } = require('../../lib/netbox/snmp');

const MIB = {
  '1.3.6.1.2.1.1.1.0': 'RackTrack test agent, 24 port',
  '1.3.6.1.2.1.1.5.0': 'sw-test-01',
  '1.3.6.1.2.1.2.2.1.2.1': 'GigabitEthernet1/0/1',
  '1.3.6.1.2.1.2.2.1.2.2': 'GigabitEthernet1/0/2',
  '1.3.6.1.2.1.2.2.1.2.3': 'GigabitEthernet1/0/3',
  '1.3.6.1.3.99.0': 'past the end of the subtree',
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

function startAgent() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const outer = b.readTLV(msg, 0);
    let p = outer.start;
    p = b.readTLV(msg, p).next;                       // version
    p = b.readTLV(msg, p).next;                       // community
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
      // GETNEXT and GETBULK both walk forward from the requested OID.
      const want = pdu.tag === 0xa5 ? b.decodeInt(maxRep.value) : 1;
      let i = KEYS.findIndex((k) => cmpOid(k, asked[0]) > 0);
      while (i >= 0 && i < KEYS.length && answers.length < want) {
        answers.push([KEYS[i], MIB[KEYS[i]]]);
        i += 1;
      }
    }

    const varbinds = answers.map(([oid, val]) => b.tlv(0x30, Buffer.concat([
      b.encodeOid(oid),
      val === undefined
        ? b.tlv(0x81, Buffer.alloc(0))                // noSuchInstance
        : b.tlv(0x04, Buffer.from(String(val))),
    ])));

    const reply = b.tlv(0x30, Buffer.concat([
      b.encodeInt(0x02, 1),
      b.tlv(0x04, Buffer.from('public')),
      b.tlv(0xa2, Buffer.concat([
        b.encodeInt(0x02, b.decodeInt(rid.value)),
        b.encodeInt(0x02, 0),
        b.encodeInt(0x02, 0),
        b.tlv(0x30, Buffer.concat(varbinds)),
      ])),
    ]));
    sock.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(sock)));
}

test('v2c GET returns the values the agent holds', async () => {
  const agent = await startAgent();
  const s = new Session({
    host: '127.0.0.1', port: agent.address().port, version: '2c',
    community: 'public', timeout: 1000, retries: 0,
  });
  try {
    const vbs = await s.get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0']);
    assert.equal(vbs.length, 2);
    assert.equal(vbs[0].value, 'sw-test-01');
    assert.equal(vbs[1].value, 'RackTrack test agent, 24 port');
  } finally { s.close(); agent.close(); }
});

test('an OID the agent does not hold comes back absent, not blank', async () => {
  const agent = await startAgent();
  const s = new Session({
    host: '127.0.0.1', port: agent.address().port, version: '2c',
    community: 'public', timeout: 1000, retries: 0,
  });
  try {
    const [vb] = await s.get(['1.3.6.1.2.1.47.1.1.1.1.11.1']);
    assert.deepEqual(vb.value, { absent: 'noSuchInstance' });
  } finally { s.close(); agent.close(); }
});

test('walk stops at the end of its subtree', async () => {
  const agent = await startAgent();
  const s = new Session({
    host: '127.0.0.1', port: agent.address().port, version: '2c',
    community: 'public', timeout: 1000, retries: 0,
  });
  try {
    const rows = await s.walk('1.3.6.1.2.1.2.2.1.2', { chunk: 2 });
    assert.equal(rows.length, 3, 'three interfaces, and nothing from 1.3.6.1.3');
    assert.deepEqual(rows.map((r) => r.index), ['1', '2', '3']);
    assert.equal(rows[2].value, 'GigabitEthernet1/0/3');
  } finally { s.close(); agent.close(); }
});

test('a silent agent times out with a message that names the host', async () => {
  const dead = dgram.createSocket('udp4');
  await new Promise((r) => dead.bind(0, '127.0.0.1', r));
  const s = new Session({
    host: '127.0.0.1', port: dead.address().port, version: '2c',
    community: 'public', timeout: 120, retries: 0,
  });
  try {
    await assert.rejects(() => s.get(['1.3.6.1.2.1.1.5.0']), /did not answer/);
  } finally { s.close(); dead.close(); }
});
