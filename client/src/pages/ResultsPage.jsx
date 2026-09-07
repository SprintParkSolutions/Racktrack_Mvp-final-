import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import styles from './ResultsPage.module.css';
import { apiUrl, authFetch, bustUrl } from '../utils/api';
import { getItem, getJSON, setItem, setJSON } from '../utils/safeStorage';
import CmdbApprovalModal from '../components/CmdbApprovalModal.jsx';
import BackButton from '../components/BackButton.jsx';
import ScanTabBar from '../components/ScanTabBar.jsx';
import { useIsDesktop } from '../hooks/useIsDesktop';
import RackTabs from '../components/RackTabs.jsx';
import StandardFeedback from '../components/StandardFeedback.jsx';
import { PortsContent } from './PortsPage.jsx';
import { TopologyContent } from './TopologyPage.jsx';
import { NetdiscoContent } from './NetdiscoPage.jsx';
import { SwitchInfoContent } from './SwitchInformationPage.jsx';
import { PortHistoryContent } from './PortHistoryPage.jsx';
import AssetImg from '../components/AssetImg';
import { useSmartBack } from '../hooks/useSmartBack';
import { useTour } from '../TourContext.jsx';
import { useAuth } from '../AuthContext';
import { Browser } from '@capacitor/browser';

// ── Naming convention ─────────────────────────────────────────
const CLASS_CODE = {
  'Switch': 'SW', 'Patch Panel': 'PP', 'Firewall': 'FW', 'Router': 'RO',
  'Server': 'SVR', 'Load Balancer': 'LB', 'Modem': 'MO',
  'Controller': 'CTRL', 'Recorder': 'REC', 'Amplifier': 'AMP', 'Gateway': 'GT',
  'PDU': 'PDU', 'PSU': 'PSU', 'UPS': 'UPS', 'Empty': 'EMP', 'Closed Unit': 'CL',
};
const TYPE_COLOR = {
  'Switch': '#6366f1', 'Patch Panel': '#60a5fa', 'Server': '#a78bfa',
  'Gateway': '#fb923c', 'Firewall': '#f87171', 'PDU': '#fbbf24',
  'PSU': '#f472b6', 'UPS': '#34d399', 'Router': '#818cf8',
  'Load Balancer': '#c084fc', 'Modem': '#a1a1a1',
  'Controller': '#67e8f9', 'Recorder': '#86efac', 'Amplifier': '#fda4af',
  'Closed Unit': '#f43f5e', 'Empty': 'rgba(79, 70, 229,0.3)',
};
const DEFAULT_COLOR = '#6366f1';

function getColor(name) { return TYPE_COLOR[name] || DEFAULT_COLOR; }

function parseUnitNumber(label) {
  const match = String(label || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function formatUnitsRange(units = []) {
  const numbers = [...new Set((units || [])
    .map(parseUnitNumber)
    .filter((n) => n !== null))].sort((a, b) => a - b);
  if (!numbers.length) return '';

  const ranges = [];
  let start = numbers[0];
  let prev = numbers[0];

  for (let i = 1; i < numbers.length; i += 1) {
    const current = numbers[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push([start, prev]);
    start = current;
    prev = current;
  }
  ranges.push([start, prev]);

  return ranges.map(([s, e]) =>
    s === e
      ? `U${String(s).padStart(2, '0')}`
      : `U${String(s).padStart(2, '0')}-U${String(e).padStart(2, '0')}`
  ).join(' ');
}

// The lowest U a device occupies, for ordering. Units arrive as "u14"; a
// device with none sorts by its pixel position instead (larger y = lower in
// the photo = lower in the rack), and after every device that has units.
function lowestUnit(dev) {
  const nums = (dev.units || []).map(u => parseInt(String(u).replace(/\D/g, ''), 10)).filter(Number.isFinite);
  if (nums.length) return Math.min(...nums);
  const y = Array.isArray(dev.box) ? dev.box[3] : 0;
  return 10000 - y;   // no unit: rank below every unit-bearing device, bottom first
}

function buildDeviceLabels(devices, unitsDetected = [], pattern = null) {
  const counts = {};
  const padding = pattern?.padding || 2;
  // Number from the BOTTOM of the rack, as racks themselves are numbered (U1
  // at the base): the lowest switch is SW01, the one above it SW02. The
  // devices array stays in photo order (top-down) because the picture is drawn
  // from it; only the sequence each device gets is decided bottom-up.
  const order = devices.map((dev, idx) => idx)
    .sort((a, b) => lowestUnit(devices[a]) - lowestUnit(devices[b]));
  const out = new Array(devices.length);
  for (const idx of order) {
    const dev = devices[idx];
    const code = CLASS_CODE[dev.class_name] || dev.class_name.replace(/\s+/g, '').slice(0, 4).toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    const seq = String(counts[code]).padStart(padding, '0');
    // When OCR detected a real label on this rack, mint matching names for
    // the rest (e.g. RVEW-CORE-SW01 → RVEW-CORE-PDU01) instead of falling
    // back to the unit-prefixed scheme.
    if (pattern) { out[idx] = `${pattern.prefix}${pattern.sep}${code}${seq}`; continue; }
    const labelUnits = dev.units?.length ? dev.units : unitsDetected.length ? [unitsDetected[0]] : [];
    const formatted = formatUnitsRange(labelUnits) || 'U01';
    const primaryLabel = formatted.split(' ')[0];
    out[idx] = `${primaryLabel}-${code}${seq}`;
  }
  return out;
}

function buildPortLabel(deviceLabel, className, portNum) {
  const p = String(portNum).padStart(2, '0');
  switch (className) {
    case 'Switch':      return `${deviceLabel}-IF-Gi1/0/${portNum}`;
    case 'Patch Panel': return `${deviceLabel}-FP-${p}`;
    case 'PDU':         return `${deviceLabel}-OUT-${p}`;
    case 'Server': case 'PSU': case 'UPS': return `${deviceLabel}-PWR-${p}`;
    case 'Gateway': case 'Router': case 'Firewall': return `${deviceLabel}-IF-${p}`;
    default:            return `${deviceLabel}-P${p}`;
  }
}

const DEVICE_CLASS_OPTIONS = [
  'Switch', 'Patch Panel', 'Firewall', 'Router', 'Server', 'Load Balancer',
  'Modem', 'Controller', 'Recorder', 'Amplifier', 'Gateway', 'PDU', 'PSU', 'UPS',
];
const CABLE_COLOR_OPTIONS = [
  'Black', 'Blue', 'Brown', 'Green', 'Grey', 'Orange',
  'Pink', 'Red', 'White', 'Yellow', 'Violet', 'Aqua',
];

// Physical port types the type model knows (ports_9.pt). Used by the port-type
// correction control; values must match the server's PORT_TYPE_OPTIONS.
const PORT_TYPE_OPTIONS = [
  'RJ45', 'SFP', 'QSFP', 'CONSOLE', 'AUX', 'MANAGEMENT_PORT',
  'USB_A', 'USB_B', 'USB_C',
];
const prettyPortType = (t) => t ? t.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ') : '';

// Real cable colours so the swatch matches the detected colour name (the
// monochrome theme applies to the app chrome, not to physical cable colours —
// showing an orange cable as a black dot is confusing/wrong).
const CABLE_COLOR_MAP = {
  black: '#1c1c1c', blue: '#2f6bd8', brown: '#8b5a2b', green: '#1f9d55',
  grey: '#9f9f9f', gray: '#9f9f9f', orange: '#e8792b', pink: '#e86fa6',
  red: '#d0342c', white: '#f4f4f4', yellow: '#e6b800', violet: '#8b5cf6',
  aqua: '#22c3d6',
};
function cableColorCSS(name) {
  if (!name) return '#474747';
  return CABLE_COLOR_MAP[name.toLowerCase()] || '#474747';
}

function parseCableType(label) {
  if (!label) return { raw: '', display: '', colorName: '' };
  const raw = String(label).trim();
  const normalized = raw.replace(/_/g, ' ').replace(/RJ[ _]?45/i, 'RJ-45');
  const parts = normalized.split(/\s+/);
  const colors = ['aqua','black','blue','brown','green','grey','gray','orange','pink','red','white','yellow','violet'];
  const found = parts.find(part => colors.includes(part.toLowerCase()));
  const colorName = found ? found[0].toUpperCase() + found.slice(1).toLowerCase() : '';
  const displayParts = found ? parts.filter(part => part.toLowerCase() !== found.toLowerCase()) : parts;
  const display = displayParts.join(' ');
  return { raw, display, colorName };
}

// Aggregate a device's CONNECTED ports (main + SFP + other) into
// connector+colour groups with counts — e.g. [{connector:'RJ-45', color:'Blue',
// count:12}, {connector:'LC', color:'Aqua', count:2}]. Fed by the background
// cable enrichment (cable_connector / cable_color on each connected port);
// returns [] until enrichment has run, so the chips simply appear when ready.
function cableChips(dev) {
  const lists = [dev?.ports, dev?.sfp_ports, dev?.other_ports];
  const map = new Map();
  for (const lst of lists) {
    if (!Array.isArray(lst)) continue;
    for (const p of lst) {
      if (!p || p.status !== 'connected') continue;
      const parsed = (!p.cable_connector && !p.cable_color) ? parseCableType(p.cable_type) : null;
      const connector = p.cable_connector || parsed?.display || '';
      const color     = p.cable_color     || parsed?.colorName || '';
      if (!connector && !color) continue;     // this port not enriched yet
      const key = `${connector}|${color}`;
      const cur = map.get(key) || { connector, color, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ── Port report builder ──────────────────────────────────────
// Parses the console transcript into a structured report:
//   { switch, port, link, learnedMacs[{mac,vlan,type,vendor,ip}], lldp, cable, stp, vlan }
// Heuristic regexes — tolerant to TP-Link, Cisco, D-Link dialects.

function normalizeMac(s) {
  const hex = (s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return (s || '').toLowerCase().trim();
  return hex.match(/.{2}/g).join(':');
}

function parseLearnedMacs(text) {
  if (!text) return [];
  const macRx = /([0-9a-fA-F]{2}[:\-.][0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2})\s+(\d+)\s+(\S+)\s+(\S+)/;
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(macRx);
    if (!m) continue;
    const mac = normalizeMac(m[1]);
    if (mac.split(':').length !== 6) continue;
    out.push({ mac, vlan: m[2], port: m[3], type: m[4] });
  }
  return out;
}

function parseInterfaceStatus(text, iface) {
  if (!text) return null;
  // `Gi1/0/6   LinkUp      1000M     Full      Disable     Copper`
  const esc = (iface || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${esc}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  return {
    status: m[1], speed: m[2], duplex: m[3],
    flow: m[4], medium: m[5], description: (m[6] || '').trim(),
  };
}

function parseLldpNeighborBlock(text) {
  if (!text) return null;
  if (/No Neighbor/i.test(text) || /no lldp neighbor/i.test(text)) return null;
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const info = {
    chassis_id:    pick(/Chassis (?:ID|Id)\s*[:=]\s*([^\n]+)/i),
    port_id:       pick(/Port (?:ID|Id)\s*[:=]\s*([^\n]+)/i),
    port_desc:     pick(/Port [Dd]escription\s*[:=]\s*([^\n]+)/i),
    system_name:   pick(/System [Nn]ame\s*[:=]\s*([^\n]+)/i),
    system_desc:   pick(/System [Dd]escription\s*[:=]\s*([^\n]+)/i),
    mgmt_addr:     pick(/(?:Management [Aa]ddress|Management IP)[^\n]*?\b((?:\d{1,3}\.){3}\d{1,3})\b/i),
    pvid:          pick(/Port VLAN ID\(PVID\)\s*[:=]\s*(\d+)/i),
    ttl:           pick(/TTL\s*[:=]\s*(\d+)/i),
  };
  const hasAny = Object.values(info).some(v => v && v.toLowerCase() !== 'none');
  return hasAny ? info : null;
}

function parseCableDiag(text) {
  if (!text) return null;
  const pairs = {};
  for (const line of text.split('\n')) {
    const m = line.match(/[Pp]air[-\s]?([A-D1-4])[\s:]+(\S+)(?:[^0-9]*(\d+))?/);
    if (!m) continue;
    pairs[m[1].toUpperCase()] = { status: m[2], length_m: m[3] ? +m[3] : null };
  }
  return Object.keys(pairs).length ? pairs : null;
}

function parseStp(text) {
  if (!text) return null;
  if (/Spanning tree is disabled/i.test(text)) return { state: 'disabled' };
  if (/Interface information is not available/i.test(text)) return { state: 'unknown' };
  return { state: 'enabled' };
}

function buildPortReport({ host, vendor, iface, portNum, entries = [], neighbor, neighborMethod }) {
  const byName = {};
  for (const e of entries) if (e && e.name) byName[e.name.toLowerCase()] = e;

  const ifaceStatusText = (byName['interface status'] || byName['port status'] || {}).output || '';
  const macText = (byName['mac address-table'] || byName['mac address table'] || {}).output || '';
  const lldpText = (byName['lldp neighbor'] || byName['lldp remote ports'] || {}).output || '';
  const cableText = (byName['cable diagnostics'] || byName['cable diag'] || {}).output || '';
  const stpText = (byName['spanning tree'] || {}).output || '';

  const link = parseInterfaceStatus(ifaceStatusText, iface);
  const macs = parseLearnedMacs(macText);
  const lldp = parseLldpNeighborBlock(lldpText);
  const cable = parseCableDiag(cableText);
  const stp = parseStp(stpText);

  // If we already resolved a neighbor via the quick-lookup fallback chain, merge it in.
  const mergedLldp = lldp || (neighbor?.found ? {
    system_name: neighbor.system_name || null,
    port_id: neighbor.port_id || null,
    port_desc: neighbor.port_description || null,
    chassis_id: neighbor.chassis_id || null,
    system_desc: neighbor.system_description || null,
    mgmt_addr: neighbor.management_address || null,
    _via: neighborMethod || null,
  } : null);

  // One-line end-device verdict
  let verdict;
  if (link?.status === 'LinkDown') {
    verdict = 'Link is DOWN - no device connected (or cable unplugged at the far end).';
  } else if (mergedLldp?.system_name || mergedLldp?.chassis_id) {
    const name = mergedLldp.system_name || mergedLldp.chassis_id;
    const mgmt = mergedLldp.mgmt_addr ? ` @ ${mergedLldp.mgmt_addr}` : '';
    verdict = `${name}${mgmt}${mergedLldp._via ? ` (via ${mergedLldp._via})` : ''}`;
  } else if (macs.length === 1) {
    verdict = `One endpoint: ${macs[0].mac} (VLAN ${macs[0].vlan})`;
  } else if (macs.length > 1) {
    verdict = `${macs.length} MACs learned - likely a downstream switch/hub/AP`;
  } else {
    verdict = 'Link is UP but no MAC learned yet and no LLDP neighbor - device is silent.';
  }

  return {
    generatedAt: new Date().toISOString(),
    switch: { host, vendor },
    port: { iface, number: portNum },
    link, macs, lldp: mergedLldp, cable, stp,
    verdict,
    transcript: entries,
  };
}

// ── Switch info parser ───────────────────────────────────────
// Parses live SSH output (show version / show system-info) into a small set
// of fields we surface in the Switch Info modal. Live data only — never
// persisted, never reconciled with CMDB.
function parseSwitchInfo(raw, vendor) {
  const text = String(raw || '').replace(/\r/g, '');
  const out = { model: null, firmware: null, uptime: null, serial: null, mac: null, hostname: null };
  if (!text) return out;

  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  if (vendor === 'tplink') {
    out.model    = grab(/(?:Device\s*Model|Hardware\s*Version)\s*[-:]\s*([^\r\n]+)/i);
    out.firmware = grab(/(?:Software|Firmware)\s*Version\s*[-:]\s*([^\r\n]+)/i);
    // "Running Time" is the actual uptime; "System Time" is wall-clock.
    out.uptime   = grab(/Running\s*Time\s*[-:]\s*([^\r\n]+)/i)
                || grab(/System\s*Up\s*Time\s*[-:]\s*([^\r\n]+)/i);
    out.serial   = grab(/Serial\s*Number\s*[-:]\s*(\S+)/i);
    out.mac      = grab(/(?:System\s*)?MAC\s*Address\s*[-:]\s*([0-9A-Fa-f:.\- ]+)/i);
    out.hostname = grab(/(?:Device\s*Name|System\s*Name)\s*[-:]\s*([^\r\n]+)/i);
  } else if (vendor === 'dlink') {
    out.model    = grab(/(?:Device\s*Type|System\s*Hardware\s*Version)\s*:\s*([^\r\n]+)/i);
    out.firmware = grab(/(?:Firmware|System\s*Firmware)\s*Version\s*:\s*([^\r\n]+)/i);
    out.uptime   = grab(/System\s*Up\s*Time\s*:\s*([^\r\n]+)/i);
    out.serial   = grab(/Serial\s*Number\s*:\s*([^\r\n]+)/i);
    out.mac      = grab(/(?:System\s*)?MAC\s*Address\s*:\s*([0-9A-Fa-f:.\- ]+)/i);
    out.hostname = grab(/(?:Device\s*Name|System\s*Name)\s*:\s*([^\r\n]+)/i);
  } else {
    // cisco-ios (default): `show version`
    // Hardware model: try Model number first, then "cisco <MODEL> (...)"
    out.model =
      grab(/Model\s*number\s*:\s*([^\r\n]+)/i) ||
      grab(/^cisco\s+(\S+)\s*\(/im);
    // IOS / IOS-XE software version
    out.firmware =
      grab(/(?:IOS\s*XE\s*Software|IOS\s*Software)[^\n]*Version\s+([^\s,]+)/i) ||
      grab(/Version\s+([^\s,]+),\s*RELEASE/i);
    out.uptime   = grab(/uptime\s+is\s+([^\r\n]+)/i);
    out.serial   = grab(/(?:Processor\s*board\s*ID|System\s*Serial\s*Number)\s*:?\s*([A-Z0-9]+)/i);
    out.hostname = grab(/^([^\s]+)\s+uptime\s+is/im);
  }
  return out;
}

// Vendor → command we run for the Switch Info modal. Live SSH only.
const SWITCH_INFO_CMD = {
  'cisco-ios': 'show version',
  'tplink':    'show system-info',
  'dlink':     'show switch',
};

// SSH vendor code → vendor display name in the spec-scraper Excel sheet.
// The /api/specs and /api/firmware backends take a free-text vendor and
// substring-match it against the sheet, so we need the canonical brand name.
const SSH_VENDOR_TO_DISPLAY = {
  'cisco-ios': 'Cisco',
  'tplink':    'TP-Link',
  'dlink':     'D-Link',
};

// Strip a trailing hardware-revision suffix ("TL-SG2428P 5.0" → "TL-SG2428P")
// so the vendor product page actually resolves. Vendors don't put hw rev in
// the URL slug; SSH does include it in `Hardware Version`.
function cleanModelForLookup(m) {
  if (!m) return '';
  return String(m).trim().replace(/\s+v?\d+(?:\.\d+){0,2}\s*$/i, '').trim();
}

// Extract a clean dotted version from messy firmware strings.
//   "5.0.2 Build 20220909 Rel.75392" → "5.0.2"
//   "16.9.5"                          → "16.9.5"
//   "9.3(7)I7(7)"                     → "9.3(7)I7(7)"
function cleanFirmwareVersion(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Cisco NX-OS form first — has parentheses our generic regex would miss.
  const nx = s.match(/\b\d+\.\d+\([^)]+\)(?:[A-Z]\d+(?:\([^)]+\))?)?/);
  if (nx) return nx[0];
  const dotted = s.match(/\b\d+\.\d+(?:\.\d+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,5})?(?:-[A-Za-z0-9]{1,8})?\b/);
  return dotted ? dotted[0] : s;
}

// ── Switch info modal ────────────────────────────────────────
// Live snapshot of the switch over SSH — model, firmware, uptime, serial.
// Independent of CMDB / Netdisco / any synthesized data.
function SwitchInfoModal({
  status, info, raw, error, host, vendor,
  specs, specsStatus, specsError,
  firmware, firmwareStatus, firmwareError,
  onClose, onRetry,
}) {
  const [rawOpen, setRawOpen] = useState(false);

  return (
    <div className={styles.portReportBackdrop} onClick={onClose}>
      <div className={`${styles.portReport} ${styles.siModal}`} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className={styles.siHeader}>
          <div className={styles.siHeaderLeft}>
            <div className={styles.siHeaderIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="18" rx="3"/>
                <circle cx="7" cy="16" r="1.2" fill="currentColor" stroke="none"/>
                <circle cx="11" cy="16" r="1.2" fill="currentColor" stroke="none"/>
                <line x1="6" y1="8" x2="18" y2="8"/>
              </svg>
            </div>
            <div>
              <div className={styles.siTitle}>Switch Info</div>
              <div className={styles.siSub}>
                <span className={styles.siLiveDot} />
                live · {host || '-'} · {vendor || '-'}
              </div>
            </div>
          </div>
          <button className={styles.portReportClose} onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.siBody}>
          {status === 'loading' && (
            <div className={styles.siCard}>
              <p className={styles.prEmpty}>Querying switch over SSH…</p>
            </div>
          )}

          {status === 'error' && (
            <div className={styles.siCard}>
              <div className={styles.siCardHead}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#474747" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <h4>Could not reach switch</h4>
              </div>
              <p className={styles.prEmpty}>{error || 'Unknown error'}</p>
              <div style={{ marginTop: 10 }}>
                <button className={styles.reportChip} onClick={onRetry}>Retry</button>
              </div>
            </div>
          )}

          {status === 'ready' && info && (
            <>
              {/* ── Hardware & Firmware card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
                  <h4>Hardware &amp; Firmware</h4>
                </div>
                <div className={styles.siTable}>
                  <div className={styles.siRow}><span>Model</span><span>{info.model || '-'}</span></div>
                  <div className={styles.siRow}><span>Firmware</span><span>{info.firmware || '-'}</span></div>
                  <div className={styles.siRow}><span>Serial</span><span>{info.serial || '-'}</span></div>
                  <div className={styles.siRow}><span>Uptime</span><span>{info.uptime || '-'}</span></div>
                  {info.hostname && <div className={styles.siRow}><span>Hostname</span><span>{info.hostname}</span></div>}
                  {info.mac && <div className={styles.siRow}><span>MAC Address</span><span>{info.mac}</span></div>}
                </div>
              </div>

              {/* ── Firmware Update card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <h4>Firmware Update</h4>
                </div>
                {firmwareStatus === 'loading' && (
                  <p className={styles.prEmpty}>Checking vendor site for newer firmware…</p>
                )}
                {firmwareStatus === 'error' && (
                  <p className={styles.prEmpty}>Could not check: {firmwareError || 'lookup failed'}</p>
                )}
                {firmwareStatus === 'ready' && firmware && (() => {
                  const tone =
                    firmware.upToDate === true ? 'ok'
                    : firmware.upToDate === false ? 'warn'
                    : 'neutral';
                  const headline =
                    firmware.upToDate === true ? 'Up to date'
                    : firmware.upToDate === false ? 'Upgrade available'
                    : 'Could not determine latest version';
                  const icon =
                    tone === 'ok' ? '✓' : tone === 'warn' ? '↑' : '?';
                  return (
                    <>
                      <div className={`${styles.siBadge} ${styles[`siBadge_${tone}`]}`}>
                        <span className={styles.siBadgeIcon}>{icon}</span>
                        {headline}
                      </div>
                      <div className={styles.siTable} style={{ marginTop: 10 }}>
                        <div className={styles.siRow}>
                          <span>Current version</span>
                          <span>{firmware.currentVersion || '-'}</span>
                        </div>
                        <div className={styles.siRow}>
                          <span>Latest version</span>
                          <span>{firmware.latestVersion || '-'}</span>
                        </div>
                      </div>
                      {firmware.releaseNotesUrl && (
                        <a href={firmware.releaseNotesUrl} target="_blank" rel="noreferrer noopener"
                           className={styles.siLink}>
                          Release notes
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
                        </a>
                      )}
                    </>
                  );
                })()}
                {firmwareStatus === 'skipped' && (
                  // Model and version come from the live SSH snapshot, so with
                  // no switch reachable this card used to state a requirement
                  // and stop — the user was told what was missing with no way
                  // to supply it, which is why "Firmware is disabled" was
                  // reported. The Switches tab is where a make, model and version are
                  // entered by hand, so name that instead of dead-ending.
                  <p className={styles.prEmpty}>
                    Need both model and firmware version to check for updates —
                    set them on the Switches tab.
                  </p>
                )}
              </div>

              {/* ── Vendor Specifications card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                  <h4>Vendor Specifications</h4>
                  {specsStatus === 'ready' && specs?.productUrl && (
                    <a href={specs.productUrl} target="_blank" rel="noreferrer noopener"
                       className={styles.siLink} style={{ marginLeft: 'auto' }}>
                      Source
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
                    </a>
                  )}
                </div>
                {specsStatus === 'loading' && (
                  <p className={styles.prEmpty}>Looking up specs on vendor site…</p>
                )}
                {specsStatus === 'error' && (
                  <p className={styles.prEmpty}>Could not fetch specs: {specsError || 'lookup failed'}</p>
                )}
                {specsStatus === 'ready' && specs?.specs && (
                  <div className={styles.siTable}>
                    {Object.entries(specs.specs).slice(0, 12).map(([k, v]) => (
                      <div className={styles.siRow} key={k}>
                        <span>{k}</span>
                        <span>{String(v).length > 80 ? String(v).slice(0, 77) + '…' : String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {specsStatus === 'skipped' && (
                  // Same dead end as the firmware card above — see the note there.
                  <p className={styles.prEmpty}>
                    Need a model to look up specs — set one on the Switches tab.
                  </p>
                )}
              </div>

              {/* ── Raw Output (collapsible) ── */}
              {raw && (
                <div className={styles.siCard}>
                  <button className={styles.siCardToggle} onClick={() => setRawOpen(o => !o)}>
                    <div className={styles.siCardHead} style={{ margin: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                      <h4>Raw Output</h4>
                    </div>
                    <span className={`${styles.siChevron} ${rawOpen ? styles.siChevronOpen : ''}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                  </button>
                  {rawOpen && (
                    <pre className={styles.siRawPre}>{raw}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Port report modal (shown when the user presses "Done" in the console) ────
function PortReportModal({ report, onClose }) {
  const {
    switch: sw, port, link, macs = [], lldp, cable, stp, verdict, transcript = [],
  } = report || {};
  return (
    <div className={styles.portReportBackdrop} onClick={onClose}>
      <div className={styles.portReport} onClick={(e) => e.stopPropagation()}>
        <div className={styles.portReportHead}>
          <div>
            <div className={styles.portReportTitle}>Port Report · {port?.iface}</div>
            <div className={styles.portReportSub}>{sw?.host} · {sw?.vendor}</div>
          </div>
          <button className={styles.portReportClose} onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.portReportVerdict}>▸ {verdict}</div>

        <div className={styles.portReportBody}>
          <section className={styles.prSection}>
            <h4>Link</h4>
            {link ? (
              <div className={styles.prGrid}>
                <div><span>Status</span><b>{link.status}</b></div>
                <div><span>Speed</span><b>{link.speed}</b></div>
                <div><span>Duplex</span><b>{link.duplex}</b></div>
                <div><span>Flow Ctrl</span><b>{link.flow}</b></div>
                <div><span>Medium</span><b>{link.medium}</b></div>
                <div><span>Description</span><b>{link.description || '-'}</b></div>
              </div>
            ) : <p className={styles.prEmpty}>Link status not captured.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>End device(s) on this port</h4>
            {macs.length === 0 ? (
              <p className={styles.prEmpty}>No MACs learned - port idle or never carried traffic.</p>
            ) : (
              <ul className={styles.prMacList}>
                {macs.map((m, i) => (
                  <li key={i}>
                    <code>{m.mac}</code>
                    <span>VLAN {m.vlan}</span>
                    <span>{m.type}</span>
                  </li>
                ))}
              </ul>
            )}
            {macs.length > 1 && (
              <p className={styles.prHint}>
                Multiple MACs on this port - likely a downstream switch, hub, or access point.
              </p>
            )}
          </section>

          <section className={styles.prSection}>
            <h4>LLDP neighbor</h4>
            {lldp ? (
              <div className={styles.prGrid}>
                {lldp.system_name && <div><span>System name</span><b>{lldp.system_name}</b></div>}
                {lldp.chassis_id && <div><span>Chassis ID</span><b>{lldp.chassis_id}</b></div>}
                {lldp.port_id && <div><span>Remote port</span><b>{lldp.port_id}</b></div>}
                {lldp.port_desc && <div><span>Port desc</span><b>{lldp.port_desc}</b></div>}
                {lldp.mgmt_addr && <div><span>Management IP</span><b>{lldp.mgmt_addr}</b></div>}
                {lldp.pvid && <div><span>PVID</span><b>{lldp.pvid}</b></div>}
                {lldp.ttl && <div><span>TTL</span><b>{lldp.ttl}</b></div>}
                {lldp._via && <div><span>Resolved via</span><b>{lldp._via}</b></div>}
                {lldp.system_desc && <div className={styles.prWide}><span>System desc</span><b>{lldp.system_desc}</b></div>}
              </div>
            ) : <p className={styles.prEmpty}>No LLDP neighbor advertised - endpoint does not speak LLDP, or it is disabled.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>Cable</h4>
            {cable ? (
              <ul className={styles.prPairList}>
                {Object.keys(cable).sort().map(pair => (
                  <li key={pair}>
                    Pair {pair}: <b>{cable[pair].status}</b>
                    {cable[pair].length_m != null && <span> @ {cable[pair].length_m}m</span>}
                  </li>
                ))}
              </ul>
            ) : <p className={styles.prEmpty}>Cable diagnostics not run on this port.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>Spanning tree</h4>
            <p className={styles.prEmpty}>{stp?.state ? `STP state: ${stp.state}` : 'STP state unknown.'}</p>
          </section>

          <section className={styles.prSection}>
            <h4>Full transcript</h4>
            <div className={styles.prTranscript}>
              {transcript.map((e, i) => (
                <details key={i} className={styles.prCmd}>
                  <summary>{e.name || 'manual'} - <code>{e.cmd}</code></summary>
                  {e.error
                    ? <pre className={styles.prCmdErr}>{e.error}</pre>
                    : <pre>{e.output || '(no output)'}</pre>}
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Switch credentials modal ──────────────────────────────────
// Vendor is locked to TP-Link for now — multi-vendor picker can be
// reintroduced later by restoring VENDOR_CHOICES + the segmented control.
const STATIC_VENDOR = 'tplink';
const STATIC_VENDOR_LABEL = 'TP-Link';

function CredsModal({ initial, onCancel, onSubmit }) {
  const [host, setHost] = useState(initial?.host || '');
  const [user, setUser] = useState(initial?.username || '');
  const [pass, setPass] = useState(initial?.password || '');
  const vendor = STATIC_VENDOR;             // locked to TP-Link for now
  const [enablePass, setEnablePass] = useState(initial?.enablePassword || '');

  // Does the encrypted env store already have user/password? If so, hide
  // those fields and ask for only the switch IP.
  const [credsStatus, setCredsStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setCredsStatus(null);
    authFetch(apiUrl(`/api/switch/creds-status?vendor=${encodeURIComponent(vendor)}`))
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { if (!cancelled) setCredsStatus(data); })
      .catch(() => { if (!cancelled) setCredsStatus({ has_username: false, has_password: false, has_enable: false }); });
    return () => { cancelled = true; };
  }, [vendor]);

  const stored = !!(credsStatus?.has_username && credsStatus?.has_password);
  const disabled = !host.trim() || (!stored && (!user.trim() || !pass));

  return (
    <div className={styles.credsBackdrop} onClick={onCancel}>
      <div className={styles.credsModal} onClick={e => e.stopPropagation()}>
        <div className={styles.credsHeader}>
          <div className={styles.vendorStaticPill}>{STATIC_VENDOR_LABEL}</div>
          <button className={styles.credsClose} onClick={onCancel} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        {!stored && (
          <p className={styles.credsHint}>
            Stored only in memory for this session. SSH is used to query LLDP / MAC table on the switch.
          </p>
        )}
        <label className={styles.credsField}>
          <span>Switch IP</span>
          <input className="input" type="text" autoFocus value={host} onChange={e => setHost(e.target.value)} placeholder="e.g. 10.0.0.5"
            onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
        </label>

        {!stored && (
          <>
            <label className={styles.credsField}>
              <span>Username</span>
              <input className="input" type="text" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" />
            </label>
            <label className={styles.credsField}>
              <span>Password</span>
              <input className="input" type="password" value={pass} onChange={e => setPass(e.target.value)} autoComplete="current-password"
                onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
            </label>
            <label className={styles.credsField}>
              <span>Enable password <span style={{ opacity: 0.6 }}>(optional)</span></span>
              <input className="input" type="password" value={enablePass} onChange={e => setEnablePass(e.target.value)} autoComplete="off"
                placeholder="Only if your switch requires one"
                onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
            </label>
          </>
        )}
        <div className={styles.credsActions}>
          <button className={styles.credsCancel} onClick={onCancel}>Cancel</button>
          <button className={styles.credsSubmit} disabled={disabled} onClick={() => onSubmit(host, user, pass, vendor, enablePass)}>Connect →</button>
        </div>
      </div>
    </div>
  );
}

// ── Device picker dropdown ────────────────────────────────────
// 'Unidentified' is a synthetic placeholder the pipeline inserts for rack
// rows where no detector produced a class even at low confidence — hide
// it from the picker (nothing to inspect) while keeping it on the rack
// map / report so the row isn't lost visually.
const HIDDEN_DEVICE_TYPES = new Set(['Empty', 'Closed Unit', 'Unidentified']);

// Small badge shown next to a value that came from a USER correction (active
// learning), not the model's own output — so a tester doesn't mistake their
// own confirmed value for a model mistake.
function UserTag({ label = 'Your correction' }) {
  return (
    <span
      className={styles.userTag}
      title="This value is from your correction, not the model's original guess."
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
      </svg>
      {label}
    </span>
  );
}

// What counts as a "switch" for the picker / dropdown. Matches the
// SWITCHES-tab badge (Switch + Router), and also recovers devices that
// were originally detected as a Switch but reclassified to a brand-specific
// subclass (Controller, Gateway, etc.) by OCR brand-token logic.
const SWITCH_LIKE_CLASSES = new Set(['Switch', 'Router']);
function isSwitchLike(dev) {
  if (!dev) return false;
  if (SWITCH_LIKE_CLASSES.has(dev.class_name)) return true;
  if (dev._reclassifiedFrom && SWITCH_LIKE_CLASSES.has(dev._reclassifiedFrom)) return true;
  return false;
}

// These port-bearing device types are selectable — the kinds with
// user-inspectable ports. PDUs are included because they have their own
// power-outlet detection and a dedicated power view (outlets · in use · free ·
// powered) on selection. Servers, PSUs, UPSes, etc. are shown in the annotated
// image but not offered for selection.
const PICKABLE_DEVICE_TYPES = new Set(['Switch', 'Patch Panel', 'Router', 'Gateway', 'Firewall', 'PDU']);
function isDevicePickable(dev) {
  if (!dev || HIDDEN_DEVICE_TYPES.has(dev.class_name)) return false;
  if (PICKABLE_DEVICE_TYPES.has(dev.class_name)) return true;
  if (dev._reclassifiedFrom && PICKABLE_DEVICE_TYPES.has(dev._reclassifiedFrom)) return true;
  return false;
}

// Port categories the pipeline emits (the 9 model classes collapse to these
// four buckets: RJ45→main, SFP/QSFP→sfp, CONSOLE/AUX/MGMT→console, USB→other).
const PORT_CATEGORIES = [
  { k: 'main',    label: 'RJ45' },
  { k: 'sfp',     label: 'SFP' },
  { k: 'console', label: 'Console' },
  { k: 'other',   label: 'USB' },
];

// A device's port field may arrive as an array (from /api/analyze) or as a
// count number (from the canonical /api/scan/:id/result). Handle both.
function portCatCount(dev, k) {
  if (!dev) return 0;
  const v = k === 'main'    ? (dev.port_count != null ? dev.port_count : dev.ports)
          : k === 'sfp'     ? dev.sfp_ports
          : k === 'console' ? dev.console_ports
          : k === 'other'   ? dev.other_ports
          : 0;
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' ? v : 0;
}

function totalPortCount(dev) {
  return PORT_CATEGORIES.reduce((sum, c) => sum + portCatCount(dev, c.k), 0);
}

// Per-type breakdown string, e.g. "24 RJ45 · 2 SFP · 1 Console" — only the
// categories the device actually has. Empty string when it has no ports.
function portBreakdown(dev) {
  return PORT_CATEGORIES
    .map(c => ({ label: c.label, n: portCatCount(dev, c.k) }))
    .filter(p => p.n > 0)
    .map(p => `${p.n} ${p.label}`)
    .join(' · ');
}

// ── PDU power outlets ────────────────────────────────────────
const isPdu = (dev) => dev?.class_name === 'PDU';

// Short outlet summary for the picker, e.g. "24 outlets · 18 in use".
function powerSummary(dev) {
  const total = dev?.power_total || 0;
  if (!total) return '';
  const used = dev?.power_connected || 0;
  return `${total} outlet${total === 1 ? '' : 's'} · ${used} in use`;
}

// ── All components ───────────────────────────────────────────
// Marks a rack as confirmed by the user — a later re-upload that perceptually
// matches will serve this confirmed result instead of re-detecting it.
function ConfirmRackButton({ scanId }) {
  const [state, setState] = useState('idle'); // 'idle' | 'saving' | 'done' | 'error'
  const confirm = async () => {
    if (!scanId || state === 'saving') return;
    setState('saving');
    try {
      const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(scanId)}/confirm-layout`), { method: 'POST' });
      if (!r.ok) throw new Error('failed');
      setState('done');
    } catch { setState('error'); }
  };
  if (state === 'done') {
    return <span className={styles.confirmDone} title="Future scans of this rack will show this confirmed result">✓ Confirmed</span>;
  }
  return (
    <button className={styles.confirmBtn} onClick={confirm} disabled={state === 'saving'}
      title="Mark this rack as correct - a re-scan will show this instead of re-detecting">
      {state === 'saving' ? 'Saving…' : state === 'error' ? 'Retry' : 'Confirm rack'}
    </button>
  );
}

export function AllDevicesView({ devices, labels, rackId, scanId, originalExt, originalImageUrl, onBack, embedded = false }) {
  const navigate = useNavigate();
  const { state } = useLocation();
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeLabels  = Array.isArray(labels)  ? labels  : [];
  // Only the five port-bearing types are offered for selection (dropdown +
  // cards). Other detected gear still shows on the annotated image.
  const visible = safeDevices
    .map((dev, i) => ({ dev: dev || {}, label: safeLabels[i], idx: i }))
    .filter(({ dev }) => isDevicePickable(dev));

  const [selectedCard, setSelectedCard] = useState(null);
  const [imgNat, setImgNat] = useState(null);
  const heroPath = originalImageUrl
    || `/outputs/${scanId}/original_image.${originalExt || 'jpg'}`;
  const heroSrc = apiUrl(heroPath);

  // CMDB approval modal — shows once after a fresh detect-mode scan when
  // the rack isn't yet registered in CMDB. Skipped for ticket-mode scans
  // (which are investigating a specific incident on a known device) and
  // for navigation arrivals without a fresh scan (history, back button).
  const cmdbRackId = rackId || scanId;
  const isFreshDetectScan = !!state?.result && !state?.ticketMode;
  const [cmdbTicket, setCmdbTicket] = useState(null);
  const [cmdbModalOpen, setCmdbModalOpen] = useState(false);
  const dismissKey = cmdbRackId ? `rt_cmdbModalDismissed_${cmdbRackId}` : null;

  useEffect(() => {
    if (!cmdbRackId || !isFreshDetectScan) return;
    const dismissed = dismissKey && getItem(dismissKey, 'session') === '1';
    if (dismissed) return;

    // Server auto-creates the CMDB ticket ~4s after canonical scan write.
    // Poll the status endpoint for up to 25s, then surface the modal once
    // we see an open ticket with missing-data summary.
    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 12;     // 12 × 2s = 24s
    const intervalMs = 2000;
    let pendingTimer = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await authFetch(apiUrl(`/api/cmdb/ticket/${cmdbRackId}`));
        const d = await r.json();
        if (cancelled) return;
        const t = d?.ticket || null;
        if (t) setCmdbTicket(t);
        const hasMissing = t && t.state === 'open' &&
          ((t.summary?.added_devices ?? 0) > 0 ||
           (t.summary?.added_ports   ?? 0) > 0 ||
           (t.summary?.changed_devices ?? 0) > 0);
        if (hasMissing) {
          setCmdbModalOpen(true);
          return;             // stop polling
        }
        if (t && t.state === 'applied') return;   // already in CMDB
      } catch (_) { /* keep polling */ }
      attempt += 1;
      if (!cancelled && attempt < maxAttempts) {
        pendingTimer = setTimeout(tick, intervalMs);
      }
    };
    // Wait 1s before the first attempt so the server's debounced
    // auto-create has a chance to fire.
    pendingTimer = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, [cmdbRackId, dismissKey, isFreshDetectScan]);

  const closeCmdbModal = () => {
    setCmdbModalOpen(false);
    if (dismissKey) {
      try { setItem(dismissKey, '1', 'session'); } catch (_) {}
    }
  };

  const allBody = (
      <div className={embedded ? styles.tabContent : styles.allWrap}>
        {cmdbModalOpen && cmdbRackId && (
          <CmdbApprovalModal
            rackId={cmdbRackId}
            ticket={cmdbTicket}
            onTicketUpdate={(t) => setCmdbTicket(t)}
            onClose={closeCmdbModal}
          />
        )}
        {/* Show rack image with selected device highlighted */}
        {selectedCard !== null && (
          <div className={styles.resultHero}>
            <AssetImg path={heroPath} src={heroSrc} alt="Rack" className={styles.heroImg}
              onLoad={e => setImgNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} />
            {imgNat && (() => {
              const dev = safeDevices[selectedCard];
              if (!dev?.box) return null;
              const [bx1, by1, bx2, by2] = dev.box;
              const w = bx2 - bx1, h = by2 - by1;
              const poly = dev.mask_polygon;
              const stroke = getColor(dev.class_name);
              return (
                <svg className={styles.devOverlay} viewBox={`0 0 ${imgNat.w} ${imgNat.h}`} preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <filter id="neonAll">
                      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
                      <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>
                  {poly ? (
                    <polygon points={poly.map(p => `${p[0]},${p[1]}`).join(' ')}
                      fill="none" stroke={stroke} strokeWidth="3" filter="url(#neonAll)"
                      className={styles.devNeonBorder} />
                  ) : (
                    <rect x={bx1} y={by1} width={w} height={h} rx="6"
                      fill="none" stroke={stroke} strokeWidth="3" filter="url(#neonAll)"
                      className={styles.devNeonBorder} />
                  )}
                </svg>
              );
            })()}
          </div>
        )}

        {visible.length === 0 ? (
          <div className={styles.empty}>
            <p>No components detected.</p>
            <button className="btn btn-primary" onClick={onBack}>Back to scan results</button>
          </div>
        ) : (
          <div className={styles.allCards}>
            {visible.map(({ dev, label, idx }, i) => {
              const c = getColor(dev.class_name);
              const units = formatUnitsRange(dev.units)?.toUpperCase() || '-';
              const active = selectedCard === idx;
              return (
                <div key={i} className={styles.allCard}
                  style={active ? { borderColor: c, background: `${c}11` } : undefined}
                  onClick={() => setSelectedCard(active ? null : idx)}>
                  <div className={styles.allCardBar} style={{ background: c }} />
                  <div className={styles.allCardBody}>
                    <div className={styles.allCardTop}>
                      <span className={styles.allCardLabel} style={{ color: c }}>{label}</span>
                      <span className={styles.allCardType}>{dev.class_name}</span>
                    </div>
                    <div className={styles.allCardBottom}>
                      <span className={styles.allCardUnit}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/>
                        </svg>
                        {units}
                      </span>
                      <span className={styles.allCardPorts}>
                        {dev.port_count > 0 && <span className={styles.portPill}>{dev.port_count}p</span>}
                        {dev.console_ports?.length > 0 && <span className={styles.portPillC}>{dev.console_ports.length}c</span>}
                        {dev.sfp_ports?.length > 0 && <span className={styles.portPillS}>{dev.sfp_ports.length}s</span>}
                        {!dev.port_count && !dev.console_ports?.length && !dev.sfp_ports?.length && (
                          <span className={styles.noPorts}>-</span>
                        )}
                      </span>
                    </div>
                    {(() => {
                      const chips = cableChips(dev);
                      if (!chips.length) return null;
                      return (
                        <div className={styles.cableChipRow} onClick={(e) => e.stopPropagation()}>
                          {chips.map((ch, k) => (
                            <span key={k} className={styles.cableChip}
                              title={`${ch.count} × ${ch.connector} ${ch.color} cable${ch.count === 1 ? '' : 's'}`}>
                              <span className={styles.cableChipSwatch} style={{ background: cableColorCSS(ch.color) }} />
                              {[ch.connector, ch.color].filter(Boolean).join(' ')}
                              <b className={styles.cableChipCount}>×{ch.count}</b>
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
  );

  if (embedded) return allBody;

  return (
    <div className={styles.allPage}>
      <div className={styles.amb} />
      <header className={styles.header} style={{ position: 'sticky', top: 0 }}>
        <button className="btn btn-ghost btn-icon" onClick={onBack}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>All Components</h2>
          <span className={styles.headerMono}>{rackId ? `${rackId} · ` : ''}{visible.length} devices</span>
        </div>
        <ConfirmRackButton scanId={scanId || rackId} />
      </header>
      {allBody}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────
export default function ResultsPage({ rackId: propRackId = null, embedded: embeddedProp = false } = {}) {
  const navigate = useNavigate();
  // Back from a rack leaves the rack. There is no Home any more, so it lands
  // on Scan — the start of the next job, which is what someone who has
  // finished with this rack is about to do.
  const exitRack = () => navigate('/scan');
  // Null outside TourProvider (this page is also rendered embedded), so read
  // through optional chaining rather than destructuring.
  const tour = useTour();
  const tourActive = !!tour?.active;
  const stopTour = tour?.stopTour;
  const location = useLocation();
  const { state } = location;
  // Only a platform owner may send a free-form command to a switch — the server
  // holds everyone else to the curated checks (app.js isAllowedConsoleCommand).
  // Rendering the terminal box to a member anyway would just be a text field
  // that 403s on Enter, so it isn't rendered.
  const { user } = useAuth();
  const canRunFreeformCmd = user?.role === 'owner';
  const { rackId: paramRackId } = useParams();
  // When rendered side-by-side (a rack group), the rackId comes in as a prop
  // and there's no navigation state — the cold-link fetch path populates it.
  const urlRackId = propRackId || paramRackId;
  // The in-page tab strip (ScanTabBar) is redundant on desktop because
  // the DesktopShell sidebar already shows the same OVERVIEW / PORTS /
  // TOPOLOGY / NETWORK / SWITCHES / DRIFT links. Mobile keeps it.
  const isDesktop = useIsDesktop();
  // Two ways to land here:
  //   1. ScanPage navigated with state.result = full /api/analyze response
  //   2. RackTabs navigated to /results/<rackId> (no state) — fetch via API
  const [fetchedResult, setFetchedResult] = useState(null);
  const result = state?.result || fetchedResult;

  // Cold-link / rack-tab-switch path: when there's no state but the URL
  // carries a rackId, hit /api/scan/:rackId once to materialize the same
  // payload shape ScanPage's analyze response would provide.
  useEffect(() => {
    if (state?.result || !urlRackId) return;
    if (fetchedResult?.rackId === urlRackId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(urlRackId)}`));
        if (!r.ok) {
          // Stale rackId — server doesn't have this rack anymore (or
          // never did). Clear the sidebar's in-memory rackId, prune the
          // local history, and route the user somewhere usable.
          if (r.status === 404 && !cancelled) {
            try {
              window.dispatchEvent(new CustomEvent('rt:rack-id-changed', { detail: '' }));
              const arr = getJSON('rackTrackHistory', []);
              if (Array.isArray(arr)) {
                setJSON('rackTrackHistory', arr.filter(h => h?.scanId !== urlRackId));
              }
            } catch { /* ignore */ }
            navigate('/scan', { replace: true });
          }
          return;
        }
        const data = await r.json();
        if (!cancelled) setFetchedResult(data);
      } catch { /* leave fetchedResult null — page renders an empty state */ }
    })();
    return () => { cancelled = true; };
  }, [urlRackId, state?.result, fetchedResult?.rackId, navigate]);

  const [selectedIdx, setSelectedIdx] = useState(null);
  const [portNum,     setPortNum]     = useState('');
  // RJ45 -> 'main' | SFP -> 'sfp' (matches backend VALID_CATEGORIES + pipeline --port_category)
  const [portCategory, setPortCategory] = useState('main');
  const [phase,       setPhase]       = useState('detect');
  // Initial tab honours a URL hash fragment so the sidebar's Drift link
  // (which navigates to /results/<id>#drift) actually lands on the drift
  // view instead of the default overview tab.
  const _initialTabFromHash = (() => {
    const h = (location.hash || '').replace(/^#/, '').toLowerCase();
    return ['overview', 'topology', 'drift'].includes(h) ? h : 'overview';
  })();
  const [tab,         setTab]         = useState(_initialTabFromHash);
  // Once the user leaves the ticket-drift alert (picks another tab or dismisses
  // it), stop the drift early-return from re-hijacking every tab.
  const [driftDismissed, setDriftDismissed] = useState(false);
  // "Raise ticket" on the CMDB-drift view → POST create, show the resulting
  // ServiceNow incident number (or error) inline.
  const [raiseTicket, setRaiseTicket] = useState({ status: 'idle', number: null, error: null });
  async function raiseDriftTicket() {
    if (raiseTicket.status === 'loading' || !rackId) return;
    setRaiseTicket({ status: 'loading', number: null, error: null });
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}/create`), { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) {
        setRaiseTicket({ status: 'done', number: j.ticket?.number || j.ticket?.incident_number || ticket?.incident_number || null, error: null });
      } else {
        setRaiseTicket({ status: 'error', number: null, error: j.error || `HTTP ${r.status}` });
      }
    } catch (e) {
      setRaiseTicket({ status: 'error', number: null, error: e.message });
    }
  }
  // Track the user's in-page tab navigation so the header back arrow can
  // walk it back instead of bouncing straight to /scan. Each user-driven
  // tab change pushes the previous tab onto this stack.
  const tabHistoryRef = useRef([]);
  const handleTabChange = (newTab) => {
    // Network is the live switches, read from this phone over SNMP. It is a
    // page of its own rather than a tab of this one, because reading a switch
    // is work with its own state — credentials, a reading, where it sits in
    // the rack — not another view of the photograph.
    if (newTab === 'network' || newTab === 'report') {
      // urlRackId first: it is the id in the address bar and is set before the
      // scan result has loaded, whereas `rackId` comes out of that result.
      navigate(`/results/${encodeURIComponent(urlRackId || rackId || scanId)}/${newTab}`);
      return;
    }
    setTab(prev => {
      if (prev !== newTab) tabHistoryRef.current.push(prev);
      return newTab;
    });
    // Leaving the port-detail sub-view whenever the user picks a tab —
    // otherwise the `phase === 'port'` early return below swallows the
    // new tab's content (notably the drift tab, which would render blank).
    setPhase('detect');
  };
  // Header back button:
  //   • on the Overview tab → ALWAYS leave the rack and go to /scan
  //     (overview is the root of this rack — back means "exit the rack")
  //   • on any other tab → pop the in-page tab history if there's any,
  //     otherwise fall back to Overview.
  const handleHeaderBack = () => {
    // Four of the seven tour steps happen on this page, so leaving it means
    // abandoning the walkthrough — end it rather than leave the spotlight
    // hunting for anchors that are no longer rendered.
    if (tourActive) stopTour?.();
    if (tab === 'overview') {
      // Clear any stored tab-history since we're leaving the rack entirely.
      tabHistoryRef.current = [];
      // Go BACK through history to wherever the rack was opened from (Scan,
      // Profile, a link…), NOT a fresh push to /scan. Pushing /scan while Scan
      // itself backs with navigate(-1) is what made Scan⇆Results ping-pong:
      // each "back" landed on the other page instead of climbing out. Falls
      // back to /scan only on a cold start with no history behind it.
      exitRack();
      return;
    }
    if (tabHistoryRef.current.length > 0) {
      const prev = tabHistoryRef.current.pop();
      setTab(prev);
      setPhase('detect');
      return;
    }
    setTab('overview');
    setPhase('detect');
  };
  // React to subsequent hash changes too — e.g. user clicks Drift in the
  // sidebar while already on the rack page, no remount happens.
  useEffect(() => {
    const h = (location.hash || '').replace(/^#/, '').toLowerCase();
    // An empty / unknown hash means the plain rack root → the Overview tab.
    // Without this fallback, navigating Drift (#drift) → Overview (no hash)
    // left `tab` stuck on 'drift' because empty wasn't a recognised value.
    const next = ['overview', 'topology', 'drift'].includes(h)
      ? h : 'overview';
    setTab(curr => {
      if (curr !== next) tabHistoryRef.current.push(curr);
      return next;
    });
    // Drop back to the detect phase whenever the tab changes via the URL.
    // Otherwise an earlier `phase === 'port'` early-return path would keep
    // showing the port-detail view and swallow the tab content.
    setPhase('detect');
  }, [location.hash]);
  const [resultImg,   setResultImg]   = useState(null);
  const [portInfo,    setPortInfo]    = useState(null);
  const [zoom,        setZoom]        = useState(1);
  const [offset,      setOffset]      = useState({ x: 0, y: 0 });
  const [imgNat,      setImgNat]      = useState(null);
  // Focus mode: when true, the hero image zooms into the selected device's
  // bounding box and hides all other overlays. Toggled by tapping the
  // selected (red-bordered) device on the rack; exited by the back button.
  const [focusMode,   setFocusMode]   = useState(false);
  // Drag origin lives in a ref, not state. It used to be state, and
  // handlePointerMove set BOTH it and the offset on every pointermove — two
  // re-renders of this 4,900-line component per move event, 60-120 times a
  // second. That is what made the screen freeze while panning on Android.
  const dragRef = useRef(null);
  const panRafRef = useRef(0);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [nextPort,  setNextPort]  = useState('');
  const [rackImg,   setRackImg]   = useState(null);
  const [portView,  setPortView]  = useState('rack'); // 'rack' → 'device' → 'zoom' → 'rack'
  const [feedbackStatus, setFeedbackStatus] = useState('idle'); // 'idle' | 'wrong-port' | 'wrong-color' | 'submitting' | 'submitted' | 'hidden'
  const [actualPortInput, setActualPortInput] = useState('');
  const [actualCableColor, setActualCableColor] = useState('');
  const [feedbackError, setFeedbackError] = useState(null);
  // Cable-only feedback (separate Yes/No block below the port one)
  const [cableFbStatus, setCableFbStatus] = useState('idle'); // 'idle' | 'wrong' | 'submitting' | 'submitted' | 'hidden'
  // Port-TYPE correction (RJ45/SFP/USB/…) — tags the physical port type,
  // feeding the active-learning memory + retraining dataset.
  const [portTypeStatus, setPortTypeStatus] = useState('idle'); // 'idle' | 'picking' | 'submitting' | 'submitted' | 'error'
  const [cableFbColor, setCableFbColor] = useState('');
  const [cableFbError, setCableFbError] = useState(null);
  // Device-classification feedback (separate flow)
  const [deviceFbStatus, setDeviceFbStatus] = useState('idle'); // 'idle' | 'wrong-pending' | 'submitting' | 'submitted' | 'hidden'
  const [actualDeviceClass, setActualDeviceClass] = useState('');
  const [deviceFbError, setDeviceFbError] = useState(null);
  // Port-count feedback (main ports detected per device — separate flow)
  const [portCountFbStatus, setPortCountFbStatus] = useState('idle');
  const [actualPortCount, setActualPortCount] = useState('');
  const [portCountFbError, setPortCountFbError] = useState(null);
  // Items the user has already given feedback on THIS session, so the standard
  // feedback prompts don't re-ask. Keyed per (device, port, kind); reset per scan.
  const [answeredKeys, setAnsweredKeys] = useState(() => new Set());
  const markAnswered = (key) => setAnsweredKeys(s => { const n = new Set(s); n.add(key); return n; });
  // Developer diagnostics (timings + confidences)
  const [portTimings, setPortTimings] = useState(null);
  const [devOpen, setDevOpen] = useState(() => {
    try { return getItem('rt_devOpen') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { setItem('rt_devOpen', devOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [devOpen]);
  const [reportOpen, setReportOpen] = useState(false);
  // When true, the in-app report iframe loads with the #download hash, which
  // makes the report auto-trigger window.print() (Save-as-PDF) INSIDE the
  // WebView. (The reason given here used to be ngrok's browser-warning
  // interstitial; the backend is on the Hostinger VPS now, so that no longer
  // applies — keeping it in-WebView is simply the shorter path for a preview.)
  const [reportDownload, setReportDownload] = useState(false);
  // The report <iframe src> can't send an Authorization header, which is why
  // /api/scan/:rackId/report used to be public — and therefore served any
  // tenant's rack to anyone with an id. It now needs a short-lived token scoped
  // to this one rack, fetched (authenticated) whenever the modal opens.
  const [reportToken, setReportToken] = useState(null);
  const [reportTokenErr, setReportTokenErr] = useState(null);
  const [sessionPorts, setSessionPorts] = useState([]); // [{deviceIdx, port, deviceLabel, deviceClass, status}]
  // The device picker's own open state. It is a listbox we draw, not a native
  // <select>, so the open/closed state is ours to hold — see the note where it
  // is rendered.
  const [deviceListOpen, setDeviceListOpen] = useState(false);
  // Which of the two things the person chose to do with this rack. Until they
  // choose, the page is the photograph and the choice — nothing else.
  const [portMode, setPortMode] = useState(false);
  const [shareStatus, setShareStatus] = useState('idle'); // 'idle' | 'sending' | 'sent' | 'error'
  const [shareMsg, setShareMsg] = useState(null);
  const [shareChannel, setShareChannel] = useState(null); // 'slack' | 'teams' | 'outlook'
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  // Recipient prompt — channel is the active dialog (null = closed). Email +
  // optional note (Outlook subject / Teams + Slack message) are filled by the user.
  const [shareDialogChannel, setShareDialogChannel] = useState(null);
  const [shareEmailInput, setShareEmailInput] = useState('');
  const [shareNoteInput, setShareNoteInput]   = useState('');
  const [shareEmailErr, setShareEmailErr]     = useState(null);
  // Switch SSH / LLDP neighbor lookup — credentials held in memory only.
  // Host defaults to the in-office switch so the LLDP pre-fetch can fire
  // automatically as soon as a port is picked. Username/password still come
  // from the encrypted server-side store or the creds modal.
  // Host starts from the per-deployment default rather than a baked-in office
  // address — on a deployment with no route to that LAN the old literal
  // pre-filled a switch that could not be there. Unset → empty, and the
  // /api/switch/default-host lookup or the user fills it in.
  const [switchCreds, setSwitchCreds] = useState({
    host: import.meta.env.VITE_FALLBACK_SWITCH_HOST || '',
    username: '', password: '', vendor: 'tplink', enablePassword: '',
  });
  // Track which port the in-flight LLDP call belongs to, so a rapid port
  // switch doesn't overwrite the current result with a stale one.
  const neighborPortRef = useRef(null);
  const [credsOpen, setCredsOpen] = useState(false);
  const [neighborStatus, setNeighborStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'empty' | 'error'
  const [neighbor, setNeighbor] = useState(null);
  const [neighborMethod, setNeighborMethod] = useState(null); // 'lldp' | 'cdp' | 'mac_arp' | 'mac_only' | 'none'
  const [neighborChain, setNeighborChain] = useState(null);
  const [neighborErr, setNeighborErr] = useState(null);
  const [neighborDetailsOpen, setNeighborDetailsOpen] = useState(false);
  // Console sheet state
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState([]);
  const [consoleStatus, setConsoleStatus] = useState('idle'); // 'idle' | 'running-auto' | 'running-manual' | 'ready' | 'error'
  const [consolePlan, setConsolePlan] = useState([]);            // planned commands emitted by the server at stream start
  const [runningIdx, setRunningIdx] = useState(-1);              // index of command currently executing
  const [manualCmd, setManualCmd] = useState('');
  // Detailed per-port console report (shown when the user presses "Done")
  const [portReportOpen, setPortReportOpen] = useState(false);
  const [portReport, setPortReport] = useState(null);
  // Switch Info modal — live SSH snapshot, independent of CMDB/Netdisco.
  const [switchInfoOpen, setSwitchInfoOpen] = useState(false);
  const [switchInfoStatus, setSwitchInfoStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [switchInfoData, setSwitchInfoData] = useState(null);
  const [switchInfoRaw, setSwitchInfoRaw] = useState('');
  const [switchInfoError, setSwitchInfoError] = useState(null);
  // Specifications + firmware-update lookups — fired after we have a model
  // from SSH. Independent of the SSH call so a slow vendor scrape doesn't
  // hold back the basic info section.
  const [switchSpecs, setSwitchSpecs] = useState(null);
  const [switchSpecsStatus, setSwitchSpecsStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'skipped'
  const [switchSpecsError, setSwitchSpecsError] = useState(null);
  const [switchFirmware, setSwitchFirmware] = useState(null);
  const [switchFirmwareStatus, setSwitchFirmwareStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'skipped'
  const [switchFirmwareError, setSwitchFirmwareError] = useState(null);
  const consoleTermRef = useRef(null);
  // Auto-scroll the console terminal to the bottom as entries stream in so
  // the user always sees the latest command / output, not the first one.
  useEffect(() => {
    const el = consoleTermRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [consoleEntries.length, runningIdx, consolePlan.length]);
  // After which action: the console was invoked with creds already — otherwise we prompt.
  const [pendingConsoleOpen, setPendingConsoleOpen] = useState(false);
  // How long the auto-run took to complete (ms). Set when the stream ends.
  const [consoleRunMs, setConsoleRunMs] = useState(null);
  const consoleRunStartRef = useRef(null);
  // Track whether an auto-run is currently in flight so we don't fire two
  // concurrent SSH sessions if creds get re-submitted or the console is
  // opened mid-run.
  const autoRunInFlightRef = useRef(false);
  // ── Intent dropdown state ──
  // List of {id, label, cmd} fetched from the server based on switch vendor.
  const [consoleIntents, setConsoleIntents] = useState([]);
  const [selectedIntentId, setSelectedIntentId] = useState('');
  // ── Switch credentials status (per vendor, booleans only) ──
  // True when the encrypted env store already has user/pass for this vendor —
  // lets the page send requests with just `host` and have the server fill
  // username/password from the encrypted store on its side.
  const [credsStatus, setCredsStatus] = useState({ has_username: false, has_password: false, has_enable: false });
  useEffect(() => {
    const vendor = switchCreds.vendor || 'tplink';
    let cancelled = false;
    authFetch(apiUrl(`/api/switch/creds-status?vendor=${encodeURIComponent(vendor)}`))
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!cancelled) setCredsStatus(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [switchCreds.vendor]);

  // Fetch the intent dropdown for the current vendor whenever the console
  // sheet is opened. Cheap GET, no SSH, no automation.
  useEffect(() => {
    if (!consoleOpen) return;
    const vendor = switchCreds.vendor || 'tplink';
    let cancelled = false;
    let attempt = 0;
    const tryFetch = () => {
      authFetch(apiUrl(`/api/switch/console/intents?vendor=${encodeURIComponent(vendor)}`))
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(data => {
          if (cancelled) return;
          setConsoleIntents(data.intents || []);
        })
        .catch((err) => {
          if (cancelled) return;
          attempt += 1;
          // One quick retry — covers transient WebView/network hiccups.
          if (attempt < 2) {
            setTimeout(tryFetch, 600);
          } else {
            console.warn('[console] intent fetch failed:', err?.message || err);
            setConsoleIntents([]);
          }
        });
    };
    tryFetch();
    return () => { cancelled = true; };
  }, [consoleOpen, switchCreds.vendor]);

  const { scanId, rackId, cached, devices: initialDevices = [], units_detected = [], originalExt, originalImageUrl, qualityWarning, qualityWarningMsg, timings: analysisTimings } = result || {};
  const [fetchedOcrLabels, setFetchedOcrLabels] = useState(null);
  const ocrLabels = fetchedOcrLabels;
  const [warningDismissed, setWarningDismissed] = useState(false);

  // ── Ticket-mode bootstrapping ──
  // When ScanPage routed us here with a ticket-driven bundled payload, skip
  // the device picker entirely and jump straight into the port view.
  const ticketMode = !!state?.ticketMode;
  const ticket = state?.ticket || null;
  const lldp = result?.lldp || null;
  const ticketResolved = result?.resolved || null;

  // ── Live port monitoring (ticket mode only) ──
  // Polls /api/switch/port-status every 5s while we're in the port view of a
  // ticket. Surfaces a "cable attached — problem solved" banner as soon as
  // the port transitions from "no activity" (no neighbor, no MACs) to active.
  const [liveSnapshot, setLiveSnapshot] = useState(null);
  const [liveLastAt,   setLiveLastAt]   = useState(null);
  const [liveResolvedAt, setLiveResolvedAt] = useState(null); // set when we detect transition to active
  const liveInFlightRef = useRef(false);
  const livePrevActiveRef = useRef(null); // null = no reading yet
  const LIVE_POLL_MS = 5000;
  const [ticketReportOpen, setTicketReportOpen] = useState(false);
  // Agent Analysis panel (zero-LLM extraction + reasoning + work-note preview
  // from the backend's /api/analyze-for-ticket call). Collapsed by default.
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [agentNoteCopied, setAgentNoteCopied] = useState(false);
  const [agentPosting, setAgentPosting] = useState(false);
  const [agentPostResult, setAgentPostResult] = useState(null); // { status, message }
  const agent = result?.agent || null;

  // Posts the agent's work-note text to the ServiceNow incident via the
  // server's /api/incidents/:inc/post-work-note route. Honors agent.py's
  // guards (confidence floor, no-change hash, 24h rate-limit). When the
  // user clicks Post again on the same analysis it should report
  // 'skipped_no_change' instead of double-posting.
  const postWorkNoteToSn = async ({ force = false } = {}) => {
    if (!ticket?.incident_number || agentPosting) return;
    setAgentPosting(true);
    setAgentPostResult(null);
    try {
      const r = await authFetch(
        apiUrl(`/api/incidents/${encodeURIComponent(ticket.incident_number)}/post-work-note`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAgentPostResult({ status: 'error', message: data.error || `HTTP ${r.status}` });
      } else {
        setAgentPostResult({ status: data.status || 'unknown', message: data.status });
      }
    } catch (err) {
      setAgentPostResult({ status: 'error', message: err.message });
    } finally {
      setAgentPosting(false);
    }
  };
  useEffect(() => {
    if (!ticketMode || !result) return;
    // Drift case: a dedicated early-return render handles it; just don't
    // switch to the port phase (there's no port to pinpoint).
    if (result.driftDetected) return;
    if (!ticketResolved) return;
    setSelectedIdx(ticketResolved.device_index);
    setPortNum(String(ticketResolved.port));
    if (result.resultImageUrl) setResultImg(apiUrl(result.resultImageUrl));
    if (result.rackImageUrl)   setRackImg(apiUrl(result.rackImageUrl));
    if (result.portInfo)       setPortInfo(result.portInfo);
    // Don't pre-populate neighbor state here — the native LLDP panel
    // auto-fires against the configured switch host (which is the reachable
    // real switch) and shows live data. Our server-side LLDP against CMDB's
    // mgmt_ip is best-effort and may fail for demo IPs.
    setPhase('port');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live polling loop: in ticket-mode port phase, hit /api/switch/port-status
  // every LIVE_POLL_MS. Uses the configured switchCreds.host (which is the
  // real reachable switch). The interface name must match the vendor dialect
  // (TP-Link expects "1/0/15", Cisco IOS expects "Gi1/0/15") — derive from
  // the ticket's raw port number using VENDOR_IFACE.
  useEffect(() => {
    if (!ticketMode || phase !== 'port') return;
    const host = switchCreds.host || ticket?.cmdb?.mgmt_ip;
    const vendor = switchCreds.vendor || 'tplink';
    const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
    const portNumber = ticket?.target?.port;
    if (!host || portNumber == null) return;
    const iface = ifaceFn(portNumber);

    let cancelled = false;
    const ac = new AbortController();

    const tick = async () => {
      if (cancelled || liveInFlightRef.current) return;
      liveInFlightRef.current = true;
      try {
        const res = await authFetch(apiUrl('/api/switch/port-status'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            host,
            interface: iface,
            vendor,
            username: switchCreds.username || undefined,
            password: switchCreds.password || undefined,
            enablePassword: switchCreds.enablePassword || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled || !data) return;
        setLiveSnapshot(data);
        setLiveLastAt(Date.now());
        const nowActive = !!data.link_active;
        const prev = livePrevActiveRef.current;
        // Transition detection: prev was observed inactive → now active → resolved.
        if (prev === false && nowActive && !liveResolvedAt) {
          setLiveResolvedAt(Date.now());
        }
        if (data.ok) livePrevActiveRef.current = nowActive;
      } catch { /* swallow transient network errors; next tick tries again */ }
      finally { liveInFlightRef.current = false; }
    };

    tick(); // fire immediately, then interval
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { cancelled = true; ac.abort(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketMode, phase, ticket?.incident_number, switchCreds.host, switchCreds.vendor]);

  // Auto-fire the native LLDP panel (the "LINKED ENDPOINT" card) in ticket
  // mode so the user doesn't have to press "Find end device". The normal
  // code paths that call findNeighbor after port-select don't run in
  // ticket-mode because we jump straight into phase='port'.
  useEffect(() => {
    if (!ticketMode || phase !== 'port') return;
    if (neighborStatus !== 'idle') return;
    const p = ticket?.target?.port;
    if (!p) return;
    findNeighbor(null, { port: p, silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketMode, phase, ticket?.target?.port, switchCreds.host, switchCreds.vendor, credsStatus.has_username, credsStatus.has_password]);
  // Mutable copy of devices so feedback-triggered re-labels (port count) can
  // patch a single entry without round-tripping the whole result. Reset only
  // when the scan itself changes — not on every render (result destructures
  // create a new array reference each pass).
  const [devices, setDevices] = useState(initialDevices);
  useEffect(() => { setDevices(initialDevices); }, [scanId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh from the server on mount: navigation state can be stale (e.g. when
  // the page is reached via History/Profile, which serve cached fullResult
  // from localStorage, or after a backend re-detection updated device_unit_map.json).
  // We fetch /api/scan/:rackId and overwrite the devices array so port counts
  // and per-port detection reflect what's actually on disk right now.
  useEffect(() => {
    if (!scanId) return;
    let cancelled = false;
    let tries = 0;
    const MAX_TRIES = 7;          // ~30s of polling, then give up
    // Cable enrichment runs in the background after analyze; poll a few times
    // so the per-port cable chips appear once it finishes, then stop.
    const hasCable = (devs) => Array.isArray(devs) && devs.some(d =>
      [d?.ports, d?.sfp_ports, d?.other_ports].some(l =>
        Array.isArray(l) && l.some(p => p?.status === 'connected' && (p.cable_connector || p.cable_color))));
    let timer = null;
    const poll = async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${scanId}`));
        if (r.ok) {
          const fresh = await r.json();
          if (cancelled) return;
          if (Array.isArray(fresh.devices)) {
            setDevices(fresh.devices);
            if (hasCable(fresh.devices)) return;    // enriched — stop polling
          }
        }
      } catch { /* network blip — keep what we have */ }
      if (!cancelled && ++tries < MAX_TRIES) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [scanId]);

  // Always fetch /api/ocr/labels/:rackId on mount so refresh, deep-link, and
  // navigation-from-history routes pick up the latest OCR-derived names and
  // reclassifications.
  useEffect(() => {
    if (!scanId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/ocr/labels/${encodeURIComponent(scanId)}`));
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const hasLabels = Array.isArray(data?.deviceLabels) && data.deviceLabels.some(d => d.label);
        const hasReclass = Array.isArray(data?.reclassifications) && data.reclassifications.length > 0;
        if (hasLabels || data?.pattern || hasReclass) setFetchedOcrLabels(data);
      } catch { /* ignore — fall back to synthesized names */ }
    })();
    return () => { cancelled = true; };
  }, [scanId]);

  const fmtMs = (ms) => {
    if (ms == null || isNaN(ms)) return '-';
    return `${(ms / 1000).toFixed(2)} s`;
  };
  const fmtPct = (v) => {
    if (v == null || isNaN(v)) return '-';
    return `${Math.round(Number(v) * 100)}%`;
  };
  // Overview hero: ALWAYS the clean raw photo. The SVG overlay below draws the
  // device boxes and labels on top, and highlights the selected one.
  //
  // Selecting a device used to swap this to result.overlayImageUrl —
  // 7_rack_all_ports.png — described in the old comment here as showing "the
  // selected device's ports". It does not: runner.py builds that image by
  // looping over EVERY port-bearing device in the rack and baking in all of
  // their port boxes. So picking one device lit up the ports on all of them,
  // which is what testers reported. There is no pipeline render for "full rack,
  // just this device's ports", and the canonical scan_result.json carries port
  // COUNTS rather than boxes, so the client can't draw them itself on a
  // reopened scan either.
  //
  // It doesn't need to. The per-device view already exists below: the port
  // result panel's 'device' mode shows 5_selected_device_with_port.png — that
  // device's ports with the chosen one highlighted — and its 'rack' mode shows
  // the selected port on the full rack. Those are separate elements from this
  // hero, so leaving the hero clean loses nothing.
  //
  // The old fallback chain was also unsound: with overlayImageUrl absent it
  // dropped to resultImg, a DEVICE CROP, while the SVG overlay above it keeps
  // drawing in full-image coordinates — a crop under a full-rack overlay.
  // Prefer the path the server resolved from the file that actually exists.
  // Guessing it here as `original_image.${originalExt || 'png'}` meant any
  // payload that arrived without an extension asked for a .png the camera
  // never produced — an iPhone sends JPEG or HEIC — and the rack photo came up
  // as a broken image while the rest of the result rendered fine. The guess is
  // kept only as a fallback for a server that predates originalImageUrl.
  const originalPath = originalImageUrl
    || `/outputs/${scanId}/original_image.${originalExt || 'jpg'}`;
  const originalSrc = apiUrl(originalPath);
  // Keep the server-relative path alongside the resolved URL: AssetImg needs the
  // path so it can rebuild the URL with a fresh capability token when the old
  // one has expired, rather than retrying the same dead query string.
  const heroImgPath = originalPath;
  const heroImgSrc = originalSrc;

  // Apply brand-token reclassifications from the OCR labels endpoint, so a
  // Planar AV controller YOLO labelled as UPS gets bumped to "Controller" for
  // both naming and rendering. Synthesizing labels reads class_name, so the
  // override must precede buildDeviceLabels.
  const effectiveDevices = useMemo(() => {
    const reclass = ocrLabels?.reclassifications;
    if (!Array.isArray(reclass) || reclass.length === 0) return devices;
    const byIdx = new Map(reclass.map(r => [r.device_index, r]));
    return devices.map((dev, idx) => {
      const r = byIdx.get(idx);
      if (!r || !r.class_name || r.class_name === dev?.class_name) return dev;
      return { ...dev, class_name: r.class_name, _reclassifiedFrom: dev.class_name, _reclassifiedBrand: r.brand };
    });
  }, [devices, ocrLabels]);

  const labels = useMemo(() => {
    const pattern = ocrLabels?.pattern || null;
    const generated = buildDeviceLabels(effectiveDevices, units_detected, pattern);

    // If we have OCR labels, use them preferentially, falling back to the
    // pattern-derived synthetic names from buildDeviceLabels.
    if (ocrLabels && Array.isArray(ocrLabels.deviceLabels)) {
      return effectiveDevices.map((_, idx) => {
        const ocr = ocrLabels.deviceLabels.find(d => d.device_index === idx);
        const synthetic = generated[idx] || `Device ${idx}`;
        if (ocr?.label && (ocr.conf || 0) >= 0.4) return ocr.label;
        return synthetic;
      });
    }

    return generated;
  }, [effectiveDevices, units_detected, ocrLabels]);

  const clampZoom = (value) => Math.min(2.5, Math.max(0.8, value));
  const zoomIn = () => setZoom((prev) => clampZoom(prev + 0.15));
  const zoomOut = () => setZoom((prev) => {
    const next = clampZoom(prev - 0.15);
    // Re-centre as we shrink: an offset that was legal at 2.5x parks the image
    // off-screen at 1x, so zooming out could "lose" the picture entirely.
    if (next <= 1) setOffset({ x: 0, y: 0 });
    return next;
  });
  const resetZoom = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const handleWheel = (event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.15 : -0.15;
    setZoom((prev) => clampZoom(prev + delta));
  };
  // Keep the image on screen. The offset was unbounded, so a determined drag
  // translated the picture entirely out of view — which is exactly the
  // "image disappears" testers reported. Allow panning only as far as the
  // parts of the scaled image that are actually off-screen.
  const clampOffset = (next, z, el) => {
    const box = el?.getBoundingClientRect?.();
    const w = box?.width || 320;
    const h = box?.height || 320;
    const maxX = Math.max(0, (w * z - w) / 2);
    const maxY = Math.max(0, (h * z - h) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  };

  const releaseCapture = (event) => {
    // Throws NotFoundError if the pointer was already released — e.g. the
    // browser fired pointercancel first. An uncaught throw here left the drag
    // permanently engaged.
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    // Only engage pan when zoomed in — otherwise capturing the pointer would
    // swallow taps meant for the device rectangles on the hero overlay.
    if (zoom <= 1) return;
    dragRef.current = { x: event.clientX, y: event.clientY };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
  };
  const handlePointerMove = (event) => {
    const start = dragRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    dragRef.current = { x: event.clientX, y: event.clientY };
    // Coalesce to one state update per animation frame. Pointer events arrive
    // far faster than React can usefully re-render a page this size.
    if (panRafRef.current) return;
    const el = event.currentTarget;
    panRafRef.current = requestAnimationFrame(() => {
      panRafRef.current = 0;
      setOffset((prev) => clampOffset({ x: prev.x + dx, y: prev.y + dy }, zoom, el));
    });
  };
  const handlePointerUp = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (panRafRef.current) { cancelAnimationFrame(panRafRef.current); panRafRef.current = 0; }
    releaseCapture(event);
  };
  const handlePointerCancel = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (panRafRef.current) { cancelAnimationFrame(panRafRef.current); panRafRef.current = 0; }
    releaseCapture(event);
  };
  const handlePointerLeave = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (panRafRef.current) { cancelAnimationFrame(panRafRef.current); panRafRef.current = 0; }
  };
  // Cursor is derived from zoom alone now. Tying it to the drag ref would not
  // re-render anyway (that is the point of the ref), and a cursor that lags a
  // frame behind is not worth a render per pointermove.
  const cursorStyle = zoom > 1 ? 'grab' : 'zoom-in';
  // The translate is applied in screen space (after scale), so it must match the
  // drag 1:1 — NOT divided by zoom. Dividing made panning sluggish at high zoom,
  // so a tall rack couldn't be dragged far enough to reveal its top devices.
  const imageTransform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;

  useEffect(() => {
    if (!result) return;
    // Tell the desktop sidebar which rack we're on. Pure in-memory
    // event — no sessionStorage / localStorage. The sidebar's RACK
    // section only appears after this fires (i.e. after a real upload
    // completes in this view session). A browser refresh clears it,
    // so a stale rack from a previous visit doesn't linger in the nav.
    try {
      const id = result.scanId || urlRackId || '';
      window.dispatchEvent(new CustomEvent('rt:rack-id-changed', { detail: id }));
    } catch { /* ignore */ }

    // History holds a SUMMARY per scan, never the whole payload. It used to
    // store `fullResult` — every detected device with its box and confidence —
    // twelve times over, which reliably outgrew the ~5 MB origin quota. The
    // write then threw inside this effect and, with no boundary above it, took
    // the whole app down on the Results page: on success, right after a scan
    // the user had waited through, and stickily, because the oversized history
    // was already committed and every later visit re-threw. Opening a scan from
    // History now rehydrates from /api/scan/:id via the cold-fetch effect above.
    const existing = getJSON('rackTrackHistory', []);
    const history  = Array.isArray(existing) ? existing : [];
    if (!history.some(h => h.scanId === result.scanId)) {
      history.unshift({
        scanId: result.scanId, timestamp: result.timestamp, severity: 'info',
        incidentLabel: labels[0] || 'Rack scan',
        componentLabel: `${devices.length} devices`,
        scanSummary: `${formatUnitsRange(units_detected) || `${units_detected.length} units`} scanned`,
        imageUrl: result.imageUrl,
      });
      setJSON('rackTrackHistory', history.slice(0, 12));
    }
  }, [result]);

  // ── Drift tab short-circuit ──────────────────────────────────────
  // Drift uses /api/ports/* (live SSH polling) and is independent of
  // the rack scan result. Render it directly BEFORE any other early
  // return so it works even if the rack hasn't loaded, the page is in
  // 'port' phase, or any other state would otherwise block the main
  // render. This is the cleanest path to a guaranteed-visible drift
  // view from the sidebar link.
  // ── Selection-driven effects — MUST stay above the early `return` below
  //    so they run unconditionally on every render (Rules of Hooks). They
  //    compute the selected device inline from effectiveDevices (defined
  //    above) rather than the `selectedDevice` const declared after the gate.
  // Pick the port category to land on when the selected device changes.
  //
  // This only used to act when the CURRENT category had zero ports on the new
  // device, which made the category sticky in a way that misreads as a broken
  // port lookup. Select an all-fibre firewall (0 RJ45, 18 SFP) and it correctly
  // moved to SFP; select an ordinary 24-port switch next and, because that
  // switch also has 2 SFP cages, the count wasn't zero so it STAYED on SFP.
  // You were then on the SFP tab of an RJ45 switch: "2" found SFP port 2 rather
  // than RJ45 port 2, and "24" was rejected with "This device has 2 ports".
  //
  // RJ45 is what people mean by "port" on a switch or patch panel, so prefer it
  // whenever the device has any, and only fall back to another category for
  // devices that genuinely have no RJ45.
  useEffect(() => {
    const dev = selectedIdx ? effectiveDevices[selectedIdx - 1] : null;
    if (!dev) return;
    const preferred = portCatCount(dev, 'main') > 0
      ? 'main'
      : (PORT_CATEGORIES.find(c => portCatCount(dev, c.k) > 0)?.k || null);
    if (preferred && preferred !== portCategory) setPortCategory(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  useEffect(() => {
    const dev = selectedIdx ? effectiveDevices[selectedIdx - 1] : null;
    if (!dev) setFocusMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  // Reset the device-type + port-count confirmation cards whenever the selected
  // device changes, so every device runs the same sequence (confirm type →
  // confirm ports). Without this the statuses carried over from the previously
  // selected device, so the "Detected N RJ45 ports" card inconsistently showed
  // or stayed hidden depending on what you'd confirmed on the last device.
  useEffect(() => {
    setDeviceFbStatus('idle');
    setActualDeviceClass('');
    setDeviceFbError(null);
    setPortCountFbStatus('idle');
    setActualPortCount('');
    setPortCountFbError(null);
     
  }, [selectedIdx]);

  // NOTE: the previous version of this file early-returned here when
  // tab === 'drift', but that violated the Rules of Hooks — there are
  // useEffect/useMemo hooks defined further down, and skipping them
  // produced "Rendered fewer hooks than expected". Drift now renders
  // through the normal layout below (which already has the header and
  // ScanTabBar), and the `!result` gate just below has been relaxed so
  // drift can show even on cold-link `/results/<rackId>#drift` URLs
  // where the rack payload is still being fetched.

  if (!result && tab !== 'drift') {
    // Deep-linked /results/:rackId — fetch in flight. Show a benign
    // loading state instead of the cold "No scan result" panel.
    if (urlRackId) {
      return (
        <div className={`page page-full ${styles.results}`} data-tab="loading"
             style={{ minHeight: '70vh', padding: '60px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div style={{
            width: 48, height: 48,
            border: '4px solid rgba(0,0,0,0.18)',
            borderTopColor: '#000000',
            borderRadius: '50%',
            animation: 'spin 0.9s linear infinite',
          }} />
          <p style={{
            fontSize: '1.05rem',
            fontWeight: 700,
            color: 'var(--t1, #1c1c1c)',
            margin: 0,
          }}>
            Loading rack <span style={{ fontFamily: 'ui-monospace, monospace', color: '#000000' }}>{urlRackId}</span>
          </p>
          <p style={{ fontSize: '.84rem', color: 'var(--t2, #474747)', margin: 0 }}>
            Fetching analysis from the server…
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }
    return (
      <div className={`page page-full ${styles.results}`} data-tab="loading"
           style={{ minHeight: '70vh', padding: '60px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--t1, #1c1c1c)', margin: 0 }}>
          No scan result available
        </p>
        <p style={{ fontSize: '.84rem', color: 'var(--t2, #474747)', margin: 0, maxWidth: 420, textAlign: 'center' }}>
          Start a new scan to identify devices, ports, and cables on a rack.
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/scan')}>Start a Scan</button>
      </div>
    );
  }

  // phase='all' is now handled by the 'all' tab — no early return needed

  const selectedDevice = selectedIdx ? effectiveDevices[selectedIdx - 1] : null;
  const selectedLabel  = selectedIdx ? labels[selectedIdx - 1]  : null;
  const selColor       = selectedDevice ? getColor(selectedDevice.class_name) : DEFAULT_COLOR;
  const cableInfo      = parseCableType(portInfo?.cable_type);

  // Which port categories this device actually has (so an all-SFP firewall
  // offers SFP/Console, not just RJ45), and the max port # for the currently
  // selected category — used for both validation and the input's max.
  const availablePortCats = selectedDevice
    ? PORT_CATEGORIES.filter(c => portCatCount(selectedDevice, c.k) > 0)
    : [];
  const portCatsToShow = availablePortCats.length ? availablePortCats : [PORT_CATEGORIES[0]];
  const selPortMax = portCatCount(selectedDevice, portCategory);

  // Upper bound for the port-number inputs: the selected category's detected
  // count, or the device's total port_count as a fallback. 0 = unknown.
  const portMaxLimit = selPortMax > 0
    ? selPortMax
    : (selectedDevice?.port_count > 0 ? selectedDevice.port_count : 0);
  // Keep typed port numbers well-formed: whole digits only (no ".", "e", signs,
  // or leading zeros), capped at 4 digits so nothing absurd reaches the API.
  //
  // This deliberately does NOT clamp to portMaxLimit any more. It used to
  // silently rewrite an over-range number down to the max — type 48 on a device
  // we believe has 24 ports and the box became 24, so the user was shown port
  // 24 having asked for 48, with nothing on screen saying so. That is the
  // "gave me a different port than I entered" report, and it was worst exactly
  // where portMaxLimit itself was wrong. Over-range numbers now survive to
  // findPort/findAnotherPort, which reject them with the real range in the
  // message instead of quietly answering a question nobody asked.
  const sanitizePortInput = (val) => (
    String(val).replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 4)
  );

  // Focus-mode transform: scale up so the selected device's bbox fills
  // most of the viewport, and use transform-origin at the box center
  // (expressed as a % of image dimensions) so the math is independent of
  // the wrapper's actual on-screen size.
  const focusFx = (() => {
    if (!focusMode || !selectedDevice?.box || !imgNat) return null;
    const [bx1, by1, bx2, by2] = selectedDevice.box;
    const bw = Math.max(1, bx2 - bx1);
    const bh = Math.max(1, by2 - by1);
    const cxPct = ((bx1 + bx2) / 2 / imgNat.w) * 100;
    const cyPct = ((by1 + by2) / 2 / imgNat.h) * 100;
    // Fit-to-box, leaving ~15% padding so the device doesn't kiss the edge.
    const scale = Math.min(imgNat.w / bw, imgNat.h / bh) * 0.85;
    return {
      transform: `scale(${scale})`,
      transformOrigin: `${cxPct}% ${cyPct}%`,
      transition: 'transform 0.45s cubic-bezier(0.34, 1.2, 0.64, 1), transform-origin 0.45s ease',
    };
  })();

  const findPort = async (forcedPort) => {
    const portArg = forcedPort != null ? String(forcedPort) : portNum;
    if (!selectedDevice || !portArg) return;
    // Whole numbers only (reject "1.23" → the value must equal its integer
    // parse) and within the device's port count.
    const p = parseInt(portArg, 10);
    if (isNaN(p) || p < 1 || String(p) !== String(portArg).trim()) {
      setError('Enter a valid whole port number');
      return;
    }
    if (portMaxLimit > 0 && p > portMaxLimit) {
      setError(`This device has ${portMaxLimit} ports - enter a number between 1 and ${portMaxLimit}.`);
      return;
    }
    // Port count unknown → we have no upper bound, so we cannot honestly locate
    // a port. Don't silently accept any number (that's how "port 34" on a
    // 24-port switch got through). Ask for the real count first.
    if (portMaxLimit === 0) {
      setError("We couldn't read how many ports this device has. Set the port count below, then pick a port.");
      return;
    }
    if (forcedPort != null) setPortNum(String(forcedPort));
    setLoading(true); setError(null);
    try {
      const res  = await authFetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: selectedIdx, port: p, port_category: portCategory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setResultImg(bustUrl(apiUrl(data.resultImageUrl)));
      setRackImg(data.rackImageUrl ? bustUrl(apiUrl(data.rackImageUrl)) : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      resetFeedback();
      setNeighborStatus('idle');
      setNeighbor(null);
      setNeighborErr(null);
      setConsoleEntries([]);
      setConsoleStatus('idle');
      setManualCmd('');
      setSessionPorts(prev => {
        const next = prev.filter(sp => !(sp.deviceIdx === selectedIdx && sp.port === p));
        next.push({
          deviceIdx: selectedIdx,
          port: p,
          deviceLabel: labels[selectedIdx - 1] || `Device ${selectedIdx}`,
          deviceClass: selectedDevice?.class_name || '',
          status: data.portInfo?.status || null,
          portCategory,
        });
        return next;
      });
      setPhase('port');
      // Pre-fetch the LLDP neighbour in the background so end-device info
      // is ready by the time the user looks for it — silent on missing creds.
      findNeighbor(null, { port: p, silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const portLabel = selectedLabel && portNum
    ? buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum)
    : null;

  // step state: 0=idle, 1=device selected, 2=port filled

  // ── Port result ──────────────────────────────────────────
  // ── Find another port on the same device ──
  const findAnotherPort = async (forcedPort) => {
    const portArg = forcedPort != null ? String(forcedPort) : nextPort;
    if (!selectedDevice || !portArg) return;
    // Whole numbers only (reject "1.23" → the value must equal its integer
    // parse) and within the device's port count.
    const p = parseInt(portArg, 10);
    if (isNaN(p) || p < 1 || String(p) !== String(portArg).trim()) {
      setError('Enter a valid whole port number');
      return;
    }
    if (portMaxLimit > 0 && p > portMaxLimit) {
      setError(`This device has ${portMaxLimit} ports - enter a number between 1 and ${portMaxLimit}.`);
      return;
    }
    if (portMaxLimit === 0) {
      setError("We couldn't read how many ports this device has. Set the port count below, then pick a port.");
      return;
    }
    setLoading(true); setError(null);
    try {
      const res  = await authFetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: selectedIdx, port: p, port_category: portCategory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setResultImg(bustUrl(apiUrl(data.resultImageUrl)));
      setRackImg(data.rackImageUrl ? bustUrl(apiUrl(data.rackImageUrl)) : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      setPortNum(String(p));
      setNextPort('');
      resetFeedback();
      setNeighborStatus('idle');
      setNeighbor(null);
      setNeighborErr(null);
      setConsoleEntries([]);
      setConsoleStatus('idle');
      setManualCmd('');
      setSessionPorts(prev => {
        const next = prev.filter(sp => !(sp.deviceIdx === selectedIdx && sp.port === p));
        next.push({
          deviceIdx: selectedIdx,
          port: p,
          deviceLabel: labels[selectedIdx - 1] || `Device ${selectedIdx}`,
          deviceClass: selectedDevice?.class_name || '',
          status: data.portInfo?.status || null,
          portCategory,
        });
        return next;
      });
      findNeighbor(null, { port: p, silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const reloadSessionPort = async (entry) => {
    setLoading(true); setError(null);
    try {
      const res = await authFetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: entry.deviceIdx, port: entry.port, port_category: entry.portCategory || 'main' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setSelectedIdx(entry.deviceIdx);
      setPortNum(String(entry.port));
      setResultImg(bustUrl(apiUrl(data.resultImageUrl)));
      setRackImg(data.rackImageUrl ? bustUrl(apiUrl(data.rackImageUrl)) : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      resetFeedback();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Interface name differs by vendor CLI; keep this table in sync with server VENDORS.
  const VENDOR_IFACE = {
    'cisco-ios': (p) => `Gi1/0/${p}`,
    'dlink':     (p) => String(p),
    'tplink':    (p) => `1/0/${p}`,
  };
  const deriveInterface = (p) => (VENDOR_IFACE[switchCreds.vendor] || VENDOR_IFACE['tplink'])(p);

  const findNeighbor = async (credsOverride, opts = {}) => {
    const { port: portOverride, silent = false } = opts;
    const creds = credsOverride || switchCreds;
    const targetPort = portOverride != null ? portOverride : portNum;
    // Host is always required from the user. User/pass can come from the
    // encrypted env store on the server side — if it has them, the client
    // doesn't need to ask.
    const userOk = !!creds.username || credsStatus.has_username;
    const passOk = !!creds.password || credsStatus.has_password;
    if (!creds.host || !userOk || !passOk) {
      // In background mode we just bail silently instead of popping the
      // creds modal on top of the user.
      if (silent) return;
      setCredsOpen(true);
      return;
    }
    if (!targetPort) return;
    neighborPortRef.current = String(targetPort);
    setNeighborStatus('loading'); setNeighborErr(null); setNeighbor(null);
    try {
      const vendor = creds.vendor || 'tplink';
      const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
      const res = await authFetch(apiUrl('/api/switch/lldp-neighbor'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          enablePassword: creds.enablePassword || '',
          interface: ifaceFn(targetPort),
          vendor,
        }),
      });
      const data = await res.json();
      // Drop stale response: the user moved to a different port while this
      // was in flight.
      if (neighborPortRef.current !== String(targetPort)) return;
      if (!res.ok || !data.ok) throw new Error(data.error || 'Lookup failed');
      setNeighbor(data.neighbor);
      setNeighborMethod(data.method || null);
      setNeighborChain(data.chain || null);
      setNeighborDetailsOpen(false);
      setNeighborStatus(data.neighbor?.found ? 'ok' : 'empty');
    } catch (err) {
      if (neighborPortRef.current !== String(targetPort)) return;
      if (silent) { setNeighborStatus('idle'); return; }
      setNeighborErr(err.message);
      setNeighborStatus('error');
    }
  };

  const submitCreds = (host, username, password, vendor, enablePassword) => {
    const next = { host: host.trim(), username: username.trim(), password, vendor: vendor || 'tplink', enablePassword: enablePassword || '' };
    setSwitchCreds(next);
    setCredsOpen(false);
    // No automatic console run any more — user picks an action from the
    // intent dropdown inside the console sheet.
    if (pendingConsoleOpen) {
      setPendingConsoleOpen(false);
      setConsoleOpen(true);
    } else {
      // "Find another end of device" is the only auto-fired action — and
      // only when that's why we asked for creds.
      findNeighbor(next);
    }
  };

  // Streams the predefined console commands one-at-a-time via SSE.
  // Runs in the background — does NOT open the console sheet. The user can
  // open the sheet later to watch live progress / inspect completed entries.
  const startAutoConsoleRun = async (credsOverride) => {
    const creds = credsOverride || switchCreds;
    if (!creds.host || !creds.username || !creds.password) return;
    if (!portNum) return;
    if (autoRunInFlightRef.current) return; // already running
    autoRunInFlightRef.current = true;

    setConsoleStatus('running-auto');
    setConsoleEntries([]);
    setConsolePlan([]);
    setRunningIdx(-1);
    setPortReportOpen(false);
    setPortReport(null);
    setConsoleRunMs(null);
    consoleRunStartRef.current = Date.now();

    const vendor = creds.vendor || 'tplink';
    const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
    const iface = ifaceFn(portNum);

    try {
      const res = await authFetch(apiUrl('/api/switch/console/run-auto-stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          enablePassword: creds.enablePassword || '',
          interface: iface,
          vendor,
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let msg;
            try { msg = JSON.parse(payload); } catch { continue; }
            if (msg.type === 'plan') {
              setConsolePlan(msg.commands || []);
            } else if (msg.type === 'running') {
              setRunningIdx(msg.i);
            } else if (msg.type === 'entry') {
              setConsoleEntries(prev => [...prev, msg.entry]);
            } else if (msg.type === 'done') {
              setRunningIdx(-1);
              setConsoleStatus('ready');
              if (consoleRunStartRef.current != null) {
                setConsoleRunMs(Date.now() - consoleRunStartRef.current);
                consoleRunStartRef.current = null;
              }
            } else if (msg.type === 'error') {
              throw new Error(msg.error || 'Stream error');
            }
          }
        }
      }
      setRunningIdx(-1);
      setConsoleStatus(prev => (prev === 'error' ? 'error' : 'ready'));
      if (consoleRunStartRef.current != null) {
        setConsoleRunMs(Date.now() - consoleRunStartRef.current);
        consoleRunStartRef.current = null;
      }
    } catch (err) {
      setConsoleEntries(prev => [...prev, { name: 'Error', cmd: '(auto-run)', output: '', error: err.message, source: 'auto' }]);
      setRunningIdx(-1);
      setConsoleStatus('error');
      if (consoleRunStartRef.current != null) {
        setConsoleRunMs(Date.now() - consoleRunStartRef.current);
        consoleRunStartRef.current = null;
      }
    } finally {
      autoRunInFlightRef.current = false;
    }
  };

  // Console open → just unveils the sheet. Nothing runs until the user
  // picks an action from the intent dropdown inside.
  const openConsole = async (credsOverride) => {
    const creds = credsOverride || switchCreds;
    const userOk = !!creds.username || credsStatus.has_username;
    const passOk = !!creds.password || credsStatus.has_password;
    if (!creds.host || !userOk || !passOk) {
      setPendingConsoleOpen(true);
      setCredsOpen(true);
      return;
    }
    setConsoleOpen(true);
  };

  // Live SSH snapshot of the switch — model, firmware, uptime, serial.
  // Fires the vendor's "switch info" command (show version / show
  // system-info) and parses the output. Does NOT pass scanId/device_index/
  // port so the server skips appending to the persisted transcript — this
  // is an out-of-band lookup, not part of the rack scan record.
  // Fire /api/specs in the background once we know vendor + model.
  // No await on the caller — this runs in parallel with the firmware check.
  const lookupSpecs = async (displayVendor, lookupModel) => {
    if (!displayVendor || !lookupModel) {
      setSwitchSpecsStatus('skipped');
      return;
    }
    setSwitchSpecsStatus('loading');
    setSwitchSpecsError(null);
    setSwitchSpecs(null);
    try {
      const res = await authFetch(apiUrl('/api/specs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel }),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!data) throw new Error(`HTTP ${res.status}`);
      if (!res.ok || !data.ok) {
        setSwitchSpecsError(data.error || `HTTP ${res.status}`);
        setSwitchSpecs(data); // preserve any partial fields (productUrl etc.)
        setSwitchSpecsStatus('error');
        return;
      }
      setSwitchSpecs(data);
      setSwitchSpecsStatus('ready');
    } catch (err) {
      setSwitchSpecsError(err.message || String(err));
      setSwitchSpecsStatus('error');
    }
  };

  // Fire /api/firmware in the background — needs vendor + model + version.
  const lookupFirmware = async (displayVendor, lookupModel, currentVersion) => {
    if (!displayVendor || !lookupModel || !currentVersion) {
      setSwitchFirmwareStatus('skipped');
      return;
    }
    setSwitchFirmwareStatus('loading');
    setSwitchFirmwareError(null);
    setSwitchFirmware(null);
    try {
      const res = await authFetch(apiUrl('/api/firmware'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel, currentVersion }),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!data) throw new Error(`HTTP ${res.status}`);
      if (!res.ok || !data.ok) {
        setSwitchFirmwareError(data.error || `HTTP ${res.status}`);
        setSwitchFirmwareStatus('error');
        return;
      }
      setSwitchFirmware(data);
      setSwitchFirmwareStatus('ready');
    } catch (err) {
      setSwitchFirmwareError(err.message || String(err));
      setSwitchFirmwareStatus('error');
    }
  };

  const fetchSwitchInfo = async () => {
    const vendor = switchCreds.vendor || 'tplink';
    const cmd = SWITCH_INFO_CMD[vendor] || 'show version';
    setSwitchInfoStatus('loading');
    setSwitchInfoError(null);
    setSwitchInfoData(null);
    setSwitchInfoRaw('');
    // Reset downstream lookups so a stale prior result doesn't flash.
    setSwitchSpecs(null);
    setSwitchSpecsStatus('idle');
    setSwitchSpecsError(null);
    setSwitchFirmware(null);
    setSwitchFirmwareStatus('idle');
    setSwitchFirmwareError(null);
    try {
      const res = await authFetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: cmd,
          vendor,
          // Slow on some platforms; allow up to 30s.
          timeoutMs: 30000,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok || data.entry?.error) {
        throw new Error(data.entry?.error || data.error || 'Command failed');
      }
      const raw = data.entry?.output || '';
      const parsed = parseSwitchInfo(raw, vendor);
      setSwitchInfoRaw(raw);
      setSwitchInfoData(parsed);
      setSwitchInfoStatus('ready');

      // Kick off specs + firmware lookups in parallel. These are best-effort
      // and don't block the modal; each section renders its own status.
      const displayVendor = SSH_VENDOR_TO_DISPLAY[vendor] || '';
      const lookupModel = cleanModelForLookup(parsed.model);
      const cleanVer = cleanFirmwareVersion(parsed.firmware);
      lookupSpecs(displayVendor, lookupModel);
      lookupFirmware(displayVendor, lookupModel, cleanVer);
    } catch (err) {
      setSwitchInfoError(err.message || String(err));
      setSwitchInfoStatus('error');
    }
  };

  const openSwitchInfo = () => {
    const userOk = !!switchCreds.username || credsStatus.has_username;
    const passOk = !!switchCreds.password || credsStatus.has_password;
    if (!switchCreds.host || !userOk || !passOk) {
      setCredsOpen(true);
      return;
    }
    setSwitchInfoOpen(true);
    fetchSwitchInfo();
  };

  // Run a single intent — exactly the command behind the user's chosen
  // dropdown option, nothing else. Result lands in consoleEntries with the
  // intent's English label as the entry name (we hide the raw cmd in the UI).
  const runIntent = async (intentId) => {
    const intent = consoleIntents.find(i => i.id === intentId);
    if (!intent) return;
    const userOk = !!switchCreds.username || credsStatus.has_username;
    const passOk = !!switchCreds.password || credsStatus.has_password;
    if (!switchCreds.host || !userOk || !passOk) {
      setCredsOpen(true);
      return;
    }
    setConsoleStatus('running-manual');
    try {
      const res = await authFetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: intent.cmd,
          interface: deriveInterface(portNum),
          vendor: switchCreds.vendor || 'tplink',
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Command failed');
      // Override the entry name with the friendly label so the UI shows it
      // instead of the shell command.
      const entry = { ...(data.entry || {}), name: intent.label, intent_id: intent.id };
      setConsoleEntries(prev => [...prev, entry]);
      setConsoleStatus('ready');
    } catch (err) {
      setConsoleEntries(prev => [...prev, {
        name: intent.label, cmd: intent.cmd, output: '', error: err.message, source: 'intent', intent_id: intent.id,
      }]);
      setConsoleStatus('ready');
    }
  };

  // Build a structured report from the captured transcript, close the console
  // sheet, and open the report modal in one step. Done = "show me the report".
  const finishConsole = () => {
    const built = buildPortReport({
      host: switchCreds.host,
      vendor: switchCreds.vendor,
      iface: deriveInterface(portNum),
      portNum,
      entries: consoleEntries,
      neighbor,
      neighborMethod,
    });
    setPortReport(built);
    setPortReportOpen(true);
    setConsoleOpen(false);
    setConsoleStatus('idle');
    setManualCmd('');
  };

  const runManualCommand = async () => {
    const cmd = manualCmd.trim();
    if (!cmd) return;
    setConsoleStatus('running-manual');
    try {
      const res = await authFetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: cmd,
          interface: deriveInterface(portNum),
          vendor: switchCreds.vendor || 'tplink',
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Command failed');
      setConsoleEntries(prev => [...prev, data.entry]);
      setManualCmd('');
      setConsoleStatus('ready');
    } catch (err) {
      setConsoleEntries(prev => [...prev, { name: 'Manual', cmd, output: '', error: err.message, source: 'manual' }]);
      setManualCmd('');
      setConsoleStatus('ready');
    }
  };

  // Exit closes the sheet; transcript is already persisted server-side, so the next
  // report generation includes it automatically.
  const exitConsole = () => {
    setConsoleOpen(false);
    setConsoleStatus('idle');
    setManualCmd('');
  };

  const SHARE_CHANNELS = [
    {
      key: 'teams', label: 'Teams',
      icon: (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="2" y="6" width="18" height="20" rx="3" fill="#1c1c1c"/>
          <path d="M6 12h10M11 12v10" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round"/>
          <circle cx="25" cy="11" r="3" fill="#474747"/>
          <rect x="21" y="15" width="9" height="10" rx="2" fill="#474747"/>
        </svg>
      ),
    },
    {
      key: 'outlook', label: 'Outlook',
      icon: (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="2" y="7" width="17" height="18" rx="2" fill="#1c1c1c"/>
          <circle cx="10.5" cy="16" r="4.5" fill="none" stroke="#ffffff" strokeWidth="2"/>
          <rect x="20" y="10" width="10" height="12" rx="1.5" fill="#c6c6c6"/>
          <path d="M20 11l5 4 5-4" stroke="#1c1c1c" strokeWidth="1.4" fill="none"/>
        </svg>
      ),
    },
    // Slack was removed from the share menu on the owner's instruction ("remove
    // slack keep teams and outlook"). Only this list drives what the menu
    // offers, so dropping the entry is enough to take it out of the UI.
    //
    // The server route, the Python sender and the per-channel note/recipient
    // maps are deliberately left in place: they are inert with nothing able to
    // select the channel, and keeping them means turning Slack back on is a
    // one-entry change rather than a re-implementation. Nothing here reads the
    // list to enumerate what the backend supports.
  ];

  // Per-channel last recipient is cached in localStorage so the dialog pre-fills
  // with the address the user most recently sent to via that channel.
  const SHARE_LS_KEY = (channel) => `racktrack.share.lastRecipient.${channel}`;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SHARE_NOTE_LABEL = { teams: 'Message', slack: 'Message', outlook: 'Subject' };
  const SHARE_NOTE_PLACEHOLDER = {
    teams:   'Hi, please find the attached rack scan report.',
    slack:   'Sharing the latest rack scan report for your review.',
    outlook: `Rack scan report for ${rackId || scanId}`,
  };

  const openShareDialog = (channel) => {
    setShareMenuOpen(false);
    setShareDialogChannel(channel);
    setShareEmailErr(null);
    let prefill = '';
    try { prefill = getItem(SHARE_LS_KEY(channel)) || ''; } catch (_) {}
    setShareEmailInput(prefill);
    setShareNoteInput('');
  };

  const closeShareDialog = () => {
    setShareDialogChannel(null);
    setShareEmailInput('');
    setShareNoteInput('');
    setShareEmailErr(null);
  };

  const confirmShareSend = async () => {
    const channel = shareDialogChannel;
    if (!channel) return;
    const email = shareEmailInput.trim();
    if (!email) { setShareEmailErr('Recipient email is required.'); return; }
    if (!EMAIL_RE.test(email)) { setShareEmailErr('Enter a valid email address.'); return; }

    const note = shareNoteInput.trim();
    const payload = { email };
    if (note) {
      if (channel === 'outlook') payload.subject = note;
      else if (channel === 'teams') payload.message = note;
      else if (channel === 'slack') payload.comment = note;
    }

    try { setItem(SHARE_LS_KEY(channel), email); } catch (_) {}

    setShareDialogChannel(null);
    setShareStatus('sending');
    setShareChannel(channel);
    setShareMsg(null);
    try {
      const res = await authFetch(apiUrl(`/api/scan/${scanId}/${channel}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `${channel} send failed`);
      setShareStatus('sent');
      setShareMsg(`Sent to ${data.recipient} via ${channel}`);
      setTimeout(() => { setShareStatus('idle'); setShareMsg(null); setShareChannel(null); }, 3500);
    } catch (err) {
      setShareStatus('error');
      setShareMsg(err.message);
      // Clear eventually even if untouched — long enough to read a real
      // explanation, short enough that it cannot sit over the page forever.
      setTimeout(() => { setShareStatus('idle'); setShareMsg(null); setShareChannel(null); }, 15000);
    }
  };

  // Which part of the report to land on. The tour sends the user here right
  // after Find Port, and testers reported arriving at the top with no idea the
  // port detail was further down. When a port has been located, go to it.
  const reportHash = reportDownload ? '#download' : (portInfo ? '#ports' : '');

  // `download` asks the server for Content-Disposition: attachment. Without it
  // the PDF is served inline, so a browser renders it instead of saving it -
  // half of why the Download button appeared to do nothing on mobile.
  const reportUrl = (format, download = false) =>
    apiUrl(`/api/scan/${scanId}/report?format=${format}`) +
    (download ? '&download=1' : '') +
    (reportToken ? `&t=${encodeURIComponent(reportToken)}` : '');
  // Tokens are short-lived, so mint one per open rather than caching.
  const fetchReportToken = async () => {
    setReportToken(null); setReportTokenErr(null);
    try {
      const r = await authFetch(apiUrl(`/api/scan/${scanId}/report-token`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { token } = await r.json();
      setReportToken(token);
    } catch (err) {
      setReportTokenErr(err.message || 'could not authorise report');
    }
  };
  const viewReport = () => { setReportDownload(false); setReportOpen(true); fetchReportToken(); };
  // Same in-app modal as View, but with the auto-print hash — keeps the whole
  // download flow inside the app (no external browser, no ngrok URL shown).
  const openReportForDownload = () => { setReportDownload(true); setReportOpen(true); fetchReportToken(); };
  const downloadReport = async (format) => {
    try {
      const url = reportUrl(format, true);

      // Inside the packaged app the WebView ignores both blob: URLs and the
      // <a download> attribute, so the tap did nothing at all and there was no
      // error to show — the report simply never arrived. Hand the URL to the
      // system instead, which downloads it properly. The URL already carries
      // the short-lived report token, so it works without an auth header.
      const isNative = typeof window !== 'undefined'
        && (window.Capacitor?.isNativePlatform?.() || !!window.Capacitor?.isNative);
      if (isNative) {
        // `window.open(url, '_system')` is a Cordova convention. Capacitor has
        // no handler for that target, so the tap did nothing at all in the
        // packaged app — testers reported the Download button as dead. The
        // Capacitor equivalent is Browser.open, which this app already uses for
        // OAuth in SocialSignIn.jsx; it hands the URL to a Custom Tab / Safari
        // view that honours the attachment header and saves the file.
        await Browser.open({ url });
        return;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Report request failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${scanId}_report.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    }
  };

  const resetFeedback = () => {
    setFeedbackStatus('idle');
    setActualPortInput('');
    setActualCableColor('');
    setFeedbackError(null);
    setDeviceFbStatus('idle');
    setActualDeviceClass('');
    setDeviceFbError(null);
    setPortCountFbStatus('idle');
    setActualPortCount('');
    setPortCountFbError(null);
  };

  // Step 1 of the wrong-pending flow: validate the port number.
  // If the port is connected, advance to color step; otherwise submit immediately.
  const advancePortStep = () => {
    if (!selectedDevice) return;
    const a = parseInt(actualPortInput, 10);
    if (isNaN(a) || a < 1 || (selectedDevice.port_count > 0 && a > selectedDevice.port_count)) {
      setFeedbackError(selectedDevice.port_count > 0
        ? `Port must be between 1 and ${selectedDevice.port_count}`
        : 'Invalid port number');
      return;
    }
    setFeedbackError(null);
    if (portInfo?.status === 'connected') {
      setFeedbackStatus('wrong-color');
    } else {
      submitFeedback(false);
    }
  };

  const submitFeedback = async (isCorrect, overrides = {}) => {
    if (!selectedDevice || !portNum) return;
    let payloadActualPort = null;
    let payloadActualCableColor = null;

    if (!isCorrect) {
      const portCandidate = overrides.actualPort ?? actualPortInput;
      const a = parseInt(portCandidate, 10);
      if (isNaN(a) || a < 1 || (selectedDevice.port_count > 0 && a > selectedDevice.port_count)) {
        setFeedbackError(selectedDevice.port_count > 0
          ? `Port must be between 1 and ${selectedDevice.port_count}`
          : 'Invalid port number');
        setFeedbackStatus('wrong-port');
        return;
      }
      payloadActualPort = a;
      // Cable color is now collected via the separate cable Yes/No block —
      // not required here. If somehow set in state (legacy override), still
      // include it so a combined correction still works.
      const colorOverride = overrides.actualCableColor ?? actualCableColor;
      if (colorOverride) payloadActualCableColor = colorOverride;
    }

    setFeedbackStatus('submitting'); setFeedbackError(null);
    try {
      const res = await authFetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          predicted_port: parseInt(portNum, 10),
          is_correct: isCorrect,
          actual_port: payloadActualPort,
          actual_cable_color: payloadActualCableColor,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      markAnswered(`${scanId}:p:${selectedIdx}:${portNum}:loc`);
      // Helper: apply a cable-color override to a portInfo object.
      const _applyColor = (pi, color) => {
        if (!pi || !color) return pi;
        const next = { ...pi };
        next.cable_color = color;
        const colorWord = /\b(?:White|Black|Blue|Red|Green|Yellow|Grey|Gray|Brown|Orange|Purple|Pink|Violet|Aqua)\b/i;
        if (next.cable_type && colorWord.test(next.cable_type)) {
          next.cable_type = next.cable_type.replace(colorWord, color);
        }
        return next;
      };

      // Cable-color-only correction: in-place overlay, no re-select needed.
      if (!isCorrect && payloadActualCableColor && payloadActualPort == null) {
        setPortInfo(prev => _applyColor(prev, payloadActualCableColor));
      }
      setFeedbackStatus('submitted');

      // Port-number correction (with optional cable-color in the same submit):
      // The user said "this position (model called it port N) is actually
      // port M". Their goal hasn't changed — they were looking for port N
      // and still want port N. After saving the shift, re-select port N
      // so the highlight moves to where port N really lives under the new
      // numbering. The server's /api/select translates user→raw via the
      // saved shift, so calling with port=N here lands on the correct
      // physical port and labels it N.
      if (!isCorrect && payloadActualPort != null) {
        const userGoalPort = parseInt(portNum, 10);  // the port the user was looking for
        try {
          const sres = await authFetch(apiUrl('/api/select'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scanId,
              device_index: selectedIdx,
              port: userGoalPort,
              port_category: portCategory || 'main',
            }),
          });
          const sdata = await sres.json();
          if (sres.ok) {
            if (sdata.resultImageUrl) setResultImg(bustUrl(apiUrl(sdata.resultImageUrl)));
            if (sdata.rackImageUrl)   setRackImg(bustUrl(apiUrl(sdata.rackImageUrl)));
            if (sdata.portInfo) {
              // Server's /api/select doesn't apply cable-color overrides — so
              // if the user corrected the cable color in this same submit,
              // overlay it on top of the fresh portInfo. Otherwise the new
              // highlight would briefly show the OLD cable color.
              setPortInfo(payloadActualCableColor
                ? _applyColor(sdata.portInfo, payloadActualCableColor)
                : sdata.portInfo);
            } else if (payloadActualCableColor) {
              setPortInfo(prev => _applyColor(prev, payloadActualCableColor));
            }
            // Keep portNum at the user's goal (don't flip it to the corrected label).
            setPortNum(String(userGoalPort));
          }
        } catch (_) { /* highlight refresh is best-effort */ }
      }

      setTimeout(() => {
        setFeedbackStatus('hidden');
        setActualPortInput('');
        setActualCableColor('');
        setFeedbackError(null);
      }, 2000);
    } catch (err) {
      setFeedbackError(err.message);
      setFeedbackStatus(isCorrect ? 'idle' : 'wrong-port');
      throw err;   // let StandardFeedback surface the failure
    }
  };

  // Cable-only feedback: independent of port-number correction. Submits
  // to the same /api/feedback endpoint with is_correct=false +
  // actual_cable_color (and no actual_port), so the override layer
  // re-paints the cable color without touching port numbering.
  const submitCableFeedback = async (isCorrect, color) => {
    if (!selectedDevice || !portNum) return;
    if (!isCorrect && !color) {
      setCableFbError('Pick the actual cable color.');
      return;
    }
    setCableFbStatus('submitting'); setCableFbError(null);
    try {
      const res = await authFetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          predicted_port: parseInt(portNum, 10),
          is_correct: isCorrect,
          actual_port: null,
          actual_cable_color: isCorrect ? null : color,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      markAnswered(`${scanId}:p:${selectedIdx}:${portNum}:cable`);
      // Optimistic: paint the new cable color into portInfo immediately.
      if (!isCorrect && color) {
        setPortInfo(prev => {
          if (!prev) return prev;
          const next = { ...prev };
          next.cable_color = color;
          const colorWord = /\b(?:White|Black|Blue|Red|Green|Yellow|Grey|Gray|Brown|Orange|Purple|Pink|Violet|Aqua)\b/i;
          if (next.cable_type && colorWord.test(next.cable_type)) {
            next.cable_type = next.cable_type.replace(colorWord, color);
          }
          return next;
        });
      }
      setCableFbStatus('submitted');
      setTimeout(() => {
        setCableFbStatus('hidden');
        setCableFbColor('');
        setCableFbError(null);
      }, 2000);
    } catch (err) {
      setCableFbError(err.message);
      setCableFbStatus(isCorrect ? 'idle' : 'wrong');
      throw err;
    }
  };

  // Tag / correct the physical PORT TYPE of the selected port. Feeds the
  // active-learning memory + retraining dataset via /api/feedback/port-type.
  const submitPortTypeFeedback = async (actualType) => {
    if (!selectedIdx || !actualType) return;
    setPortTypeStatus('submitting');
    try {
      const res = await authFetch(apiUrl('/api/feedback/port-type'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          port: portNum ? parseInt(portNum, 10) : null,
          predicted_type: portInfo?.port_type || null,
          actual_type: actualType,
          port_location: portInfo?.location || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'save failed');
      }
      markAnswered(`${scanId}:p:${selectedIdx}:${portNum}:type`);
      setPortInfo(prev => (prev ? { ...prev, port_type: actualType, _port_type_user: true } : prev));
      setPortTypeStatus('submitted');
      setTimeout(() => setPortTypeStatus('idle'), 2000);
    } catch (err) {
      setPortTypeStatus('error');
      throw err;
    }
  };

  const submitDeviceFeedback = async (isCorrect, valueArg = '') => {
    if (!selectedDevice) return;
    const cls = valueArg || actualDeviceClass;   // valueArg from StandardFeedback, else state
    if (!isCorrect && !cls) {
      setDeviceFbError('Pick the actual device type.');
      return;
    }
    setDeviceFbStatus('submitting'); setDeviceFbError(null);
    try {
      const res = await authFetch(apiUrl('/api/feedback/device'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          is_correct: isCorrect,
          actual_device_class: isCorrect ? null : cls,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      markAnswered(`${scanId}:d:${selectedIdx}:class`);
      // Optimistic: reflect the user's device-class correction in the
      // local devices[] so the picker / "Selected Device" line updates
      // without a refresh. Server overlays the same change into
      // scan_result.json via applyFeedbackOverrides.
      if (!isCorrect && cls) {
        setDevices(prev => prev.map((d, i) =>
          (i + 1 === selectedIdx) ? { ...d, class_name: cls, class_name_source: 'user_corrected' } : d
        ));
      }
      setDeviceFbStatus('submitted');
      setTimeout(() => {
        setDeviceFbStatus('hidden');
        setActualDeviceClass('');
        setDeviceFbError(null);
      }, 2000);
    } catch (err) {
      setDeviceFbError(err.message);
      setDeviceFbStatus(isCorrect ? 'idle' : 'wrong-pending');
      throw err;
    }
  };

  const submitPortCountFeedback = async (isCorrect, valueArg = null) => {
    if (!selectedDevice) return;
    let actualNum = null;
    if (!isCorrect) {
      const a = parseInt(valueArg != null ? valueArg : actualPortCount, 10);
      if (isNaN(a) || a < 0) {
        setPortCountFbError('Enter a valid port count (0 or more).');
        return;
      }
      actualNum = a;
    }
    setPortCountFbStatus('submitting'); setPortCountFbError(null);
    try {
      const res = await authFetch(apiUrl('/api/feedback/port-count'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          is_correct: isCorrect,
          actual_port_count: isCorrect ? null : actualNum,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      markAnswered(`${scanId}:d:${selectedIdx}:count`);
      // If the server re-labeled the device with the user's target count,
      // patch the local devices array so the picker reflects the new count
      // immediately — no page refresh needed.
      if (data.relabel?.ok && data.relabel?.device) {
        const idx = data.relabel.device_index;
        setDevices(prev => prev.map((d, i) => (i + 1 === idx ? data.relabel.device : d)));
        // The server redrew the device image with the corrected port count —
        // cache-bust so the port view shows the new dots/indices immediately.
        if (data.relabel.image_updated) {
          setResultImg(prev => (prev ? bustUrl(prev) : prev));
        }
      } else if (!isCorrect && actualNum > 0) {
        // The server didn't relabel, but the user still told us the real count.
        // Reflect it locally so the port-number input's 1–N bound follows the
        // correction straight away (correct it to 28 → only 1–28 is accepted).
        setDevices(prev => prev.map((d, i) => (
          i + 1 === selectedIdx ? { ...d, port_count: actualNum } : d
        )));
      }
      setPortCountFbStatus('submitted');
      setTimeout(() => {
        setPortCountFbStatus('hidden');
        setActualPortCount('');
        setPortCountFbError(null);
      }, 2000);
    } catch (err) {
      setPortCountFbError(err.message);
      setPortCountFbStatus(isCorrect ? 'idle' : 'wrong-pending');
      throw err;
    }
  };

  // ── Ticket-mode drift view ─────────────────────────────────────────────
  // When the ticket-driven analyze detected physical drift (CMDB expected
  // e.g. Switch at U15 but scan sees Closed Unit), we don't have a port to
  // pinpoint. Render a dedicated "something is wrong" view instead of the
  // port layout.
  // Only take over the Overview tab (the ticket landing) — and only until the
  // user dismisses it or switches to another tab. Otherwise this return fired
  // for EVERY tab, so navigating away changed the state but never the screen.
  if (ticketMode && result?.driftDetected && tab === 'overview' && !driftDismissed) {
    const drift = result.drift || {};
    const uStr = `U${String(drift.expected_u ?? '?').padStart(2, '0')}`;
    const seen = drift.detections_at_u || [];
    const rackImgUrl = result.rackImageUrl ? apiUrl(result.rackImageUrl) : (result.imageUrl ? apiUrl(result.imageUrl) : null);
    return (
      <div className={`page page-full ${styles.results}`}>
        <div className={styles.portAmb} style={{ '--ac': '#1c1c1c' }} />

        <header className={styles.header}>
          <button className="btn btn-ghost btn-icon"
            aria-label="Back to rack overview"
            onClick={() => setDriftDismissed(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
          </button>
          <div className={styles.headerCenter}>
            <h2 className={styles.headerTitle} style={{color:'#1c1c1c'}}>Physical Drift Detected</h2>
            <div className={styles.headerMetaRow}>
              {rackId && <span className={styles.headerMono}>{rackId}</span>}
            </div>
          </div>
          <div style={{ width: 40 }} />
        </header>

        <div className={styles.portBody}>
          {/* Drift alert card */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(0,0,0,0.15), rgba(0,0,0,0.05))',
            border: '1px solid rgba(0,0,0,0.55)',
            borderRadius: 12,
            padding: '14px 16px',
            margin: '8px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:'#1c1c1c',textTransform:'uppercase'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              CMDB ↔ scan mismatch for {ticket?.incident_number}
            </div>
            <div style={{fontSize:14,color:'var(--text, #c6c6c6)',lineHeight:1.45}}>
              {drift.reason}
            </div>
            {/* CMDB vs scan comparison */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginTop:4}}>
              <div style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:8,padding:10}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>CMDB expects</div>
                <div style={{fontSize:13,color:'var(--text, #c6c6c6)'}}>
                  <strong>{drift.expected_device}</strong>
                </div>
                <div style={{fontSize:12,color:'var(--muted, #474747)',marginTop:2}}>
                  {drift.expected_class} @ {uStr}
                </div>
              </div>
              <div style={{background:'rgba(0,0,0,0.06)',border:'1px solid rgba(0,0,0,0.3)',borderRadius:8,padding:10}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'#474747',textTransform:'uppercase',marginBottom:4}}>Scan sees at {uStr}</div>
                {seen.length === 0 ? (
                  <div style={{fontSize:13,color:'var(--text, #c6c6c6)'}}>nothing</div>
                ) : (
                  seen.map((d, i) => (
                    <div key={i} style={{fontSize:13,color:'var(--text, #c6c6c6)'}}>
                      <strong>{d.class_name}</strong>
                      <span style={{fontSize:11,color:'var(--muted, #474747)',marginLeft:6}}>
                        conf {typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '?'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Next-step guidance */}
            <div style={{fontSize:12,color:'var(--muted, #474747)',lineHeight:1.5,marginTop:4}}>
              <strong style={{color:'var(--text, #c6c6c6)'}}>Next steps:</strong> either the CMDB is stale (device was moved/replaced) or someone installed the wrong hardware. Verify physically at rack <strong>{ticket?.cmdb?.rack_name || '?'}</strong>, then update whichever side is wrong.
            </div>

          </div>

          {/* Annotated rack scan so the tech can eyeball what the camera saw */}
          {rackImgUrl && (
            <div style={{margin:'0 12px',borderRadius:10,overflow:'hidden',border:'1px solid rgba(255,255,255,0.08)'}}>
              {/* AssetImg, not <img>: /outputs is served against a short-lived
                  asset token, and a plain tag that painted before the token
                  landed (or after it expired) gets a 404 and stays broken
                  forever. AssetImg re-mints once and retries. */}
              <AssetImg src={rackImgUrl} alt="Annotated rack scan" style={{display:'block',width:'100%',height:'auto'}} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'port') {
    const rc = selectedDevice ? getColor(selectedDevice.class_name) : DEFAULT_COLOR;
    const resultLabel = buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum);
    const isConn = portInfo?.status === 'connected';
    const connectorVal = portInfo?.cable_connector || cableInfo?.display;
    const colorVal = portInfo?.cable_color || cableInfo?.colorName;
    return (
      <div className={`page page-full ${styles.results}`}>
        <div className={styles.portAmb} style={{ '--ac': rc }} />

        <header className={styles.header}>
          <button
            type="button"
            aria-label="Back to results"
            onClick={() => {
              setPhase('detect');
              setPortInfo(null); setPortNum(''); setNextPort('');
              setResultImg(null); setRackImg(null); setPortView('rack');
              setError(null); resetZoom();
              if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            style={{ width: 40, height: 40, display: 'grid', placeItems: 'center',
              border: '1px solid #ececec', borderRadius: 12, background: '#fff',
              color: '#121212', cursor: 'pointer', flex: '0 0 auto' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          </button>
          <div className={styles.headerCenter}>
            <h2 className={styles.headerTitle}>Port Located</h2>
            <div className={styles.headerMetaRow}>
              {rackId && <span className={styles.headerMono}>{rackId}</span>}
            </div>
          </div>
          <div style={{ width: 40 }} />
        </header>

        {/* Full-screen port result layout */}
        <div className={styles.portBody}>

          {/* Ticket context + LLDP result (only in ticket-mode) */}
          {ticketMode && ticket && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(0,0,0,0.08), rgba(0,0,0,0.05))',
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: 12,
              padding: '12px 14px',
              margin: '8px 12px 4px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
            }}>
              <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:'#000000',textTransform:'uppercase'}}>
                Auto-targeted from {ticket.incident_number}
              </div>
              <div style={{color:'var(--text, #c6c6c6)',lineHeight:1.4}}>
                {ticket.short_description}
              </div>
              <div style={{display:'flex',gap:10,flexWrap:'wrap',color:'var(--muted, #474747)',fontSize:12}}>
                <span><strong style={{color:'var(--text, #c6c6c6)'}}>{ticket.cmdb?.rack_name || '?'}</strong></span>
                <span>·</span>
                <span><strong style={{color:'var(--text, #c6c6c6)'}}>{ticket.target?.device}</strong> ({ticket.cmdb?.model || '?'})</span>
                <span>·</span>
                <span>port <strong style={{color:'var(--text, #c6c6c6)'}}>{ticket.cmdb?.interface_alias || `#${ticket.target?.port}`}</strong></span>
                {ticket.cmdb?.mgmt_ip && <><span>·</span><span>{ticket.cmdb.mgmt_ip}</span></>}
              </div>

              {/* Resolved banner — shows when the port transitions to active */}
              {liveResolvedAt && (
                <div style={{
                  marginTop:8,
                  background:'linear-gradient(135deg, rgba(0,0,0,0.20), rgba(0,0,0,0.06))',
                  border:'1px solid rgba(0,0,0,0.6)',
                  borderRadius:10,
                  padding:'10px 12px',
                  display:'flex',
                  alignItems:'center',
                  gap:10,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1c1c1c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
                  </svg>
                  <div style={{display:'flex',flexDirection:'column'}}>
                    <div style={{fontSize:13,fontWeight:600,color:'#1c1c1c'}}>Cable attached - port is now active</div>
                    <div style={{fontSize:11,color:'var(--muted, #474747)'}}>
                      Detected at {new Date(liveResolvedAt).toLocaleTimeString()} · incident {ticket.incident_number} likely resolved
                    </div>
                  </div>
                </div>
              )}

              {/* Live monitoring status strip */}
              <div style={{
                marginTop: liveResolvedAt ? 6 : 8,
                paddingTop: 6,
                borderTop:'1px dashed rgba(255,255,255,0.1)',
                display:'flex',
                flexWrap:'wrap',
                alignItems:'center',
                gap:10,
                fontSize:11,
                color:'var(--muted, #474747)',
              }}>
                <span style={{display:'inline-flex',alignItems:'center',gap:6}}>
                  <span style={{
                    width:8, height:8, borderRadius:'50%',
                    background: liveSnapshot?.link_active ? '#1c1c1c' : (liveSnapshot?.ok ? '#474747' : '#474747'),
                    boxShadow: liveSnapshot?.link_active ? '0 0 6px #1c1c1c' : 'none',
                    animation: liveInFlightRef.current ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  }}/>
                  Live · every {Math.round(LIVE_POLL_MS/1000)}s
                </span>
                {liveSnapshot?.ok ? (
                  <>
                    <span>·</span>
                    <span>link: <strong style={{color: liveSnapshot.link_active ? '#1c1c1c' : '#474747'}}>
                      {liveSnapshot.link_active ? 'active' : 'idle'}
                    </strong></span>
                    <span>·</span>
                    <span>neighbor: <strong style={{color:'var(--text, #c6c6c6)'}}>
                      {liveSnapshot.has_neighbor ? (liveSnapshot.neighbor?.sysname || 'present') : 'none'}
                    </strong></span>
                    <span>·</span>
                    <span>MACs: <strong style={{color:'var(--text, #c6c6c6)'}}>{liveSnapshot.mac_count ?? 0}</strong></span>
                  </>
                ) : liveSnapshot ? (
                  <span>· last attempt failed: {liveSnapshot.error?.slice(0, 60) || 'unknown'}</span>
                ) : (
                  <span>· waiting for first sample…</span>
                )}
                {liveLastAt && (
                  <>
                    <span>·</span>
                    <span>updated {Math.round((Date.now() - liveLastAt)/1000)}s ago</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Agent Analysis — zero-LLM extraction + reasoning chain + work-note preview.
              Only shown in ticket mode when /api/analyze-for-ticket returned an `agent` payload. */}
          {ticketMode && agent && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(0,0,0,0.06), rgba(0,0,0,0.04))',
              border: '1px solid rgba(0,0,0,0.30)',
              borderRadius: 12,
              padding: '12px 14px',
              margin: '8px 12px 4px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 13,
            }}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:'#1c1c1c',textTransform:'uppercase'}}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 00-3 3v0a3 3 0 003 3 3 3 0 003-3v0a3 3 0 00-3-3z"/>
                    <path d="M19 12a3 3 0 00-3-3 3 3 0 00-3 3v0a3 3 0 003 3 3 3 0 003-3v0z"/>
                    <path d="M5 12a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3z"/>
                    <path d="M12 16a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3z"/>
                    <line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="15" x2="13" y2="13"/><line x1="16" y1="15" x2="11" y2="13"/>
                  </svg>
                  Agent Analysis
                  <span style={{
                    padding:'2px 6px',
                    borderRadius:6,
                    background: (agent.extraction?.confidence ?? 0) >= 0.5
                      ? 'rgba(0,0,0,0.18)'
                      : 'rgba(0,0,0,0.18)',
                    color: (agent.extraction?.confidence ?? 0) >= 0.5 ? '#1c1c1c' : '#474747',
                    fontSize:10,
                    letterSpacing:'0.04em',
                  }}>
                    conf {Math.round((agent.extraction?.confidence ?? 0) * 100)}%
                  </span>
                </div>
                <button type="button"
                  onClick={() => setAgentExpanded(v => !v)}
                  style={{
                    background:'transparent',
                    border:'1px solid rgba(255,255,255,0.12)',
                    color:'var(--muted, #474747)',
                    fontSize:11,
                    padding:'4px 10px',
                    borderRadius:6,
                    cursor:'pointer',
                  }}>
                  {agentExpanded ? 'Collapse' : 'Show details'}
                </button>
              </div>

              {/* One-line summary always visible */}
              <div style={{color:'var(--text, #c6c6c6)',lineHeight:1.4}}>
                {agent.extraction?.one_line_summary || 'no extractable details'}
              </div>

              {/* Field grid — always visible, terse */}
              <div style={{display:'flex',flexWrap:'wrap',gap:8,fontSize:11,color:'var(--muted, #474747)'}}>
                {agent.extraction?.failure_mode && (
                  <span>mode: <strong style={{color:'var(--text, #c6c6c6)'}}>{agent.extraction.failure_mode.replace(/_/g,' ')}</strong></span>
                )}
                {agent.extraction?.affected_device && (
                  <>
                    <span>·</span>
                    <span>device: <strong style={{color:'var(--text, #c6c6c6)'}}>{agent.extraction.affected_device}</strong></span>
                  </>
                )}
                {agent.extraction?.affected_port != null && (
                  <>
                    <span>·</span>
                    <span>port: <strong style={{color:'var(--text, #c6c6c6)'}}>{agent.extraction.affected_port}</strong></span>
                  </>
                )}
                {agent.extraction?.urgency_signal && (
                  <>
                    <span>·</span>
                    <span>urgency: <strong style={{color:'var(--text, #c6c6c6)'}}>{agent.extraction.urgency_signal.replace(/_/g,' ')}</strong></span>
                  </>
                )}
              </div>

              {/* Expanded body — reasoning chain + signals + work-note preview */}
              {agentExpanded && (
                <div style={{marginTop:6,display:'flex',flexDirection:'column',gap:10,fontSize:12}}>

                  {/* Signals used */}
                  {Array.isArray(agent.extraction?.signals_used) && agent.extraction.signals_used.length > 0 && (
                    <div>
                      <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.08em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:5}}>
                        Signals
                      </div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                        {agent.extraction.signals_used.map(sig => (
                          <code key={sig} style={{
                            fontSize:10,
                            padding:'2px 6px',
                            borderRadius:4,
                            background:'rgba(255,255,255,0.05)',
                            color:'#ffffff',
                            fontFamily:'var(--mono, monospace)',
                          }}>{sig}</code>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Reasoning chain */}
                  {Array.isArray(agent.reasoning) && agent.reasoning.length > 0 && (
                    <div>
                      <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.08em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:5}}>
                        Reasoning chain
                      </div>
                      <ol style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
                        {agent.reasoning.map((step, i) => (
                          <li key={i} style={{color:'var(--text, #c6c6c6)',lineHeight:1.5}}>
                            <span style={{
                              display:'inline-block',
                              minWidth:90,
                              fontSize:10,
                              fontWeight:700,
                              color:'#000000',
                              letterSpacing:'0.04em',
                              textTransform:'uppercase',
                            }}>
                              {step.step?.replace(/_/g,' ')}
                            </span>
                            <span style={{color:'var(--muted, #474747)'}}> · </span>
                            <span>{step.evidence}</span>
                            <span style={{fontSize:10,color:'rgba(255,255,255,0.35)',marginLeft:6}}>
                              ({Math.round((step.confidence ?? 0) * 100)}%)
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Work-note preview */}
                  {agent.work_note_preview?.text && (
                    <div>
                      <div style={{
                        fontSize:10,fontWeight:700,letterSpacing:'0.08em',
                        color:'var(--muted, #474747)',textTransform:'uppercase',
                        marginBottom:5,
                        display:'flex',alignItems:'center',justifyContent:'space-between',
                      }}>
                        <span>Work-note preview</span>
                        <span style={{
                          fontSize:9,
                          color: agent.work_note_preview.would_post ? '#1c1c1c' : '#474747',
                          letterSpacing:'0.02em',
                          textTransform:'none',
                        }}>
                          {agent.work_note_preview.status}
                        </span>
                      </div>
                      <pre style={{
                        margin:0,
                        padding:'10px 12px',
                        borderRadius:8,
                        background:'rgba(0,0,0,0.35)',
                        border:'1px solid rgba(255,255,255,0.08)',
                        color:'#ffffff',
                        fontSize:11,
                        fontFamily:'var(--mono, monospace)',
                        whiteSpace:'pre-wrap',
                        wordBreak:'break-word',
                        maxHeight:220,
                        overflowY:'auto',
                      }}>{agent.work_note_preview.text}</pre>
                      <div style={{marginTop:6,display:'flex',gap:6,flexWrap:'wrap'}}>
                        <button type="button"
                          onClick={() => {
                            try {
                              navigator.clipboard.writeText(agent.work_note_preview.text);
                              setAgentNoteCopied(true);
                              setTimeout(() => setAgentNoteCopied(false), 1800);
                            } catch (_) { /* clipboard unavailable */ }
                          }}
                          style={{
                            background: agentNoteCopied ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.05)',
                            border: `1px solid ${agentNoteCopied ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.12)'}`,
                            color: agentNoteCopied ? '#1c1c1c' : 'var(--text, #c6c6c6)',
                            fontSize:11,
                            padding:'5px 12px',
                            borderRadius:6,
                            cursor:'pointer',
                          }}>
                          {agentNoteCopied ? 'Copied' : 'Copy note'}
                        </button>

                        {/* Post-to-ServiceNow button. Only shown when the agent
                            says it would post (confidence ≥ floor); below that
                            we still let the user force-post but warn first. */}
                        {ticket?.incident_number && (
                          <button type="button"
                            onClick={() => postWorkNoteToSn()}
                            disabled={agentPosting}
                            title={agent.work_note_preview.would_post
                              ? `Post work note to ${ticket.incident_number} in ServiceNow`
                              : `Agent confidence below auto-post floor - click anyway to post`}
                            style={{
                              background: agentPosting
                                ? 'rgba(0,0,0,0.10)'
                                : agent.work_note_preview.would_post
                                  ? 'rgba(0,0,0,0.18)'
                                  : 'rgba(0,0,0,0.10)',
                              border: `1px solid ${agent.work_note_preview.would_post
                                ? 'rgba(0,0,0,0.50)'
                                : 'rgba(0,0,0,0.40)'}`,
                              color: agentPosting
                                ? 'var(--muted, #474747)'
                                : agent.work_note_preview.would_post
                                  ? '#c6c6c6'
                                  : '#474747',
                              fontSize:11,
                              fontWeight:600,
                              padding:'5px 12px',
                              borderRadius:6,
                              cursor: agentPosting ? 'wait' : 'pointer',
                              display:'inline-flex',
                              alignItems:'center',
                              gap:6,
                            }}>
                            {agentPosting ? (
                              <>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                                  style={{animation:'spin 1s linear infinite'}}>
                                  <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
                                  <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
                                </svg>
                                Posting…
                              </>
                            ) : (
                              <>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                                </svg>
                                Post to ServiceNow
                              </>
                            )}
                          </button>
                        )}

                        {/* Result chip */}
                        {agentPostResult && (
                          <span style={{
                            fontSize:10,
                            padding:'5px 10px',
                            borderRadius:6,
                            background: agentPostResult.status === 'posted'
                              ? 'rgba(0,0,0,0.18)'
                              : agentPostResult.status === 'error'
                                ? 'rgba(0,0,0,0.15)'
                                : 'rgba(0,0,0,0.15)',
                            color: agentPostResult.status === 'posted'
                              ? '#1c1c1c'
                              : agentPostResult.status === 'error'
                                ? '#474747'
                                : '#474747',
                            border: `1px solid ${agentPostResult.status === 'posted'
                              ? 'rgba(0,0,0,0.40)'
                              : agentPostResult.status === 'error'
                                ? 'rgba(0,0,0,0.30)'
                                : 'rgba(0,0,0,0.30)'}`,
                            alignSelf:'center',
                          }}>
                            {agentPostResult.status === 'posted'         && 'Posted to ServiceNow'}
                            {agentPostResult.status === 'skipped_low_confidence'
                              && (<>Skipped - low confidence. <button onClick={() => postWorkNoteToSn({force:true})} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',padding:0,fontSize:10}}>Force post</button></>)}
                            {agentPostResult.status === 'skipped_no_change'   && 'Already posted - no change'}
                            {agentPostResult.status === 'skipped_rate_limit'  && 'Rate-limited - already posted within 24h'}
                            {agentPostResult.status === 'error'               && `Error: ${agentPostResult.message?.slice(0, 80)}`}
                            {!['posted','skipped_low_confidence','skipped_no_change','skipped_rate_limit','error'].includes(agentPostResult.status)
                              && (agentPostResult.message || agentPostResult.status)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Port image — tap to cycle: rack → device → zoomed port → rack */}
          {(() => {
            const cycleView = () => {
              if (portView === 'rack') setPortView('device');
              else if (portView === 'device') setPortView('zoom');
              else setPortView('rack');
            };
            const isRack = portView === 'rack' && rackImg;
            const isZoom = portView === 'zoom';
            // Fall back to whichever port image exists, then the annotated rack,
            // so the located view always shows something.
            const imgSrc = (isRack ? rackImg : resultImg) || resultImg || rackImg
              || (result?.imageUrl ? apiUrl(result.imageUrl) : null);
            const wrapClass = isRack ? styles.portImgRack : isZoom ? styles.portImgZoom : styles.portImgDev;
            const hint = isRack ? 'Tap for device view' : isZoom ? 'Tap for rack view' : 'Tap to zoom port';

            let zoomStyle = {};
            if (isZoom && portInfo?.location && selectedDevice?.box) {
              const [px1, py1, px2, py2] = portInfo.location;
              const [dx1, dy1, dx2, dy2] = selectedDevice.box;
              const devW = dx2 - dx1;
              const devH = dy2 - dy1;
              const portW = px2 - px1;
              const portH = py2 - py1;
              const pctX = Math.max(10, Math.min(90, (((px1 + px2) / 2 - dx1) / devW) * 100));
              const rawY = (((py1 + py2) / 2 - dy1) / devH) * 100;
              const pctY = Math.max(25, Math.min(75, rawY));
              const scale = Math.min(devW / (portW * 2.2), devH / (portH * 2.2), 6);
              zoomStyle = { transform: `scale(${scale}) translateY(8%)`, transformOrigin: `${pctX}% ${pctY}%` };
            }

            return (
              <div className={`${styles.portImgWrap} ${wrapClass}`} data-tour="port-image-tap" onClick={cycleView}>
                {/* AssetImg so a token that landed late (or expired while the
                    page sat open) re-mints and retries instead of leaving a
                    permanently broken picture — this is the image users
                    actually look at after a scan. */}
                <AssetImg src={imgSrc} alt="Port located"
                  className={styles.portImg}
                  style={zoomStyle}
                  draggable="false" />
                <span className={styles.portImgHint}>{hint}</span>
                {portTimings?.total_ms != null && (
                  <span className={`${styles.timingBadge} ${styles.heroTiming}`} title="Time from device+port submit to result">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    Done in {fmtMs(portTimings.total_ms)}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Port label — plain text, no container, below hero image */}
          <div className={styles.prLabelLine} style={{ '--ac': rc }}>
            {resultLabel}
          </div>

          {/* Port verdict — telemetry-style dashboard */}
          {(() => {
            const s = portInfo?.status;
            const isOn = s === 'connected';
            const isEmpty = s === 'empty';
            const statusText = isOn ? 'Connected' : isEmpty ? 'Empty' : 'Unknown';
            const statusColor = isOn ? '#1c1c1c' : isEmpty ? '#c6c6c6' : '#474747';
            return (
              <div className={styles.prDash} style={{ '--sc': statusColor, '--ac': rc }}>
                <div className={styles.prPortTile}>
                  <span className={styles.prPortLabel}>PORT</span>
                  <span className={styles.prPortNum}>{portNum}</span>
                  {portInfo?._port_shift && <UserTag label="Renumbered" />}
                  <span className={styles.prPortGlow} aria-hidden />
                </div>
                <div className={styles.prMetrics}>
                  <div className={`${styles.prMetric} ${styles.prMetricStatus}`}>
                    <span className={styles.prMetricLabel}>Status</span>
                    <span className={styles.prMetricVal}>
                      <span className={styles.prMetricDot} />
                      {statusText}
                    </span>
                  </div>
                  <div className={styles.prMetric}>
                    <span className={styles.prMetricLabel}>Device</span>
                    <span className={styles.prMetricVal}>
                      {selectedDevice?.class_name || '-'}
                      {selectedDevice?.class_name_source === 'user_corrected'
                        ? <UserTag />
                        : (selectedDevice?.confidence != null && (
                            <span className={styles.prMetricConf}>{fmtPct(selectedDevice.confidence)}</span>
                          ))}
                    </span>
                  </div>
                  {connectorVal && (
                    <div className={styles.prMetric}>
                      <span className={styles.prMetricLabel}>Cable</span>
                      <span className={styles.prMetricVal}>
                        {connectorVal}
                        {portInfo?.cable_confidence != null && (
                          <span className={styles.prMetricConf}>{fmtPct(portInfo.cable_confidence)}</span>
                        )}
                      </span>
                    </div>
                  )}
                  {colorVal && (
                    <div className={styles.prMetric}>
                      <span className={styles.prMetricLabel}>Color</span>
                      <span className={styles.prMetricVal}>
                        <span className={styles.prMetricSwatch}
                          style={{ background: cableColorCSS(colorVal), border: '1px solid rgba(0,0,0,0.18)' }} />
                        {colorVal}
                        {portInfo?._cable_color_model && <UserTag />}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Port-TYPE tag / correction — record the physical port type
              (RJ45 / SFP / USB / …). Feeds active-learning memory + retraining.
              Only shown once a port is selected. */}
          {portInfo && portInfo.status !== 'invalid' && portInfo.port_type && (
            <StandardFeedback
              key={`${scanId}:${selectedIdx}:${portNum}:type`}
              accent={rc}
              prompt={`Port type: ${prettyPortType(portInfo.port_type)} - right?`}
              options={PORT_TYPE_OPTIONS.map(t => ({ value: t, label: prettyPortType(t) }))}
              otherInput={null}
              submitLabel="Save"
              thanks="Saved - thanks, this trains the model."
              answered={answeredKeys.has(`${scanId}:p:${selectedIdx}:${portNum}:type`) || !!portInfo._port_type_user}
              answeredText={`Port type: ${prettyPortType(portInfo.port_type)} - you set this`}
              onYes={async () => { markAnswered(`${scanId}:p:${selectedIdx}:${portNum}:type`); }}
              onSubmit={(v) => submitPortTypeFeedback(v)}
            />
          )}

          {/* Low-confidence nudge — when the cable read is uncertain (usually a
              low-resolution / poorly-lit photo), tell the tech plainly and ask
              them to verify and correct it with the feedback below. */}
          {portInfo?.status === 'connected' && portInfo?.cable_confidence != null
            && portInfo.cable_confidence < 0.5 && (
            <div className={styles.prLowConf}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>
                Not fully sure about this cable ({fmtPct(portInfo.cable_confidence)} confidence) - the photo
                resolution may be too low to read it clearly. Please check the cable and its colour, and
                correct them below if they're wrong.
              </span>
            </div>
          )}

          {/* End device (LLDP) — shown for any non-empty port. The inner states
              cover the whole flow: idle → a "Find end device" button, loading,
              resolved neighbour, none-found, and error/retry. Previously the
              outer gate also required neighborStatus==='ok', which meant the
              button (and every other state) could never render — so the LLDP
              lookup was unreachable unless it happened to auto-resolve.
              We ALSO show it when the switch found a live neighbour (or is
              resolving one) even if the photo called the port empty — the live
              switch is ground truth, so a real endpoint must never be hidden by
              a mis-classified photo. */}
          {(portInfo?.status !== 'empty'
            || neighborStatus === 'loading'
            || (neighborStatus === 'ok' && neighbor?.found)) && (
          <div className={styles.prEnd} style={{ '--ac': rc }}>
            {neighborStatus === 'loading' && (
              <>
                <span className={styles.prEndPulse} />
                <span className={styles.prEndDim}>Resolving end device…</span>
              </>
            )}
            {neighborStatus === 'ok' && neighbor && (() => {
              // Pick a clean name: skip any field that contains a trailing
              // colon (which means the LLDP parser returned a field label
              // like "System description:" by mistake).
              const isLabelish = (v) => !v || /:\s*$/.test(String(v).trim());
              const cleanOrNull = (v) => (v && !isLabelish(v) ? String(v).trim() : null);
              const MAC_RE = /^(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$/i;
              const chassis = cleanOrNull(neighbor.chassis_id);
              const sysname = cleanOrNull(neighbor.system_name);
              const portId  = cleanOrNull(neighbor.port_id);
              // Prefer a human-readable name; a bare MAC is only a fallback name.
              const humanName = (chassis && !MAC_RE.test(chassis) ? chassis : null)
                             || (sysname && !MAC_RE.test(sysname) ? sysname : null);
              const macAddr = [portId, chassis].find(v => v && MAC_RE.test(v)) || null;
              const name = humanName || macAddr || 'End device';
              const desc = cleanOrNull(neighbor.port_description);
              const mgmt = cleanOrNull(neighbor.management_address);
              // Always surface the identifying facts as their own labelled chips.
              const chips = [
                macAddr && macAddr !== name && { kind: 'mac',  label: 'MAC',  value: macAddr },
                neighbor.vlan_id            && { kind: 'vlan', label: 'VLAN', value: String(neighbor.vlan_id) },
                mgmt                        && { kind: 'ip',   label: 'IP',   value: mgmt },
                desc && !MAC_RE.test(desc)  && { kind: 'info', label: null,   value: desc },
              ].filter(Boolean).map((c, i) => ({ key: `c${i}`, ...c }));
              return (
                <div className={styles.prEndCreative}>
                  <div className={styles.prEndIcon} aria-hidden>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2"/>
                      <line x1="8" y1="21" x2="16" y2="21"/>
                      <line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    <span className={styles.prEndLiveDot} />
                  </div>
                  <div className={styles.prEndBody}>
                    <div className={styles.prEndHead}>
                      <span className={styles.prEndLabel}>Linked endpoint</span>
                      <span className={styles.prEndTag}>LIVE</span>
                    </div>
                    <strong className={styles.prEndName}>{name}</strong>
                    {chips.length > 0 && (
                      <div className={styles.prEndChips}>
                        {chips.map(chip => (
                          <span key={chip.key} className={`${styles.prEndChip} ${styles[`prEndChip_${chip.kind}`]}`}>
                            {chip.kind === 'mac' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M6 4v6m12-6v6m-14 0h16v4a4 4 0 01-4 4h-1v4h-2v-4H9v4H7v-4H6a4 4 0 01-4-4v-4h2z"/>
                              </svg>
                            )}
                            {chip.kind === 'ttl' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9"/>
                                <polyline points="12 7 12 12 15 14"/>
                              </svg>
                            )}
                            {chip.kind === 'vlan' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
                                <line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>
                              </svg>
                            )}
                            {chip.kind === 'ip' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/>
                                <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>
                              </svg>
                            )}
                            {chip.label && <span className={styles.prEndChipKey}>{chip.label}</span>}
                            <span className={styles.prEndChipVal}>{chip.value}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            {neighborStatus === 'empty' && (
              <>
                <span className={styles.prEndDim}>
                  No end device responded - the endpoint doesn’t advertise LLDP, or LLDP is disabled on the switch.
                </span>
                <button className={styles.prEndAction} onClick={() => findNeighbor()}>Retry</button>
              </>
            )}
            {neighborStatus === 'error' && (
              <>
                <span className={styles.prEndDim}>End device lookup failed</span>
                <button className={styles.prEndAction} onClick={() => findNeighbor()}>Retry</button>
              </>
            )}
            {neighborStatus === 'idle' && (
              <button className={styles.prEndAction} onClick={() => findNeighbor()}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find end device
              </button>
            )}
          </div>
          )}

          {/* Port-location feedback — standard Yes/No → dropdown of ports + Other# */}
          {!ticketMode && selectedDevice && portNum && (
            <StandardFeedback
              key={`${scanId}:${selectedIdx}:${portNum}:loc`}
              accent={rc}
              prompt={`Port ${portNum}${selectedDevice?.class_name ? ` on ${selectedDevice.class_name}` : ''} - right?`}
              options={Array.from({ length: Math.max(0, selectedDevice?.port_count || 0) }, (_, i) => ({ value: i + 1, label: `Port ${i + 1}` }))}
              otherInput="number"
              answered={answeredKeys.has(`${scanId}:p:${selectedIdx}:${portNum}:loc`) || !!portInfo?._port_shift}
              answeredText="Port number corrected - you set this"
              onYes={() => submitFeedback(true)}
              onSubmit={(v) => submitFeedback(false, { actualPort: parseInt(v, 10) })}
            />
          )}

          {/* Cable-colour feedback — standard Yes/No → colour dropdown + Other */}
          {!ticketMode && portInfo?.status === 'connected' && portInfo?.cable_color && (
            <StandardFeedback
              key={`${scanId}:${selectedIdx}:${portNum}:cable`}
              accent={rc}
              prompt={`Cable colour is ${portInfo.cable_color} - right?`}
              options={CABLE_COLOR_OPTIONS.map(c => ({ value: c, label: c }))}
              otherInput="text"
              answered={answeredKeys.has(`${scanId}:p:${selectedIdx}:${portNum}:cable`)}
              answeredText={`Cable colour: ${portInfo.cable_color} - you set this`}
              onYes={() => submitCableFeedback(true)}
              onSubmit={(v) => submitCableFeedback(false, v)}
            />
          )}

          {/* Jump to another port — optional type switch, then a compact input.
              Switching type (e.g. RJ45 → SFP) re-points the input at that port
              set so the user can locate a different type without going back. */}
          {!ticketMode && selectedDevice && portCatsToShow.length > 1 && (
            <div className={styles.prTypeSwitch}>
              {portCatsToShow.map(opt => {
                const on = portCategory === opt.k;
                const count = portCatCount(selectedDevice, opt.k);
                return (
                  <button
                    key={opt.k}
                    type="button"
                    className={`${styles.portTypeBtn} ${on ? styles.portTypeBtnOn : ''}`}
                    onClick={() => { if (!on) { setPortCategory(opt.k); setNextPort(''); setError(null); } }}
                  >
                    {opt.label}{count > 0 ? ` · ${count}` : ''}
                  </button>
                );
              })}
            </div>
          )}
          {!ticketMode && selectedDevice && (
            <div className={styles.prAnother} style={{ '--ac': rc }}>
              <input
                className={`input ${styles.portInput}`}
                type="text" inputMode="numeric" pattern="[0-9]*"
                style={{ '--focus-color': rc }}
                placeholder={portMaxLimit > 0
                  ? `Another ${portCategory === 'sfp' ? 'SFP' : portCategory === 'console' ? 'console' : portCategory === 'main' ? 'RJ45' : ''} port · 1-${portMaxLimit}`.replace('  ', ' ')
                  : 'Another port #'}
                value={nextPort}
                onChange={e => { setNextPort(sanitizePortInput(e.target.value)); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && nextPort && findAnotherPort()}
              />
              <button
                type="button"
                className={`btn btn-primary ${styles.findBtn}`}
                style={{ '--btn-glow': rc }}
                disabled={!nextPort || loading}
                onClick={() => findAnotherPort()}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find
              </button>
            </div>
          )}
          {loading && (
            <div className={styles.portLoadingRow}>
              <span className={styles.btnSpinner} />
              <span>Locating port…</span>
            </div>
          )}

          {error && (
            <div className={styles.errBox}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          {shareMsg && (
            <div role="status" aria-live="polite" style={{
              position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)',
              zIndex: 10000, maxWidth: '92vw',
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '13px 20px', borderRadius: 12,
              fontSize: '.95rem', fontWeight: 600, color: '#fff',
              background: shareStatus === 'error' ? '#c0392b' : '#1e874b',
              boxShadow: '0 10px 34px rgba(0,0,0,.28)',
            }}>
              {/* Success keeps its tick. The error state deliberately shows NO
                  leading glyph: it used to render a decorative ✕ here, which sat
                  a few pixels from the real dismiss × on the right and read as a
                  second, broken close button ("remove cross mark here when there
                  is error to send report in teams"). The red background already
                  says this failed, so one cross on the toast — the one that
                  actually closes it — is enough. */}
              {shareStatus !== 'error' && (
                <span style={{ fontSize: '1.1rem', lineHeight: 1, flexShrink: 0 }} aria-hidden="true">
                  ✓
                </span>
              )}
              <span style={{ flex: 1, minWidth: 0 }}>{shareMsg}</span>
              {/* A real dismiss control. The ✕ on the left is a status glyph
                  with no handler — testers reasonably read it as a close
                  button and reported it broken. Errors also never cleared
                  themselves (only successes did), so the banner sat there for
                  good until the page was left. */}
              <button
                type="button"
                onClick={() => { setShareStatus('idle'); setShareMsg(null); setShareChannel(null); }}
                aria-label="Dismiss"
                style={{
                  flexShrink: 0, width: 28, height: 28, marginLeft: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  font: 'inherit', fontSize: '1rem', lineHeight: 1,
                  color: '#fff', background: 'rgba(255,255,255,0.18)',
                  border: 0, borderRadius: '50%', cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* Report row — View / Download / Share as labeled chips */}
          <div className={styles.reportRow} style={{ '--ac': rc }}>
            <button className={`${styles.reportChip} ${styles.reportChipView}`}
              data-tour="full-report-btn"
              onClick={ticketMode ? () => setTicketReportOpen(true) : viewReport}
              title="View report">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              View
            </button>
            <div className={styles.shareWrap}>
              <button className={`${styles.reportChip} ${styles.reportChipShare} ${shareStatus === 'sent' ? styles.reportChipSlackSent : ''} ${shareStatus === 'error' ? styles.reportChipSlackErr : ''}`}
                onClick={() => { if (shareStatus !== 'sending') setShareMenuOpen(v => !v); }}
                disabled={shareStatus === 'sending'}
                title="Share report">
                {shareStatus === 'sending' ? (
                  <span className={styles.btnSpinner} />
                ) : shareStatus === 'sent' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                )}
                {shareStatus === 'sending'
                  ? `Sending${shareChannel ? ` to ${shareChannel}` : ''}`
                  : shareStatus === 'sent' ? 'Sent' : 'Share'}
              </button>
              {shareMenuOpen && (
                <>
                  <div className={styles.shareBackdrop} onClick={() => setShareMenuOpen(false)} />
                  <div className={styles.shareMenu} role="menu">
                    {SHARE_CHANNELS.map(ch => (
                      <button key={ch.key}
                        className={styles.shareMenuItem}
                        onClick={() => openShareDialog(ch.key)}
                        role="menuitem"
                        aria-label={ch.label}
                        title={ch.label}>
                        <span className={styles.shareMenuIcon}>{ch.icon}</span>
                        <span>{ch.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Change Device + New Scan sit in the same 4-column row as View + Share. */}
            <button className={styles.reportChip} onClick={() => {
              setPhase('detect');
              setTab('overview');
              setSelectedIdx(null);
              setPortNum(''); setNextPort(''); setPortInfo(null);
              setResultImg(null); setRackImg(null); setPortView('rack');
              setDeviceFbStatus('idle'); setActualDeviceClass(''); setDeviceFbError(null);
              setPortCountFbStatus('idle'); setActualPortCount(''); setPortCountFbError(null);
              setError(null); resetZoom();
              // Land at the top so the device picker / dropdown is in view —
              // otherwise the page stays scrolled to the bottom (where this
              // button lives) and the dropdown appears hidden above the fold.
              if (typeof window !== 'undefined') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="17" width="20" height="4" rx="1"/></svg>
              Change Device
            </button>
            <button className={styles.reportChip} onClick={() => navigate('/scan')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
              New Scan
            </button>
          </div>
        </div>

        {loading && (
          <div className={styles.loadOverlay}>
            <div className={styles.loadCard}>
              <div className={styles.loadRing} style={{ '--c': rc }}><div className={styles.loadRingInner} /></div>
              <p className={styles.loadTitle}>Identifying</p>
              <p className={styles.loadSub}>{buildPortLabel(selectedLabel, selectedDevice?.class_name, nextPort || portNum)}</p>
            </div>
          </div>
        )}

        {shareDialogChannel && (() => {
          const channel = shareDialogChannel;
          const meta = SHARE_CHANNELS.find(c => c.key === channel);
          const title = `Send report via ${meta?.label || channel}`;
          return (
            <div className={styles.shareDialogBackdrop}
                 onClick={(e) => { if (e.target === e.currentTarget) closeShareDialog(); }}
                 onKeyDown={(e) => { if (e.key === 'Escape') closeShareDialog(); }}
                 role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle">
              <div className={styles.shareDialog}>
                <div className={styles.shareDialogHeader}>
                  <span className={styles.shareDialogIcon}>{meta?.icon}</span>
                  <span id="shareDialogTitle" className={styles.shareDialogTitle}>{title}</span>
                  <button type="button" className={styles.shareDialogClose}
                          onClick={closeShareDialog} aria-label="Close">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>

                <form className={styles.shareDialogBody}
                      onSubmit={(e) => { e.preventDefault(); confirmShareSend(); }}>
                  <p className={styles.shareDialogHint}>
                    Enter the recipient for this rack scan report. The address is remembered
                    on this device for next time.
                  </p>

                  <label className={styles.shareDialogLabel} htmlFor="shareEmailInput">
                    Recipient email <span aria-hidden className={styles.shareDialogReq}>*</span>
                  </label>
                  <input
                    id="shareEmailInput"
                    type="email"
                    autoFocus
                    required
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                    placeholder="name@company.com"
                    className={`${styles.shareDialogInput} ${shareEmailErr ? styles.shareDialogInputErr : ''}`}
                    value={shareEmailInput}
                    onChange={(e) => { setShareEmailInput(e.target.value); if (shareEmailErr) setShareEmailErr(null); }}
                  />
                  {shareEmailErr && (
                    <div className={styles.shareDialogFieldErr}>{shareEmailErr}</div>
                  )}

                  <label className={styles.shareDialogLabel} htmlFor="shareNoteInput">
                    {SHARE_NOTE_LABEL[channel]} <span className={styles.shareDialogOpt}>(optional)</span>
                  </label>
                  <textarea
                    id="shareNoteInput"
                    rows={channel === 'outlook' ? 2 : 3}
                    placeholder={SHARE_NOTE_PLACEHOLDER[channel]}
                    className={styles.shareDialogTextarea}
                    value={shareNoteInput}
                    onChange={(e) => setShareNoteInput(e.target.value)}
                  />

                  <div className={styles.shareDialogActions}>
                    <button type="button" className={styles.shareDialogCancel}
                            onClick={closeShareDialog}>Cancel</button>
                    <button type="submit" className={styles.shareDialogSend}
                            style={{ background: '#000', color: '#fff', border: '1px solid #000' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                      Send report
                    </button>
                  </div>
                </form>
              </div>
            </div>
          );
        })()}

        {reportOpen && (
          <div className={styles.reportModalBackdrop}>
            <div className={styles.reportModal}>
              <div className={styles.reportModalHeader}>
                <span className={styles.reportModalTitle}>Scan Report · {scanId}</span>
                <button className={styles.reportModalClose} onClick={() => setReportOpen(false)} aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Close
                </button>
              </div>
              {reportTokenErr ? (
                <div className={styles.errBox} style={{ margin: 20 }}>Could not open report: {reportTokenErr}</div>
              ) : !reportToken ? (
                <div className={styles.portLoadingRow} style={{ padding: 20 }}>Preparing report…</div>
              ) : (
                <iframe className={styles.reportModalFrame} src={reportUrl('html') + reportHash} title="Scan report" />
              )}
            </div>
          </div>
        )}

        {credsOpen && (
          <CredsModal
            initial={switchCreds}
            onCancel={() => { setCredsOpen(false); setPendingConsoleOpen(false); }}
            onSubmit={submitCreds}
          />
        )}

        {consoleOpen && (
          <div className={styles.consoleSheetWrap}>
            <div className={styles.consoleSheetBackdrop} onClick={exitConsole} />
            <div className={styles.consoleSheet}>
              <div className={styles.consoleSheetHandle} />
              <div className={styles.consoleSheetHeader}>
                <div className={styles.consoleSheetTitleWrap}>
                  <span className={styles.consoleSheetTitle}>Switch Console</span>
                  <span className={styles.consoleSheetSub}>
                    {switchCreds.host} · {deriveInterface(portNum)}
                    {consoleRunMs != null && (
                      <span className={styles.timingBadge} style={{ marginLeft: 8 }} title="Time to complete automated console commands">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        Done in {fmtMs(consoleRunMs)}
                      </span>
                    )}
                  </span>
                </div>
                <div className={styles.consoleSheetActions}>
                  <button
                    className={styles.consoleSheetDone}
                    onClick={finishConsole}
                    disabled={consoleEntries.length === 0}
                    title="Show consolidated report for this port">
                    Done
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  <button className={styles.consoleSheetExit} onClick={exitConsole}>
                    Exit
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              </div>

              {/* ── Intent picker bar — user-driven, no automation ── */}
              <div className={styles.intentBar}>
                <select
                  className={styles.intentSelect}
                  value={selectedIntentId}
                  onChange={e => {
                    const id = e.target.value;
                    setSelectedIntentId(id);
                    // Run immediately on selection — users expect picking an
                    // option to query the switch, not to require a second click
                    // on the separate Run button.
                    if (id && consoleStatus !== 'running-manual') runIntent(id);
                  }}
                  disabled={consoleStatus === 'running-manual' || consoleIntents.length === 0}
                  aria-label="Choose what to look up">
                  <option value="">Choose what to look up…</option>
                  {consoleIntents.map(it => (
                    <option key={it.id} value={it.id}>{it.label}</option>
                  ))}
                </select>
                <button
                  className={styles.intentRunBtn}
                  onClick={() => selectedIntentId && runIntent(selectedIntentId)}
                  disabled={!selectedIntentId || consoleStatus === 'running-manual'}>
                  {consoleStatus === 'running-manual'
                    ? <span className={styles.btnSpinner} />
                    : <>Run <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></>}
                </button>
              </div>

              <div className={styles.consoleTerminal} ref={consoleTermRef}>
                {consoleEntries.length === 0 && consoleStatus !== 'running-manual' && (
                  <div className={styles.consoleEmpty}>
                    Pick an option above to query the switch - it runs as soon as
                    you choose. Or type a command below.
                  </div>
                )}

                {/* Result list — show only the friendly label + the cleaned
                    output. The raw shell command is intentionally hidden. */}
                {consoleEntries.map((entry, i) => (
                  <div key={`e-${i}`} className={styles.consoleEntry}>
                    <div className={styles.consoleEntryHead}>
                      <span className={styles.consolePrompt}>▸</span>
                      <span className={styles.intentLabel}>{entry.name || 'Result'}</span>
                    </div>
                    {entry.error
                      ? <pre className={`${styles.consoleOut} ${styles.consoleOutErr}`}>{entry.error}</pre>
                      : <pre className={styles.consoleOut}>{entry.output || '(no output)'}</pre>}
                  </div>
                ))}

                {consoleStatus === 'running-manual' && (
                  <div className={styles.consoleTermLine}>
                    <span className={styles.consolePrompt}>▸</span>
                    <span className={styles.consoleHint}>Running…</span>
                  </div>
                )}
              </div>

              {canRunFreeformCmd && (
                <div className={styles.consoleInputRow}>
                  <span className={styles.consolePrompt}>$</span>
                  <input className={styles.consoleInput}
                    type="text"
                    placeholder="Or type any command (e.g. show version)"
                    value={manualCmd}
                    onChange={e => setManualCmd(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && manualCmd.trim() && runManualCommand()}
                    disabled={consoleStatus === 'running-manual'} />
                  <button className={styles.consoleSendBtn}
                    onClick={runManualCommand}
                    disabled={!manualCmd.trim() || consoleStatus === 'running-auto' || consoleStatus === 'running-manual'}>
                    Run
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ticket-mode simplified report modal — just the essentials */}
        {ticketReportOpen && ticketMode && ticket && (
          <div
            onClick={() => setTicketReportOpen(false)}
            style={{
              position:'fixed', inset:0, zIndex:9999,
              background:'rgba(0,0,0,0.75)',
              display:'flex', alignItems:'center', justifyContent:'center',
              padding:16,
            }}>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                width:'min(560px, 100%)',
                maxHeight:'90vh',
                overflow:'auto',
                background:'#ffffff',
                border:'1px solid rgba(0,0,0,0.12)',
                borderRadius:14,
                padding:18,
                color:'#1c1c1c',
              }}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
                <div>
                  <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.08em',color:'#000000',textTransform:'uppercase'}}>Incident Report</div>
                  <div style={{fontSize:18,fontWeight:600,marginTop:2}}>{ticket.incident_number}</div>
                </div>
                <button onClick={() => setTicketReportOpen(false)} style={{background:'none',border:'none',color:'var(--muted, #474747)',cursor:'pointer',fontSize:20,lineHeight:1}}>×</button>
              </div>

              {/* Incident */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>Incident</div>
                <div style={{fontSize:14,lineHeight:1.4}}>{ticket.short_description}</div>
                <div style={{fontSize:12,color:'var(--muted, #474747)',marginTop:4}}>
                  {ticket.priority} · opened {ticket.opened_at || '?'}
                </div>
              </div>

              {/* Image */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>Image</div>
                {rackImg || resultImg ? (
                  <AssetImg src={rackImg || resultImg} alt="Located port" style={{width:'100%',maxHeight:280,objectFit:'contain',borderRadius:8,border:'1px solid rgba(255,255,255,0.08)'}}/>
                ) : <div style={{fontSize:12,color:'var(--muted, #474747)'}}>not available</div>}
              </div>

              {/* Port located */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>Port Located</div>
                <div style={{fontSize:14}}>
                  <strong>{ticket.target?.device}</strong> @ <strong>{ticket.cmdb?.interface_alias || `port ${ticket.target?.port}`}</strong>
                </div>
                <div style={{fontSize:12,color:'var(--muted, #474747)',marginTop:2}}>
                  {ticket.cmdb?.rack_name} · {ticket.cmdb?.model || '?'} · mgmt {ticket.cmdb?.mgmt_ip || '?'}
                </div>
              </div>

              {/* Output */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>Output</div>
                {liveSnapshot?.ok ? (
                  <div style={{fontSize:13,lineHeight:1.6,fontFamily:'ui-monospace, monospace',background:'#ffffff',border:'1px solid rgba(0,0,0,0.08)',color:'#1c1c1c',padding:10,borderRadius:6}}>
                    <div>link        : <strong style={{color: liveSnapshot.link_active ? '#1c1c1c' : '#474747'}}>{liveSnapshot.link_active ? 'active' : 'idle'}</strong></div>
                    <div>neighbor    : {liveSnapshot.has_neighbor ? (liveSnapshot.neighbor?.sysname || 'present') : 'none'}</div>
                    {liveSnapshot.neighbor?.port_id && <div>remote port : {liveSnapshot.neighbor.port_id}</div>}
                    {liveSnapshot.neighbor?.mgmt_ip && <div>remote mgmt : {liveSnapshot.neighbor.mgmt_ip}</div>}
                    <div>macs        : {liveSnapshot.mac_count}{liveSnapshot.first_mac ? ` (${liveSnapshot.first_mac})` : ''}</div>
                    <div>method      : {liveSnapshot.neighbor_method}</div>
                    <div>as of       : {new Date(liveSnapshot.as_of).toLocaleTimeString()}</div>
                  </div>
                ) : liveSnapshot ? (
                  <div style={{fontSize:12,color:'#474747'}}>Live sample failed: {liveSnapshot.error}</div>
                ) : (
                  <div style={{fontSize:12,color:'var(--muted, #474747)'}}>no live sample yet</div>
                )}
              </div>

              {/* Suggestions */}
              <div>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #474747)',textTransform:'uppercase',marginBottom:4}}>Suggestions</div>
                <div style={{fontSize:13,lineHeight:1.5}}>
                  {(() => {
                    if (liveResolvedAt) return <span style={{color:'#1c1c1c'}}>✓ Port is active now - cable was attached at {new Date(liveResolvedAt).toLocaleTimeString()}. Incident likely resolved; verify with monitoring, then close the ticket.</span>;
                    if (liveSnapshot?.link_active) return <span style={{color:'#1c1c1c'}}>Port is currently active. Issue may be intermittent - watch for re-flaps over the next few minutes.</span>;
                    if (liveSnapshot?.ok && !liveSnapshot.link_active) return <span>No traffic on this port right now. Verify the cable is plugged in on both ends, check the far-end device power/NIC status, then re-monitor.</span>;
                    if (liveSnapshot && !liveSnapshot.ok) return <span>Cannot reach the switch over SSH to verify. Check mgmt connectivity to {ticket.cmdb?.mgmt_ip || 'the switch'}.</span>;
                    return <span style={{color:'var(--muted, #474747)'}}>Waiting for first live sample.</span>;
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {portReportOpen && portReport && (
          <PortReportModal report={portReport} onClose={() => setPortReportOpen(false)} />
        )}

        {switchInfoOpen && (
          <SwitchInfoModal
            status={switchInfoStatus}
            info={switchInfoData}
            raw={switchInfoRaw}
            error={switchInfoError}
            host={switchCreds.host}
            vendor={switchCreds.vendor}
            specs={switchSpecs}
            specsStatus={switchSpecsStatus}
            specsError={switchSpecsError}
            firmware={switchFirmware}
            firmwareStatus={switchFirmwareStatus}
            firmwareError={switchFirmwareError}
            onClose={() => setSwitchInfoOpen(false)}
            onRetry={fetchSwitchInfo}
          />
        )}
      </div>
    );
  }

  // ── Detect view ──────────────────────────────────────────
  return (
    <div className={`page page-full ${styles.results}`} data-tab={tab}
         data-embedded={embeddedProp ? 'true' : undefined}
         data-device={selectedIdx ? 'sel' : 'none'}
         /* No tab bar yet → no space reserved for one. Same condition the bar
            itself renders on, so the two can never disagree. */
         data-tabs={(!isDesktop && !embeddedProp && (tab !== 'overview' || portMode)) ? 'some' : 'none'}>
      <div className={styles.amb} />

      {!embeddedProp && (
      <header className={styles.header}>
        {/* The one back control the app has: a filled 38px square, same mark,
            same place. This header used the global ghost icon button, which is
            a circle — two different back buttons on adjacent screens. */}
        <BackButton
          onBack={handleHeaderBack}
          data-tour-bypass={tourActive ? 'true' : undefined}
        />
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>{
            tab === 'switches' ? 'Switches'
            : tab === 'topology' ? 'Topology'
            : tab === 'network'  ? 'Discovery'
            : tab === 'drift'    ? 'Port History & Drift'
            :                       'Scan Results'
          }</h2>
          <div className={styles.headerMetaRow}>
            <span className={styles.headerMono}>
              {rackId || scanId}
            </span>
          </div>
        </div>
        <div style={{ width: 40 }} />
      </header>
      )}

      {/* Rack-tab strip — only renders when this rack is part of a multi-rack scan */}
      {!embeddedProp && <RackTabs rackId={rackId || scanId} />}

      {/* The rack's tabs appear once there is a job in progress, not before.
          Straight after a scan the page is the photograph and one question —
          read the switches, or look at a port — and a row of tabs under it
          would be five more answers to a question nobody asked yet. Choosing
          either one brings the tabs in, and they stay for the rest of the rack. */}
      {!isDesktop && !embeddedProp && (tab !== 'overview' || portMode) && (
        <ScanTabBar
          rackId={rackId}
          activeTab={tab}
          onTabChange={handleTabChange}
          badges={{
            ports: devices.filter(d => d.class_name === 'Switch').reduce((s, d) => s + (d.port_count || 0), 0) || undefined,
          }}
        />
      )}

      {tab === 'overview' && (<>
      {qualityWarning && !warningDismissed && (
        <div className={styles.qualityModalBackdrop}>
          <div className={styles.qualityModal}>
            <div className={styles.qualityModalIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h3 className={styles.qualityModalTitle}>Image quality warning</h3>
            <p className={styles.qualityModalMsg}>
              {qualityWarningMsg || 'Image may not be ideal - results may be less accurate.'}
            </p>
            <ul className={styles.qualityModalTips}>
              <li>Stand directly in front of the rack - not at an angle.</li>
              <li>Keep the camera level with the middle of the rack.</li>
              <li>Make sure the full rack fits inside the frame.</li>
            </ul>
            <div className={styles.qualityModalActions}>
              <button className={styles.qualityRetake} onClick={() => navigate('/scan')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/>
                </svg>
                Retake
              </button>
              <button className={styles.qualityProceed} onClick={() => setWarningDismissed(true)}>
                Proceed anyway
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hero image ── */}
      <div className={styles.heroWrap} data-tour="rack-image">
        <div className={styles.zoomViewport}
          style={{ touchAction: zoom > 1 ? 'none' : 'pan-y' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
        >
          <div className={styles.heroImgWrap} style={focusFx || { transform: imageTransform, cursor: cursorStyle }}>
            <AssetImg path={heroImgPath} src={heroImgSrc} alt="Rack scan" className={styles.heroImg}
              style={{ touchAction: zoom > 1 ? 'none' : 'pan-y' }}
              onLoad={e => setImgNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
              draggable="false"
            />
            {imgNat && (
              <svg className={styles.devOverlay} viewBox={`0 0 ${imgNat.w} ${imgNat.h}`} preserveAspectRatio="xMidYMid meet">
                <defs>
                  <filter id="neon">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                {/* Rect + label chip per detected device.
                    Hero overlay shows every real detection (switches, patch
                    panels, PDUs, servers, etc.) so the user sees the full
                    coverage at a glance. Placeholder Empty / Unidentified /
                    Closed-Unit boxes are hidden — they're rack-slot fillers,
                    not actionable. The overlay is purely visual: device
                    selection happens through the dropdown below, not by
                    tapping the image. */}
                {effectiveDevices.map((dev, i) => {
                  if (!dev?.box || HIDDEN_DEVICE_TYPES.has(dev.class_name)) return null;
                  const idx = i + 1;
                  const isSel = selectedIdx === idx;
                  if (isSel) return null; // selected rendered last for z-order
                  // In focus mode, only the selected device is shown — drop
                  // every other overlay so the user gets a clean drill-in view.
                  if (focusMode) return null;
                  const [bx1, by1, bx2, by2] = dev.box;
                  const w = bx2 - bx1, h = by2 - by1;
                  const color = getColor(dev.class_name);
                  const lbl = labels[i] || '';
                  // Chip size scales with image resolution so it reads on any rack size
                  const chipH = Math.max(18, Math.min(44, h * 0.42));
                  const chipPadX = chipH * 0.6;
                  const chipW = Math.max(chipH * 2.2, lbl.length * chipH * 0.45 + chipPadX * 2);
                  const chipX = bx1 + 4;
                  const chipY = by1 + 4;
                  const poly = dev.mask_polygon;
                  return (
                    <g
                      key={idx}
                      className={styles.devPickGroup}
                      onClick={() => setSelectedIdx(idx)}
                      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    >
                      {poly ? (
                        <polygon
                          points={poly.map(p => `${p[0]},${p[1]}`).join(' ')}
                          className={styles.devPickRect}
                          style={{ stroke: color, fill: 'transparent', pointerEvents: 'all' }}
                        />
                      ) : (
                        <rect
                          x={bx1} y={by1} width={w} height={h} rx="4"
                          className={styles.devPickRect}
                          style={{ stroke: color, fill: 'transparent', pointerEvents: 'all' }}
                        />
                      )}
                      {lbl && (
                        <g className={styles.devPickChip}>
                          <rect
                            x={chipX} y={chipY}
                            width={chipW} height={chipH}
                            rx={chipH / 2}
                            fill="rgba(0,0,0,0.88)"
                            stroke={color}
                            strokeWidth="2"
                          />
                          <text
                            x={chipX + chipW / 2}
                            y={chipY + chipH / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="#ffffff"
                            fontFamily="var(--mono, monospace)"
                            fontWeight="800"
                            fontSize={chipH * 0.56}
                            paintOrder="stroke"
                            stroke="rgba(0,0,0,0.55)"
                            strokeWidth="2"
                            strokeLinejoin="round"
                          >
                            {lbl}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {selectedDevice && (() => {
                  const [bx1, by1, bx2, by2] = selectedDevice.box;
                  const w = bx2 - bx1, h = by2 - by1;
                  const c = 40;
                  const poly = selectedDevice.mask_polygon;
                  return (
                    <g>
                      {/* Bright red neon border — silhouette when seg mask is
                          available, falls back to bbox rect otherwise. Click
                          handler is on the outline shape so the corner
                          brackets (always bbox-based) stay decorative. */}
                      {poly ? (
                        <polygon points={poly.map(p => `${p[0]},${p[1]}`).join(' ')}
                          fill="#2f6bd8" fillOpacity={0.26} stroke="#2f6bd8" strokeWidth="4" filter="url(#neon)"
                          className={styles.devNeonBorder}
                          style={{ cursor: focusMode ? 'zoom-out' : 'zoom-in', pointerEvents: 'auto' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusMode(m => !m);
                          }}
                        />
                      ) : (
                        <rect x={bx1} y={by1} width={w} height={h} rx="6"
                          fill="#2f6bd8" fillOpacity={0.26} stroke="#2f6bd8" strokeWidth="4" filter="url(#neon)"
                          className={styles.devNeonBorder}
                          style={{ cursor: focusMode ? 'zoom-out' : 'zoom-in', pointerEvents: 'auto' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusMode(m => !m);
                          }}
                        />
                      )}
                      {/* Red corner brackets */}
                      <g filter="url(#neon)" className={styles.devNeonCorners}>
                        <path d={`M${bx1},${by1+c} L${bx1},${by1} L${bx1+c},${by1}`} fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx2-c},${by1} L${bx2},${by1} L${bx2},${by1+c}`} fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx1},${by2-c} L${bx1},${by2} L${bx1+c},${by2}`} fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx2-c},${by2} L${bx2},${by2} L${bx2},${by2-c}`} fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
                      </g>
                      {/* Name chip for the selected device — the per-device loop
                          above skips the selected one (rendered here for z-order),
                          so without this its label disappears behind the shade. */}
                      {(() => {
                        const lbl = labels[selectedIdx - 1] || '';
                        if (!lbl) return null;
                        const chipH = Math.max(18, Math.min(44, h * 0.42));
                        const chipPadX = chipH * 0.6;
                        const chipW = Math.max(chipH * 2.2, lbl.length * chipH * 0.45 + chipPadX * 2);
                        const chipX = bx1 + 4;
                        const chipY = by1 + 4;
                        return (
                          <g>
                            <rect x={chipX} y={chipY} width={chipW} height={chipH} rx={chipH / 2}
                              fill="rgba(0,0,0,0.9)" stroke="#2f6bd8" strokeWidth="2.5" />
                            <text x={chipX + chipW / 2} y={chipY + chipH / 2}
                              textAnchor="middle" dominantBaseline="central"
                              fill="#ffffff" fontFamily="var(--mono, monospace)" fontWeight="800"
                              fontSize={chipH * 0.56} paintOrder="stroke"
                              stroke="rgba(0,0,0,0.55)" strokeWidth="2" strokeLinejoin="round">
                              {lbl}
                            </text>
                          </g>
                        );
                      })()}
                    </g>
                  );
                })()}
              </svg>
            )}
          </div>
        </div>
        {focusMode ? (
          <button
            type="button"
            className={styles.focusBack}
            onClick={() => setFocusMode(false)}
            aria-label="Back to full rack"
            title="Back to full rack"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            <span>Back to rack</span>
          </button>
        ) : (
          <div className={styles.zoomControls}>
            <button type="button" className={styles.zoomButton} onClick={zoomOut} aria-label="Zoom out">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="16.5" y1="16.5" x2="21" y2="21" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
            <button type="button" className={styles.zoomButton} onClick={zoomIn} aria-label="Zoom in">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="16.5" y1="16.5" x2="21" y2="21" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
          </div>
        )}
        {analysisTimings?.total_ms != null && (
          <span className={`${styles.timingBadge} ${styles.heroTiming}`} title="Time from image upload to detect mode">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Done in {fmtMs(analysisTimings.total_ms)}
          </span>
        )}
        {/* scan line animation */}
        <div className={styles.scanLine} />
        {/* corner HUD */}
        <span className={`${styles.hc} ${styles.hcTL}`} />
        <span className={`${styles.hc} ${styles.hcTR}`} />
        <span className={`${styles.hc} ${styles.hcBL}`} />
        <span className={`${styles.hc} ${styles.hcBR}`} />
        {/* bottom fade */}
        <div className={styles.heroFade} />
        {/* info badge */}
        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} />
          <span className={styles.heroBadgeTxt}>ANALYZED</span>
        </div>
      </div>

      {/* Selected device label — plain subtle-black header, no class-colour
          accent (kept monochrome per the user's white-focused brief). */}
      {selectedDevice && (
        <div className={styles.heroLabel}>
          <span className={styles.heroLabelVal}>{selectedLabel}</span>
          <span className={styles.heroLabelType}>{selectedDevice.class_name}</span>
        </div>
      )}

      {/* ── Action sheet ── */}
      <div className={styles.sheet}>

        {/* What next. After seeing the rack there are two things to do: read
            its switches, or look at one port. Nothing else is on screen until
            one of them is chosen — the picker used to sit here open at the
            same time, which made the choice above it meaningless. */}
        {/* The photograph, and the two ways on. Nothing else: the rack is on
            screen above, so a tally of it and a list of what is in it were
            both saying again what the picture already says. */}
        {!ticketMode && phase !== 'all' && !portMode && (
          <div className={styles.stepChoices}>
            <button
              type="button"
              className={`${styles.stepChoice} ${styles.stepChoicePrimary}`}
              onClick={() => navigate(`/results/${encodeURIComponent(urlRackId || rackId)}/network`)}
            >
              Analyse the network
            </button>
            <button
              type="button"
              className={`${styles.stepChoice} ${styles.stepChoiceSecondary}`}
              onClick={() => { setPortMode(true); setDeviceListOpen(true); }}
            >
              Look up a port
            </button>
          </div>
        )}

        {/* Chosen "Select a port": the picker, and the way back to the choice. */}
        {!ticketMode && phase !== 'all' && portMode && (
          <button
            type="button"
            className={styles.stepBack}
            onClick={() => { setPortMode(false); setDeviceListOpen(false); setSelectedIdx(null); }}
          >
            ← Back
          </button>
        )}

        {/* Manual-mode device dropdown — alternative to tapping the hero
            rectangle (mobile-friendly). Hidden in ticket-mode and when the
            all-devices view is up. */}
        {!ticketMode && phase !== 'all' && portMode && (() => {
          const pickables = effectiveDevices
            .map((dev, i) => ({ dev, idx: i + 1, label: labels[i] || `Device ${i + 1}` }))
            .filter(({ dev }) => isDevicePickable(dev));
          if (pickables.length === 0) {
            // When the scan already worked out WHY nothing was found — a rack
            // hidden behind cable bundles, a shot taken at too steep an angle —
            // say that. "No devices detected" on a photo where the rack is
            // plainly visible reads as the app being broken, and gives the user
            // nothing to do differently. The reason was already being sent to
            // this page and thrown away.
            return (
              <div className={styles.deviceEmpty}>
                {qualityWarningMsg
                  ? <>No devices could be read from this photo. {qualityWarningMsg}</>
                  : <>No devices detected in this rack. If the rack is clearly visible,
                      try again from straight on with the whole rack in frame.</>}
              </div>
            );
          }
          const pickDevice = (idx) => {
            setSelectedIdx(idx);
            setPortNum(''); setPortInfo(null); setError(null);
            setDeviceFbStatus('idle');
            setActualDeviceClass('');
            setDeviceFbError(null);
            setPortCountFbStatus('idle');
            setActualPortCount('');
            setPortCountFbError(null);
            setDeviceListOpen(false);
          };
          const chosen = pickables.find((p) => p.idx === selectedIdx) || null;
          const detailFor = (dev) => (isPdu(dev) ? powerSummary(dev) : portBreakdown(dev)) || '';

          return (
            <div className={styles.devicePicker} data-tour="device-picker">
              <span className={styles.devicePickerLabel}>Device</span>

              {/* A listbox, not a native <select>.
                  The native control's popup is drawn by the OS: on Android it
                  is a full-bleed list in the system font with no room to
                  breathe, and every option here is three facts joined by
                  middots — "U01-SW01 · switch · 24 RJ45" — which that popup
                  truncates. Testers read the result as broken. Rendering the
                  list ourselves lets each device be a row with its identifier
                  on one line and its detail beneath, in the app's own type. */}
              <button
                type="button"
                className={styles.devicePickerTrigger}
                aria-haspopup="listbox"
                aria-expanded={deviceListOpen}
                onClick={() => setDeviceListOpen((o) => !o)}
              >
                <span className={styles.devicePickerValue}>
                  {chosen
                    ? <><span className={styles.devicePickerValueId}>{chosen.label}</span>
                        <span className={styles.devicePickerValueSub}>{chosen.dev.class_name}</span></>
                    : <span className={styles.devicePickerPlaceholder}>Pick a device, or tap one in the image</span>}
                </span>
                <svg className={styles.devicePickerCaret} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {/* Portalled to <body>, and a sheet rather than a dropdown
                  anchored under the trigger. The picker lives inside .sheet,
                  which is an `overflow-y: auto` scroll container — an absolutely
                  positioned list would be clipped by it, which is the same trap
                  the native <select> was avoiding by handing its popup to the
                  OS. A sheet also gives the list the room the tester asked for:
                  margins, full-width rows, and the app's own type. */}
              {deviceListOpen && createPortal(
                <div className={styles.devicePickerBackdrop} onClick={() => setDeviceListOpen(false)}>
                  <div
                    className={styles.devicePickerSheet}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Choose a device"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className={styles.devicePickerSheetHead}>
                      <span className={styles.devicePickerSheetTitle}>Device</span>
                      <button
                        type="button"
                        className={styles.devicePickerSheetClose}
                        onClick={() => setDeviceListOpen(false)}
                        aria-label="Close"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <ul className={styles.devicePickerList} role="listbox" aria-label="Devices in this rack">
                      {pickables.map(({ dev, idx, label }) => {
                        const detail = detailFor(dev);
                        return (
                          <li key={idx}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={idx === selectedIdx}
                              className={`${styles.devicePickerOption} ${idx === selectedIdx ? styles.devicePickerOptionOn : ''}`}
                              onClick={() => pickDevice(idx)}
                            >
                              <span className={styles.devicePickerOptionId}>{label}</span>
                              <span className={styles.devicePickerOptionMeta}>
                                {dev.class_name}{detail ? ` · ${detail}` : ''}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {chosen && (
                      <button
                        type="button"
                        className={styles.devicePickerClear}
                        onClick={() => { setSelectedIdx(null); setPortNum(''); setPortInfo(null); setError(null); setDeviceListOpen(false); }}
                      >
                        Clear selection
                      </button>
                    )}
                  </div>
                </div>,
                document.body,
              )}
            </div>
          );
        })()}

        {selectedDevice && isPdu(selectedDevice) && (
          <div className={styles.portCard} style={{ '--accent': selColor }}>
            <div className={styles.portCardTop}>
              <div>
                <p className={styles.portCardTitle}>Power</p>
                <p className={styles.portCardSub}>
                  {selectedDevice.power_total > 0
                    ? `${selectedDevice.power_total} outlets · ${selectedDevice.power_connected || 0} in use · ${selectedDevice.power_empty || 0} free`
                    : 'No power outlets detected'}
                </p>
              </div>
              <span
                className={styles.portCardLabel}
                style={{ color: selectedDevice.powered ? '#16a34a' : '#dc2626' }}
              >
                {selectedDevice.powered ? '● Powered' : '○ No power'}
              </span>
            </div>
          </div>
        )}

        {selectedDevice && !isPdu(selectedDevice) && (
          <div className={styles.portCard} style={{ '--accent': selColor }}>
            {/* One line says everything: what to type and how many there are.
                The instruction that used to sit in its own box, and the single
                port-type pill, are folded into it — on a phone the card was
                taller than the photo it points at. */}
            <div className={styles.portCardTop}>
              <div>
                <p className={styles.portCardTitle}>Find a port</p>
                <p className={styles.portCardSub}>
                  {portMaxLimit > 0
                    ? `Type 1 to ${portMaxLimit}${portCatsToShow.length === 1 ? ` · ${portCatsToShow[0].label}` : ''}`
                    : 'Confirm how many ports this device has first'}
                </p>
              </div>
              {portLabel && (
                <span className={styles.portCardLabel} style={{ color: selColor }}>
                  {portLabel}
                </span>
              )}
            </div>
            {/* Port type — RJ45 / SFP / Console / USB — only when there is a
                choice to make. Sent as port_category so the pipeline
                highlights the right port set. */}
            {portCatsToShow.length > 1 && (
            <div className={styles.portTypeRow}>
              {portCatsToShow.map(opt => {
                const on = portCategory === opt.k;
                const count = portCatCount(selectedDevice, opt.k);
                return (
                  <button
                    key={opt.k}
                    type="button"
                    onClick={() => setPortCategory(opt.k)}
                    className={`${styles.portTypeBtn} ${on ? styles.portTypeBtnOn : ''}`}
                  >
                    {opt.label}{count > 0 ? ` · ${count}` : ''}
                  </button>
                );
              })}
            </div>
            )}
            <div className={styles.portInputRow} data-tour="port-input-row">
              <input
                className={`input ${styles.portInput}`}
                type="text" inputMode="numeric" pattern="[0-9]*"
                style={{ '--focus-color': selColor }}
                placeholder={portMaxLimit > 0 ? `1-${portMaxLimit}` : 'Port #'}
                value={portNum}
                onChange={e => { setPortNum(sanitizePortInput(e.target.value)); setPortInfo(null); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && portNum && findPort()}
                autoFocus
              />
              <button
                type="button"
                data-tour="find-port-btn"
                className={`btn btn-primary ${styles.findBtn}`}
                style={{ '--btn-glow': selColor }}
                disabled={!portNum || loading}
                onClick={() => findPort()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find Port
              </button>
            </div>
            {loading && (
              <div className={styles.portLoadingRow}>
                <span className={styles.btnSpinner} />
                <span>Locating port…</span>
              </div>
            )}
          </div>
        )}

        {/* Device-classification feedback — standard Yes/No → type dropdown + Other */}
        {selectedDevice && (
          <StandardFeedback
            key={`${scanId}:${selectedIdx}:class`}
            accent={selColor}
            prompt={`Detected as ${selectedDevice.class_name} - right?`}
            options={DEVICE_CLASS_OPTIONS.map(c => ({ value: c, label: c }))}
            otherInput="text"
            answered={answeredKeys.has(`${scanId}:d:${selectedIdx}:class`) || selectedDevice.class_name_source === 'user_corrected'}
            answeredText={`Device: ${selectedDevice.class_name} - you set this`}
            onYes={() => submitDeviceFeedback(true)}
            onSubmit={(v) => submitDeviceFeedback(false, v)}
          />
        )}

        {/* Port-count feedback — shown independently once the device feedback is
            no longer visible ('hidden' or 'submitted'). Using both states makes
            the chain robust even if the device fb is skipped. PDUs have power
            outlets, not RJ45 ports, so the "Detected N RJ45 ports" confirmation
            is irrelevant for them — the Power card already summarises outlets. */}
        {/* Port-count feedback — standard Yes/No → count dropdown + Other#. Shown
            after the device-class question is answered (keeps it to one prompt at
            a time). PDUs have power outlets, not RJ45 ports, so it's skipped. */}
        {selectedDevice && !isPdu(selectedDevice)
          && (answeredKeys.has(`${scanId}:d:${selectedIdx}:class`) || selectedDevice.class_name_source === 'user_corrected') && (
          <StandardFeedback
            key={`${scanId}:${selectedIdx}:count`}
            accent={selColor}
            prompt={(() => {
              const rj = selectedDevice.port_count ?? 0;
              const total = totalPortCount(selectedDevice);
              const breakdown = portBreakdown(selectedDevice);
              if (total > rj && breakdown) {
                return `Detected ${total} total port${total === 1 ? '' : 's'} (${breakdown.replace(/ · /g, ', ')}) - right?`;
              }
              return `Detected ${rj} RJ45 port${rj === 1 ? '' : 's'} - right?`;
            })()}
            options={[8, 12, 16, 24, 48].map(n => ({ value: n, label: `${n} ports` }))}
            otherInput="number"
            answered={answeredKeys.has(`${scanId}:d:${selectedIdx}:count`)}
            answeredText="Port count corrected - you set this"
            onYes={() => submitPortCountFeedback(true)}
            onSubmit={(v) => submitPortCountFeedback(false, parseInt(v, 10))}
          />
        )}

        {error && (
          <div className={styles.errBox}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}
      </div>
      </>)}

      {/* ── Tab: Ports ── */}
      {/* ── Tab: Topology ── */}
      {tab === 'topology' && (
        <div className={styles.tabContent}>
          <TopologyContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Network ── */}

      {/* ── Tab: Switches ── */}
      {tab === 'switches' && (
        <div className={styles.tabContent}>
          <SwitchInfoContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Drift (continuous SSH telemetry from monitored switches) ── */}
      {tab === 'drift' && (
        <div className={styles.tabContent} style={{ minHeight: '60vh', padding: '20px 24px' }}>
          <h2 style={{
            margin: '0 0 12px',
            fontSize: '1.4rem',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: 'var(--t1, #1c1c1c)',
          }}>
            Port history &amp; drift
          </h2>
          <p style={{
            margin: '0 0 20px',
            fontSize: '.88rem',
            color: 'var(--t2, #474747)',
          }}>
            Live port state, VLAN and link-flap tracking across this rack.
          </p>
          <PortHistoryContent rackId={urlRackId || rackId || scanId} />
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div className={styles.loadOverlay}>
          <div className={styles.loadCard}>
            <div className={styles.loadRing} style={{ '--c': selColor }}>
              <div className={styles.loadRingInner} />
            </div>
            <p className={styles.loadTitle}>Identifying</p>
            <p className={styles.loadSub}>{buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum)}</p>
          </div>
        </div>
      )}

      {reportOpen && (
        <div className={styles.reportModalBackdrop}>
          <div className={styles.reportModal}>
            <div className={styles.reportModalHeader}>
              <span className={styles.reportModalTitle}>Scan Report · {scanId}</span>
              <button className={styles.reportModalClose} onClick={() => setReportOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Close
              </button>
            </div>
            {reportTokenErr ? (
                <div className={styles.errBox} style={{ margin: 20 }}>Could not open report: {reportTokenErr}</div>
              ) : !reportToken ? (
                <div className={styles.portLoadingRow} style={{ padding: 20 }}>Preparing report…</div>
              ) : (
                <iframe className={styles.reportModalFrame} src={reportUrl('html') + reportHash} title="Scan report" />
              )}
          </div>
        </div>
      )}

      {devOpen && (
        <div className={styles.diagPanel}>
          <div className={styles.diagHeader}>
            <span className={styles.diagTitle}>Diagnostics</span>
            <button className={styles.diagClose} onClick={() => setDevOpen(false)} aria-label="Close diagnostics">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className={styles.diagSection}>
            <div className={styles.diagSectionLabel}>Image → Detect</div>
            {analysisTimings ? (
              <>
                {analysisTimings.cached && <div className={styles.diagRow}><span>cache</span><span className={styles.diagVal}>HIT</span></div>}
                <div className={styles.diagRow}><span>normalize</span><span className={styles.diagVal}>{fmtMs(analysisTimings.normalize_ms)}</span></div>
                <div className={styles.diagRow}><span>quality_check</span><span className={styles.diagVal}>{fmtMs(analysisTimings.quality_check_ms)}</span></div>
                <div className={styles.diagRow}><span>pipeline</span><span className={styles.diagVal}>{fmtMs(analysisTimings.pipeline_ms)}</span></div>
                <div className={`${styles.diagRow} ${styles.diagRowTotal}`}><span>total</span><span className={styles.diagVal}>{fmtMs(analysisTimings.total_ms)}</span></div>
              </>
            ) : (
              <div className={styles.diagEmpty}>No timing data</div>
            )}
          </div>

          {phase === 'port' && (
            <div className={styles.diagSection}>
              <div className={styles.diagSectionLabel}>Device + Port → Result</div>
              {portTimings ? (
                <>
                  <div className={styles.diagRow}><span>pipeline</span><span className={styles.diagVal}>{fmtMs(portTimings.pipeline_ms)}</span></div>
                  <div className={`${styles.diagRow} ${styles.diagRowTotal}`}><span>total</span><span className={styles.diagVal}>{fmtMs(portTimings.total_ms)}</span></div>
                </>
              ) : (
                <div className={styles.diagEmpty}>No port detection yet</div>
              )}
            </div>
          )}

          {selectedDevice && (
            <div className={styles.diagSection}>
              <div className={styles.diagSectionLabel}>Confidences</div>
              <div className={styles.diagRow}><span>device class</span><span className={styles.diagVal}>{fmtPct(selectedDevice.confidence)}</span></div>
              {portInfo && (
                <>
                  <div className={styles.diagRow}><span>port detection</span><span className={styles.diagVal}>{fmtPct(portInfo.confidence)}</span></div>
                  {portInfo.cable_confidence != null && (
                    <div className={styles.diagRow}><span>cable color</span><span className={styles.diagVal}>{fmtPct(portInfo.cable_confidence)}</span></div>
                  )}
                  {portInfo.port_type_confidence != null && (
                    <div className={styles.diagRow}><span>port type</span><span className={styles.diagVal}>{fmtPct(portInfo.port_type_confidence)}</span></div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
