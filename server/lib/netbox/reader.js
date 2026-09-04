/**
 * Read one switch, shape what it said, and store it.
 *
 * This sits between lib/collect.js, which knows MIBs and nothing else, and the
 * routes, which know HTTP and nothing else. Both the Network screen (one
 * switch at a time) and the scan's Collect stage (every switch in the rack) go
 * through here, so a switch read from either place is stored identically and
 * the two can never drift apart.
 */
const { pollSwitch } = require('./collect');
const switches = require('./switches');

/** Why a switch cannot be read, in the words the operator needs. */
const NO_CREDENTIALS = {
  error: 'This switch has no usable password stored.',
  hint: 'Edit it and enter the password again. If RT_SECRET changed, every '
      + 'stored password has to be re-entered, because they were encrypted with the old one.',
};

/**
 * The collected data, in the shape the screen reads it in.
 *
 * lib/collect.js returns the MIBs faithfully, with entPhysicalTable rows and
 * bridge port numbers intact, because that is the honest record of what the
 * switch said. This turns it into the four things an operator asked for. The
 * translation lives here rather than in collect.js so the transport layer
 * never has to know what a screen looks like.
 */
function forClient(poll) {
  const chassis = poll.chassis[0] || {};
  return {
    collectedAt: poll.polledAt,
    tookMs: poll.durationMs,
    localChassisId: poll.localChassisId || null,
    identity: {
      // ENTITY-MIB is the truth when present; otherwise the model parsed from
      // the switch's own description string, which these budget switches do
      // fill in even when they leave ENTITY-MIB empty.
      model: chassis.model || poll.derivedModel || null,
      modelSource: chassis.model ? 'entity' : (poll.derivedModel ? 'sysDescr' : null),
      serial: chassis.serial || null,
      manufacturer: chassis.manufacturer || null,
      hardwareRev: chassis.hardwareRev || null,
      firmwareRev: chassis.firmwareRev || null,
      softwareRev: chassis.softwareRev || null,
      // A stack answers as one device but occupies several U of rack. Saying
      // so is the difference between one row in NetBox and the right number.
      stackMembers: poll.chassis.length,
      members: poll.chassis,
    },
    system: {
      sysName: poll.system.name,
      sysDescr: poll.system.descr,
      sysLocation: poll.system.location,
      sysContact: poll.system.contact,
      uptimeSeconds: poll.system.uptimeSeconds,
      vendor: poll.system.vendor,
    },
    interfaces: poll.interfaces.map((i) => ({
      ifIndex: i.index,
      name: i.name,
      alias: i.alias,
      type: i.type,
      operStatus: i.oper,
      adminStatus: i.admin,
      speedMbps: i.speedMbps,
      mtu: i.mtu,
      duplex: i.duplex,
      pvid: i.pvid,
      mac: i.mac,
    })),
    neighbours: poll.neighbours.map((n) => ({
      localPort: n.localPortNum,
      localPortName: n.localPort,
      remoteSysName: n.remoteSysName,
      remotePortDesc: n.remotePortDescr,
      remotePortId: n.remotePortId,
      chassisId: n.chassisId,
    })),
    vlans: poll.vlans || [],
    ipAddrs: poll.ipAddrs || [],
    arp: poll.arp || [],
    macs: poll.macs,
    counts: {
      interfaces: poll.counts.physicalPorts,
      interfacesUp: poll.counts.portsUp,
      neighbours: poll.counts.neighbours,
      vlans: poll.counts.vlans,
      ipAddrs: poll.counts.ipAddrs,
      arp: poll.counts.arp,
      macs: poll.counts.macs,
    },
    gaps: poll.gaps,
  };
}

async function readSwitch(id, { macTable = false } = {}) {
  const credentials = switches.credentials(id);
  if (!credentials) return { ok: false, ...NO_CREDENTIALS, kind: 'credentials' };
  try {
    const data = forClient(await pollSwitch(credentials, { macTable }));
    switches.saveData(id, data);
    switches.recordCollected(id, data);
    switches.recordTest(id, { ok: true, sysName: data.system.sysName });
    return { ok: true, data };
  } catch (err) {
    switches.recordTest(id, { ok: false, reason: String(err.message) });
    return { ok: false, error: String(err.message), hint: err.hint || '', kind: err.kind || 'error' };
  }
}


module.exports = { readSwitch, forClient, NO_CREDENTIALS };
