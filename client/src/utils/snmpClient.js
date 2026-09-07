// SNMP, spoken by the phone itself.
//
// The server cannot reach a switch that lives on the customer's own network —
// it sits in a data centre, the switch sits behind their firewall on a private
// address. The phone is standing next to it on the same Wi-Fi. So the phone
// asks, and this is what does the asking.
//
// Two dialects:
//   v2c   a community string. What the D-Link answers to.
//   v3    a user name, at the noAuthNoPriv level — no password check and no
//         encryption, which is how the TP-Links are configured today (and how
//         every stored reading of them was taken). It needs USM engine
//         discovery and the v3 message shape, and no cryptography at all.
//
// v3 WITH authentication or privacy is deliberately not here yet. It means
// SHA and AES running in the WebView, and the switches are not set up to need
// it, so nothing on this screen can fail for a reason we would have to untangle
// from the question it exists to answer: can a phone talk to a switch? That path
// is written and proven on the server against RFC 3414's own vectors; it comes
// to the phone as its own step once these switches are hardened.
//
// READ ONLY. GET, GETNEXT and GETBULK. There is no SET here, the same way there
// is none in the server's engine — a read-only tool should be read-only in its
// transport, where the guarantee is structural rather than a matter of
// discipline.
//
// This is a port of the server's snmp.js, kept line-for-line where the protocol
// is concerned, so that when one misbehaves the other is a reference rather
// than a second design to hold in your head.

import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  T, tlv, encodeInt, encodeStr, encodeOid, readTLV,
  decodeInt, decodeValue, decodeOid, isAbsent, PDU_ERRORS,
  bytesToB64, b64ToBytes,
} from './snmpBer';

const SnmpUdp = registerPlugin('SnmpUdp');

/**
 * Reading a switch needs a UDP socket, and a web page is not allowed one —
 * only the installed app is. Checked here, once, so the reason is said in
 * words that name the fix rather than letting Capacitor's own '"SnmpUdp"
 * plugin is not implemented on web' reach someone standing at a rack.
 */
export const canReadSwitches = () => Capacitor.isNativePlatform();

export const OID = {
  sysDescr:    '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime:   '1.3.6.1.2.1.1.3.0',
  sysName:     '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  sysContact:  '1.3.6.1.2.1.1.4.0',

  // ENTITY-MIB. The standard place for model and serial — and empty on every
  // switch we have tested so far, which is why the model is also parsed out of
  // sysDescr below. Asked for anyway: when a switch does implement it, it is
  // the switch stating its own identity, which beats any amount of parsing.
  entPhysicalSerialNum: '1.3.6.1.2.1.47.1.1.1.1.11',
  entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13',

  ifDescr:      '1.3.6.1.2.1.2.2.1.2',
  ifType:       '1.3.6.1.2.1.2.2.1.3',
  ifAdminStatus:'1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName:       '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed:  '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias:      '1.3.6.1.2.1.31.1.1.1.18',

  // The port's own hardware address, and whether it negotiated full duplex.
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  dot3Duplex:    '1.3.6.1.2.1.10.7.2.1.19',

  // BRIDGE-MIB / Q-BRIDGE-MIB: the forwarding table — every MAC the switch has
  // learned and the port it learned it on. This is how a port says what is
  // plugged into it when nothing on the other end speaks LLDP, which on the
  // switches we have tested is almost everything.
  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  dot1qTpFdbPort:       '1.3.6.1.2.1.17.7.1.2.2.1.2',
  dot1dTpFdbPort:       '1.3.6.1.2.1.17.4.3.1.2',

  // IP-MIB: the ARP cache, which turns a learned MAC into an IP address.
  ipNetToMediaMac: '1.3.6.1.2.1.4.22.1.2',

  // Our own end of a neighbour: the local port number LLDP reports, and the
  // name that goes with it. Read rather than derived — the number is LLDP's
  // own port numbering, which on the TP-Links is neither the ifIndex (49153+)
  // nor anything a person would recognise.
  lldpLocPortId:    '1.0.8802.1.1.2.1.3.7.1.3',
  lldpRemPortId:    '1.0.8802.1.1.2.1.4.1.1.7',
  lldpRemSysName:   '1.0.8802.1.1.2.1.4.1.1.9',
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
};

/**
 * What the maker's own MIB says about the box.
 *
 * ENTITY-MIB is the standard place for a serial number and neither of the
 * switches in the lab answers it. Both makers publish a private MIB that does,
 * and it is documented support in both cases — so where we already know the
 * vendor (from sysObjectID), we ask that vendor's own leaves. One GET, four
 * or five values.
 *
 * Named OIDs only, never a walk of the private tree: the D-Link keeps a
 * masked password at .1.7.0, and a blind walk would fetch it and file it on
 * the server. We ask for the four things we want and nothing else.
 */
const VENDOR_FACTS = {
  'TP-Link': {
    model:    '1.3.6.1.4.1.11863.6.1.1.2.0',
    hardware: '1.3.6.1.4.1.11863.6.1.1.5.0',
    firmware: '1.3.6.1.4.1.11863.6.1.1.6.0',
    serial:   '1.3.6.1.4.1.11863.6.1.1.8.0',
  },
  'D-Link': {
    hardware: '1.3.6.1.4.1.171.11.153.1000.1.2.0',
    firmware: '1.3.6.1.4.1.171.11.153.1000.1.3.0',
  },
};

/** ifDuplex, as the switch's own settings page words it. */
const DUPLEX = { 1: 'unknown', 2: 'half', 3: 'full' };

/** Six decimal arcs of an OID index, as a MAC address. */
const macFromArcs = (arcs) =>
  arcs.map((n) => Number(n).toString(16).padStart(2, '0')).join(':');

/** The USM counters an agent reports instead of answering (RFC 3414 §6). */
export const USM_REPORTS = {
  '1.3.6.1.6.3.15.1.1.1.0': ['unsupportedSecLevel', 'The switch does not offer the security level asked for.'],
  '1.3.6.1.6.3.15.1.1.2.0': ['notInTimeWindow', 'The clocks are out of step. Retried automatically.'],
  '1.3.6.1.6.3.15.1.1.3.0': ['unknownUserName', 'The switch has no SNMPv3 user by that name.'],
  '1.3.6.1.6.3.15.1.1.4.0': ['unknownEngineId', 'Engine discovery did not settle.'],
  '1.3.6.1.6.3.15.1.1.5.0': ['wrongDigest', 'The authentication password or protocol is wrong.'],
  '1.3.6.1.6.3.15.1.1.6.0': ['decryptionError', 'The privacy password or protocol is wrong.'],
};

/**
 * sysObjectID starts 1.3.6.1.4.1.<enterprise>, and the enterprise number names
 * the vendor even when sysDescr is a marketing paragraph. Copied from the
 * server's table so both agree; TP-Link registered more than one.
 */
const ENTERPRISE = {
  9: 'Cisco', 11: 'HP', 25506: 'H3C', 2011: 'Huawei', 2636: 'Juniper',
  171: 'D-Link', 1916: 'Extreme Networks', 1991: 'Foundry', 4526: 'NETGEAR',
  674: 'Dell', 6027: 'Dell Force10', 30065: 'Arista', 14988: 'MikroTik',
  890: 'Zyxel', 41112: 'Ubiquiti', 12356: 'Fortinet', 259: 'Accton',
  5003: 'Nortel', 4413: 'Broadcom', 3955: 'Linksys', 8072: 'Net-SNMP',
  2620: 'Check Point', 11863: 'TP-Link', 35265: 'TP-Link',
  52642: 'TP-Link Omada', 43356: 'Cambium',
};

export function vendorOf(sysObjectID) {
  const m = String(sysObjectID || '').match(/^1\.3\.6\.1\.4\.1\.(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return ENTERPRISE[n] || `enterprise ${n}`;
}

/**
 * The model, pulled out of whatever the switch says about itself.
 *
 * These switches leave ENTITY-MIB empty, so they never state their model in
 * the standard place — but it is almost always sitting in sysDescr as a token
 * ("WS6-DGS-1210-52/F1 6.30.016"), and when it is not, it is often what the
 * device has been named ("SG2428P"). Both are checked, description first,
 * because a name can be changed by whoever set the switch up and a description
 * cannot.
 */
const MODEL_PATTERNS = [
  // TP-Link. The TL- prefix is optional: the Omada SG2428P reports its model
  // bare, and requiring the prefix matched nothing on a real switch.
  /\b(?:TL-)?S[GL]-?\d{3,4}[A-Z]{0,3}\b/i,
  /\bD[GEX]S-?\d{3,4}(?:-\d{1,2})?[A-Z]{0,2}\b/i,  // D-Link DGS-1210-52
  /\bCatalyst\s?[A-Z0-9-]+/i,
  /\bWS-C[A-Z0-9-]+/i,
  /\bC9\d{3}[A-Z0-9-]*/i,
  /\bGS\d{3}[A-Z0-9]*/i,                           // NETGEAR GS724T
  /\bJ[LG]\d{3}[A-Z]\b/i,                          // Aruba / HP JL256A
  /\bICX\d{4}[A-Z0-9-]*/i,                         // Ruckus ICX7150
];

export function modelFrom(sysDescr, sysName) {
  for (const source of [sysDescr, sysName]) {
    const s = String(source || '');
    if (!s) continue;
    for (const re of MODEL_PATTERNS) {
      const hit = s.match(re);
      if (hit) return hit[0].toUpperCase();
    }
  }
  return null;
}

/** A failure that names what someone can actually go and fix. */
export class SnmpError extends Error {
  constructor(kind, message, hint = '') {
    super(message);
    this.name = 'SnmpError';
    this.kind = kind;
    this.hint = hint;
  }
}

// One counter for request ids and v3 message ids, as the server does. Starts
// at a random point so two app launches do not replay the same sequence.
let nextId = Math.floor(Math.random() * 0x7fff) + 1;
const bump = () => {
  nextId = nextId >= 0x7ffffffe ? 1 : nextId + 1;
  return nextId;
};

const EMPTY = [];

/** OID + NULL varbind list, the request shape for every PDU type here. */
const varbindList = (oids) => tlv(T.SEQUENCE, oids.flatMap((oid) =>
  tlv(T.SEQUENCE, [...encodeOid(oid), ...tlv(T.NULL, EMPTY)])));

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

// ── The session ────────────────────────────────────────────────────────────

export class Snmp {
  constructor(opts) {
    this.host = String(opts.host || '').trim();
    this.port = Number(opts.port) || 161;
    this.timeoutMs = Number(opts.timeoutMs) || 3000;
    this.retries = Number.isInteger(opts.retries) ? opts.retries : 1;
    // The UI speaks 'v2c' / 'v3' because that is what a switch's own settings
    // screen calls them. Normalised here rather than at every call site.
    this.version = String(opts.version || 'v2c').replace(/^v/, '');

    if (this.version === '2c' || this.version === '1') {
      this.community = opts.community ?? '';
    } else if (this.version === '3') {
      this.user = String(opts.username ?? opts.user ?? '');
      this.level = opts.securityLevel || opts.level || 'noAuthNoPriv';
      if (this.level !== 'noAuthNoPriv') {
        throw new SnmpError('config',
          'This build reads SNMPv3 without a password only.',
          'Authentication and encryption (authNoPriv, authPriv) come in the next '
          + 'build. Set the switch user to noAuthNoPriv to test now.');
      }
      if (!this.user) {
        throw new SnmpError('config', 'An SNMPv3 user name is required.');
      }
      this.engineId = new Uint8Array(0);
      this.engineBoots = 0;
      this.engineTime = 0;
      this.syncedAt = 0;
    } else {
      throw new SnmpError('config', `Unknown SNMP version: ${opts.version}`);
    }
  }

  // ── transport ────────────────────────────────────────────────────────

  /**
   * One datagram out, one back, with retries — a dropped packet is not a
   * failure. `matches` turns raw bytes into a result or null; null means the
   * reply was for some other request and we keep waiting for ours.
   */
  async transact(messageBytes, matches) {
    if (!canReadSwitches()) {
      throw new SnmpError('web',
        'A web browser cannot read a switch.',
        'Open this rack in the RackTrack app on a phone that is on the same network '
        + 'as the switch. A browser is not allowed to make the kind of network '
        + 'connection SNMP needs; the app is.');
    }
    const data = bytesToB64(Uint8Array.from(messageBytes));
    let last = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const reply = await SnmpUdp.query({
          host: this.host, port: this.port, timeoutMs: this.timeoutMs, data,
        });
        const parsed = matches(b64ToBytes(reply.data));
        if (parsed) return parsed;
        last = new SnmpError('mismatch', 'The reply did not match the request.');
      } catch (e) {
        if (e instanceof SnmpError) throw e;        // our own parse-time refusals
        // The native side reports a timeout as a rejection; keep its wording,
        // it is better than anything reconstructed here.
        last = new SnmpError(e.code || 'failed', e.message || String(e));
        if (e.code && e.code !== 'timeout') throw last;
      }
    }
    throw last || new SnmpError('failed', 'No answer.');
  }

  // ── v2c ──────────────────────────────────────────────────────────────

  buildV2c(pduTag, requestId, oids, extra = {}) {
    const pdu = tlv(pduTag, [
      ...encodeInt(T.INTEGER, requestId),
      ...encodeInt(T.INTEGER, extra.nonRepeaters ?? 0),
      ...encodeInt(T.INTEGER, extra.maxRepetitions ?? 0),
      ...varbindList(oids),
    ]);
    return tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, 1),                 // version 1 == SNMPv2c
      ...encodeStr(T.OCTET_STRING, this.community),
      ...pdu,
    ]);
  }

  parseV2c(msg, requestId) {
    const outer = readTLV(msg, 0);
    if (outer.tag !== T.SEQUENCE) return null;
    let p = outer.start;
    p = readTLV(msg, p).next;                     // version
    p = readTLV(msg, p).next;                     // community, echoed back
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

  // ── v3, noAuthNoPriv ─────────────────────────────────────────────────

  /** The agent's notion of now, extrapolated from the last sync. */
  currentEngineTime() {
    if (!this.syncedAt) return this.engineTime;
    return this.engineTime + Math.floor((Date.now() - this.syncedAt) / 1000);
  }

  /**
   * RFC 3412 message: version, global header, USM security parameters, and
   * the scoped PDU in the clear. Discovery sends an empty engine id and zero
   * boots/time, which is how an agent knows to answer with a REPORT carrying
   * its real ones.
   */
  buildV3(pduTag, requestId, oids, extra = {}, discovery = false) {
    const msgId = bump();
    const flags = 0x04;                           // reportable; no auth, no priv

    const pdu = tlv(pduTag, [
      ...encodeInt(T.INTEGER, requestId),
      ...encodeInt(T.INTEGER, extra.nonRepeaters ?? 0),
      ...encodeInt(T.INTEGER, extra.maxRepetitions ?? 0),
      ...varbindList(oids),
    ]);

    const scoped = tlv(T.SEQUENCE, [
      ...tlv(T.OCTET_STRING, [...this.engineId]), // contextEngineID
      ...tlv(T.OCTET_STRING, EMPTY),              // contextName
      ...pdu,
    ]);

    const header = tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, msgId),
      ...encodeInt(T.INTEGER, 65507),             // the largest a UDP datagram can be
      ...tlv(T.OCTET_STRING, [flags]),
      ...encodeInt(T.INTEGER, 3),                 // USM
    ]);

    const sec = tlv(T.OCTET_STRING, tlv(T.SEQUENCE, [
      ...tlv(T.OCTET_STRING, discovery ? EMPTY : [...this.engineId]),
      ...encodeInt(T.INTEGER, discovery ? 0 : this.engineBoots),
      ...encodeInt(T.INTEGER, discovery ? 0 : this.currentEngineTime()),
      ...encodeStr(T.OCTET_STRING, this.user),
      ...tlv(T.OCTET_STRING, EMPTY),              // authParams: none at this level
      ...tlv(T.OCTET_STRING, EMPTY),              // privParams: none at this level
    ]));

    const message = tlv(T.SEQUENCE, [
      ...encodeInt(T.INTEGER, 3),
      ...header,
      ...sec,
      ...scoped,
    ]);
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
    h = readTLV(msg, h).next;                     // msgMaxSize, not used
    const flags = readTLV(msg, h);
    const encrypted = Boolean(flags.value[0] & 0x02);

    const secWrap = readTLV(msg, p); p = secWrap.next;
    const sec = readTLV(msg, secWrap.start);
    let s = sec.start;
    const engineId = readTLV(msg, s); s = engineId.next;
    const boots = readTLV(msg, s); s = boots.next;
    const time = readTLV(msg, s);
    const engine = {
      id: Uint8Array.from(engineId.value),
      boots: decodeInt(boots.value),
      time: decodeInt(time.value),
    };

    // At noAuthNoPriv nothing is encrypted. A switch that answers encrypted
    // has been configured for a level this build does not speak; say so
    // rather than trying to parse ciphertext as a PDU.
    if (encrypted) {
      throw new SnmpError('config', 'The switch answered with an encrypted message.',
        'It is configured for authPriv. This build reads noAuthNoPriv only.');
    }

    const scoped = readTLV(msg, p);
    let sp = scoped.start;
    sp = readTLV(msg, sp).next;                   // contextEngineID
    sp = readTLV(msg, sp).next;                   // contextName
    const pdu = readTLV(msg, sp);

    let q = pdu.start;
    const rid = readTLV(msg, q); q = rid.next;
    const errStatus = readTLV(msg, q); q = errStatus.next;
    const errIndex = readTLV(msg, q); q = errIndex.next;
    const varbinds = parseVarbinds(msg, readTLV(msg, q));

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

  /** Ask the agent who it is. Nothing is known yet, so nothing is claimed. */
  async discover() {
    const requestId = bump();
    const { message, msgId } = this.buildV3(T.GET, requestId, [], {}, true);
    let reply;
    try {
      reply = await this.transact(message, (msg) => this.parseV3(msg, msgId, requestId));
    } catch (e) {
      // Silence here is the very first v3 packet going unanswered, which is a
      // different problem from a refused user name and worth saying so. What
      // happened is stated; why it happened is not something this end can see,
      // so the hint asks rather than tells.
      if (e instanceof SnmpError && e.kind === 'timeout') {
        throw new SnmpError('timeout', e.message,
          'Nothing came back from the SNMPv3 discovery — the first packet, before '
          + 'any user name is sent. Check the address, and that SNMPv3 is enabled '
          + 'on the switch.');
      }
      throw e;
    }
    if (!reply?.engine?.id?.length) {
      throw new SnmpError('protocol', 'The switch did not return an engine id.',
        'It answered, but not as an SNMPv3 agent. Check that v3 is enabled.');
    }
    this.engineId = reply.engine.id;
    this.engineBoots = reply.engine.boots;
    this.engineTime = reply.engine.time;
    this.syncedAt = Date.now();
    return reply.engine;
  }

  // ── one request, either dialect ──────────────────────────────────────

  /** One request/response, retrying once on a clock-skew report. */
  async request(pduTag, oids, extra = {}) {
    if (this.version === '3' && !this.engineId.length) await this.discover();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = bump();
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
        const name = PDU_ERRORS[reply.errorStatus] || `error ${reply.errorStatus}`;
        throw new SnmpError('pdu', `The switch refused the request (${name}).`,
          reply.errorStatus === 1 ? 'Ask for fewer values at once.' : '');
      }
      return reply.varbinds;
    }
    throw new SnmpError('auth', 'The switch would not settle on a time window.',
      'Its clock moved between the two attempts.');
  }

  /** Read named values. Absent ones come back null rather than invented. */
  async get(oids) {
    const rows = await this.request(T.GET, oids);
    const map = {};
    rows.forEach((row, i) => { map[oids[i]] = isAbsent(row.value) ? null : row.value; });
    return map;
  }

  /**
   * Walk a table with GETBULK, falling back to GETNEXT on a switch that will
   * not do bulk. Stops at the first OID outside the subtree, which is what
   * keeps a mistyped OID from marching through the agent's entire MIB.
   */
  async walk(base, { limit = 2000, chunk = 20 } = {}) {
    const rows = [];
    let cursor = base;
    let bulk = true;

    while (rows.length < limit) {
      let batch;
      try {
        batch = bulk
          ? await this.request(T.GET_BULK, [cursor], { maxRepetitions: chunk })
          : await this.request(T.GET_NEXT, [cursor]);
      } catch (e) {
        if (bulk && e.kind === 'pdu') { bulk = false; continue; }
        throw e;
      }
      if (!batch.length) break;

      let done = false;
      let advanced = false;
      for (const row of batch) {
        if (!row.oid.startsWith(`${base}.`) || isAbsent(row.value)) { done = true; break; }
        rows.push({ index: row.oid.slice(base.length + 1), value: row.value });
        cursor = row.oid;
        advanced = true;
      }
      // A reply that stays inside the subtree but never moves the cursor would
      // spin here forever. It should not happen; a switch that does it once
      // would otherwise hang the phone until the walk limit ran out.
      if (done || !advanced) break;
    }
    return rows;
  }
}

// ── What the test screen asks for ──────────────────────────────────────────

/** A single round trip (two for v3), to prove the switch is there and the login is right. */
export async function testLogin(config) {
  const s = new Snmp(config);
  // Six values, one datagram. sysLocation and sysContact are free at this
  // point and are the only two fields on a switch a person has written.
  const r = await s.get([OID.sysDescr, OID.sysName, OID.sysObjectID, OID.sysUpTime,
    OID.sysLocation, OID.sysContact]);
  const sysDescr = r[OID.sysDescr];
  const sysName = r[OID.sysName];
  return {
    sysName: sysName || null,
    sysDescr: sysDescr || null,
    vendor: vendorOf(r[OID.sysObjectID]),
    model: modelFrom(sysDescr, sysName),
    location: r[OID.sysLocation] || null,
    contact: r[OID.sysContact] || null,
    uptime: r[OID.sysUpTime] || null,
    engineId: s.engineId?.length ? [...s.engineId].map((b) => b.toString(16).padStart(2, '0')).join('') : null,
  };
}

// Loopbacks, tunnels, VLAN interfaces, aggregates — and 53 (propVirtual),
// which is what several vendors call the VLAN interface a switch answers on.
// None of them is a socket on the front of the box.
const IF_TYPE_SKIP = new Set([24, 23, 131, 135, 136, 161, 53]);

/**
 * ...and the ones that lie about their type.
 *
 * The TP-Link SG2428P reports "Vlan-interface1" as ifType 6, ethernetCsmacd —
 * the same type as the 28 sockets on the front. Believing it made a 28-port
 * switch a 29-port switch. Nothing physical is called this.
 */
const NOT_A_SOCKET = /vlan|loopback|^lo\d|tunnel|null ?0|port-?channel|^po\d|aggregat|^ae\d/i;

/** Everything the rack cares about: what it is, its ports, and its neighbours. */
export async function readSwitch(config, onProgress = () => {}, onPartial = () => {}) {
  const s = new Snmp(config);

  // A table a switch does not implement is answered with silence, and silence
  // costs a full timeout and then the retry. Asked with a short fuse and no
  // retry instead: a switch that offers none of the optional tables costs a
  // few seconds rather than a minute, and an empty answer is recorded as "not
  // offered" rather than failing the reading.
  const soft = async (oid, limit = 4096) => {
    const t = s.timeoutMs; const r = s.retries;
    s.timeoutMs = 1500; s.retries = 0;
    try { return await s.walk(oid, { limit }); } catch { return []; } finally { s.timeoutMs = t; s.retries = r; }
  };

  // ── What it is ──
  // One round trip, and the two things a person is waiting to see. Handed back
  // immediately rather than at the end: the make and model are known in a
  // fraction of a second, and holding them until the ports, the forwarding
  // table and LLDP are all in made a switch look unreadable for seven seconds
  // when it had already answered.
  onProgress('Asking what it is');
  const identity = await testLogin(config);
  onPartial({ kind: 'hello', ...identity });

  // One table at a time, not seven at once. The native side runs a small
  // thread pool, and a phone on office Wi-Fi loses datagrams under load — a
  // burst of parallel walks turns into retries and reads slower than doing it
  // in order. A switch also tends to have one SNMP worker; asking politely
  // gets a faster answer than asking seven times simultaneously.
  // Say which table, not just "reading the ports". Seven walks of a 52-port
  // switch take a while, and one message held for all of them reads as a
  // screen that has stopped rather than one that is working. It is also where
  // a person's Stop lands: the caller's progress callback is free to throw.
  onProgress('Reading the port names');
  const names  = await s.walk(OID.ifName);
  onProgress('Reading the port descriptions');
  const descrs = names.length ? [] : await s.walk(OID.ifDescr);
  onProgress('Reading which ports are up');
  const oper   = await s.walk(OID.ifOperStatus);

  // Draw the faceplate here, off two tables, and fill in the rest underneath.
  // The SG2428P answers about 280 ms per request; waiting for all seven
  // interface tables before showing anything left a switch that had already
  // named all 28 of its ports looking unread for four seconds.
  {
    const q = (rows) => Object.fromEntries(rows.map((r) => [r.index, r.value]));
    const QN = q(names.length ? names : descrs); const QO = q(oper);
    const quick = Object.keys(QN)
      .filter((i) => !NOT_A_SOCKET.test(String(QN[i] || '')))
      .sort((a, b) => Number(a) - Number(b))
      .map((i) => ({
        index: Number(i), name: QN[i], descr: null,
        up: Number(QO[i]) === 1, enabled: true, speedMbps: null, type: 6,
      }));
    onPartial({
      kind: 'full', ...identity, serial: null,
      interfaces: quick, neighbours: [], attached: [], gaps: [],
      counts: { ports: quick.length, up: quick.filter((i) => i.up).length, neighbours: 0, attached: 0 },
    });
  }

  onProgress('Reading the rest of the port table');
  const descrs2 = names.length ? await s.walk(OID.ifDescr) : descrs;
  onProgress('Reading which ports are enabled');
  const admin  = await s.walk(OID.ifAdminStatus);
  onProgress('Reading the port speeds');
  const speed  = await s.walk(OID.ifHighSpeed);
  onProgress('Reading the port types');
  const types  = await s.walk(OID.ifType);
  onProgress('Reading the port labels');
  const alias  = await s.walk(OID.ifAlias);

  const by = (rows) => Object.fromEntries(rows.map((r) => [r.index, r.value]));
  const N = by(names); const D = by(descrs2); const O = by(oper);
  const A = by(admin); const S = by(speed); const Y = by(types); const L = by(alias);

  const sockets0 = Object.keys({ ...N, ...D })
    .filter((i) => !IF_TYPE_SKIP.has(Number(Y[i])))
    .filter((i) => !NOT_A_SOCKET.test(String(N[i] || D[i] || '')))
    .sort((a, b) => Number(a) - Number(b))
    .map((i) => ({
      index: Number(i),
      name: N[i] || D[i] || `if${i}`,
      descr: L[i] || null,
      up: Number(O[i]) === 1,
      enabled: Number(A[i]) === 1,
      speedMbps: Number(S[i]) || null,
      // Kept so the screen can tell a socket from a VLAN interface without
      // guessing from the name.
      type: Number(Y[i]) || null,
    }));
  const interfaces = sockets0;
  onPartial({
    kind: 'full', ...identity, serial: null,
    interfaces, neighbours: [], attached: [], gaps: [],
    counts: { ports: interfaces.length, up: interfaces.filter((i) => i.up).length, neighbours: 0, attached: 0 },
  });

  // ── Everything that takes longer ──
  onProgress('Asking the maker what this is');
  // The vendor's own record, where we know the vendor. This is where the
  // serial number actually lives on these switches.
  let vendorFacts = {};
  const leaves = VENDOR_FACTS[identity.vendor];
  if (leaves) {
    const t = s.timeoutMs; const r = s.retries;
    s.timeoutMs = 1500; s.retries = 0;
    try {
      const got = await s.get(Object.values(leaves));
      for (const [key, oid] of Object.entries(leaves)) {
        const v = got[oid];
        if (v && String(v).trim()) vendorFacts[key] = String(v).trim();
      }
    } catch { vendorFacts = {}; } finally { s.timeoutMs = t; s.retries = r; }
  }

  onProgress('Asking for its serial');
  // Almost always empty on these switches. Asked anyway, and left empty when
  // it is — an empty serial is a fact, a filled-in one would be a liability.
  // Soft, because a switch without ENTITY-MIB says nothing at all, and this
  // sat between "what is it" and "what are its ports" costing six seconds on
  // every TP-Link read.
  const entSerial = (await soft(OID.entPhysicalSerialNum, 64))
    .map((e) => e.value).find((v) => v && String(v).trim()) || null;
  // ENTITY-MIB first when it answers — it is the standard and the switch
  // stating it in the standard place. The maker's own MIB is the fallback,
  // which on both of these switches is the only one that answers.
  const serial = entSerial || vendorFacts.serial || null;

  onProgress('Reading how much each port has carried');
  const IN = by(await soft(OID.ifHCInOctets));
  const OUT = by(await soft(OID.ifHCOutOctets));

  onProgress('Reading the port hardware addresses');
  const M = by(await soft(OID.ifPhysAddress));
  onProgress('Reading how the ports negotiated');
  const X = by(await soft(OID.dot3Duplex));
  for (const i of interfaces) {
    i.mac = M[i.index] || null;
    i.duplex = DUPLEX[Number(X[i.index])] || null;
    // Counters, not rates. A single reading of a counter says how much has
    // gone through the port since the switch last booted, which is a fact;
    // calling it a speed would not be. The screen turns two readings into a
    // rate, because then there is an interval to divide by.
    i.octetsIn = Number(IN[i.index]) || 0;
    i.octetsOut = Number(OUT[i.index]) || 0;
  }
  const nameOfIndex = new Map(interfaces.map((i) => [i.index, i.name]));

  onProgress('Asking who its neighbours are');
  let neighbours = [];
  // LLDP numbers our ports its own way. This is the table that says which
  // socket each of those numbers is.
  const locName = by(await soft(OID.lldpLocPortId, 256));
  try {
    const remName = await s.walk(OID.lldpRemSysName, { limit: 256 });
    const remPort = await s.walk(OID.lldpRemPortId, { limit: 256 });
    const remChassis = await soft(OID.lldpRemChassisId, 256);
    const P = by(remPort); const C = by(remChassis); const NM = by(remName);
    // A neighbour that does not send a system name is still a neighbour. The
    // TP-Links report three of them with the name field empty and only a
    // chassis id, and taking the name column as the list meant the screen said
    // there were none.
    const seen = [...new Set([...remName, ...remPort, ...remChassis].map((r) => r.index))];
    neighbours = seen.map((idx) => {
      // The index is time.localPort.entry — the middle arc is our own port,
      // in LLDP's numbering. Named from LLDP's own local-port table, falling
      // back to the interface table, and finally to the bare number rather
      // than to a name that would be somebody else's port.
      const local = String(idx).split('.')[1];
      return {
        sysName: NM[idx] || C[idx] || 'unnamed',
        port: P[idx] || null,
        localPort: locName[local] || nameOfIndex.get(Number(local)) || (local ? `port ${local}` : null),
        named: Boolean(NM[idx]),
      };
    });
  } catch { /* LLDP switched off is a finding, not a failure */ }

  // ── What is plugged in ──
  //
  // The forwarding table is the switch's own record of every device it has
  // heard from and the port it heard it on. LLDP is a courtesy the other end
  // has to offer; this is bookkeeping the switch does whether anyone asks or
  // not, so it sees laptops, cameras, phones and printers that announce
  // nothing. The ARP cache then puts an IP address to some of those MACs.
  onProgress('Reading what is plugged into each port');
  const bridgeToIf = new Map(
    (await soft(OID.dot1dBasePortIfIndex)).map((r) => [String(r.index), Number(r.value)]),
  );
  // Q-BRIDGE indexes by VLAN and MAC, the older BRIDGE-MIB by MAC alone. Both
  // report a BRIDGE port, its own numbering, which is only sometimes the same
  // as ifIndex — hence the translation table above rather than an assumption.
  const qFdb = await soft(OID.dot1qTpFdbPort, 8192);
  const rawFdb = qFdb.length
    ? qFdb.map((r) => {
      const arcs = String(r.index).split('.');
      return { vlan: Number(arcs[0]), mac: macFromArcs(arcs.slice(1, 7)), port: String(r.value) };
    })
    : (await soft(OID.dot1dTpFdbPort, 8192)).map((r) => {
      const arcs = String(r.index).split('.');
      return { vlan: null, mac: macFromArcs(arcs.slice(0, 6)), port: String(r.value) };
    });

  onProgress('Reading the address cache');
  const ipOfMac = new Map();
  for (const r of await soft(OID.ipNetToMediaMac)) {
    // index = ifIndex.a.b.c.d, value = the MAC at that address.
    const ip = String(r.index).split('.').slice(1).join('.');
    if (r.value) ipOfMac.set(String(r.value).toLowerCase(), ip);
  }

  const attached = rawFdb
    // Port 0 means "learned, but not on a port" — not a fact about cabling.
    .filter((r) => Number(r.port) > 0)
    .map((r) => {
      const ifIndex = bridgeToIf.get(r.port) ?? Number(r.port);
      return {
        mac: r.mac,
        vlan: r.vlan,
        ifIndex,
        port: nameOfIndex.get(ifIndex) || String(ifIndex),
        ip: ipOfMac.get(r.mac) || null,
      };
    })
    // The switch's own address on its uplink is itself, not something plugged in.
    .filter((d) => !interfaces.some((i) => i.mac && i.mac.toLowerCase() === d.mac));

  for (const i of interfaces) {
    i.attached = attached.filter((d) => d.ifIndex === i.index).length;
  }

  // What the switch did not say. Each line states only that — what was asked
  // for and not given. Why it was not given is not something a reading can
  // know, and a guess written in the same voice as a measurement reads as one.
  const gaps = [];
  if (!serial) gaps.push('No serial number.');
  if (!identity.model) gaps.push('No model.');
  if (!neighbours.length) gaps.push('No LLDP neighbours.');
  if (!attached.length) gaps.push('No forwarding table.');

  return {
    ...identity,
    ...vendorFacts,          // hardware, firmware, and the model the maker states
    model: vendorFacts.model || identity.model,
    serial,
    readAt: new Date().toISOString(),
    interfaces,
    neighbours,
    attached,
    gaps,
    counts: {
      ports: interfaces.length,
      up: interfaces.filter((i) => i.up).length,
      neighbours: neighbours.length,
      attached: attached.length,
    },
  };
}

/**
 * The phone's reading, in the shape the server stores.
 *
 * The NetBox side of the server was written for readings its own collector
 * took, and everything downstream — reconcile, the review screen, the export
 * — consumes that one shape (see any data/netbox/switch-data/*.json). Now the
 * phone takes the reading and posts it up, so it has to arrive looking the
 * same. Fields the phone does not read (MTU, duplex, PVID, per-port MAC, VLANs,
 * ARP, IP addresses) are null or empty rather than guessed — an absent value
 * is a fact, an invented one is a liability. `source` says who read it.
 */
export function toServerReading(r, { tookMs = null } = {}) {
  const interfaces = (r.interfaces || []).map((i) => ({
    ifIndex: i.index,
    name: i.name,
    alias: i.descr ?? null,
    type: 'ethernet',
    operStatus: i.up ? 'up' : 'down',
    adminStatus: i.enabled ? 'up' : 'down',
    speedMbps: i.speedMbps ?? null,
    mtu: null, pvid: null,
    duplex: i.duplex ?? null,
    mac: i.mac ?? null,
  }));
  const neighbours = (r.neighbours || []).map((n) => ({
    localPort: n.localPort ?? null,
    localPortName: n.localPort ?? null,
    remoteSysName: n.named ? n.sysName : null,
    remotePortDesc: null,
    remotePortId: n.port ?? null,
    chassisId: n.named ? null : (n.sysName ?? null),
  }));
  // Every device the switch has learned about, with the port it learned it on
  // — the server's `macs` field, which its own collector fills the same way.
  const macs = (r.attached || []).map((d) => ({
    mac: d.mac, vlan: d.vlan ?? null, ifIndex: d.ifIndex ?? null,
    port: d.port ?? null, ip: d.ip ?? null,
  }));
  const arp = macs.filter((d) => d.ip).map((d) => ({ ip: d.ip, mac: d.mac }));
  const model = r.model ?? null;
  return {
    collectedAt: new Date().toISOString(),
    tookMs,
    source: 'phone',
    localChassisId: null,
    identity: {
      model, serial: r.serial ?? null, manufacturer: r.vendor ?? null,
      hardwareRev: r.hardware ?? null, firmwareRev: r.firmware ?? null, softwareRev: null,
      stackMembers: 0, members: [],
    },
    system: {
      sysName: r.sysName ?? null,
      sysDescr: r.sysDescr ?? null,
      sysLocation: r.location ?? null, sysContact: r.contact ?? null,
      uptimeSeconds: r.uptime != null ? Math.floor(Number(r.uptime) / 100) : null,
      vendor: r.vendor ?? null,
      derivedModel: model,           // the server's own name for "model read out of sysDescr"
    },
    interfaces,
    neighbours,
    vlans: [], ipAddrs: [], arp, macs,
    counts: {
      interfaces: interfaces.length,
      interfacesUp: interfaces.filter((i) => i.operStatus === 'up').length,
      neighbours: neighbours.length,
      vlans: 0, ipAddrs: 0, arp: arp.length, macs: macs.length,
    },
    gaps: [...(r.gaps || [])],
  };
}
