// SNMPv3 end to end, over a real UDP socket, against a toy agent.
//
// The unit tests check bytes. This checks the conversation: the phone's
// session sends a discovery, the agent answers with a REPORT carrying its
// engine id, the session stores it and asks again, the agent answers. Then
// the two things that go wrong in the field — a user the agent does not know,
// and a clock that has drifted out of the time window — and the walk's stop
// condition on a live GETBULK.
//
// The native plugin is replaced with a Node datagram socket doing exactly what
// SnmpUdp.java and SnmpUdp.swift do: one packet out, one back, or a timeout.
// So everything above the socket — the code that actually ships — runs as-is.
//
// The agent decodes what it is sent rather than replaying canned buffers, so a
// change that breaks the encoder fails here instead of passing by accident.

import { vi, beforeAll, afterAll } from 'vitest';
import dgram from 'node:dgram';

vi.mock('@capacitor/core', () => ({
  // The socket below IS the native side, so the client must believe it is on a
  // device — otherwise the web guard refuses before a packet is ever sent.
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    query: ({ host, port, timeoutMs, data }) => new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        sock.close();
        reject(Object.assign(new Error('The switch did not answer in time.'), { code: 'timeout' }));
      }, timeoutMs);
      sock.on('message', (m, rinfo) => {
        clearTimeout(timer);
        sock.close();
        resolve({ data: Buffer.from(m).toString('base64'), bytes: m.length, from: rinfo.address });
      });
      sock.send(Buffer.from(data, 'base64'), port, host);
    }),
  }),
}));

import {
  T, tlv, encodeInt, encodeStr, encodeOid, readTLV, decodeInt, decodeOid,
} from './snmpBer';
import { Snmp, SnmpError, OID, testLogin } from './snmpClient';

// ── the toy agent ──────────────────────────────────────────────────────────

const ENGINE = [0x80, 0x00, 0x1f, 0x88, 0x80, 0xde, 0xad, 0xbe, 0xef, 0x01];
const USER = 'racktrack';
const BOOTS = 5;
let engineTime = 12345;          // the agent's clock; tests move it to force a REPORT

const MIB = {
  [OID.sysDescr]: 'Toy v3 agent, 3 ports',
  [OID.sysName]: 'toy-v3',
  [OID.sysObjectID]: { oid: '1.3.6.1.4.1.11863.1.1' },   // TP-Link's enterprise
  [`${OID.ifDescr}.1`]: 'port 1',
  [`${OID.ifDescr}.2`]: 'port 2',
  [`${OID.ifDescr}.3`]: 'port 3',
  '1.3.6.1.3.99.0': 'past the end of the subtree',
};
const cmp = (a, c) => {
  const x = a.split('.').map(Number); const y = c.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  }
  return 0;
};
const KEYS = Object.keys(MIB).sort(cmp);

const USM_UNKNOWN_ENGINE = '1.3.6.1.6.3.15.1.1.4.0';
const USM_UNKNOWN_USER = '1.3.6.1.6.3.15.1.1.3.0';
const USM_NOT_IN_WINDOW = '1.3.6.1.6.3.15.1.1.2.0';

function children(buf, seq) {
  const out = []; let p = seq.start;
  while (p < seq.end) { const t = readTLV(buf, p); out.push(t); p = t.next; }
  return out;
}
const encodeValue = (v) => {
  if (v === undefined) return tlv(T.NO_SUCH_OBJECT, []);
  if (v === null) return tlv(T.END_OF_MIB_VIEW, []);
  if (typeof v === 'number') return encodeInt(T.INTEGER, v);
  if (typeof v === 'object' && v.oid) return encodeOid(v.oid);
  return encodeStr(T.OCTET_STRING, v);
};
const vb = (oid, value) => tlv(T.SEQUENCE, [...encodeOid(oid), ...encodeValue(value)]);

function v3Message(msgId, pduTag, requestId, varbinds) {
  return Buffer.from(tlv(T.SEQUENCE, [
    ...encodeInt(T.INTEGER, 3),
    ...tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, msgId), ...encodeInt(T.INTEGER, 65507),
      ...tlv(T.OCTET_STRING, [0x00]), ...encodeInt(T.INTEGER, 3),
    ]),
    ...tlv(T.OCTET_STRING, tlv(T.SEQUENCE, [
      ...tlv(T.OCTET_STRING, ENGINE), ...encodeInt(T.INTEGER, BOOTS), ...encodeInt(T.INTEGER, engineTime),
      ...encodeStr(T.OCTET_STRING, USER), ...tlv(T.OCTET_STRING, []), ...tlv(T.OCTET_STRING, []),
    ])),
    ...tlv(T.SEQUENCE, [
      ...tlv(T.OCTET_STRING, ENGINE), ...tlv(T.OCTET_STRING, []),
      ...tlv(pduTag, [
        ...encodeInt(T.INTEGER, requestId), ...encodeInt(T.INTEGER, 0), ...encodeInt(T.INTEGER, 0),
        ...tlv(T.SEQUENCE, varbinds),
      ]),
    ]),
  ]));
}

const report = (msgId, requestId, counterOid) =>
  v3Message(msgId, T.REPORT, requestId, vb(counterOid, 1));

/** What a real agent does with an incoming v3 message. */
function answer(msg) {
  const buf = new Uint8Array(msg);
  const [, header, secWrap, scoped] = children(buf, readTLV(buf, 0));
  const [msgIdT] = children(buf, header);
  const msgId = decodeInt(msgIdT.value);
  const [engineIdT, , timeT, userT] = children(buf, readTLV(buf, secWrap.start));
  const [, , pdu] = children(buf, scoped);
  const [reqIdT, , maxRepT, list] = children(buf, pdu);
  const requestId = decodeInt(reqIdT.value);

  if (engineIdT.value.length === 0) return report(msgId, requestId, USM_UNKNOWN_ENGINE);
  if (new TextDecoder().decode(userT.value) !== USER) return report(msgId, requestId, USM_UNKNOWN_USER);
  // RFC 3414 §2.2.3: 150 seconds either way, else the message is stale.
  if (Math.abs(decodeInt(timeT.value) - engineTime) > 150) return report(msgId, requestId, USM_NOT_IN_WINDOW);

  const asked = children(buf, list).map((e) => decodeOid(children(buf, e)[0].value));
  let out;
  if (pdu.tag === T.GET) {
    out = asked.flatMap((oid) => vb(oid, MIB[oid]));
  } else {                                        // GETBULK (or GETNEXT: maxRep 0 → 1)
    const maxRep = Math.max(1, decodeInt(maxRepT.value));
    out = asked.flatMap((oid) => {
      let i = KEYS.findIndex((k) => cmp(k, oid) > 0);
      const rows = [];
      for (let n = 0; n < maxRep; n += 1, i += 1) {
        rows.push(...(i >= 0 && i < KEYS.length ? vb(KEYS[i], MIB[KEYS[i]]) : vb(oid, null)));
      }
      return rows;
    });
  }
  return v3Message(msgId, T.RESPONSE, requestId, out);
}

let agent; let agentPort; let dead; let deadPort;
const seenUsers = [];

beforeAll(async () => {
  agent = dgram.createSocket('udp4');
  agent.on('message', (msg, rinfo) => {
    try {
      const buf = new Uint8Array(msg);
      const [, , secWrap] = children(buf, readTLV(buf, 0));
      const [, , , userT] = children(buf, readTLV(buf, secWrap.start));
      seenUsers.push(new TextDecoder().decode(userT.value));
      agent.send(answer(msg), rinfo.port, rinfo.address);
    } catch (e) { /* a malformed packet gets silence, as from a real agent */ }
  });
  await new Promise((r) => agent.bind(0, '127.0.0.1', r));
  agentPort = agent.address().port;
  // A bound socket that never answers, for the timeout path.
  dead = dgram.createSocket('udp4');
  await new Promise((r) => dead.bind(0, '127.0.0.1', r));
  deadPort = dead.address().port;
});
afterAll(() => { agent.close(); dead.close(); });

const session = (over = {}) => new Snmp({
  host: '127.0.0.1', port: agentPort, version: 'v3', username: USER,
  securityLevel: 'noAuthNoPriv', timeoutMs: 800, retries: 0, ...over,
});

// ── the conversation ───────────────────────────────────────────────────────

describe('SNMPv3 noAuthNoPriv against a live agent', () => {
  test('discovery, then the answer: engine id stored, values returned', async () => {
    const s = session();
    expect(s.engineId.length).toBe(0);
    const r = await s.get([OID.sysDescr, OID.sysName]);
    expect(r[OID.sysDescr]).toBe('Toy v3 agent, 3 ports');
    expect(r[OID.sysName]).toBe('toy-v3');
    expect([...s.engineId]).toEqual(ENGINE);
    expect(s.engineBoots).toBe(BOOTS);
    expect(s.engineTime).toBe(engineTime);
  });

  test('the user name travels in the discovery too, as the server does it', async () => {
    seenUsers.length = 0;
    await session().get([OID.sysName]);
    expect(seenUsers.length).toBe(2);           // discovery + the real request
    expect(seenUsers.every((u) => u === USER)).toBe(true);
  });

  test('a second request reuses the engine id: one round trip, not two', async () => {
    const s = session();
    await s.get([OID.sysName]);
    seenUsers.length = 0;
    await s.get([OID.sysDescr]);
    expect(seenUsers.length).toBe(1);
  });

  test('testLogin reports make from sysObjectID and the engine id in hex', async () => {
    const info = await testLogin({ host: '127.0.0.1', port: agentPort, version: 'v3', username: USER, securityLevel: 'noAuthNoPriv', timeoutMs: 800, retries: 0 });
    expect(info.sysName).toBe('toy-v3');
    expect(info.vendor).toBe('TP-Link');
    expect(info.engineId).toBe(ENGINE.map((b) => b.toString(16).padStart(2, '0')).join(''));
  });

  test('a GETBULK walk returns the subtree and stops at its edge', async () => {
    const rows = await session().walk(OID.ifDescr, { chunk: 2 });
    expect(rows.map((r) => r.index)).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r.value)).toEqual(['port 1', 'port 2', 'port 3']);
  });

  test('an unknown user is refused by name, with the reason', async () => {
    let caught;
    try { await session({ username: 'nobody' }).get([OID.sysName]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SnmpError);
    expect(caught.kind).toBe('auth');
    expect(caught.message).toMatch(/unknownUserName/);
    expect(caught.hint).toMatch(/no SNMPv3 user by that name/);
  });

  test("a stale clock gets one REPORT, the session re-syncs and the retry succeeds", async () => {
    const s = session();
    await s.get([OID.sysName]);               // discovered; s.engineTime === engineTime
    engineTime += 1000;                       // the agent's clock jumps out of the window
    seenUsers.length = 0;
    const r = await s.get([OID.sysDescr]);    // → notInTimeWindow → resync → retry
    expect(r[OID.sysDescr]).toBe('Toy v3 agent, 3 ports');
    expect(seenUsers.length).toBe(2);         // the refused attempt and the good one
    expect(s.engineTime).toBe(engineTime);
    engineTime -= 1000;
  });

  test('an unanswered discovery is a timeout that names discovery, not a bad user', async () => {
    let caught;
    try { await session({ port: deadPort, timeoutMs: 150 }).get([OID.sysName]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SnmpError);
    expect(caught.kind).toBe('timeout');
    expect(caught.hint).toMatch(/discovery/);
    expect(caught.hint).toMatch(/not reachable|SNMPv3 is not enabled/);
  });

  test('absent objects come back null, never invented', async () => {
    const r = await session().get([OID.sysName, OID.entPhysicalSerialNum + '.1']);
    expect(r[OID.sysName]).toBe('toy-v3');
    expect(r[OID.entPhysicalSerialNum + '.1']).toBeNull();
  });
});
