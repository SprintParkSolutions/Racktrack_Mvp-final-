/**
 * Domain object -> NetBox API shape. One table, one place.
 *
 * Every piece of "what NetBox calls this" knowledge lives here so the writer
 * stays a plain loop and the translation stays auditable.
 *
 * Field names track NetBox 4.x, which docker-compose pins. Two that moved
 * between majors and fail silently if you get them wrong:
 *   - Device role is `role` in 4.x; it was `device_role` in 3.x.
 *   - Interface MAC is the `mac_address` string up to 4.1; 4.2 moved MACs to
 *     their own object. If you bump the pin past 4.1, revisit `interfaces`.
 *   - A front port's link to its rear port is `rear_port` + `rear_port_position`
 *     up to 4.5. 4.6 made it a list, `rear_ports`, one entry per front position,
 *     and silently ignores the old field: the port is created with no mapping
 *     and a cable trace stops dead at the panel. Verified against 4.6.9.
 */
const { EXPORT_ORDER, cableStatus } = require('./model');
const { UID_FIELD } = require('./netbox');

/** NetBox wants '' for an absent string, not null. */
const s = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * `ref` resolves one of our uids to the NetBox numeric id assigned earlier in
 * the walk. It returns null when the target does not exist yet, which the
 * writer treats as "pending" — never as "null".
 */
const SPECS = [
  {
    field: 'manufacturers', endpoint: '/api/dcim/manufacturers/',
    netboxType: 'dcim.manufacturer', label: 'Manufacturer',
    payload: (o) => ({ name: o.name, slug: o.slug }),
  },
  {
    field: 'deviceTypes', endpoint: '/api/dcim/device-types/',
    netboxType: 'dcim.devicetype', label: 'DeviceType',
    payload: (o, ref) => ({
      manufacturer: ref(o.manufacturerUid), model: o.model, slug: o.slug,
      u_height: o.uHeight, is_full_depth: o.isFullDepth,
    }),
  },
  {
    field: 'deviceRoles', endpoint: '/api/dcim/device-roles/',
    netboxType: 'dcim.devicerole', label: 'DeviceRole',
    payload: (o) => ({ name: o.name, slug: o.slug }),
  },
  {
    field: 'sites', endpoint: '/api/dcim/sites/',
    netboxType: 'dcim.site', label: 'Site',
    payload: (o) => ({ name: o.name, slug: o.slug }),
  },
  {
    field: 'locations', endpoint: '/api/dcim/locations/',
    netboxType: 'dcim.location', label: 'Location',
    payload: (o, ref) => ({
      name: o.name, slug: o.name.toLowerCase().replace(/\s+/g, '-'),
      site: ref(o.siteUid),
    }),
  },
  {
    field: 'racks', endpoint: '/api/dcim/racks/',
    netboxType: 'dcim.rack', label: 'Rack',
    payload: (o, ref) => ({
      name: o.name, site: ref(o.siteUid),
      location: o.locationUid ? ref(o.locationUid) : null,
      // Omitted rather than nulled when the height was never stated: NetBox
      // applies its own default, where an explicit null is rejected.
      ...(Number.isInteger(o.uHeight) ? { u_height: o.uHeight } : {}),
      desc_units: o.descUnits,
      description: s(o.description), comments: s(o.comments),
    }),
  },
  {
    field: 'devices', endpoint: '/api/dcim/devices/',
    netboxType: 'dcim.device', label: 'Device',
    payload: (o, ref) => ({
      name: o.name, device_type: ref(o.deviceTypeUid), role: ref(o.roleUid),
      site: ref(o.siteUid), rack: o.rackUid ? ref(o.rackUid) : null,
      position: o.position,
      // NetBox rejects a face on an unracked device.
      face: o.position ? o.face : '',
      serial: s(o.serial), asset_tag: o.assetTag || null,
      platform: undefined, status: o.status, description: s(o.description),
    }),
  },
  {
    field: 'interfaces', endpoint: '/api/dcim/interfaces/',
    netboxType: 'dcim.interface', label: 'Interface',
    payload: (o, ref) => ({
      device: ref(o.deviceUid), name: o.name, type: o.type,
      description: s(o.description), enabled: o.enabled,
      mac_address: o.mac || null, label: s(o.label),
    }),
  },
  {
    field: 'rearPorts', endpoint: '/api/dcim/rear-ports/',
    netboxType: 'dcim.rearport', label: 'RearPort',
    payload: (o, ref) => ({
      device: ref(o.deviceUid), name: o.name, type: o.type, positions: o.positions,
    }),
  },
  {
    field: 'frontPorts', endpoint: '/api/dcim/front-ports/',
    netboxType: 'dcim.frontport', label: 'FrontPort',
    payload: (o, ref) => ({
      device: ref(o.deviceUid), name: o.name, type: o.type, positions: 1,
      rear_ports: [{ position: 1, rear_port: ref(o.rearPortUid), rear_port_position: o.rearPortPosition }],
    }),
  },
  {
    field: 'powerPorts', endpoint: '/api/dcim/power-ports/',
    netboxType: 'dcim.powerport', label: 'PowerPort',
    payload: (o, ref) => ({ device: ref(o.deviceUid), name: o.name }),
  },
  {
    field: 'powerOutlets', endpoint: '/api/dcim/power-outlets/',
    netboxType: 'dcim.poweroutlet', label: 'PowerOutlet',
    payload: (o, ref) => ({ device: ref(o.deviceUid), name: o.name }),
  },
  {
    field: 'vlans', endpoint: '/api/ipam/vlans/',
    netboxType: 'ipam.vlan', label: 'VLAN',
    payload: (o, ref) => ({
      vid: o.vid, name: o.name, site: o.siteUid ? ref(o.siteUid) : null,
    }),
  },
  {
    field: 'prefixes', endpoint: '/api/ipam/prefixes/',
    netboxType: 'ipam.prefix', label: 'Prefix',
    payload: (o, ref) => ({
      prefix: o.prefix, vlan: o.vlanUid ? ref(o.vlanUid) : null,
      description: s(o.description),
    }),
  },
  {
    field: 'ipAddresses', endpoint: '/api/ipam/ip-addresses/',
    netboxType: 'ipam.ipaddress', label: 'IPAddress',
    payload: (o, ref) => {
      const p = { address: o.address };
      if (o.interfaceUid) {
        p.assigned_object_type = 'dcim.interface';
        p.assigned_object_id = ref(o.interfaceUid);
      }
      return p;
    },
  },
  {
    field: 'cables', endpoint: '/api/dcim/cables/',
    netboxType: 'dcim.cable', label: 'Cable',
    /**
     * Both ends, always. `object_type` is carried verbatim from the model
     * because NetBox is unforgiving here: it wants `dcim.frontport`, and
     * `dcim.front-port` fails. Status is derived from evidence, never by hand.
     */
    payload: (o, ref) => {
      const term = (t) => (t ? [{ object_type: t.objectType, object_id: ref(t.uid) }] : []);
      return {
        a_terminations: term(o.a), b_terminations: term(o.b),
        // '' is NetBox's "not set" for a choice field; null is rejected.
        status: cableStatus(o), type: o.type || '',
        label: s(o.label), color: s(o.color), description: s(o.description),
        length: o.length, length_unit: o.length ? o.lengthUnit : '',
      };
    },
  },
];

const BY_FIELD = Object.fromEntries(SPECS.map((sp) => [sp.field, sp]));

/** Walk EXPORT_ORDER — NetBox refuses out-of-order creates. */
function orderedSpecs() {
  const missing = EXPORT_ORDER.filter((f) => !BY_FIELD[f]);
  if (missing.length) {
    throw new Error(`EXPORT_ORDER names types with no mapping: ${missing.join(', ')}`);
  }
  return EXPORT_ORDER.map((f) => BY_FIELD[f]);
}

/** Every NetBox type the racktrack_uid custom field has to cover. */
const objectTypes = () => SPECS.map((sp) => sp.netboxType);

/** Attach our stable id, plus any extra custom fields the object carries. */
const withUid = (payload, uid, extra = {}) =>
  ({ ...payload, custom_fields: { ...extra, [UID_FIELD]: uid } });

module.exports = { SPECS, BY_FIELD, orderedSpecs, objectTypes, withUid };
