/**
 * The codec has no switch to talk to, so these are the only check on it.
 *
 * The key derivation vectors are RFC 3414 appendix A.3, which every real agent
 * agrees with. Getting password-to-key wrong produces a self-consistent key
 * that is rejected by every device with no diagnostic beyond "wrongDigest", so
 * this test is worth more than it looks.
 */
const test = require('node:test');
const assert = require('node:assert');
const { _internal: b } = require('../../lib/netbox/snmp');

const hex = (buf) => buf.toString('hex');

test('BER length: short form, long form, boundary', () => {
  assert.equal(hex(b.encodeLength(0)), '00');
  assert.equal(hex(b.encodeLength(127)), '7f');
  assert.equal(hex(b.encodeLength(128)), '8180');
  assert.equal(hex(b.encodeLength(300)), '82012c');
});

test('INTEGER round trips, including the sign bit cases', () => {
  for (const n of [0, 1, 127, 128, 255, 256, 65535, 2147483647, -1, -128, -129]) {
    const enc = b.encodeInt(0x02, n);
    const tlv = b.readTLV(enc, 0);
    assert.equal(b.decodeInt(tlv.value), n, `${n} did not survive`);
  }
});

test('a positive integer never sets the high bit of its first byte', () => {
  assert.equal(hex(b.encodeInt(0x02, 128)), '02020080');
  assert.equal(hex(b.encodeInt(0x02, 255)), '020200ff');
});

test('OID round trips, including multi-byte arcs', () => {
  for (const oid of [
    '1.3.6.1.2.1.1.1.0',
    '1.3.6.1.2.1.47.1.1.1.1.11.1',
    '1.0.8802.1.1.2.1.4.1.1.9',              // LLDP, with 8802 over two bytes
    '1.3.6.1.4.1.9.1.1208',
  ]) {
    const tlv = b.readTLV(b.encodeOid(oid), 0);
    assert.equal(b.decodeOid(tlv.value), oid);
  }
});

test('octet strings: text stays text, binary becomes hex', () => {
  assert.equal(b.decodeOctets(Buffer.from('GigabitEthernet1/0/1')), 'GigabitEthernet1/0/1');
  assert.equal(b.decodeOctets(Buffer.from([0x00, 0x1b, 0x54, 0xc2, 0x0a, 0x3f])),
    '00:1b:54:c2:0a:3f');
  assert.equal(b.decodeOctets(Buffer.alloc(0)), '');
});

test('nested TLVs parse at the right offsets', () => {
  const inner = Buffer.concat([b.encodeOid('1.3.6.1.2.1.1.5.0'), b.tlv(0x04, Buffer.from('sw1'))]);
  const seq = b.tlv(0x30, inner);
  const outer = b.readTLV(seq, 0);
  const oid = b.readTLV(seq, outer.start);
  const val = b.readTLV(seq, oid.next);
  assert.equal(b.decodeOid(oid.value), '1.3.6.1.2.1.1.5.0');
  assert.equal(val.value.toString(), 'sw1');
});

test('a truncated datagram is rejected, not read past', () => {
  assert.throws(() => b.readTLV(Buffer.from([0x30, 0x20, 0x01]), 0), /past the datagram/);
});

// ── RFC 3414 A.3, "maplesyrup" ──────────────────────────────────────────────
const ENGINE = Buffer.from('000000000000000000000002', 'hex');

test('password to key, MD5 (RFC 3414 A.3.1)', () => {
  assert.equal(hex(b.passwordToKey('maplesyrup', 'md5')),
    '9faf3283884e92834ebc9847d8edd963');
});

test('localised key, MD5 (RFC 3414 A.3.1)', () => {
  const ku = b.passwordToKey('maplesyrup', 'md5');
  assert.equal(hex(b.localiseKey(ku, ENGINE, 'md5')),
    '526f5eed9fcce26f8964c2930787d82b');
});

test('password to key, SHA-1 (RFC 3414 A.3.2)', () => {
  assert.equal(hex(b.passwordToKey('maplesyrup', 'sha1')),
    '9fb5cc0381497b37935289 39ff788d5d79145211'.replace(/\s/g, ''));
});

test('localised key, SHA-1 (RFC 3414 A.3.2)', () => {
  const ku = b.passwordToKey('maplesyrup', 'sha1');
  assert.equal(hex(b.localiseKey(ku, ENGINE, 'sha1')),
    '6695febc928 8e36282235fc7151f128497b38f3f'.replace(/\s/g, ''));
});
