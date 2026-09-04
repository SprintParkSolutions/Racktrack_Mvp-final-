/**
 * NetBox-shaped domain model.
 *
 * Every shape here maps 1:1 onto a NetBox object type, so the exporter is a
 * near-mechanical translation rather than a reinterpretation. When NetBox and
 * RackTrack disagree about what a "device" is, the bugs live in the gap.
 *
 * Two things every object carries that NetBox has no native place for:
 *
 *   uid       RackTrack's own stable id, written into a NetBox custom field
 *             (racktrack_uid). NetBox has no upsert, so re-scanning a rack
 *             would duplicate every object without it.
 *
 *   evidence  what proved this object exists. Never guess, never synthesise.
 *             If nothing observed it, it does not get created.
 */

/**
 * How a fact came to be known, strongest first.
 * Confidence is a property of the METHOD, not a feeling. These numbers are the
 * contract the exporter reads when deciding `connected` vs `planned`.
 */
const Evidence = Object.freeze({
  MANUAL:    'manual',      // a human looked and typed it. Trust absolutely.
  LLDP_BOTH: 'lldp_both',   // both ends report each other. A proven cable.
  SNMP:      'snmp',        // the device said so about itself (ENTITY-MIB)
  LLDP_ONE:  'lldp_one',    // one end reports it, the other is silent
  MAC_ARP:   'mac_arp',     // MAC table + ARP. Good for end devices.
  CV_OCR:    'cv_ocr',      // read off a photo
  CV_ONLY:   'cv_only',     // seen in a photo, unconfirmed by telemetry
  CONFLICT:  'conflict',    // sources disagree — NEVER exported
});

const CONFIDENCE = Object.freeze({
  [Evidence.MANUAL]:    1.0,
  [Evidence.LLDP_BOTH]: 1.0,
  [Evidence.SNMP]:      0.98,
  [Evidence.LLDP_ONE]:  0.9,
  [Evidence.MAC_ARP]:   0.75,
  [Evidence.CV_OCR]:    0.6,
  [Evidence.CV_ONLY]:   0.5,
  [Evidence.CONFLICT]:  0.0,
});

const confidence = (ev) => CONFIDENCE[ev] ?? 0;

/** A conflict is a finding, not a fact. It goes to review, not to NetBox. */
const exportable = (ev) => ev !== Evidence.CONFLICT;

/**
 * Map our confidence onto NetBox's own vocabulary.
 *
 * NetBox already distinguishes a cable that exists from one that is merely
 * proposed. Carrying our uncertainty in its native field means the customer
 * filters for "planned" and reviews exactly the cables we were unsure about,
 * inside their own tooling — without us inventing a parallel concept they
 * would have to learn.
 */
const netboxStatus = (ev) => (confidence(ev) >= 0.75 ? 'connected' : 'planned');

/**
 * NetBox is strict about creation order: you cannot rack a device whose type
 * does not exist, or cable two ports that were never created. The exporter
 * walks exactly this sequence.
 */
const EXPORT_ORDER = Object.freeze([
  'manufacturers', 'deviceTypes', 'deviceRoles',
  'sites', 'locations', 'racks',
  'devices',
  'interfaces', 'rearPorts', 'frontPorts', 'powerPorts', 'powerOutlets',
  'vlans', 'prefixes', 'ipAddresses',
  'cables',
]);

/** An empty snapshot: everything one scan produced, ready to export. */
function emptySnapshot(rackUid = '', scannedAt = '') {
  const snap = { rackUid, scannedAt, conflicts: [] };
  for (const key of EXPORT_ORDER) snap[key] = [];
  return snap;
}

/**
 * Base fields every observed object carries.
 * `provenance` is free-form breadcrumbs — image path, SNMP OID, LLDP neighbour.
 */
const observed = (uid, evidence, provenance = {}) => ({ uid, evidence, provenance });

// ── Constructors ────────────────────────────────────────────────────────────
// Thin on purpose. They exist to make the required fields obvious at the call
// site and to keep every object's shape identical across the codebase.

const Site         = (o, { name = '', slug = '' }) => ({ ...o, name, slug });
const Location     = (o, { name = '', siteUid = '' }) => ({ ...o, name, siteUid });
const Manufacturer = (o, { name = '', slug = '' }) => ({ ...o, name, slug });
const DeviceRole   = (o, { name = '', slug = '' }) => ({ ...o, name, slug });

const Rack = (o, { name = '', siteUid = '', locationUid = null, uHeight = null,
                   descUnits = false, description = '', comments = '' }) =>
  ({ ...o, name, siteUid, locationUid, uHeight, descUnits, description, comments });

/** The MODEL, not the box. "DGS-1210-52" — one row however many you own. */
const DeviceType = (o, { manufacturerUid = '', model = '', slug = '',
                         uHeight = 1, isFullDepth = true }) =>
  ({ ...o, manufacturerUid, model, slug, uHeight, isFullDepth });

/**
 * An actual physical box in an actual rack.
 *
 * `serial` and `assetTag` are what the client asked for by name. Prefer SNMP
 * ENTITY-MIB over OCR for both: a managed device states its serial exactly,
 * every time, and OCR will not.
 *
 * Note assetTag is UNIQUE ACROSS A WHOLE NETBOX INSTALL, not per site. Two
 * racks each with an "01" sticker collide — prefix them.
 *
 * NetBox has no native firmware field; put it in customFields.
 */
const Device = (o, {
  name = '', deviceTypeUid = '', roleUid = '', siteUid = '', rackUid = null,
  position = null, face = 'front', serial = null, assetTag = null,
  primaryIp = null, mac = null, platform = null, status = 'active',
  description = '', customFields = {},
}) => ({ ...o, name, deviceTypeUid, roleUid, siteUid, rackUid, position, face,
         serial, assetTag, primaryIp, mac, platform, status, description,
         customFields });

/** A network port that can carry traffic and speak LLDP. */
const Interface = (o, { deviceUid = '', name = '', type = '1000base-t',
                        description = '', mac = null, enabled = true,
                        label = null }) =>
  ({ ...o, deviceUid, name, type, description, mac, enabled, label });

/** Patch panel, back side. Passive — no electronics, no IP, ever. */
const RearPort = (o, { deviceUid = '', name = '', type = '8p8c', positions = 1 }) =>
  ({ ...o, deviceUid, name, type, positions });

/**
 * Patch panel, front side. Points at a rear port.
 *
 * This pairing is how NetBox threads a cable THROUGH a passive panel:
 * switch to front port, rear port to the far end. NetBox then computes the
 * full path itself. It is also the capability no amount of network telemetry
 * can replace, because there is nothing inside a patch panel to interrogate.
 */
const FrontPort = (o, { deviceUid = '', name = '', type = '8p8c',
                        rearPortUid = '', rearPortPosition = 1 }) =>
  ({ ...o, deviceUid, name, type, rearPortUid, rearPortPosition });

const PowerPort   = (o, { deviceUid = '', name = '' }) => ({ ...o, deviceUid, name });
const PowerOutlet = (o, { deviceUid = '', name = '' }) => ({ ...o, deviceUid, name });

const VLAN   = (o, { vid = 0, name = '', siteUid = null }) => ({ ...o, vid, name, siteUid });
const Prefix = (o, { prefix = '', vlanUid = null, description = '' }) =>
  ({ ...o, prefix, vlanUid, description });
const IPAddress = (o, { address = '', interfaceUid = null }) =>
  ({ ...o, address, interfaceUid });

/**
 * One end of a cable. `objectType` is NetBox's own app-label string, kept
 * verbatim: it wants `dcim.frontport`, and `dcim.front-port` fails.
 */
const Termination = (objectType, uid) => ({ objectType, uid });

/**
 * A physical cable, with BOTH ends.
 *
 * A cable with one end is not a cable, it is a note. This is the object the
 * client asked about most sharply, and the one v1 currently invents. Here it
 * may only be constructed from evidence.
 */
const Cable = (o, { a = null, b = null, type = 'cat6', color = null,
                    label = null, length = null, lengthUnit = 'm', description = '',
                    status = null }) =>
  ({ ...o, a, b, type, color, label, length, lengthUnit, description, status });

/**
 * Status follows evidence, unless the source itself says the cable is only
 * asserted. A manual record can be sure a link exists yet unsure which of two
 * ports carries it; `planned` is NetBox's own word for that, and it is what
 * the customer filters on to find cables that need a look.
 */
const cableStatus = (cable) => cable.status || netboxStatus(cable.evidence);
const cableComplete = (cable) => Boolean(cable.a && cable.b);

/**
 * Two sources disagreed. The most valuable output in the system.
 *
 * A disagreement between the camera and the switch usually means somebody
 * repatched a cable and did not update the documentation — the exact problem
 * the customer is buying this to solve. Surface it; never pick a winner.
 */
const Conflict = ({ subjectUid, field, cvSays = '', telemetrySays = '', note = '' }) =>
  ({ subjectUid, field, cvSays, telemetrySays, note });

module.exports = {
  Evidence, confidence, exportable, netboxStatus,
  EXPORT_ORDER, emptySnapshot, observed,
  Site, Location, Rack, Manufacturer, DeviceType, DeviceRole, Device,
  Interface, RearPort, FrontPort, PowerPort, PowerOutlet,
  VLAN, Prefix, IPAddress,
  Termination, Cable, cableStatus, cableComplete, Conflict,
};
