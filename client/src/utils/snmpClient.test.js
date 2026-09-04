// The SNMP session, checked without a switch.
//
// The wire shapes of v2c and v3 requests are asserted byte by byte where the
// RFCs fix them, and replies are synthesised with the same primitives so the
// parser is tested against messages an agent would actually send — including
// the REPORT that answers a v3 discovery, the one exchange nothing else on the
// phone can do for us.

import { vi } from 'vitest';

// The native plugin does not exist under test; the session's build and parse
// methods are exercised directly and the bridge is never touched.
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ query: vi.fn() }) }));

import { T, tlv, encodeInt, encodeStr, encodeOid, readTLV, decodeInt } from './snmpBer';
import { Snmp, SnmpError, OID, USM_REPORTS, vendorOf, modelFrom } from './snmpClient';

const U8 = (a) => Uint8Array.from(a);
const text = (t) => new TextDecoder().decode(t.value);

/** Walk one TLV level and return its children as {tag, value, start, end}. */
function children(buf, seqTlv) {
  const out = [];
  let p = seqTlv.start;
  while (p < seqTlv.end) { const t = readTLV(buf, p); out.push(t); p = t.next; }
  return out;
}

/** Encode a varbind list of [oid, tag, valueBytes]. */
const varbinds = (rows) => tlv(T.SEQUENCE, rows.flatMap(([oid, tag, val]) =>
  tlv(T.SEQUENCE, [...encodeOid(oid), ...tlv(tag, val)])));

describe('vendor and model', () => {
  test('enterprise number names the make, unknown ones stay numeric facts', () => {
    expect(vendorOf('1.3.6.1.4.1.171.10.76.28')).toBe('D-Link');
    expect(vendorOf('1.3.6.1.4.1.11863.5.44')).toBe('TP-Link');
    expect(vendorOf('1.3.6.1.4.1.99999.1')).toBe('enterprise 99999');
    expect(vendorOf('1.3.6.1.2.1.1')).toBeNull();
    expect(vendorOf(null)).toBeNull();
  });

  test('model comes out of the real strings the three switches returned', () => {
    // D-Link: model is in sysDescr.
    expect(modelFrom('WS6-DGS-1210-52/F1 6.30.016', null)).toBe('DGS-1210-52');
    // TP-Link: sysDescr is marketing copy; the model is the sysName, bare, no TL- prefix.
    expect(modelFrom('Omada 28-Port Gigabit Smart Switch with 24-Port PoE+', 'SG2428P')).toBe('SG2428P');
    expect(modelFrom('TL-SG2428P 2.0', null)).toBe('TL-SG2428P');
    expect(modelFrom('Some switch', 'edge-closet-1')).toBeNull();
  });
});

describe('constructing a session', () => {
  test('v2c takes a community, v3 takes a user at noAuthNoPriv', () => {
    expect(new Snmp({ host: '10.0.0.1', version: 'v2c', community: 'public' }).version).toBe('2c');
    const s3 = new Snmp({ host: '10.0.0.1', version: 'v3', username: 'ro', securityLevel: 'noAuthNoPriv' });
    expect(s3.version).toBe('3');
    expect(s3.engineId.length).toBe(0);
  });

  test('refuses what this build cannot do, and says what to do instead', () => {
    expect(() => new Snmp({ host: 'h', version: 'v3', username: 'ro', securityLevel: 'authPriv' }))
      .toThrow(/without a password only/);
    expect(() => new Snmp({ host: 'h', version: 'v3', username: '' })).toThrow(/user name is required/);
    expect(() => new Snmp({ host: 'h', version: 'v9' })).toThrow(/Unknown SNMP version/);
  });
});

describe('v2c wire format', () => {
  test('a GET is version 1, the community, then the PDU', () => {
    const s = new Snmp({ host: 'h', version: 'v2c', community: 'public' });
    const msg = U8(s.buildV2c(T.GET, 1234, [OID.sysDescr]));
    const outer = readTLV(msg, 0);
    expect(outer.tag).toBe(T.SEQUENCE);
    const [ver, comm, pdu] = children(msg, outer);
    expect(decodeInt(ver.value)).toBe(1);          // 1 == SNMPv2c, not 2
    expect(text(comm)).toBe('public');
    expect(pdu.tag).toBe(T.GET);
    const [rid, es, ei, list] = children(msg, pdu);
    expect(decodeInt(rid.value)).toBe(1234);
    expect(decodeInt(es.value)).toBe(0);
    expect(decodeInt(ei.value)).toBe(0);
    const [vb] = children(msg, list);
    const [oid, val] = children(msg, vb);
    expect(oid.tag).toBe(T.OID);
    expect(val.tag).toBe(T.NULL);
  });

  test('GETBULK carries non-repeaters and max-repetitions where v2c puts them', () => {
    const s = new Snmp({ host: 'h', version: 'v2c', community: 'c' });
    const msg = U8(s.buildV2c(T.GET_BULK, 9, [OID.ifDescr], { maxRepetitions: 20 }));
    const pdu = children(msg, readTLV(msg, 0))[2];
    expect(pdu.tag).toBe(T.GET_BULK);
    const [, nonRep, maxRep] = children(msg, pdu);
    expect(decodeInt(nonRep.value)).toBe(0);
    expect(decodeInt(maxRep.value)).toBe(20);
  });

  test('a matching RESPONSE parses; the wrong request id is ignored, not an error', () => {
    const s = new Snmp({ host: 'h', version: 'v2c', community: 'c' });
    const reply = (rid) => U8(tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, 1),
      ...encodeStr(T.OCTET_STRING, 'c'),
      ...tlv(T.RESPONSE, [
        ...encodeInt(T.INTEGER, rid),
        ...encodeInt(T.INTEGER, 0),
        ...encodeInt(T.INTEGER, 0),
        ...varbinds([[OID.sysName, T.OCTET_STRING, [...new TextEncoder().encode('SG2428P')]]]),
      ]),
    ]));
    const ok = s.parseV2c(reply(77), 77);
    expect(ok.errorStatus).toBe(0);
    expect(ok.varbinds[0]).toMatchObject({ oid: OID.sysName, value: 'SG2428P' });
    expect(s.parseV2c(reply(78), 77)).toBeNull();
  });
});

describe('v3 wire format at noAuthNoPriv', () => {
  const mk = () => new Snmp({ host: 'h', version: 'v3', username: 'racktrack', securityLevel: 'noAuthNoPriv' });

  test('discovery: empty engine id, zero boots and time, reportable flag, no auth or priv params', () => {
    const s = mk();
    const { message, msgId } = s.buildV3(T.GET, 5, [], {}, true);
    const msg = U8(message);
    const [ver, header, secWrap, scoped] = children(msg, readTLV(msg, 0));
    expect(decodeInt(ver.value)).toBe(3);

    const [gotMsgId, maxSize, flags, secModel] = children(msg, header);
    expect(decodeInt(gotMsgId.value)).toBe(msgId);
    expect(decodeInt(maxSize.value)).toBe(65507);
    expect([...flags.value]).toEqual([0x04]);        // reportable only
    expect(decodeInt(secModel.value)).toBe(3);       // USM

    expect(secWrap.tag).toBe(T.OCTET_STRING);
    const sec = readTLV(msg, secWrap.start);
    const [engineId, boots, time, user, authP, privP] = children(msg, sec);
    expect(engineId.value.length).toBe(0);
    expect(decodeInt(boots.value)).toBe(0);
    expect(decodeInt(time.value)).toBe(0);
    expect(text(user)).toBe('racktrack');
    expect(authP.value.length).toBe(0);
    expect(privP.value.length).toBe(0);

    expect(scoped.tag).toBe(T.SEQUENCE);             // in the clear, not an OCTET STRING
    const [ctxEngine, ctxName, pdu] = children(msg, scoped);
    expect(ctxEngine.value.length).toBe(0);
    expect(ctxName.value.length).toBe(0);
    expect(pdu.tag).toBe(T.GET);
  });

  test('after discovery the engine id, boots and time are carried in every request', () => {
    const s = mk();
    s.engineId = U8([0x80, 0x00, 0x1f, 0x88, 0x80, 0x01, 0x02, 0x03]);
    s.engineBoots = 7;
    s.engineTime = 1000;
    s.syncedAt = Date.now();
    const { message } = s.buildV3(T.GET, 6, [OID.sysName]);
    const msg = U8(message);
    const [, , secWrap, scoped] = children(msg, readTLV(msg, 0));
    const [engineId, boots, time] = children(msg, readTLV(msg, secWrap.start));
    expect([...engineId.value]).toEqual([...s.engineId]);
    expect(decodeInt(boots.value)).toBe(7);
    expect(decodeInt(time.value)).toBeGreaterThanOrEqual(1000);
    const [ctxEngine] = children(msg, scoped);
    expect([...ctxEngine.value]).toEqual([...s.engineId]);
  });

  /** A v3 reply as an agent would send it at noAuthNoPriv. */
  function v3Reply({ msgId, pduTag, requestId, engineId, boots, time, rows }) {
    return U8(tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, 3),
      ...tlv(T.SEQUENCE, [
        ...encodeInt(T.INTEGER, msgId),
        ...encodeInt(T.INTEGER, 65507),
        ...tlv(T.OCTET_STRING, [0x00]),
        ...encodeInt(T.INTEGER, 3),
      ]),
      ...tlv(T.OCTET_STRING, tlv(T.SEQUENCE, [
        ...tlv(T.OCTET_STRING, engineId),
        ...encodeInt(T.INTEGER, boots),
        ...encodeInt(T.INTEGER, time),
        ...encodeStr(T.OCTET_STRING, 'racktrack'),
        ...tlv(T.OCTET_STRING, []),
        ...tlv(T.OCTET_STRING, []),
      ])),
      ...tlv(T.SEQUENCE, [
        ...tlv(T.OCTET_STRING, engineId),
        ...tlv(T.OCTET_STRING, []),
        ...tlv(pduTag, [
          ...encodeInt(T.INTEGER, requestId),
          ...encodeInt(T.INTEGER, 0),
          ...encodeInt(T.INTEGER, 0),
          ...varbinds(rows),
        ]),
      ]),
    ]));
  }

  const ENGINE = [0x80, 0x00, 0x2e, 0x57, 0x03, 0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e];

  test('the REPORT that answers discovery yields the engine id, boots and time', () => {
    const s = mk();
    const { msgId } = s.buildV3(T.GET, 11, [], {}, true);
    const unknownEngine = Object.keys(USM_REPORTS).find((k) => USM_REPORTS[k][0] === 'unknownEngineId');
    const reply = v3Reply({
      msgId, pduTag: T.REPORT, requestId: 0, engineId: ENGINE, boots: 3, time: 4242,
      rows: [[unknownEngine, T.COUNTER32, [0x01]]],
    });
    const r = s.parseV3(reply, msgId, 11);
    expect(r.report).toBe(true);
    expect([...r.engine.id]).toEqual(ENGINE);
    expect(r.engine.boots).toBe(3);
    expect(r.engine.time).toBe(4242);
    expect(r.varbinds[0].oid).toBe(unknownEngine);
  });

  test('a RESPONSE parses its varbinds; wrong msgId or requestId is ignored', () => {
    const s = mk();
    const { msgId } = s.buildV3(T.GET, 21, [OID.sysName]);
    const rows = [[OID.sysName, T.OCTET_STRING, [...new TextEncoder().encode('SG2428P')]]];
    const good = v3Reply({ msgId, pduTag: T.RESPONSE, requestId: 21, engineId: ENGINE, boots: 3, time: 5000, rows });
    const r = s.parseV3(good, msgId, 21);
    expect(r.report).toBeUndefined();
    expect(r.errorStatus).toBe(0);
    expect(r.varbinds[0]).toMatchObject({ oid: OID.sysName, value: 'SG2428P' });

    expect(s.parseV3(good, msgId + 1, 21)).toBeNull();
    const wrongRid = v3Reply({ msgId, pduTag: T.RESPONSE, requestId: 22, engineId: ENGINE, boots: 3, time: 5000, rows });
    expect(s.parseV3(wrongRid, msgId, 21)).toBeNull();
  });

  test('an encrypted reply is refused with an explanation, not parsed as garbage', () => {
    const s = mk();
    const { msgId } = s.buildV3(T.GET, 31, [OID.sysName]);
    const enc = U8(tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, 3),
      ...tlv(T.SEQUENCE, [
        ...encodeInt(T.INTEGER, msgId), ...encodeInt(T.INTEGER, 65507),
        ...tlv(T.OCTET_STRING, [0x03]),           // auth + priv
        ...encodeInt(T.INTEGER, 3),
      ]),
      ...tlv(T.OCTET_STRING, tlv(T.SEQUENCE, [
        ...tlv(T.OCTET_STRING, ENGINE), ...encodeInt(T.INTEGER, 1), ...encodeInt(T.INTEGER, 1),
        ...encodeStr(T.OCTET_STRING, 'racktrack'),
        ...tlv(T.OCTET_STRING, new Array(12).fill(0)), ...tlv(T.OCTET_STRING, new Array(8).fill(0)),
      ])),
      ...tlv(T.OCTET_STRING, [1, 2, 3, 4, 5, 6, 7, 8]),
    ]));
    let caught = null;
    try { s.parseV3(enc, msgId, 31); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SnmpError);
    expect(caught.kind).toBe('config');
    expect(caught.message).toMatch(/encrypted/);
    expect(caught.hint).toMatch(/authPriv/);            // the fix lives in the hint
  });

  test('every USM report counter has a plain-English reason', () => {
    for (const [oid, [name, reason]] of Object.entries(USM_REPORTS)) {
      expect(oid).toMatch(/^1\.3\.6\.1\.6\.3\.15\.1\.1\.\d\.0$/);
      expect(name).toBeTruthy();
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
