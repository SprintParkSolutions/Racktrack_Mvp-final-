// BER/DER encoding and decoding for SNMP, in the browser.
//
// A direct port of the codec in the NetBox build's SNMP engine, which is
// written against the RFCs rather than pulled from npm and has been proven
// against three real switches. The only change is the container: that one runs
// on Node and uses Buffer, this one runs in a WebView and uses plain byte
// arrays. Everything else — the tag table, the length rules, the OID packing,
// the decision to render an unprintable OCTET STRING as hex — is the same, on
// purpose. Two implementations that drift are worse than one that is copied.
//
// Nothing here knows about sockets. It turns a request into bytes and bytes
// into values; sending them is the native plugin's job.

export const T = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  OPAQUE: 0x44,
  COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
  GET: 0xa0,
  GET_NEXT: 0xa1,
  RESPONSE: 0xa2,
  GET_BULK: 0xa5,
  REPORT: 0xa8,
};

// ── Base64, for the trip across the native bridge ──────────────────────────
// Done in chunks: String.fromCharCode(...bytes) on a full interface table
// overflows the argument limit and throws, which looked like a protocol bug
// the first time it happened.

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

// ── Encoding ───────────────────────────────────────────────────────────────

function encodeLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return [0x80 | bytes.length, ...bytes];
}

/** tag + length + value, the shape every BER element takes. */
export const tlv = (tag, value) => [tag, ...encodeLength(value.length), ...value];

/** Two's complement, minimal length, which is what DER requires. */
export function encodeInt(tag, n) {
  const bytes = [];
  let v = Math.trunc(n);
  if (v === 0) bytes.push(0);
  if (v > 0) {
    while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
    if (bytes[0] & 0x80) bytes.unshift(0);
  } else if (v < 0) {
    while (v < -1) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
    if (!(bytes[0] & 0x80)) bytes.unshift(0xff);
  }
  return tlv(tag, bytes);
}

export function encodeStr(tag, str) {
  const bytes = [];
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    // Community strings are ASCII in practice, but a pasted one can carry a
    // stray non-ASCII character; encode it properly rather than truncating.
    for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  return tlv(tag, bytes);
}

/** One subidentifier, base-128 with a continuation bit on every byte but the last. */
function pushArc(out, arc) {
  if (arc < 0x80) { out.push(arc); return; }
  const chunk = [];
  let v = arc;
  while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  chunk[chunk.length - 1] &= 0x7f;
  out.push(...chunk);
}

/**
 * The first two arcs are folded into ONE subidentifier (arc0 × 40 + arc1),
 * which is then base-128 encoded like every other one (X.690 §8.19.4). That
 * fold is the piece of BER that looks wrong until you know the rule — and it
 * is also where the server's codec cuts a corner, writing the folded value as
 * a single raw byte. Fine for every OID that starts 1.3 or 1.0, which is all
 * of SNMP; wrong for a first pair that folds past 255. Done properly here.
 */
export function encodeOid(oid) {
  const arcs = String(oid).replace(/^\./, '').split('.').map(Number);
  if (arcs.length < 2 || arcs.some((a) => !Number.isInteger(a) || a < 0)) {
    throw new Error(`not an OID: ${oid}`);
  }
  // X.690: the first arc is 0, 1 or 2, and under 0 or 1 the second is < 40.
  if (arcs[0] > 2 || (arcs[0] < 2 && arcs[1] > 39)) {
    throw new Error(`not an OID: ${oid}`);
  }
  const out = [];
  pushArc(out, arcs[0] * 40 + arcs[1]);
  for (const arc of arcs.slice(2)) pushArc(out, arc);
  return tlv(T.OID, out);
}

// ── Decoding ───────────────────────────────────────────────────────────────

/** Read one TLV at `pos`. Returns the tag, the value slice and what follows. */
export function readTLV(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('truncated reply');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let head = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported length field');
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + buf[pos + 2 + i];
    head = 2 + count;
  }
  const start = pos + head;
  const end = start + len;
  if (end > buf.length) throw new Error('length runs past the datagram');
  return { tag, start, end, value: buf.subarray(start, end), next: end };
}

export function decodeInt(buf) {
  if (buf.length === 0) return 0;
  let n = buf[0] & 0x80 ? -1 : 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

/** Unsigned, for Counter32 / Gauge32 / TimeTicks, which are never negative. */
export function decodeUint(buf) {
  let n = 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

export function decodeOid(buf) {
  if (buf.length === 0) return '';
  // Read every base-128 subidentifier first, then unfold the first one: under
  // 40 it was 0.x, under 80 it was 1.x, anything above is 2.(v − 80). Reading
  // the first byte alone, as the server does, is right only while that fold
  // fits in seven bits.
  const subs = [];
  let v = 0;
  for (const b of buf) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) { subs.push(v); v = 0; }
  }
  const first = subs[0];
  const arc0 = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [arc0, first - arc0 * 40, ...subs.slice(1)].join('.');
}

/**
 * An OCTET STRING is a bag of bytes and the MIB does not say which kind. A MAC
 * address, a chassis id and a system description all arrive the same way.
 * Printable ASCII becomes text; anything else becomes hex, because a mangled
 * string in a serial number field is worse than an obvious hex blob.
 */
export function decodeOctets(buf) {
  if (buf.length === 0) return '';
  let printable = true;
  for (const b of buf) {
    if (!((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d)) {
      printable = false;
      break;
    }
  }
  if (printable) return new TextDecoder().decode(buf).replace(/\s+$/, '');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

export function decodeValue(tag, value) {
  switch (tag) {
    case T.INTEGER: return decodeInt(value);
    case T.COUNTER32:
    case T.GAUGE32:
    case T.TIMETICKS:
    case T.COUNTER64: return decodeUint(value);
    case T.OID: return decodeOid(value);
    case T.IP_ADDRESS: return [...value].join('.');
    case T.OCTET_STRING:
    case T.OPAQUE: return decodeOctets(value);
    case T.NULL: return null;
    case T.NO_SUCH_OBJECT: return { absent: 'noSuchObject' };
    case T.NO_SUCH_INSTANCE: return { absent: 'noSuchInstance' };
    case T.END_OF_MIB_VIEW: return { absent: 'endOfMibView' };
    default: return decodeOctets(value);
  }
}

export const isAbsent = (v) => Boolean(v) && typeof v === 'object' && 'absent' in v;

/** The PDU error codes, so a refusal can be named rather than numbered. */
export const PDU_ERRORS = [
  'noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr',
  'noAccess', 'wrongType', 'wrongLength', 'wrongEncoding', 'wrongValue',
  'noCreation', 'inconsistentValue', 'resourceUnavailable', 'commitFailed',
  'undoFailed', 'authorizationError', 'notWritable', 'inconsistentName',
];
