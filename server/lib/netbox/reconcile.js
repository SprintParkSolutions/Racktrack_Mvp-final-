/**
 * Join the camera scan with what the switches said about themselves.
 *
 * The camera knows WHERE a device sits (its U position) but guesses at what it
 * is. A managed switch knows exactly what it is (model, serial, every port)
 * but has no idea where it sits. Neither can be matched to the other
 * automatically with certainty, because the one shared handle -- how many
 * ports -- is not unique when a rack holds two identical switches. So the
 * match is proposed here by port count and CONFIRMED by a human in Review.
 *
 * Once a switch is matched to a rack position, this overwrites the camera's
 * guesses with the switch's own facts (Evidence.SNMP), keeps the U position
 * the camera gave (the switch cannot know it), and builds cables from LLDP
 * where both switches are known to this rack.
 *
 * Nothing is invented. A field the switch did not state stays exactly as the
 * camera left it, and a cable whose two ends cannot both be resolved is not
 * drawn.
 */
const {
  Evidence, observed, Manufacturer, DeviceType, Interface, Cable, Termination,
} = require('./model');
const switches = require('./switches');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'x';

// Chassis ids and MACs arrive with assorted separators; compare on hex only.
const normId = (x) => String(x || '').toLowerCase().replace(/[^0-9a-f]/g, '');

const clone = (o) => JSON.parse(JSON.stringify(o));

/** NetBox interface type, chosen from speed and whether it reads as fibre. */
function ifTypeFor(i) {
  const s = Number(i.speedMbps) || 0;
  const fibre = /sfp|fibre|fiber|base-?x/i.test(i.type || '');
  if (s >= 10000) return '10gbase-x-sfpp';
  if (s >= 1000) return fibre ? '1000base-x-sfp' : '1000base-t';
  if (s >= 100) return '100base-tx';
  if (s > 0) return '10base-t';
  return '1000base-t';
}

/** Physical port count a switch reported. */
const portsOf = (sw) => (sw.reading?.counts?.interfaces
  ?? sw.reading?.interfaces?.length ?? 0);

/** Every switch filed against this rack, paired with its last reading. */
function gatherSwitches(rackId) {
  return switches.list(rackId).map((record) => ({
    record,
    reading: switches.loadData(record.id),
  }));
}

/** The camera's devices, flattened for matching and for the Review screen. */
function cameraDevices(snapshot) {
  const typeOf = (uid) => snapshot.deviceTypes.find((t) => t.uid === uid);
  const mfrName = (uid) => (snapshot.manufacturers.find((m) => m.uid === uid)?.name || '');
  return (snapshot.devices || []).map((d) => {
    const type = typeOf(d.deviceTypeUid);
    return {
      uid: d.uid,
      name: d.name,
      position: d.position,
      cvClass: d.provenance?.cvClass || '',
      // The rectangle on the rack photo, so the Network screen can offer the
      // picture as a way of choosing rather than only a list of names.
      box: Array.isArray(d.provenance?.box) ? d.provenance.box : null,
      portCount: (snapshot.interfaces || []).filter((i) => i.deviceUid === d.uid).length,
      model: type?.model || '',
      // The make OCR read off the faceplate, carried on the device's type.
      make: mfrName(type?.manufacturerUid),
      serial: d.serial || null,
    };
  });
}

/**
 * Normalise a make/model for comparison. "Unknown" and a bare "enterprise
 * <number>" (an SNMP vendor we could not name) both read as absent, so they
 * neither match nor penalise: an unnamed vendor is not a conflicting one.
 */
const norm = (s) => {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t === 'unknown' || /^enterprise\d+$/.test(t)) return '';
  return t;
};

/**
 * Score one (switch, camera-device) pairing on three independent signals:
 * the model each claims, the make (OCR off the photo vs the switch's own
 * vendor), and how close their port counts are. Returns the score and a
 * plain-language reason, so the human verifying sees why it was proposed.
 */
function scorePair(sw, dev) {
  const why = [];
  let score = 0;

  const swModel = norm(sw.model);
  const devModel = norm(dev.model);
  if (swModel && devModel && !devModel.startsWith('unidentified') && swModel === devModel) {
    score += 200; why.push(`same model ${sw.model}`);
  }

  const swMake = norm(sw.vendor);
  const devMake = norm(dev.make);
  if (swMake && devMake) {
    if (swMake === devMake) { score += 100; why.push(`both ${sw.vendor}`); }
    else { score -= 60; why.push(`make differs (${dev.make} vs ${sw.vendor})`); }
  }

  const diff = Math.abs(dev.portCount - sw.ports);
  const tol = Math.max(4, Math.round(sw.ports * 0.25));
  if (diff === 0) { score += 60; why.push(`exact ${sw.ports} ports`); }
  else if (diff <= tol) { score += 40 - diff * 2; why.push(`ports ${dev.portCount}≈${sw.ports}`); }
  else { score -= 10; why.push(`ports ${dev.portCount} vs ${sw.ports}`); }

  return { score, why: why.join(', ') };
}

const confidenceOf = (score) => (score >= 160 ? 'high' : score >= 55 ? 'medium' : 'low');

/** One notch up, for a pairing that has no competition. */
const bump = (c) => (c === 'low' ? 'medium' : 'high');

/**
 * Propose a match for each switch by nearest port count, biggest switch first
 * so a 52-port switch claims the 52-port device before a 28-port one can.
 * A match only stands if the counts are within a quarter (or 4 ports), so a
 * wild mismatch is left unmatched for the human rather than forced.
 */
/**
 * Propose a switch-to-device pairing using make, model and port count together.
 *
 * Every switch is scored against every camera device, and the strongest pairs
 * are taken first, one to one. A pair is only accepted if it clears a floor, so
 * a switch with no plausible box is left for the human rather than forced onto
 * the nearest leftover. Returns the matches and, per switch, the confidence and
 * the reason, so Review can show why each was proposed and the user can verify.
 */
// A managed switch answers SNMP, so it can only be an active network box in the
// rack. It is never a patch panel or a PDU, both passive, and matching one to a
// switch is always wrong. Auto-match only considers the active classes.
const PASSIVE_CLASS = new Set(['Patch Panel', 'PDU', 'Empty']);

function suggest(snapshot, sws) {
  const devices = cameraDevices(snapshot)
    .filter((d) => !PASSIVE_CLASS.has(d.cvClass))
    .map((d) => ({
      ...d,
      // The switch's own port count is the truer number, so compare the
      // camera's detected ports to it, not the reverse.
      ports: d.portCount,
      vendor: d.make,
    }));

  const pairs = [];
  for (const sw of sws) {
    const s = {
      id: sw.record.id,
      ports: portsOf(sw),
      vendor: sw.reading?.system?.vendor || sw.reading?.identity?.manufacturer || null,
      model: sw.reading?.identity?.model || null,
    };
    for (const dev of devices) {
      const { score, why } = scorePair(s, dev);
      pairs.push({ swId: sw.record.id, devUid: dev.uid, score, why });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const matches = {};
  const reasons = {};
  for (const sw of sws) { matches[sw.record.id] = null; reasons[sw.record.id] = null; }
  const takenDev = new Set();
  const FLOOR = 20; // needs at least a port-count agreement or a make match

  // How many boxes each switch could plausibly be. A switch with exactly one
  // candidate is not a guess — there is nothing else it could be — and the
  // camera reading "Unidentified Switch, make unknown" is the normal case, so
  // scoring alone leaves that pairing looking weak when it is the only one
  // available. Counted before anything is taken.
  const plausible = new Map();
  for (const p of pairs) {
    if (p.score < FLOOR) continue;
    plausible.set(p.swId, (plausible.get(p.swId) || 0) + 1);
  }

  for (const p of pairs) {
    if (matches[p.swId] || takenDev.has(p.devUid) || p.score < FLOOR) continue;
    matches[p.swId] = p.devUid;
    takenDev.add(p.devUid);
    const sole = plausible.get(p.swId) === 1;
    reasons[p.swId] = {
      deviceUid: p.devUid,
      confidence: sole ? bump(confidenceOf(p.score)) : confidenceOf(p.score),
      why: sole ? `${p.why} — the only box it could be` : p.why,
    };
  }
  return { matches, reasons };
}

/**
 * Apply confirmed matches to the camera snapshot and return the merged result.
 *
 * `matches` maps a switch id to a device uid (or null for "not in this rack").
 */
function reconcile(base, sws, matches) {
  const snap = clone(base);
  if (!snap.cables) snap.cables = [];
  const changes = [];

  const deviceByUid = new Map(snap.devices.map((d) => [d.uid, d]));
  const typeByUid = new Map(snap.deviceTypes.map((t) => [t.uid, t]));
  const mfrUids = new Set(snap.manufacturers.map((m) => m.uid));
  const byId = new Map(sws.map((s) => [s.record.id, s]));

  const ensureManufacturer = (name) => {
    if (!name) return null;
    const uid = `mfr:${slug(name)}`;
    if (!mfrUids.has(uid)) {
      snap.manufacturers.push(Manufacturer(observed(uid, Evidence.SNMP),
        { name, slug: slug(name) }));
      mfrUids.add(uid);
    }
    return uid;
  };

  // ── enrich each matched device from its switch ────────────────────────────
  for (const sw of sws) {
    const devUid = matches[sw.record.id];
    if (!devUid || !sw.reading) continue;
    const dev = deviceByUid.get(devUid);
    if (!dev) continue;

    const r = sw.reading;
    const ident = r.identity || {};
    const vendor = ident.manufacturer || r.system?.vendor || null;
    const mfrUid = ensureManufacturer(vendor);

    if (ident.model) {
      const typeUid = `dtype:${slug(ident.model)}`;
      if (!typeByUid.has(typeUid)) {
        const t = DeviceType(observed(typeUid, Evidence.SNMP), {
          manufacturerUid: mfrUid || typeByUid.get(dev.deviceTypeUid)?.manufacturerUid || '',
          model: ident.model, slug: slug(ident.model), uHeight: 1,
        });
        snap.deviceTypes.push(t);
        typeByUid.set(typeUid, t);
      }
      dev.deviceTypeUid = typeUid;
      dev.evidence = Evidence.SNMP;
      changes.push({ device: dev.name, field: 'model', was: null, now: ident.model });
    } else if (mfrUid) {
      // No ENTITY model (e.g. this D-Link), but we at least know the make.
      const t = typeByUid.get(dev.deviceTypeUid);
      if (t) t.manufacturerUid = mfrUid;
      changes.push({ device: dev.name, field: 'manufacturer', was: null, now: vendor });
    }

    if (ident.serial) {
      dev.serial = ident.serial;
      dev.evidence = Evidence.SNMP;
      changes.push({ device: dev.name, field: 'serial', was: null, now: ident.serial });
    }

    dev.customFields = { ...(dev.customFields || {}), managementIp: sw.record.host };
    if (ident.firmwareRev) dev.customFields.firmware = ident.firmwareRev;
    dev.provenance = {
      ...(dev.provenance || {}),
      switchId: sw.record.id, snmpHost: sw.record.host,
      sysName: r.system?.sysName || null, sysDescr: r.system?.sysDescr || null,
      stackMembers: ident.stackMembers || 1,
    };

    // Real ports replace the camera's port guesses entirely.
    snap.interfaces = snap.interfaces.filter((i) => i.deviceUid !== devUid);
    for (const i of r.interfaces || []) {
      snap.interfaces.push(Interface(
        observed(`if:${devUid}:${i.ifIndex}`, Evidence.SNMP,
          { ifIndex: i.ifIndex, oper: i.operStatus, speedMbps: i.speedMbps }),
        {
          deviceUid: devUid, name: i.name, type: ifTypeFor(i),
          description: i.alias || '', mac: i.mac || null,
          enabled: i.adminStatus !== 'down', label: null,
        }));
    }
    changes.push({ device: dev.name, field: 'ports', was: null,
      now: `${(r.interfaces || []).length} real ports` });
  }

  // ── cables from LLDP, only between switches we can place ───────────────────
  const byChassis = new Map();
  const bySysName = new Map();
  for (const s of sws) {
    if (!s.reading) continue;
    if (s.reading.localChassisId) byChassis.set(normId(s.reading.localChassisId), s);
    const nm = s.reading.system?.sysName;
    if (nm) { const a = bySysName.get(nm) || []; a.push(s); bySysName.set(nm, a); }
  }
  const remoteSwitchOf = (n) => {
    if (n.chassisId) {
      const hit = byChassis.get(normId(n.chassisId));
      if (hit) return hit;
    }
    if (n.remoteSysName) {
      const a = bySysName.get(n.remoteSysName);
      if (a && a.length === 1) return a[0]; // unique name only; no guessing
    }
    return null;
  };
  const ifUid = (devUid, name) => {
    if (!name) return null;
    const hit = snap.interfaces.find((i) => i.deviceUid === devUid && i.name === name);
    return hit ? hit.uid : null;
  };

  const cables = [];
  const seen = new Set();
  const unresolved = [];

  for (const sw of sws) {
    const devUid = matches[sw.record.id];
    if (!devUid || !sw.reading) continue;

    for (const n of sw.reading.neighbours || []) {
      const remote = remoteSwitchOf(n);
      if (!remote || remote.record.id === sw.record.id) continue;
      const remoteDevUid = matches[remote.record.id];
      if (!remoteDevUid) { unresolved.push({ from: sw.record.label, seen: n.remoteSysName || n.chassisId, why: 'the neighbour is a switch in this rack but not placed yet' }); continue; }

      const localIf = ifUid(devUid, n.localPortName) || ifUid(devUid, `port ${n.localPort}`);
      const remoteName = n.remotePortDesc || n.remotePortId;
      const remoteIf = ifUid(remoteDevUid, remoteName);
      if (!localIf || !remoteIf) {
        unresolved.push({ from: sw.record.label, seen: n.remoteSysName || remoteName,
          why: 'could not line the LLDP port name up with a port that was read' });
        continue;
      }

      const key = [localIf, remoteIf].sort().join('::');
      if (seen.has(key)) continue;
      seen.add(key);

      const mutual = (remote.reading.neighbours || []).some((rn) => {
        const back = remoteSwitchOf(rn);
        return back && back.record.id === sw.record.id;
      });

      const cable = Cable(
        observed(`cable:${slug(key)}`, mutual ? Evidence.LLDP_BOTH : Evidence.LLDP_ONE,
          { via: 'lldp', localPort: n.localPortName, remotePort: remoteName }),
        { a: Termination('dcim.interface', localIf), b: Termination('dcim.interface', remoteIf),
          type: 'cat6' });
      snap.cables.push(cable);
      cables.push({
        from: `${deviceByUid.get(devUid).name} · ${n.localPortName}`,
        to: `${deviceByUid.get(remoteDevUid).name} · ${remoteName}`,
        evidence: cable.evidence,
      });
    }
  }

  const summary = {
    switchesTotal: sws.length,
    matched: Object.values(matches).filter(Boolean).length,
    unmatched: sws.filter((s) => !matches[s.record.id]).length,
    serials: changes.filter((c) => c.field === 'serial').length,
    models: changes.filter((c) => c.field === 'model').length,
    cables: cables.length,
    cablesProven: cables.filter((c) => c.evidence === Evidence.LLDP_BOTH).length,
    changes,
    cableList: cables,
    unresolved,
  };
  return { snapshot: snap, summary };
}

/**
 * The whole picture the Review screen needs: the camera's devices, each
 * switch's headline facts, and the current or suggested matching.
 */
/**
 * Where the rack's photo can be fetched from, or null when none was kept.
 *
 * Adoption stores the absolute path of whatever file was on disk; the served
 * route is /outputs/<rackId>/<file>, so take the name and rebuild the path.
 */
function rackImageUrl(base, rackId) {
  const stored = (base.racks || [])[0]?.provenance?.image || '';
  const file = String(stored).split(/[\\/]/).pop();
  if (!file) return null;
  return `/outputs/${encodeURIComponent(rackId)}/${encodeURIComponent(file)}`;
}

function view(base, rackId, storedMatches) {
  const sws = gatherSwitches(rackId);
  const auto = suggest(base, sws);
  const matches = storedMatches || auto.matches;
  const { summary } = reconcile(base, sws, matches);
  return {
    // The photo the camera read, as a URL this rack's owner may fetch. The
    // snapshot carries wherever the file sat on disk when it was adopted;
    // only its name survives into a path the client can ask for.
    image: rackImageUrl(base, rackId),
    devices: cameraDevices(base),
    switches: sws.map((s) => ({
      id: s.record.id,
      label: s.record.label,
      host: s.record.host,
      read: Boolean(s.reading),
      model: s.reading?.identity?.model || null,
      serial: s.reading?.identity?.serial || null,
      vendor: s.reading?.system?.vendor || null,
      sysName: s.reading?.system?.sysName || null,
      // The maker's own MIB gives these where the standard one is silent —
      // and the Switches tab wants them, because a firmware version read off
      // the box beats one read off a photograph of the box.
      hardware: s.reading?.identity?.hardwareRev || null,
      firmware: s.reading?.identity?.firmwareRev || null,
      uptimeSeconds: s.reading?.system?.uptimeSeconds ?? null,
      ports: portsOf(s),
      neighbours: s.reading?.counts?.neighbours ?? 0,
      matchedTo: matches[s.record.id] || null,
      // Why the auto-matcher proposed this, for the user to verify against.
      autoMatch: auto.reasons[s.record.id] || null,
    })),
    matches,
    reasons: auto.reasons,
    summary,
    suggested: !storedMatches,
  };
}

module.exports = { gatherSwitches, cameraDevices, suggest, reconcile, view };
