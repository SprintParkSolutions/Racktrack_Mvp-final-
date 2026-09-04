/**
 * The whole rack in one document: every device, and for a managed switch every
 * port with its state, VLAN, the cable it carries, and the host heard on it.
 *
 * This is the join of both witnesses in a form meant to be read, not exported.
 * The camera gives the layout and which box is which; the switch reading gives
 * the live per-port truth. Where a device is matched to a switch (in Review),
 * its ports come from the switch; where it is not, from the camera.
 */
const store = require('./store');
const reconcile = require('./reconcile');
const unmanaged = require('./unmanaged');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function build(scan) {
  const p = scan.payload || {};
  const base = p.reconciled || p.snapshot;
  if (!base) return null;
  // Fold in any unmanaged switches a person declared, so their brand and model
  // show here instead of "Unidentified". Safe to mutate: getScan hands back a
  // per-request copy of the payload.
  unmanaged.applyTo(base, scan.rackId);
  const matches = p.matches || {};

  // The switch readings for this rack, indexed by the device each is matched to.
  const sws = reconcile.gatherSwitches(scan.rackId);
  const readingByDevice = new Map();
  const swByDevice = new Map();
  for (const s of sws) {
    const devUid = matches[s.record.id];
    if (devUid && s.reading) { readingByDevice.set(devUid, s.reading); swByDevice.set(devUid, s.record); }
  }

  const typeOf = (uid) => (base.deviceTypes || []).find((t) => t.uid === uid);
  const mfrName = (uid) => (base.manufacturers || []).find((m) => m.uid === uid)?.name || '';
  const ifByUid = new Map((base.interfaces || []).map((i) => [i.uid, i]));
  const devByUid = new Map((base.devices || []).map((d) => [d.uid, d]));

  // The camera's per-port physical facts, keyed by U then by port number: is a
  // cable plugged in, and what colour and connector it is. This is the physical
  // half that gets joined to the switch's logical half below.
  const map = p.map || {};
  const NOT = new Set(['Empty', 'Unidentified']);
  const camByU = new Map();
  for (const md of (map.devices || [])) {
    if (NOT.has(md.class_name || 'Unidentified')) continue;
    const u = md.units && md.units[0] ? Number(String(md.units[0]).replace(/\D/g, '')) : null;
    if (u == null) continue;
    const byIdx = new Map();
    for (const port of (md.ports || [])) {
      if (port.index == null) continue;
      byIdx.set(Number(port.index), {
        plugged: port.status === 'connected',
        cableColor: port.cable_color || null,
        cableType: port.cable_connector || port.cable_type || null,
      });
    }
    camByU.set(u, byIdx);
  }
  // The trailing number of a switch port name is its port number: "Slot0/12",
  // "gigabitEthernet 1/0/4" -> 12, 4. That is how a camera port lines up with
  // the switch's own interface.
  const portNum = (name) => { const m = String(name || '').match(/(\d+)\s*$/); return m ? Number(m[1]) : null; };

  // ── per-device, physical and logical joined per port ──────────────────────
  const devices = (base.devices || [])
    .slice()
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1))
    .map((d) => {
      const type = typeOf(d.deviceTypeUid);
      const reading = readingByDevice.get(d.uid);
      const rec = swByDevice.get(d.uid);
      const cam = d.position != null ? camByU.get(d.position) : null;
      const cameraPorts = (base.interfaces || []).filter((i) => i.deviceUid === d.uid).length;

      // Real ports only: drop the switch's logical interfaces (VLAN SVIs,
      // loopbacks, the CPU port) so the table is the physical faceplate.
      const physIfaces = reading
        ? reading.interfaces.filter((i) => !/vlan|loopback|\bnull\b|\bcpu\b|mgmt/i.test(i.name || ''))
        : [];

      let ports = null;
      if (reading) {
        // The switch's own tables, so each port can name what is on it.
        const macsByIf = new Map();
        for (const m of (reading.macs || [])) {
          if (m.ifIndex == null) continue;
          if (!macsByIf.has(m.ifIndex)) macsByIf.set(m.ifIndex, []);
          macsByIf.get(m.ifIndex).push(m);
        }
        const ipByMac = new Map((reading.arp || []).map((a) => [norm(a.mac), a.ip]));
        const nbrByPort = new Map();
        for (const n of (reading.neighbours || [])) {
          nbrByPort.set(String(n.localPortName), n);
          nbrByPort.set(String(n.localPort), n);
        }
        ports = physIfaces.map((i) => {
          const num = portNum(i.name);
          const c = (cam && num != null) ? cam.get(num) : null;   // the physical half
          const nbr = nbrByPort.get(String(i.name)) || nbrByPort.get(String(i.ifIndex)) || null;
          const hosts = (macsByIf.get(i.ifIndex) || []).map((m) => ({
            mac: m.mac, ip: ipByMac.get(norm(m.mac)) || null, vlan: m.vlan ?? null,
          }));
          const plugged = c ? c.plugged : null;
          const inUse = plugged || i.operStatus === 'up' || Boolean(nbr) || hosts.length > 0;
          return {
            name: i.name,
            plugged,
            cableColor: c ? c.cableColor : null,
            cableType: c ? c.cableType : null,
            state: i.operStatus || 'unknown',
            speedMbps: i.speedMbps,
            vlan: i.pvid ?? null,
            duplex: i.duplex ?? null,
            neighbour: nbr ? {
              device: nbr.remoteSysName || nbr.chassisId || 'unnamed',
              port: nbr.remotePortDesc || nbr.remotePortId || '',
            } : null,
            hosts,
            inUse,
          };
        });
      } else if (cam && cam.size) {
        // Camera only (a patch panel or an unmanaged switch): the physical half
        // is all there is. Still worth showing which ports are cabled, in what.
        ports = [...cam.entries()].sort((a, b) => a[0] - b[0]).map(([idx, c]) => ({
          name: `Port ${idx}`,
          plugged: c.plugged,
          cableColor: c.cableColor,
          cableType: c.cableType,
          state: null, speedMbps: null, vlan: null, duplex: null,
          neighbour: null, hosts: [],
          inUse: c.plugged,
        }));
      }

      return {
        u: d.position,
        name: d.name,
        role: (base.deviceRoles || []).find((r) => r.uid === d.roleUid)?.name || '',
        model: type?.model || '',
        vendor: mfrName(type?.manufacturerUid),
        serial: d.serial || null,
        mgmtIp: (d.customFields && d.customFields.managementIp) || (rec && rec.host) || null,
        source: reading ? 'switch + camera' : 'camera',
        portCount: reading ? physIfaces.length : (cam ? cam.size : cameraPorts),
        portsUp: reading ? physIfaces.filter((i) => i.operStatus === 'up').length : null,
        ports,
      };
    });

  // ── cables, both ends resolved to device + port ───────────────────────────
  const endOf = (t) => {
    if (!t) return null;
    const i = ifByUid.get(t.uid);
    if (!i) return { device: '', port: '' };
    return { device: devByUid.get(i.deviceUid)?.name || '', port: i.name };
  };
  const cables = (base.cables || [])
    .filter((c) => c.a && c.b)
    .map((c) => ({ a: endOf(c.a), b: endOf(c.b), evidence: c.evidence }));

  // ── VLANs and addresses, gathered across the switches ─────────────────────
  const vlanSet = new Map();
  const addresses = [];
  for (const s of sws) {
    const r = s.reading;
    if (!r) continue;
    for (const v of (r.vlans || [])) if (!vlanSet.has(v.id)) vlanSet.set(v.id, v.name);
    for (const a of (r.ipAddrs || [])) addresses.push({ ip: a.ip, on: s.record.label, kind: 'switch' });
    for (const a of (r.arp || [])) addresses.push({ ip: a.ip, mac: a.mac, on: s.record.label, kind: 'host' });
  }
  const vlans = [...vlanSet.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);

  return {
    rackId: scan.rackId,
    rackName: p.rackName || scan.rackId,
    siteName: p.siteName || '',
    scannedAt: scan.createdAt,
    changeNote: p.changeNote || null,
    hasImage: Boolean(scan.imagePath),
    summary: {
      devices: devices.length,
      switchesRead: readingByDevice.size,
      ports: devices.reduce((n, d) => n + (d.portCount || 0), 0),
      cables: cables.length,
      vlans: vlans.length,
      addresses: addresses.length,
    },
    devices,
    cables,
    vlans,
    addresses,
  };
}

module.exports = { build };
