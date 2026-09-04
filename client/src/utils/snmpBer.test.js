// The BER codec, checked against the rules rather than against itself.
//
// Ported from the server's snmp.test.js so the two codecs are held to the
// same facts. Every expected byte here comes from X.690 / RFC 3416, not from
// running the encoder and pasting what it produced — a test that does that
// only proves the code agrees with itself.

import {
  T, tlv, encodeInt, encodeStr, encodeOid, readTLV,
  decodeInt, decodeUint, decodeOid, decodeOctets, decodeValue, isAbsent,
  bytesToB64, b64ToBytes,
} from './snmpBer';

const U8 = (a) => Uint8Array.from(a);
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, '0')).join(' ');

describe('BER length', () => {
  test('short form up to 127, long form above, at the boundary', () => {
    expect(tlv(T.NULL, []).slice(0, 2)).toEqual([0x05, 0x00]);
    expect(tlv(T.OCTET_STRING, new Array(127).fill(0)).slice(0, 2)).toEqual([0x04, 0x7f]);
    expect(tlv(T.OCTET_STRING, new Array(128).fill(0)).slice(0, 3)).toEqual([0x04, 0x81, 0x80]);
    expect(tlv(T.OCTET_STRING, new Array(256).fill(0)).slice(0, 4)).toEqual([0x04, 0x82, 0x01, 0x00]);
  });

  test('readTLV understands both forms and reports the right offsets', () => {
    const inner = tlv(T.OCTET_STRING, new Array(200).fill(7));
    const buf = U8(inner);
    const t = readTLV(buf, 0);
    expect(t.tag).toBe(T.OCTET_STRING);
    expect(t.start).toBe(3);           // tag (1) + 0x81 (1) + 0xC8 (1)
    expect(t.end - t.start).toBe(200);
    expect(t.next).toBe(buf.length);
  });
});

describe('INTEGER', () => {
  test('minimal two\'s complement, including the sign-bit cases', () => {
    expect(hex(encodeInt(T.INTEGER, 0))).toBe('02 01 00');
    expect(hex(encodeInt(T.INTEGER, 127))).toBe('02 01 7f');
    // 128 would set the high bit, which means negative — so a leading 0x00.
    expect(hex(encodeInt(T.INTEGER, 128))).toBe('02 02 00 80');
    expect(hex(encodeInt(T.INTEGER, 256))).toBe('02 02 01 00');
    expect(hex(encodeInt(T.INTEGER, -1))).toBe('02 01 ff');
    expect(hex(encodeInt(T.INTEGER, -128))).toBe('02 01 80');
    expect(hex(encodeInt(T.INTEGER, -129))).toBe('02 02 ff 7f');
    expect(hex(encodeInt(T.INTEGER, 65507))).toBe('02 03 00 ff e3');
  });

  test('round trips', () => {
    for (const n of [0, 1, 127, 128, 255, 256, 65535, 2147483647, -1, -128, -129, -32768]) {
      const enc = U8(encodeInt(T.INTEGER, n));
      const t = readTLV(enc, 0);
      expect(decodeInt(t.value)).toBe(n);
    }
  });

  test('a positive integer never sets the high bit of its first byte', () => {
    for (let n = 0; n < 70000; n += 997) {
      const enc = encodeInt(T.INTEGER, n);
      expect(enc[2] & 0x80).toBe(0);
    }
  });

  test('unsigned decode for counters that use all 32 bits', () => {
    expect(decodeUint(U8([0xff, 0xff, 0xff, 0xff]))).toBe(4294967295);
    expect(decodeInt(U8([0xff, 0xff, 0xff, 0xff]))).toBe(-1);
  });
});

describe('OBJECT IDENTIFIER', () => {
  test('first two arcs share a byte, later arcs are base-128', () => {
    // 1.3.6.1.2.1.1.1.0 = sysDescr
    expect(hex(encodeOid('1.3.6.1.2.1.1.1.0'))).toBe('06 08 2b 06 01 02 01 01 01 00');
    // 1.3.6.1.4.1.11863 — TP-Link's enterprise: 11863 = 92*128 + 87 → dc 57
    expect(hex(encodeOid('1.3.6.1.4.1.11863'))).toBe('06 07 2b 06 01 04 01 dc 57');
    // A leading dot is tolerated, as pasted OIDs often carry one.
    expect(hex(encodeOid('.1.3.6'))).toBe('06 02 2b 06');
  });

  test('round trips, including multi-byte arcs and LLDP\'s 1.0.8802 root', () => {
    for (const oid of [
      '1.3.6.1.2.1.1.5.0',
      '1.3.6.1.4.1.11863.6.1.1',
      '1.0.8802.1.1.2.1.4.1.1.9.0.3.1',
      '1.3.6.1.2.1.17.7.1.2.2.1.2.1.0.1.2.3.4.5',
      '2.999',
    ]) {
      const t = readTLV(U8(encodeOid(oid)), 0);
      expect(decodeOid(t.value)).toBe(oid);
    }
  });

  test('refuses something that is not an OID', () => {
    expect(() => encodeOid('hello')).toThrow(/not an OID/);
    expect(() => encodeOid('1')).toThrow(/not an OID/);
    expect(() => encodeOid('3.1')).toThrow(/not an OID/);      // first arc is 0, 1 or 2
    expect(() => encodeOid('1.40')).toThrow(/not an OID/);     // under 0 or 1 the second is < 40
    expect(() => encodeOid('1.3.-6')).toThrow(/not an OID/);
  });

  test('the folded first pair is base-128 like any other subidentifier (X.690 §8.19.4)', () => {
    // 2.999 folds to 2*40 + 999 = 1079 = 8*128 + 55 → 88 37. A single raw byte
    // would have produced 37 and read back as 1.15. This is the case the
    // server's codec gets wrong; SNMP never sends one, but a codec should not
    // depend on that.
    expect(hex(encodeOid('2.999'))).toBe('06 02 88 37');
    expect(decodeOid(U8([0x88, 0x37]))).toBe('2.999');
    // And the unfold boundaries: 0.39 → 39, 1.0 → 40, 1.39 → 79, 2.0 → 80.
    expect(decodeOid(U8([39]))).toBe('0.39');
    expect(decodeOid(U8([40]))).toBe('1.0');
    expect(decodeOid(U8([79]))).toBe('1.39');
    expect(decodeOid(U8([80]))).toBe('2.0');
  });
});

describe('OCTET STRING', () => {
  test('printable text stays text, trailing whitespace trimmed', () => {
    expect(decodeOctets(new TextEncoder().encode('SG2428P  \n'))).toBe('SG2428P');
    expect(decodeOctets(new TextEncoder().encode('WS6-DGS-1210-52/F1 6.30.016'))).toBe('WS6-DGS-1210-52/F1 6.30.016');
  });

  test('binary becomes colon-hex, so a MAC is legible and a serial is never mangled', () => {
    expect(decodeOctets(U8([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e]))).toBe('00:1a:2b:3c:4d:5e');
  });

  test('empty is empty', () => {
    expect(decodeOctets(U8([]))).toBe('');
  });

  test('encodeStr handles ASCII and a stray non-ASCII character', () => {
    expect(hex(encodeStr(T.OCTET_STRING, 'public'))).toBe('04 06 70 75 62 6c 69 63');
    const t = readTLV(U8(encodeStr(T.OCTET_STRING, 'café')), 0);
    expect(new TextDecoder().decode(t.value)).toBe('café');
  });
});

describe('decodeValue', () => {
  test('maps every SNMP type we can receive', () => {
    expect(decodeValue(T.INTEGER, U8([0x05]))).toBe(5);
    expect(decodeValue(T.COUNTER32, U8([0xff, 0xff, 0xff, 0xff]))).toBe(4294967295);
    expect(decodeValue(T.GAUGE32, U8([0x03, 0xe8]))).toBe(1000);
    expect(decodeValue(T.TIMETICKS, U8([0x01, 0x00]))).toBe(256);
    expect(decodeValue(T.IP_ADDRESS, U8([10, 10, 1, 33]))).toBe('10.10.1.33');
    expect(decodeValue(T.OID, U8([0x2b, 0x06, 0x01]))).toBe('1.3.6.1');
    expect(decodeValue(T.NULL, U8([]))).toBeNull();
    expect(isAbsent(decodeValue(T.NO_SUCH_OBJECT, U8([])))).toBe(true);
    expect(isAbsent(decodeValue(T.NO_SUCH_INSTANCE, U8([])))).toBe(true);
    expect(isAbsent(decodeValue(T.END_OF_MIB_VIEW, U8([])))).toBe(true);
    expect(isAbsent(decodeValue(T.INTEGER, U8([0])))).toBe(false);
  });
});

describe('nested TLVs and malformed input', () => {
  test('a SEQUENCE of two values parses at the right offsets', () => {
    const seq = U8(tlv(T.SEQUENCE, [...encodeInt(T.INTEGER, 7), ...encodeStr(T.OCTET_STRING, 'ab')]));
    const outer = readTLV(seq, 0);
    expect(outer.tag).toBe(T.SEQUENCE);
    const a = readTLV(seq, outer.start);
    expect(decodeInt(a.value)).toBe(7);
    const b = readTLV(seq, a.next);
    expect(new TextDecoder().decode(b.value)).toBe('ab');
    expect(b.next).toBe(outer.end);
  });

  test('a truncated datagram is rejected, not read past the end', () => {
    const good = U8(encodeStr(T.OCTET_STRING, 'hello world'));
    const cut = good.subarray(0, good.length - 3);
    expect(() => readTLV(cut, 0)).toThrow(/runs past|truncated/);
    expect(() => readTLV(U8([0x04]), 0)).toThrow(/truncated/);
  });

  test('a length field claiming more than 4 bytes is refused', () => {
    expect(() => readTLV(U8([0x04, 0x85, 1, 1, 1, 1, 1]), 0)).toThrow(/unsupported/);
  });
});

describe('base64 across the native bridge', () => {
  test('round trips, including a payload larger than one String.fromCharCode call can take', () => {
    const big = new Uint8Array(70000);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31) & 0xff;
    expect(b64ToBytes(bytesToB64(big))).toEqual(big);
    expect(b64ToBytes(bytesToB64(U8([])))).toEqual(U8([]));
  });
});
