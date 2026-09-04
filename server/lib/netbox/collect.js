/**
 * What to ask a switch, and what its answers mean.
 *
 * Everything here is a vendor-neutral standard MIB, which is the point: one
 * code path covers every managed switch regardless of make. Unmanaged switches
 * and patch panels answer none of it, and those stay the camera's job
 * permanently.
 *
 * The four that matter, and why:
 *
 *   ENTITY-MIB    Model and serial, stated by the device about itself. No
 *                 photograph of a sticker competes with this.
 *   IF-MIB        The real port list: names, descriptions, speed, up or down.
 *   LLDP-MIB      "My port 12 connects to their port 24." Proven cables.
 *   SNMPv2-MIB    Hostname and description, to match against the label on the
 *                 front of the box.
 */
const { Session, SnmpError } = require('./snmp');

const OID = {
  sysDescr:    '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime:   '1.3.6.1.2.1.1.3.0',
  sysContact:  '1.3.6.1.2.1.1.4.0',
  sysName:     '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',

  entPhysicalDescr:       '1.3.6.1.2.1.47.1.1.1.1.2',
  entPhysicalContainedIn: '1.3.6.1.2.1.47.1.1.1.1.4',
  entPhysicalClass:       '1.3.6.1.2.1.47.1.1.1.1.5',
  entPhysicalName:        '1.3.6.1.2.1.47.1.1.1.1.7',
  entPhysicalHardwareRev: '1.3.6.1.2.1.47.1.1.1.1.8',
  entPhysicalFirmwareRev: '1.3.6.1.2.1.47.1.1.1.1.9',
  entPhysicalSoftwareRev: '1.3.6.1.2.1.47.1.1.1.1.10',
  entPhysicalSerialNum:   '1.3.6.1.2.1.47.1.1.1.1.11',
  entPhysicalMfgName:     '1.3.6.1.2.1.47.1.1.1.1.12',
  entPhysicalModelName:   '1.3.6.1.2.1.47.1.1.1.1.13',

  ifDescr:       '1.3.6.1.2.1.2.2.1.2',
  ifType:        '1.3.6.1.2.1.2.2.1.3',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus:  '1.3.6.1.2.1.2.2.1.8',
  ifMtu:         '1.3.6.1.2.1.2.2.1.4',
  ifName:        '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed:   '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias:       '1.3.6.1.2.1.31.1.1.1.18',
  dot3Duplex:    '1.3.6.1.2.1.10.7.2.1.19',   // EtherLike-MIB, per ifIndex

  // IP-MIB: addresses configured on the switch, and the ARP cache.
  ipAdEntIfIndex: '1.3.6.1.2.1.4.20.1.2',     // index = the IP, value = ifIndex
  ipAdEntNetMask: '1.3.6.1.2.1.4.20.1.3',
  ipNetToMediaMac: '1.3.6.1.2.1.4.22.1.2',    // index = ifIndex.ip, value = MAC

  // Q-BRIDGE-MIB: VLANs and the access VLAN (PVID) on each bridge port.
  dot1qVlanStaticName: '1.3.6.1.2.1.17.7.1.4.3.1.1',
  dot1qPvid:           '1.3.6.1.2.1.17.7.1.4.5.1.1',

  lldpLocChassisId: '1.0.8802.1.1.2.1.3.2.0',
  lldpLocSysName:  '1.0.8802.1.1.2.1.3.3.0',
  lldpLocPortId:   '1.0.8802.1.1.2.1.3.7.1.3',
  lldpLocPortDesc: '1.0.8802.1.1.2.1.3.7.1.4',
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
  lldpRemPortId:    '1.0.8802.1.1.2.1.4.1.1.7',
  lldpRemPortDesc:  '1.0.8802.1.1.2.1.4.1.1.8',
  lldpRemSysName:   '1.0.8802.1.1.2.1.4.1.1.9',
  lldpRemSysDesc:   '1.0.8802.1.1.2.1.4.1.1.10',

  // BRIDGE-MIB and Q-BRIDGE-MIB: which MAC address is heard on which port.
  // Optional, and asked for separately, because the forwarding table on a busy
  // switch is thousands of rows and the identity of the kit does not depend
  // on it.
  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  dot1dTpFdbPort:       '1.3.6.1.2.1.17.4.3.1.2',
  dot1qTpFdbPort:       '1.3.6.1.2.1.17.7.1.2.2.1.2',
};

/** entPhysicalClass, RFC 6933. Only the ones worth showing an operator. */
const ENT_CLASS = {
  1: 'other', 2: 'unknown', 3: 'chassis', 4: 'backplane', 5: 'container',
  6: 'power supply', 7: 'fan', 8: 'sensor', 9: 'module', 10: 'port',
  11: 'stack', 12: 'cpu',
};

const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'not present', 7: 'lower layer down' };
const DUPLEX = { 1: 'unknown', 2: 'half', 3: 'full' };

/** ifType, IANAifType-MIB. Everything else is reported by number. */
const IF_TYPE = {
  6: 'ethernet', 24: 'loopback', 53: 'virtual', 54: 'multiplexor',
  131: 'tunnel', 135: 'vlan', 136: 'l3 vlan', 161: 'aggregate',
};

/**
 * sysObjectID starts 1.3.6.1.4.1.<enterprise>, and the enterprise number names
 * the vendor even when sysDescr is a marketing paragraph. Only the makes that
 * actually turn up in comms rooms; anything else is reported by its number,
 * which is still a fact rather than a guess.
 */
const ENTERPRISE = {
  9: 'Cisco', 11: 'HP', 25506: 'H3C', 2011: 'Huawei', 2636: 'Juniper',
  171: 'D-Link',
  1916: 'Extreme Networks', 1991: 'Foundry', 4526: 'NETGEAR', 674: 'Dell',
  6027: 'Dell Force10', 30065: 'Arista', 14988: 'MikroTik', 890: 'Zyxel',
  41112: 'Ubiquiti', 12356: 'Fortinet', 259: 'Accton', 5003: 'Nortel',
  4413: 'Broadcom', 3955: 'Linksys', 8072: 'Net-SNMP', 2620: 'Check Point',
  11863: 'TP-Link', 35265: 'TP-Link', 52642: 'TP-Link Omada', 43356: 'Cambium',
};

const text = (v) => (v && typeof v === 'object' ? '' : String(v ?? '').trim());
const present = (v) => (v && typeof v === 'object' ? null : (String(v ?? '').trim() || null));

function vendorOf(sysObjectID) {
  const m = /^1\.3\.6\.1\.4\.1\.(\d+)/.exec(String(sysObjectID || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return ENTERPRISE[n] || `enterprise ${n}`;
}

/**
 * The model, pulled out of the switch's own description string.
 *
 * These budget switches leave ENTITY-MIB empty, so they never state their model
 * in the standard place. But sysDescr almost always contains it as a token
 * ("DGS-1210-52 Gigabit Ethernet Switch", "TL-SG2428P 24-Port ..."). Matching a
 * few known families lets us fill the model over SNMP alone, no photo needed.
 * A miss returns null: we would rather say nothing than grab the wrong token.
 */
const MODEL_PATTERNS = [
  /\bTL-?S[GL]-?\d{3,4}[A-Z]{0,3}\b/i,          // TP-Link  TL-SG2428P
  /\bD[GEX]S-?\d{3,4}(?:-\d{1,2})?[A-Z]{0,2}\b/i, // D-Link  DGS-1210-52, DES-, DXS-
  /\bCatalyst\s?[A-Z0-9-]+/i,                    // Cisco    Catalyst 2960X-24
  /\bWS-C[A-Z0-9-]+/i,                           // Cisco    WS-C2960-24
  /\bC9\d{3}[A-Z0-9-]*/i,                        // Cisco    C9300-48
  /\bGS\d{3}[A-Z0-9]*/i,                         // NETGEAR  GS724T
  /\bJ[LG]\d{3}[A-Z]\b/i,                        // Aruba/HP JL256A
  /\bICX\d{4}[A-Z0-9-]*/i,                       // Ruckus   ICX7150
];
function modelFromDescr(descr) {
  const s = String(descr || '');
  for (const re of MODEL_PATTERNS) {
    const m = re.exec(s);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Centiseconds since the agent started, which is how sysUpTime is counted. */
function uptimeText(ticks) {
  if (!Number.isFinite(ticks)) return null;
  const s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Six decimal arcs of an OID index, as a MAC address. */
const macFromArcs = (arcs) =>
  arcs.map((n) => Number(n).toString(16).padStart(2, '0')).join(':');

/**
 * The forwarding table, VLAN-aware where the switch offers it.
 *
 * Q-BRIDGE indexes by VLAN and MAC, the older BRIDGE-MIB by MAC alone. Both
 * report a *bridge* port number, which is its own index space and is only
 * sometimes equal to ifIndex, so dot1dBasePortIfIndex is walked to translate
 * rather than the two being assumed to match.
 */
async function readMacTable(session) {
  const bridgeToIf = new Map();
  for (const row of await softWalk(session, OID.dot1dBasePortIfIndex, 2048)) {
    bridgeToIf.set(String(row.index), Number(row.value));
  }

  const vlanAware = await softWalk(session, OID.dot1qTpFdbPort, 16384);
  const rows = vlanAware.length
    ? vlanAware.map((row) => {
      const arcs = String(row.index).split('.');
      return { vlan: Number(arcs[0]), mac: macFromArcs(arcs.slice(1, 7)), port: String(row.value) };
    })
    : (await softWalk(session, OID.dot1dTpFdbPort, 16384)).map((row) => {
      const arcs = String(row.index).split('.');
      return { vlan: null, mac: macFromArcs(arcs.slice(0, 6)), port: String(row.value) };
    });

  return rows
    // Port 0 means "learned but not on a port", which is not a fact about
    // cabling and would render as a row pointing nowhere.
    .filter((r) => Number(r.port) > 0)
    .map((r) => ({
      mac: r.mac,
      vlan: r.vlan,
      bridgePort: Number(r.port),
      ifIndex: bridgeToIf.get(r.port) ?? null,
    }));
}

/** Turn a set of parallel column walks into rows keyed by table index. */
function joinColumns(columns) {
  const rows = new Map();
  for (const [name, entries] of Object.entries(columns)) {
    for (const e of entries) {
      if (!rows.has(e.index)) rows.set(e.index, { index: e.index });
      rows.get(e.index)[name] = e.value;
    }
  }
  return [...rows.values()];
}

/**
 * A column walk that tolerates the column not existing.
 *
 * Agents differ about which optional tables they implement, and a switch that
 * has no ENTITY-MIB is a normal switch, not a failure. Losing the whole poll
 * because one optional column is missing would be the wrong trade.
 */
async function softWalk(session, oid, limit) {
  try {
    return await session.walk(oid, { limit });
  } catch (err) {
    if (err instanceof SnmpError && (err.kind === 'protocol' || err.kind === 'timeout')) return [];
    throw err;
  }
}

/**
 * Credentials in, one live switch's own account of itself out.
 *
 * `target` is the stored switch record joined with whatever secrets the caller
 * holds; this module never reads them from disk itself.
 */
async function pollSwitch(target, { maxInterfaces = 1024, macTable = false } = {}) {
  const started = Date.now();
  const session = new Session(target);
  try {
    if (target.version === '3') await session.discover();

    const sys = await session.get([
      OID.sysDescr, OID.sysObjectID, OID.sysUpTime,
      OID.sysContact, OID.sysName, OID.sysLocation,
    ]);
    const [descr, objectId, upTime, contact, name, location] = sys.map((v) => v.value);

    // The switch's own LLDP chassis id (usually its base MAC). This is how a
    // neighbour is matched back to a specific switch when two of them share a
    // sysName, which TP-Link switches do out of the box.
    let localChassisId = null;
    try {
      const r = await session.get([OID.lldpLocChassisId]);
      localChassisId = present(r[0] && r[0].value);
    } catch { /* LLDP off; leave null */ }

    const entity = joinColumns({
      class:    await softWalk(session, OID.entPhysicalClass, 512),
      name:     await softWalk(session, OID.entPhysicalName, 512),
      descr:    await softWalk(session, OID.entPhysicalDescr, 512),
      model:    await softWalk(session, OID.entPhysicalModelName, 512),
      serial:   await softWalk(session, OID.entPhysicalSerialNum, 512),
      mfg:      await softWalk(session, OID.entPhysicalMfgName, 512),
      hardware: await softWalk(session, OID.entPhysicalHardwareRev, 512),
      firmware: await softWalk(session, OID.entPhysicalFirmwareRev, 512),
      software: await softWalk(session, OID.entPhysicalSoftwareRev, 512),
    });

    // A stack reports one chassis per member, so this is a list, not a value.
    const chassis = entity
      .filter((e) => Number(e.class) === 3)
      .map((e) => ({
        index: e.index,
        name: present(e.name),
        descr: present(e.descr),
        model: present(e.model),
        serial: present(e.serial),
        manufacturer: present(e.mfg),
        hardwareRev: present(e.hardware),
        firmwareRev: present(e.firmware),
        softwareRev: present(e.software),
      }));

    const modules = entity
      .filter((e) => [9, 6, 7].includes(Number(e.class)) && present(e.serial))
      .map((e) => ({
        index: e.index,
        kind: ENT_CLASS[Number(e.class)] || 'part',
        name: present(e.name) || present(e.descr),
        model: present(e.model),
        serial: present(e.serial),
      }));

    const ifRows = joinColumns({
      descr: await softWalk(session, OID.ifDescr, maxInterfaces),
      type:  await softWalk(session, OID.ifType, maxInterfaces),
      mtu:   await softWalk(session, OID.ifMtu, maxInterfaces),
      mac:   await softWalk(session, OID.ifPhysAddress, maxInterfaces),
      admin: await softWalk(session, OID.ifAdminStatus, maxInterfaces),
      oper:  await softWalk(session, OID.ifOperStatus, maxInterfaces),
      name:  await softWalk(session, OID.ifName, maxInterfaces),
      speed: await softWalk(session, OID.ifHighSpeed, maxInterfaces),
      alias: await softWalk(session, OID.ifAlias, maxInterfaces),
      duplex: await softWalk(session, OID.dot3Duplex, maxInterfaces),
    });

    // Access VLAN (PVID) is indexed by bridge port, not ifIndex, so map through
    // the base-port table. Without it the PVID column would point at the wrong
    // port on any switch where the two numbering spaces differ.
    const basePortToIf = new Map();
    for (const row of await softWalk(session, OID.dot1dBasePortIfIndex, 4096)) {
      basePortToIf.set(String(row.value), row.index);
    }
    const pvidByIf = new Map();
    for (const row of await softWalk(session, OID.dot1qPvid, 4096)) {
      const ifx = basePortToIf.get(row.index) || row.index;
      pvidByIf.set(String(ifx), Number(row.value) || null);
    }

    const interfaces = ifRows.map((r) => ({
      index: Number(r.index),
      name: present(r.name) || present(r.descr) || `if${r.index}`,
      descr: present(r.descr),
      alias: present(r.alias),
      typeCode: Number(r.type) || null,
      type: IF_TYPE[Number(r.type)] || (r.type ? `type ${r.type}` : null),
      mac: present(r.mac),
      admin: IF_STATUS[Number(r.admin)] || null,
      oper: IF_STATUS[Number(r.oper)] || null,
      speedMbps: Number(r.speed) || null,
      mtu: Number(r.mtu) || null,
      duplex: DUPLEX[Number(r.duplex)] || null,
      pvid: pvidByIf.get(String(r.index)) ?? null,
    })).sort((a, b) => a.index - b.index);

    // VLANs defined on the switch.
    const vlans = (await softWalk(session, OID.dot1qVlanStaticName, 4096))
      .map((row) => ({ id: Number(row.index), name: text(row.value) || `VLAN ${row.index}` }))
      .sort((a, b) => a.id - b.id);

    // IP addresses configured on the switch, joined to their interface.
    const maskByIp = new Map();
    for (const row of await softWalk(session, OID.ipAdEntNetMask, 1024)) maskByIp.set(row.index, text(row.value));
    const ipAddrs = (await softWalk(session, OID.ipAdEntIfIndex, 1024)).map((row) => ({
      ip: row.index, ifIndex: Number(row.value) || null, mask: maskByIp.get(row.index) || null,
    }));

    // ARP cache: which IP answers to which MAC, and on which interface. Joined
    // with the forwarding table below, this is how an end device is placed on a
    // port even when it cannot speak for itself.
    const arp = (await softWalk(session, OID.ipNetToMediaMac, 8192)).map((row) => {
      const parts = String(row.index).split('.');
      const ifIndex = Number(parts[0]) || null;
      const ip = parts.slice(1).join('.');
      return { ifIndex, ip, mac: text(row.value) };
    }).filter((a) => a.mac);

    // LLDP local port numbers are their own index space. Most vendors make
    // them equal to ifIndex and some do not, so the local port is named from
    // the LLDP table itself rather than assumed to match.
    const locPorts = new Map();
    for (const row of await softWalk(session, OID.lldpLocPortId, 512)) {
      locPorts.set(row.index, text(row.value));
    }
    for (const row of await softWalk(session, OID.lldpLocPortDesc, 512)) {
      const better = text(row.value);
      if (better) locPorts.set(row.index, better);
    }

    const remote = joinColumns({
      chassisId: await softWalk(session, OID.lldpRemChassisId, 1024),
      portId:    await softWalk(session, OID.lldpRemPortId, 1024),
      portDescr: await softWalk(session, OID.lldpRemPortDesc, 1024),
      sysName:   await softWalk(session, OID.lldpRemSysName, 1024),
      sysDescr:  await softWalk(session, OID.lldpRemSysDesc, 1024),
    });

    // The index is timeMark.localPortNum.remIndex.
    const neighbours = remote.map((r) => {
      const parts = String(r.index).split('.');
      const localPortNum = parts[1] ?? '';
      return {
        localPortNum,
        localPort: locPorts.get(localPortNum) || `port ${localPortNum}`,
        chassisId: present(r.chassisId),
        remotePort: present(r.portDescr) || present(r.portId),
        remotePortDescr: present(r.portDescr),
        remotePortId: present(r.portId),
        remoteSysName: present(r.sysName),
        remoteDescr: present(r.sysDescr),
      };
    }).sort((a, b) => Number(a.localPortNum) - Number(b.localPortNum));

    const macs = macTable ? await readMacTable(session) : null;

    const physical = interfaces.filter((i) => i.typeCode === 6);

    return {
      ok: true,
      host: target.host,
      localChassisId,
      // The model parsed from sysDescr, used only when ENTITY-MIB gave none.
      derivedModel: modelFromDescr(descr),
      polledAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      durationMs: Date.now() - started,
      system: {
        name: present(name),
        descr: present(descr),
        contact: present(contact),
        location: present(location),
        uptime: uptimeText(Number(upTime)),
        uptimeSeconds: Number.isFinite(Number(upTime)) ? Math.floor(Number(upTime) / 100) : null,
        objectId: present(objectId),
        vendor: vendorOf(objectId),
      },
      chassis,
      modules,
      interfaces,
      neighbours,
      vlans,
      ipAddrs,
      arp,
      macs,
      counts: {
        chassis: chassis.length,
        serials: chassis.filter((c) => c.serial).length,
        interfaces: interfaces.length,
        physicalPorts: physical.length,
        portsUp: physical.filter((i) => i.oper === 'up').length,
        neighbours: neighbours.length,
        vlans: vlans.length,
        ipAddrs: ipAddrs.length,
        arp: arp.length,
        macs: macs ? macs.length : null,
      },
      // Said plainly rather than left for the operator to infer from an empty
      // table: an absent ENTITY-MIB and an absent LLDP are different problems
      // with different fixes.
      gaps: [
        chassis.length === 0 && modelFromDescr(descr)
          ? `No ENTITY-MIB, but the model reads as ${modelFromDescr(descr)} from the `
            + 'description string. The serial is not in it, so that stays with a '
            + 'close-up or manual entry.' : null,
        chassis.length === 0 && !modelFromDescr(descr)
          ? 'No ENTITY-MIB, and the description string held no recognisable model. '
            + 'Model and serial stay with the camera or manual entry.' : null,
        chassis.length > 0 && chassis.every((c) => !c.serial)
          ? 'ENTITY-MIB answered but the serial field is empty on every chassis.' : null,
        neighbours.length === 0
          ? 'No LLDP neighbours. Either LLDP is off, or it is on but not '
            + 'advertising on the ports that matter.' : null,
      ].filter(Boolean),
    };
  } finally {
    session.close();
  }
}

/**
 * The cheapest question that proves the credentials work.
 *
 * Used by the Test button, so a wrong password comes back in a second instead
 * of after a full walk of a 48 port switch.
 */
async function testSwitch(target) {
  const started = Date.now();
  const session = new Session(target);
  try {
    if (target.version === '3') await session.discover();
    const [descr, name, objectId] = (await session.get([
      OID.sysDescr, OID.sysName, OID.sysObjectID,
    ])).map((v) => v.value);
    return {
      ok: true,
      durationMs: Date.now() - started,
      sysName: present(name),
      sysDescr: present(descr),
      vendor: vendorOf(objectId),
      engineId: session.engineId?.length ? session.engineId.toString('hex') : null,
    };
  } finally {
    session.close();
  }
}

module.exports = { pollSwitch, testSwitch, readMacTable, OID, ENT_CLASS, IF_STATUS, vendorOf, modelFromDescr };
