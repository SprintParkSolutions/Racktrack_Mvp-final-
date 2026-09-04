/**
 * SNMP client, written against the RFCs rather than pulled from npm.
 *
 * Why not a library: this server's dependency list is express, multer, cors,
 * dotenv and archiver. Adding a native or semi-maintained SNMP package to talk
 * to customer switches means adding a supply chain to a tool that is pointed
 * at customer infrastructure, and the protocol surface actually needed here is
 * small and completely specified. BER, one message format, three PDU types.
 *
 * Implements:
 *   v2c              RFC 3416 GetRequest / GetNextRequest / GetBulkRequest
 *   v3 USM           RFC 3414 discovery, HMAC-MD5-96 and HMAC-SHA-96 auth,
 *                    DES-CBC and AES-128-CFB privacy
 *   v3 SHA-256       RFC 7860 usmHMAC192SHA256
 *
 * Deliberately NOT implemented: SET. There is no write path to a customer
 * switch anywhere in this codebase, the same way there is no delete call to
 * NetBox. A read-only tool should be read-only in its transport layer, where
 * the guarantee is structural rather than a matter of discipline.
 */
const crypto = require('crypto');
const dgram = require('dgram');

// ── BER / DER ───────────────────────────────────────────────────────────────

const T = {
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

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, value) =>
  Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);

/** Two's complement, minimal length, which is what DER requires. */
function encodeInt(tag, n) {
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
  return tlv(tag, Buffer.from(bytes));
}

function encodeOid(oid) {
  const arcs = String(oid).replace(/^\./, '').split('.').map(Number);
  if (arcs.length < 2 || arcs.some((a) => !Number.isFinite(a))) {
    throw new Error(`not an OID: ${oid}`);
  }
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    if (arc < 0x80) { out.push(arc); continue; }
    const chunk = [];
    let v = arc;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    chunk[chunk.length - 1] &= 0x7f;
    out.push(...chunk);
  }
  return tlv(T.OID, Buffer.from(out));
}

/** Read one TLV at `pos`. Returns the tag, the value slice and its offset. */
function readTLV(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('truncated BER');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let head = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported BER length');
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + buf[pos + 2 + i];
    head = 2 + count;
  }
  const start = pos + head;
  const end = start + len;
  if (end > buf.length) throw new Error('BER length runs past the datagram');
  return { tag, start, end, value: buf.subarray(start, end), next: end };
}

function decodeInt(buf) {
  if (buf.length === 0) return 0;
  let n = buf[0] & 0x80 ? -1 : 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

/** Unsigned, for Counter32 / Gauge32 / TimeTicks, which are never negative. */
function decodeUint(buf) {
  let n = 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

function decodeOid(buf) {
  if (buf.length === 0) return '';
  const arcs = [Math.floor(buf[0] / 40), buf[0] % 40];
  let v = 0;
  for (const b of buf.subarray(1)) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) { arcs.push(v); v = 0; }
  }
  return arcs.join('.');
}

/**
 * An OCTET STRING is a bag of bytes and the MIB does not say which kind. A
 * MAC address, a chassis id and a system description all arrive the same way.
 * Printable ASCII becomes text; anything else becomes hex, because a mangled
 * string in a serial number field is worse than an obvious hex blob.
 */
function decodeOctets(buf) {
  if (buf.length === 0) return '';
  const printable = buf.every((b) => (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d);
  if (printable) return buf.toString('utf8').replace(/\s+$/, '');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function decodeValue(tag, value) {
  switch (tag) {
    case T.INTEGER: return decodeInt(value);
    case T.COUNTER32:
    case T.GAUGE32:
    case T.TIMETICKS: return decodeUint(value);
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

const isAbsent = (v) => Boolean(v) && typeof v === 'object' && 'absent' in v;

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * A failure that names what the operator has to fix. "No response" and "wrong
 * password" are different jobs for different people, and an SNMP agent that
 * refuses is almost always a configuration problem someone can act on.
 */
class SnmpError extends Error {
  constructor(kind, message, hint = '') {
    super(message);
    this.name = 'SnmpError';
    this.kind = kind;
    this.hint = hint;
  }
}

const PDU_ERRORS = [
  'noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr',
  'noAccess', 'wrongType', 'wrongLength', 'wrongEncoding', 'wrongValue',
  'noCreation', 'inconsistentValue', 'resourceUnavailable', 'commitFailed',
  'undoFailed', 'authorizationError', 'notWritable', 'inconsistentName',
];

/** The USM counters an agent reports instead of answering. */
const USM_REPORTS = {
  '1.3.6.1.6.3.15.1.1.1.0': ['unsupportedSecLevel', 'The agent does not offer the security level asked for.'],
  '1.3.6.1.6.3.15.1.1.2.0': ['notInTimeWindow', 'The clocks are out of step. Retried automatically.'],
  '1.3.6.1.6.3.15.1.1.3.0': ['unknownUserName', 'The agent has no SNMPv3 user by that name.'],
  '1.3.6.1.6.3.15.1.1.4.0': ['unknownEngineId', 'Engine discovery did not settle.'],
  '1.3.6.1.6.3.15.1.1.5.0': ['wrongDigest', 'The authentication password or protocol is wrong.'],
  '1.3.6.1.6.3.15.1.1.6.0': ['decryptionError', 'The privacy password or protocol is wrong.'],
};

// ── USM key handling (RFC 3414 §2.6, RFC 7860) ──────────────────────────────

const AUTH = {
  md5:     { hash: 'md5',    keyLen: 16, macLen: 12 },
  sha:     { hash: 'sha1',   keyLen: 20, macLen: 12 },
  sha256:  { hash: 'sha256', keyLen: 32, macLen: 24 },
};

const PRIV = {
  des:    { cipher: 'des-cbc',     keyLen: 16, blockSize: 8 },
  aes:    { cipher: 'aes-128-cfb', keyLen: 16, blockSize: 1 },
};

/**
 * Password to key: hash exactly 1,048,576 bytes of the password repeated.
 *
 * The million bytes are not decoration. They are the whole reason an SNMPv3
 * password cannot be brute-forced at wire speed, and getting the count wrong
 * produces a key that is perfectly self-consistent and rejected by every real
 * agent, with no diagnostic beyond wrongDigest.
 */
function passwordToKey(password, hashName) {
  const pw = Buffer.from(password, 'utf8');
  if (pw.length === 0) throw new SnmpError('config', 'The password is empty.');
  const h = crypto.createHash(hashName);
  const block = Buffer.alloc(64);
  let written = 0;
  let i = 0;
  while (written < 1048576) {
    for (let b = 0; b < 64; b += 1) { block[b] = pw[i % pw.length]; i += 1; }
    h.update(block);
    written += 64;
  }
  return h.digest();
}

/** Localise a key to one agent, so a stolen key is useless against the rest. */
const localiseKey = (key, engineId, hashName) =>
  crypto.createHash(hashName).update(Buffer.concat([key, engineId, key])).digest();

/** Extend a localised key to the cipher's length (RFC 3826 §3.1.2.1). */
function extendKey(key, need, engineId, hashName) {
  let out = key;
  while (out.length < need) {
    out = Buffer.concat([out, localiseKey(out.subarray(out.length - key.length), engineId, hashName)]);
  }
  return out.subarray(0, need);
}

// ── Session ─────────────────────────────────────────────────────────────────

let nextRequestId = Math.floor(Math.random() * 0x7fff) + 1;
const bumpId = () => {
  nextRequestId = nextRequestId >= 0x7ffffffe ? 1 : nextRequestId + 1;
  return nextRequestId;
};

/**
 * One conversation with one agent.
 *
 * Requests are serialised: a rack has a handful of switches and each is polled
 * once, so there is nothing to gain from pipelining and a great deal to lose
 * in matching replies to requests over UDP.
 */
class Session {
  constructor(opts) {
    this.host = opts.host;
    this.port = Number(opts.port) || 161;
    // The UI speaks 'v1' / 'v2c' / 'v3' because that is what a switch's own
    // configuration screen calls them. Normalised here rather than at every
    // call site.
    this.version = String(opts.version || '2c').replace(/^v/, '');
    this.timeout = Number(opts.timeout) || 3000;
    this.retries = Number.isInteger(opts.retries) ? opts.retries : 1;

    if (this.version === '2c' || this.version === '1') {
      this.community = Buffer.from(opts.community || '', 'utf8');
    } else if (this.version === '3') {
      this.user = String(opts.username ?? opts.user ?? '');
      this.level = opts.securityLevel || opts.level || 'authPriv';
      this.authProto = AUTH[String(opts.authProtocol || opts.authProto || 'sha').toLowerCase()];
      this.privProto = PRIV[String(opts.privProtocol || opts.privProto || 'aes').toLowerCase()];
      if (this.level !== 'noAuthNoPriv' && !this.authProto) {
        throw new SnmpError('config', 'Unsupported authentication protocol.',
          'This build offers MD5, SHA-1 and SHA-256.');
      }
      if (this.level === 'authPriv' && !this.privProto) {
        throw new SnmpError('config', 'Unsupported privacy protocol.',
          'This build offers DES and AES-128.');
      }
      this.authPass = opts.authKey || '';
      this.privPass = opts.privKey || '';
      this.engineId = Buffer.alloc(0);
      this.engineBoots = 0;
      this.engineTime = 0;
      this.syncedAt = 0;
      this.msgId = bumpId();
    } else {
      throw new SnmpError('config', `Unknown SNMP version: ${this.version}`);
    }

    this.socket = null;
    this.closed = false;
  }

  open() {
    if (this.socket) return this.socket;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', () => {});   // handled per-request, below
    this.socket.unref();
    return this.socket;
  }

  close() {
    this.closed = true;
    if (this.socket) { try { this.socket.close(); } catch { /* already gone */ } }
    this.socket = null;
  }

  /** Send one datagram and wait for the reply that matches it. */
  transact(payload, matches) {
    const sock = this.open();
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let timer = null;
      let done = false;

      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.removeListener('message', onMessage);
        sock.removeListener('error', onError);
        if (err) reject(err); else resolve(value);
      };

      const onMessage = (msg) => {
        let parsed;
        try { parsed = matches(msg); } catch { return; }   // not ours, or malformed
        if (parsed) finish(null, parsed);
      };

      const onError = (err) => finish(new SnmpError('network',
        `Could not reach ${this.host}:${this.port}. ${err.message}`,
        'Check the management IP and that UDP 161 is open from this host.'));

      const attemptSend = () => {
        attempt += 1;
        sock.send(payload, 0, payload.length, this.port, this.host, (err) => {
          if (err) onError(err);
        });
        timer = setTimeout(() => {
          if (attempt > this.retries) {
            finish(new SnmpError('timeout',
              `${this.host} did not answer in ${this.timeout} ms.`,
              'The agent may be unreachable, SNMP may be disabled, or an ACL '
              + 'on the switch may not list this host.'));
            return;
          }
          attemptSend();
        }, this.timeout);
      };

      sock.on('message', onMessage);
      sock.on('error', onError);
      attemptSend();
    });
  }

  // ── v2c ───────────────────────────────────────────────────────────────

  buildV2c(pduTag, requestId, varbinds, extra = {}) {
    const pdu = tlv(pduTag, Buffer.concat([
      encodeInt(T.INTEGER, requestId),
      encodeInt(T.INTEGER, extra.nonRepeaters ?? 0),
      encodeInt(T.INTEGER, extra.maxRepetitions ?? 0),
      tlv(T.SEQUENCE, Buffer.concat(varbinds.map((oid) =>
        tlv(T.SEQUENCE, Buffer.concat([encodeOid(oid), tlv(T.NULL, Buffer.alloc(0))]))))),
    ]));
    return tlv(T.SEQUENCE, Buffer.concat([
      encodeInt(T.INTEGER, 1),               // version 1 == SNMPv2c
      tlv(T.OCTET_STRING, this.community),
      pdu,
    ]));
  }

  parseV2c(msg, requestId) {
    const outer = readTLV(msg, 0);
    if (outer.tag !== T.SEQUENCE) return null;
    let p = outer.start;
    const version = readTLV(msg, p); p = version.next;
    const community = readTLV(msg, p); p = community.next;
    const pdu = readTLV(msg, p);
    if (pdu.tag !== T.RESPONSE) return null;

    let q = pdu.start;
    const rid = readTLV(msg, q); q = rid.next;
    if (decodeInt(rid.value) !== requestId) return null;
    const errStatus = readTLV(msg, q); q = errStatus.next;
    const errIndex = readTLV(msg, q); q = errIndex.next;

    return {
      errorStatus: decodeInt(errStatus.value),
      errorIndex: decodeInt(errIndex.value),
      varbinds: parseVarbinds(msg, readTLV(msg, q)),
    };
  }

  // ── v3 ────────────────────────────────────────────────────────────────

  securityParams({ authParams, privParams, engineId, boots, time }) {
    return tlv(T.OCTET_STRING, tlv(T.SEQUENCE, Buffer.concat([
      tlv(T.OCTET_STRING, engineId),
      encodeInt(T.INTEGER, boots),
      encodeInt(T.INTEGER, time),
      tlv(T.OCTET_STRING, Buffer.from(this.user, 'utf8')),
      tlv(T.OCTET_STRING, authParams),
      tlv(T.OCTET_STRING, privParams),
    ])));
  }

  keys() {
    if (this._keys && this._keys.engine.equals(this.engineId)) return this._keys;
    const authKey = this.authProto
      ? localiseKey(passwordToKey(this.authPass, this.authProto.hash), this.engineId, this.authProto.hash)
      : null;
    let privKey = null;
    if (this.privProto && this.level === 'authPriv') {
      const base = localiseKey(
        passwordToKey(this.privPass || this.authPass, this.authProto.hash),
        this.engineId, this.authProto.hash,
      );
      privKey = base.length >= this.privProto.keyLen
        ? base.subarray(0, this.privProto.keyLen)
        : extendKey(base, this.privProto.keyLen, this.engineId, this.authProto.hash);
    }
    this._keys = { engine: Buffer.from(this.engineId), authKey, privKey };
    return this._keys;
  }

  /** The agent's notion of now, extrapolated from the last sync. */
  currentEngineTime() {
    if (!this.syncedAt) return this.engineTime;
    return this.engineTime + Math.floor((Date.now() - this.syncedAt) / 1000);
  }

  encryptScoped(scopedPdu) {
    const { privKey } = this.keys();
    const boots = this.engineBoots;
    if (this.privProto.cipher === 'des-cbc') {
      const key = privKey.subarray(0, 8);
      const preIv = privKey.subarray(8, 16);
      const salt = Buffer.alloc(8);
      salt.writeInt32BE(boots, 0);
      crypto.randomFillSync(salt, 4, 4);
      const iv = Buffer.alloc(8);
      for (let i = 0; i < 8; i += 1) iv[i] = preIv[i] ^ salt[i];
      const pad = 8 - (scopedPdu.length % 8);
      const padded = Buffer.concat([scopedPdu, Buffer.alloc(pad === 0 ? 8 : pad, pad)]);
      const c = crypto.createCipheriv('des-cbc', key, iv);
      c.setAutoPadding(false);
      return { data: Buffer.concat([c.update(padded), c.final()]), salt };
    }
    // AES-128-CFB: IV is boots, time and the salt, so it never repeats.
    const salt = crypto.randomBytes(8);
    const iv = Buffer.alloc(16);
    iv.writeInt32BE(boots, 0);
    iv.writeInt32BE(this.currentEngineTime(), 4);
    salt.copy(iv, 8);
    const c = crypto.createCipheriv('aes-128-cfb', privKey, iv);
    return { data: Buffer.concat([c.update(scopedPdu), c.final()]), salt };
  }

  decryptScoped(data, salt, boots, time) {
    const { privKey } = this.keys();
    if (this.privProto.cipher === 'des-cbc') {
      const key = privKey.subarray(0, 8);
      const preIv = privKey.subarray(8, 16);
      const iv = Buffer.alloc(8);
      for (let i = 0; i < 8; i += 1) iv[i] = preIv[i] ^ salt[i];
      const d = crypto.createDecipheriv('des-cbc', key, iv);
      d.setAutoPadding(false);
      return Buffer.concat([d.update(data), d.final()]);
    }
    const iv = Buffer.alloc(16);
    iv.writeInt32BE(boots, 0);
    iv.writeInt32BE(time, 4);
    salt.copy(iv, 8);
    const d = crypto.createDecipheriv('aes-128-cfb', privKey, iv);
    return Buffer.concat([d.update(data), d.final()]);
  }

  buildV3(pduTag, requestId, varbinds, extra = {}, discovery = false) {
    const msgId = bumpId();
    const authed = !discovery && this.level !== 'noAuthNoPriv';
    const encrypted = !discovery && this.level === 'authPriv';
    // reportable | priv | auth
    const flags = (discovery ? 0x04 : 0x04) | (encrypted ? 0x02 : 0) | (authed ? 0x01 : 0);

    const pdu = tlv(pduTag, Buffer.concat([
      encodeInt(T.INTEGER, requestId),
      encodeInt(T.INTEGER, extra.nonRepeaters ?? 0),
      encodeInt(T.INTEGER, extra.maxRepetitions ?? 0),
      tlv(T.SEQUENCE, Buffer.concat(varbinds.map((oid) =>
        tlv(T.SEQUENCE, Buffer.concat([encodeOid(oid), tlv(T.NULL, Buffer.alloc(0))]))))),
    ]));

    const scoped = tlv(T.SEQUENCE, Buffer.concat([
      tlv(T.OCTET_STRING, this.engineId),
      tlv(T.OCTET_STRING, Buffer.alloc(0)),
      pdu,
    ]));

    let msgData = scoped;
    let privParams = Buffer.alloc(0);
    if (encrypted) {
      const { data, salt } = this.encryptScoped(scoped);
      msgData = tlv(T.OCTET_STRING, data);
      privParams = salt;
    }

    const header = tlv(T.SEQUENCE, Buffer.concat([
      encodeInt(T.INTEGER, msgId),
      encodeInt(T.INTEGER, 65507),          // the largest a UDP datagram can be
      tlv(T.OCTET_STRING, Buffer.from([flags])),
      encodeInt(T.INTEGER, 3),              // USM
    ]));

    const macLen = authed ? this.authProto.macLen : 0;
    const sec = this.securityParams({
      authParams: Buffer.alloc(macLen),
      privParams,
      engineId: discovery ? Buffer.alloc(0) : this.engineId,
      boots: discovery ? 0 : this.engineBoots,
      time: discovery ? 0 : this.currentEngineTime(),
    });

    let message = tlv(T.SEQUENCE, Buffer.concat([
      encodeInt(T.INTEGER, 3),
      header,
      sec,
      msgData,
    ]));

    if (authed) {
      // The digest covers the whole message with the digest field zeroed, so
      // it has to be written back in place afterwards rather than appended.
      const { authKey } = this.keys();
      const mac = crypto.createHmac(this.authProto.hash, authKey)
        .update(message).digest().subarray(0, macLen);
      mac.copy(message, findAuthOffset(message));
    }

    return { message, msgId };
  }

  parseV3(msg, msgId, requestId) {
    const outer = readTLV(msg, 0);
    if (outer.tag !== T.SEQUENCE) return null;
    let p = outer.start;
    const version = readTLV(msg, p); p = version.next;
    if (decodeInt(version.value) !== 3) return null;

    const header = readTLV(msg, p); p = header.next;
    let h = header.start;
    const gotMsgId = readTLV(msg, h); h = gotMsgId.next;
    if (decodeInt(gotMsgId.value) !== msgId) return null;
    h = readTLV(msg, h).next;                    // msgMaxSize, not used
    const flags = readTLV(msg, h); h = flags.next;
    const encrypted = Boolean(flags.value[0] & 0x02);

    const secWrap = readTLV(msg, p); p = secWrap.next;
    const sec = readTLV(msg, secWrap.start);
    let s = sec.start;
    const engineId = readTLV(msg, s); s = engineId.next;
    const boots = readTLV(msg, s); s = boots.next;
    const time = readTLV(msg, s); s = time.next;
    s = readTLV(msg, s).next;                    // msgUserName, echoed back
    const authParams = readTLV(msg, s); s = authParams.next;
    const privParams = readTLV(msg, s);

    const engine = {
      id: Buffer.from(engineId.value),
      boots: decodeInt(boots.value),
      time: decodeInt(time.value),
    };

    // Verify the digest before trusting anything inside the message. An agent
    // that cannot prove it holds the key does not get to tell us a serial.
    if (this.level !== 'noAuthNoPriv' && authParams.value.length > 0) {
      const copy = Buffer.from(msg);
      copy.fill(0, authParams.start, authParams.end);
      const { authKey } = this.keys();
      const want = crypto.createHmac(this.authProto.hash, authKey)
        .update(copy).digest().subarray(0, authParams.value.length);
      if (!crypto.timingSafeEqual(want, authParams.value)) {
        throw new SnmpError('auth', 'The reply failed its authentication check.',
          'Either the password is wrong or something answered that is not the switch.');
      }
    }

    let scopedBuf;
    let scopedStart;
    const data = readTLV(msg, p);
    if (encrypted) {
      const plain = this.decryptScoped(
        data.value, Buffer.from(privParams.value), engine.boots, engine.time,
      );
      scopedBuf = plain;
      scopedStart = 0;
    } else {
      scopedBuf = msg;
      scopedStart = p;
    }

    const scoped = readTLV(scopedBuf, scopedStart);
    let sp = scoped.start;
    sp = readTLV(scopedBuf, sp).next;            // contextEngineID
    sp = readTLV(scopedBuf, sp).next;            // contextName
    const pdu = readTLV(scopedBuf, sp);

    let q = pdu.start;
    const rid = readTLV(scopedBuf, q); q = rid.next;
    const errStatus = readTLV(scopedBuf, q); q = errStatus.next;
    const errIndex = readTLV(scopedBuf, q); q = errIndex.next;
    const varbinds = parseVarbinds(scopedBuf, readTLV(scopedBuf, q));

    if (pdu.tag === T.REPORT) return { report: true, engine, varbinds };
    if (pdu.tag !== T.RESPONSE) return null;
    if (decodeInt(rid.value) !== requestId) return null;

    return {
      engine,
      errorStatus: decodeInt(errStatus.value),
      errorIndex: decodeInt(errIndex.value),
      varbinds,
    };
  }

  /** Ask the agent who it is. Unauthenticated by definition: nothing is known yet. */
  async discover() {
    const requestId = bumpId();
    const { message, msgId } = this.buildV3(T.GET, requestId, [], {}, true);
    const reply = await this.transact(message, (msg) => this.parseV3(msg, msgId, requestId));
    if (!reply?.engine?.id?.length) {
      throw new SnmpError('protocol', 'The agent did not return an engine id.',
        'It answered, but not as an SNMPv3 agent. Check that v3 is enabled.');
    }
    this.engineId = reply.engine.id;
    this.engineBoots = reply.engine.boots;
    this.engineTime = reply.engine.time;
    this.syncedAt = Date.now();
    this._keys = null;
    return reply.engine;
  }

  /** One request/response, retrying once on a clock-skew report. */
  async request(pduTag, oids, extra = {}) {
    if (this.version === '3' && !this.engineId.length) await this.discover();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = bumpId();
      let reply;
      if (this.version === '3') {
        const { message, msgId } = this.buildV3(pduTag, requestId, oids, extra);
        reply = await this.transact(message, (msg) => this.parseV3(msg, msgId, requestId));
      } else {
        const message = this.buildV2c(pduTag, requestId, oids, extra);
        reply = await this.transact(message, (msg) => this.parseV2c(msg, requestId));
      }

      if (reply.report) {
        const vb = reply.varbinds[0];
        const known = USM_REPORTS[vb?.oid];
        if (known && known[0] === 'notInTimeWindow' && attempt === 0) {
          this.engineBoots = reply.engine.boots;
          this.engineTime = reply.engine.time;
          this.syncedAt = Date.now();
          continue;
        }
        throw new SnmpError('auth',
          known ? `The switch refused: ${known[0]}.` : 'The switch returned a report PDU.',
          known ? known[1] : `Counter ${vb?.oid}`);
      }

      if (reply.errorStatus) {
        throw new SnmpError('protocol',
          `The agent answered with ${PDU_ERRORS[reply.errorStatus] || reply.errorStatus}.`,
          reply.errorStatus === 1
            ? 'The reply did not fit in one datagram. Fewer OIDs per request would help.'
            : '');
      }
      return reply.varbinds;
    }
    throw new SnmpError('auth', 'The switch would not settle on a time window.',
      'Its clock moved between the two attempts.');
  }

  get(oids) {
    return this.request(T.GET, Array.isArray(oids) ? oids : [oids]);
  }

  /**
   * Walk one subtree.
   *
   * GETBULK on v2c and v3, GETNEXT on v1. `limit` is a hard stop: a walk of a
   * mistyped OID can otherwise march through the agent's entire MIB, and on a
   * busy switch that is a self-inflicted denial of service.
   */
  async walk(base, { limit = 3000, chunk = 25 } = {}) {
    const prefix = `${String(base).replace(/^\./, '')}.`;
    const rows = [];
    let cursor = String(base).replace(/^\./, '');

    while (rows.length < limit) {
      const useBulk = this.version !== '1';
      const vbs = await this.request(
        useBulk ? T.GET_BULK : T.GET_NEXT,
        [cursor],
        useBulk ? { nonRepeaters: 0, maxRepetitions: chunk } : {},
      );
      if (vbs.length === 0) break;

      let advanced = false;
      for (const vb of vbs) {
        if (!vb.oid.startsWith(prefix)) return rows;
        if (isAbsent(vb.value)) return rows;
        rows.push({ ...vb, index: vb.oid.slice(prefix.length) });
        cursor = vb.oid;
        advanced = true;
        if (rows.length >= limit) return rows;
      }
      if (!advanced) break;
    }
    return rows;
  }
}

function parseVarbinds(buf, listTlv) {
  const out = [];
  let p = listTlv.start;
  while (p < listTlv.end) {
    const entry = readTLV(buf, p);
    let q = entry.start;
    const oid = readTLV(buf, q); q = oid.next;
    const val = readTLV(buf, q);
    out.push({ oid: decodeOid(oid.value), type: val.tag, value: decodeValue(val.tag, val.value) });
    p = entry.next;
  }
  return out;
}

/**
 * Where the digest lives in a message we just built.
 *
 * The security parameters are the third field of the message and the digest is
 * the fifth field inside them, so it is found by structure rather than by
 * searching for a run of zero bytes: a zeroed privacy salt or an engine id
 * with a zero byte in it would both match a search and corrupt the message.
 */
function findAuthOffset(message) {
  const outer = readTLV(message, 0);
  let p = outer.start;
  p = readTLV(message, p).next;          // msgVersion
  p = readTLV(message, p).next;          // msgGlobalData
  const secWrap = readTLV(message, p);
  const sec = readTLV(message, secWrap.start);
  let s = sec.start;
  s = readTLV(message, s).next;          // engine id
  s = readTLV(message, s).next;          // boots
  s = readTLV(message, s).next;          // time
  s = readTLV(message, s).next;          // user
  return readTLV(message, s).start;      // auth params
}

module.exports = {
  Session, SnmpError, T,
  // exported for the unit tests, which are the only way to check a codec that
  // has no switch to talk to
  _internal: {
    encodeInt, encodeOid, encodeLength, readTLV, decodeInt, decodeOid,
    decodeOctets, decodeValue, passwordToKey, localiseKey, tlv,
  },
};
