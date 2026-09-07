/**
 * Feed a switch reading into Drift.
 *
 * The rack's Drift view reads monitored_devices + port_snapshots, the table
 * the SSH poller used to fill. A switch read over SNMP — by the phone or by
 * this server — is filed there too: created once, with enabled:0 so the SSH
 * poller never tries to log into it, and every reading becomes one snapshot
 * per port. writePoll diffs against the previous snapshot and records the
 * change events, so "what changed since last time" works for these switches
 * exactly as it did for polled ones.
 *
 * This used to live inside the switches router. It is here so the poller can
 * call it too, without requiring an Express router to get at a function.
 */
const portsDb = require('../port_history_db');

/**
 * @param rec     the switch record (label, host)
 * @param data    the reading, in the collector's shape
 * @param opts    tenantId — who owns a device this creates; null for the owner
 * @returns       the monitored_devices row the reading was filed under
 */
function feedDrift(rec, data, { tenantId = null } = {}) {
  const host = rec && rec.host;
  if (!host) return null;
  let dev = portsDb.getDeviceByHost(host);
  if (!dev) {
    dev = portsDb.addDevice({
      host, ssh_port: 0, vendor: 'snmp', label: rec.label || host, enabled: 0,
      tenant_id: tenantId,
    });
  }
  portsDb.updateDeviceMetadata(dev.id, {
    system_name:        data.system?.sysName,
    system_description: data.system?.sysDescr,
    model:              data.identity?.model || data.system?.derivedModel,
    serial:             data.identity?.serial,
    sw_version:         data.identity?.softwareRev || data.identity?.firmwareRev,
  });
  const byLocal = new Map();
  for (const n of data.neighbours || []) {
    if (n.localPort != null) byLocal.set(String(n.localPort), n);
    if (n.localPortName) byLocal.set(String(n.localPortName), n);
  }
  const ts = data.collectedAt || new Date().toISOString();
  for (const i of data.interfaces || []) {
    const n = byLocal.get(String(i.ifIndex)) || byLocal.get(String(i.name)) || null;
    portsDb.writePoll(dev.id, {
      port:         i.name || String(i.ifIndex),
      oper:         i.operStatus ?? null,
      admin:        i.adminStatus ?? null,
      speed_mbps:   i.speedMbps ?? null,
      duplex:       i.duplex ?? null,
      flowctrl:     null,                     // not in the standard MIBs
      medium:       null,                     // no standard MIB says copper vs fibre
      descr:        i.alias ?? null,
      lldp_chassis: n?.chassisId ?? null,
      lldp_port:    n?.remotePortId ?? null,
      lldp_system:  n?.remoteSysName ?? null,
    }, ts);
  }
  return dev;
}

module.exports = { feedDrift };
