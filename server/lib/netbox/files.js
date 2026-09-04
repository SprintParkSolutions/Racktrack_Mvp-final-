/**
 * The same snapshot as files: NetBox bulk-import CSV, and reviewable JSON.
 *
 * Two reasons this exists alongside the API writer. A university wants a file
 * a human can read before anything touches their system of record — and if the
 * API path hits a permissions wall on the day, CSV import is the way in that
 * needs no token.
 *
 * CSV uses NetBox's bulk-import shape, which addresses objects by NATURAL KEY
 * (names and slugs) rather than numeric id. So the uid graph is resolved
 * against the snapshot itself here, not against a live NetBox.
 */
const { EXPORT_ORDER, exportable, confidence, cableStatus, cableComplete } = require('./model');

function index(snapshot) {
  const ix = new Map();
  for (const field of EXPORT_ORDER) {
    for (const o of snapshot[field] || []) ix.set(o.uid, { field, o });
  }
  return ix;
}

const nameOf = (ix, uid) => {
  if (!uid) return '';
  const hit = ix.get(uid);
  return hit ? (hit.o.name || hit.o.model || '') : '';
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvText = (cols, rows) =>
  [cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';

/** One table per NetBox bulk-import file. Conflicts are never emitted. */
function tables(snapshot) {
  const ix = index(snapshot);
  const keep = (arr) => (arr || []).filter((o) => exportable(o.evidence));

  /** (device, object_type, port name) for one cable end. */
  const term = (t) => {
    if (!t) return ['', '', ''];
    const hit = ix.get(t.uid);
    if (!hit) return ['', t.objectType, ''];
    return [nameOf(ix, hit.o.deviceUid), t.objectType, hit.o.name];
  };

  const out = {
    manufacturers: [['name', 'slug'],
      keep(snapshot.manufacturers).map((o) => [o.name, o.slug])],

    device_types: [['manufacturer', 'model', 'slug', 'u_height', 'is_full_depth'],
      keep(snapshot.deviceTypes).map((o) =>
        [nameOf(ix, o.manufacturerUid), o.model, o.slug, o.uHeight, o.isFullDepth])],

    device_roles: [['name', 'slug'],
      keep(snapshot.deviceRoles).map((o) => [o.name, o.slug])],

    sites: [['name', 'slug', 'status'],
      keep(snapshot.sites).map((o) => [o.name, o.slug, 'active'])],

    racks: [['site', 'name', 'u_height', 'status'],
      keep(snapshot.racks).map((o) => [nameOf(ix, o.siteUid), o.name, o.uHeight, 'active'])],

    devices: [['name', 'role', 'device_type', 'site', 'rack', 'position', 'face',
               'serial', 'asset_tag', 'status'],
      keep(snapshot.devices).map((o) => [
        o.name, nameOf(ix, o.roleUid), nameOf(ix, o.deviceTypeUid),
        nameOf(ix, o.siteUid), nameOf(ix, o.rackUid),
        o.position ?? '', o.position ? o.face : '',
        o.serial || '', o.assetTag || '', o.status])],

    interfaces: [['device', 'name', 'type', 'label', 'description', 'enabled'],
      keep(snapshot.interfaces).map((o) =>
        [nameOf(ix, o.deviceUid), o.name, o.type, o.label || '', o.description || '', o.enabled])],

    rear_ports: [['device', 'name', 'type', 'positions'],
      keep(snapshot.rearPorts).map((o) =>
        [nameOf(ix, o.deviceUid), o.name, o.type, o.positions])],

    front_ports: [['device', 'name', 'type', 'rear_port', 'rear_port_position'],
      keep(snapshot.frontPorts).map((o) =>
        [nameOf(ix, o.deviceUid), o.name, o.type, nameOf(ix, o.rearPortUid), o.rearPortPosition])],

    cables: [['side_a_device', 'side_a_type', 'side_a_name',
              'side_b_device', 'side_b_type', 'side_b_name',
              'status', 'type', 'label', 'color'],
      keep(snapshot.cables)
        // A cable with one end is a note, not a cable.
        .filter(cableComplete)
        .map((o) => [...term(o.a), ...term(o.b),
                     cableStatus(o), o.type, o.label || '', o.color || ''])],
  };
  return out;
}

/** { "devices.csv": "..." } — only tables that have rows. */
function toCsv(snapshot) {
  const out = {};
  for (const [name, [cols, rows]] of Object.entries(tables(snapshot))) {
    if (rows.length) out[`${name}.csv`] = csvText(cols, rows);
  }
  return out;
}

/**
 * The whole snapshot, every object carrying its evidence and confidence.
 *
 * This is the reviewable artefact: for each value you can see what proved it.
 * A field with no source is null here — never filled in to look complete.
 */
function toJson(snapshot, indent = 2) {
  const doc = {
    schema_version: '2.0',
    rack_uid: snapshot.rackUid,
    scanned_at: snapshot.scannedAt,
    export_order: [...EXPORT_ORDER],
    objects: {},
    conflicts: snapshot.conflicts || [],
  };
  for (const field of EXPORT_ORDER) {
    doc.objects[field] = (snapshot[field] || []).map((o) => ({
      ...o,
      confidence: confidence(o.evidence),
      exportable: exportable(o.evidence),
    }));
  }
  doc.summary = Object.fromEntries(
    Object.entries(doc.objects).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
  return JSON.stringify(doc, null, indent);
}

/**
 * A human-readable rack report. Not for import: this is the artefact someone
 * reads in a ticket or a wiki, or hands to whoever owns the rack, before any
 * of it touches NetBox. Devices top-down the way the rack reads, then the
 * proven cables, then anything held back.
 */
function toMarkdown(snapshot) {
  const ix = index(snapshot);
  const rack = (snapshot.racks || [])[0];
  const site = (snapshot.sites || [])[0];
  const t = tables(snapshot);
  const ifCount = (uid) => (snapshot.interfaces || []).filter((i) => i.deviceUid === uid).length;

  const L = [];
  L.push(`# Rack inventory: ${rack ? rack.name : snapshot.rackUid}`);
  L.push('');
  if (site) L.push(`- **Site:** ${site.name}`);
  if (rack && rack.uHeight) L.push(`- **Height:** ${rack.uHeight}U`);
  if (snapshot.scannedAt) L.push(`- **Scanned:** ${snapshot.scannedAt}`);
  L.push('');

  const devs = (snapshot.devices || [])
    .filter((d) => exportable(d.evidence))
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1));
  if (devs.length) {
    L.push(`## Devices (${devs.length})`);
    L.push('');
    L.push('| U | Name | Role | Model | Ports | Serial |');
    L.push('|---|------|------|-------|------:|--------|');
    for (const d of devs) {
      L.push(`| ${d.position ?? '—'} | ${d.name} | ${nameOf(ix, d.roleUid)} `
        + `| ${nameOf(ix, d.deviceTypeUid)} | ${ifCount(d.uid) || ''} | ${d.serial || ''} |`);
    }
    L.push('');
  }

  const [, cableRows] = t.cables;
  if (cableRows.length) {
    L.push(`## Cables (${cableRows.length})`);
    L.push('');
    L.push('| From device | Port | To device | Port | Status |');
    L.push('|-------------|------|-----------|------|--------|');
    // row = [aDev, aType, aName, bDev, bType, bName, status, ...]
    for (const r of cableRows) L.push(`| ${r[0]} | ${r[2]} | ${r[3]} | ${r[5]} | ${r[6]} |`);
    L.push('');
  }

  const conflicts = snapshot.conflicts || [];
  if (conflicts.length) {
    L.push(`## Disagreements held back (${conflicts.length})`);
    L.push('');
    L.push('These are not written to NetBox. A person decides.');
    L.push('');
    for (const c of conflicts) L.push(`- **${c.field}** — ${c.note}`);
    L.push('');
  }

  return `${L.join('\n')}\n`;
}

module.exports = { toCsv, toJson, toMarkdown, tables, index, nameOf };
