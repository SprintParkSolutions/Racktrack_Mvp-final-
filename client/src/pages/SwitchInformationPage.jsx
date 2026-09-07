import { useCallback, useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSmartBack } from '../hooks/useSmartBack';
import styles from './SpecificationsPage.module.css';
import desk from './SwitchInformationPage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';
import { useTheme } from '../ThemeContext.jsx';
import { getCached, setCached, cacheKey } from '../utils/scanPrefetch';
import SfpAdvisor from '../components/SfpAdvisor.jsx';
import DeviceLabelCapture from '../components/DeviceLabelCapture.jsx';
import { findVendorLogin } from '../utils/vendorLoginUrls';
import { getItem, setItem, removeItem } from '../utils/safeStorage';

// CMDB-driven switch info. Reads the list of switches stored in CMDB for
// this rack, and on demand fetches vendor specs + firmware-update info per
// device. Distinct from the live SSH "Switch Info" modal in port mode —
// that one talks directly to the device; this one trusts what's in CMDB.

// Map common CMDB manufacturer strings to the display name in the
// vendor-spec Excel sheet so /api/specs matches.
function vendorFromCmdb(manufacturer, model) {
  const m = (manufacturer || '').toLowerCase();
  if (m.includes('cisco'))   return 'Cisco';
  if (m.includes('tp-link') || m.includes('tplink')) return 'TP-Link';
  if (m.includes('d-link')   || m.includes('dlink')) return 'D-Link';
  if (m.includes('juniper')) return 'Juniper';
  if (m.includes('aruba'))   return 'Aruba';
  if (m.includes('arista'))  return 'Arista';
  if (m.includes('huawei'))  return 'Huawei';
  if (m.includes('dell'))    return 'Dell';
  if (m.includes('hpe') || m.includes('hewlett')) return 'HPE';
  // Last-ditch: guess from the model number prefix.
  const mod = (model || '').toUpperCase();
  if (mod.startsWith('C9') || mod.startsWith('WS-C')) return 'Cisco';
  if (mod.startsWith('TL-'))                          return 'TP-Link';
  if (mod.startsWith('DGS-') || mod.startsWith('DXS-')) return 'D-Link';
  return manufacturer || '';
}

// Client-side fallback: extract model number from raw OCR text when the
// pipeline returned make but missed the model (e.g. underscore/hyphen misread).
function extractModelFromRaw(rawText, make) {
  if (!rawText) return '';
  // Normalize underscores → hyphens (same logic as pipeline fix)
  const norm = rawText.replace(/[_][-]|[-][_]/g, '-').replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, '-');
  const patterns = [
    /\b(?:WS-C|C)\d{4,5}[A-Z]*-\d{1,3}[A-Z]{0,4}(?:-\w{1,4})?\b/,  // Cisco
    /\bTL-[A-Z]{2,4}\d{3,5}[A-Z]{0,4}\b/,                            // TP-Link
    /\bT[1-9]\d{2,3}[A-Z]{0,4}\b/,                                    // TP-Link JetStream
    /\bD[GX]S-\d{3,4}[A-Z]?-\d{1,3}[A-Z]{0,4}\b/,                   // D-Link
    /\b(?:EX|QFX|MX|SRX)\d{3,5}[A-Z0-9-]*\b/,                       // Juniper
    /\bCX\s?\d{4}[A-Z]?\b/,                                           // Aruba
    /\b(?:DCS-)?7\d{3}[A-Z]?-\d{1,3}[A-Z0-9-]*\b/,                  // Arista
    /\b(?:CRS|CCR)\d{3,4}(?:-[\w+]{1,12})*\b/i,                      // Mikrotik
  ];
  for (const rx of patterns) {
    const m = norm.match(rx);
    if (m) return m[0].toUpperCase();
  }
  // Fuzzy fallback for Mikrotik: OCR often garbles CRS→CAS/CR5/@R5 etc.
  // Look for patterns like *RS3xx or *RS1xx followed by dash-separated suffixes
  if (make && make.toLowerCase().includes('mikro')) {
    const fuzzy = norm.match(/[A-Z@][A-Z]*[RS]\d{3,4}(?:-[\w+]{1,12})*/i);
    if (fuzzy) {
      // Try to reconstruct: assume CRS or CCR prefix
      const raw = fuzzy[0];
      const digits = raw.match(/\d{3,4}(?:-[\w+]{1,12})*/);
      if (digits) {
        const prefix = raw.toLowerCase().includes('ccr') ? 'CCR' : 'CRS';
        return prefix + digits[0].toUpperCase();
      }
    }
  }
  return '';
}

// Expand known partial OCR model fragments to full model numbers.
// Mirrors the _FUZZY_MODEL_DB in pipeline/all_vendor.py.
const PARTIAL_MODEL_MAP = [
  // MikroTik
  [/^CRS3265?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3261?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3541?/i,    'CRS354-48G-4S+2Q+RM'],
  [/^CRS3121?/i,    'CRS312-4C+8XG-RM'],
  [/^CRS3171?/i,    'CRS317-1G-16S+RM'],
  [/^CRS3051?/i,    'CRS305-1G-4S+IN'],
  [/^CRS3281?/i,    'CRS328-24P-4S+RM'],
  [/^CRS5181?/i,    'CRS518-16XS-2XQ-RM'],
  [/^CCR20041?/i,   'CCR2004-1G-12S+2XS'],
  [/^CCR20161?/i,   'CCR2016-1G-12S+2XS'],
  // Cisco
  [/^C93001?$/i,    'C9300-24T'],
  [/^C93004?$/i,    'C9300-48T'],
  [/^C93002?$/i,    'C9300-24P'],
  [/^C93006?$/i,    'C9300-48P'],
  // TP-Link
  [/^TLSG24281?/i,  'TL-SG2428P'],
];

function expandPartialModel(model) {
  if (!model) return model;
  // Only try to expand if it looks partial: no hyphens and short, or ends with 1-2 digits
  const looksPartial = (!model.includes('-') && !model.includes('+') && model.length < 12)
    || /[A-Z]\d{1,2}$/i.test(model);
  if (!looksPartial) return model;
  for (const [rx, full] of PARTIAL_MODEL_MAP) {
    if (rx.test(model)) return full;
  }
  return model;
}

function cleanModel(m) {
  if (!m) return '';
  return String(m).trim().replace(/\s+v?\d+(?:\.\d+){0,2}\s*$/i, '').trim();
}

// Pull a clean dotted version out of messy firmware strings.
function cleanVersion(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const nx = s.match(/\b\d+\.\d+\([^)]+\)(?:[A-Z]\d+(?:\([^)]+\))?)?/);
  if (nx) return nx[0];
  const dotted = s.match(/\b\d+\.\d+(?:\.\d+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,5})?(?:-[A-Za-z0-9]{1,8})?\b/);
  return dotted ? dotted[0] : s;
}

// Spot raw Python tracebacks / JSONDecodeError text leaking from the
// backend so we can hide them behind a friendly empty state rather than
// dumping them in the UI. The user shouldn't have to read "Expecting
// value: line 1 column 1 (char 0)" — that's a backend signal, not a
// user-actionable message.
function looksLikeBackendNoise(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return (
    m.includes('expecting value') ||
    m.includes('traceback') ||
    m.includes('jsondecode') ||
    m.includes('line 1 column') ||
    m.startsWith('http ') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    // Catch anything that looks like a Python module / dotted path or
    // a stray "X timed out" message — those are developer-facing
    // strings that occasionally slip through the server's friendly
    // wrapper and shouldn't reach end users.
    m.includes('pipeline.') ||
    m.includes('timed out') ||
    m.includes('spawn ') ||
    m.includes('python exited') ||
    m.includes('exit code')
  );
}

function SourceBadge({ sw }) {
  const source = sw.discovery_source || '';
  const conf = sw.ocr_conf != null ? Math.round(sw.ocr_conf * 100) : null;

  let label, bg, color;
  if (sw._fromSwitch) {
    // The box answering for itself. Nothing the camera can offer beats it.
    label = 'From the switch';
    bg = 'rgba(15,123,79,.10)';
    color = '#0f7b4f';
  } else if (sw._fromOcr) {
    // From the rack photo — confidence shown when available.
    label = conf != null ? `Photo ${conf}%` : 'From photo';
    bg = '#ffffff';
    color = '#717171';
  } else if (source.startsWith('ocr')) {
    label = conf != null ? `Photo ${conf}%` : 'From photo';
    bg = '#ffffff';
    color = '#717171';
  } else if (source === 'override') {
    label = 'Manual';
    bg = '#ffffff';
    color = '#717171';
  } else if (source === 'synth') {
    label = 'Synth';
    bg = '#ffffff';
    color = '#717171';
  } else {
    label = 'CMDB';
    bg = '#ffffff';
    color = '#717171';
  }

  return (
    <span style={{
      fontSize: '.6rem', fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '.04em', padding: '2px 6px', borderRadius: 4,
      background: bg, color, border: '1px solid #ececec',
    }}>
      {label}
    </span>
  );
}

// Stable per-switch identifier for localStorage keys. Uses serial > mac >
// position as the primary key — deliberately NOT manufacturer/model
// because those are exactly the fields the user can override, and the
// key needs to be stable across edits so a saved override survives a
// re-scan that returns different OCR text.
function switchStableId(sw) {
  if (sw.serial_number) return `s:${sw.serial_number}`;
  if (sw.mac_address)   return `m:${sw.mac_address}`;
  if (sw.position)      return `p:${sw.position}`;
  // Last-ditch fallback — at least pin to the original (CV-derived) name
  // so multiple unidentified devices at the same scan don't collide.
  return `n:${sw.name || 'unknown'}`;
}

function userOverrideKey(rackId, sw, field) {
  return `racktrack:${field}:${rackId || '_'}::${switchStableId(sw)}`;
}
function loadOverride(rackId, sw, field) {
  try { return getItem(userOverrideKey(rackId, sw, field)) || ''; }
  catch { return ''; }
}
function saveOverride(rackId, sw, field, value) {
  try {
    const k = userOverrideKey(rackId, sw, field);
    if (value) setItem(k, value);
    else removeItem(k);
  } catch (_) {}
  // The overrides live in each card, but the list around them has to know:
  // the note under it says the labels are still being read, and it should
  // stop saying that the moment somebody supplies one by hand.
  try { window.dispatchEvent(new Event('rt:device-override')); } catch (_) { /* not a browser */ }
}

// Backwards-compat helpers for the existing firmware-version override.
function loadUserVersion(rackId, sw)        { return loadOverride(rackId, sw, 'fwVersion'); }
function saveUserVersion(rackId, sw, value) { saveOverride(rackId, sw, 'fwVersion', value); }

// Mirrors the override server-side (outputs/<rackId>/device_overrides.json,
// keyed by sw.position — same "U04" key the OCR pass uses) so it's visible
// to anything that isn't this browser, notably the Rack Scan Report.
// localStorage above stays the source of truth for this page itself; this
// is purely so the correction propagates. Best-effort — a failed sync
// (offline, no rackId, device has no position yet) never blocks the UI.
function syncDeviceOverride(rackId, sw, fields) {
  if (!rackId || !sw?.position) return;
  authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/device-override`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: sw.position, ...fields }),
  }).catch(() => {});
}

function SwitchCard({ sw, rackId, defaultExpanded = false, hideHeader = false }) {
  const { theme } = useTheme();
  const lt = theme === 'light';

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [specs, setSpecs] = useState(null);
  const [specsStatus, setSpecsStatus] = useState('idle');
  const [firmware, setFirmware] = useState(null);
  const [firmwareStatus, setFirmwareStatus] = useState('idle');
  // In-card tab strip — Specifications first (the vendor spec sheet),
  // then Firmware (version check), then the SFP Advisor (which optics
  // fit this chassis). Order chosen by the user.
  const [swTab, setSwTab] = useState('hardware');

  // User-supplied overrides — used when OCR / CMDB didn't capture the
  // value. Persisted per switch (keyed by serial > mac > position) so
  // they survive reloads and aren't disturbed by a re-scan that returns
  // different OCR text. Empty string means "not set".
  const [userMake, setUserMake]       = useState(() => loadOverride(rackId, sw, 'make'));
  const [userModel, setUserModel]     = useState(() => loadOverride(rackId, sw, 'model'));
  const [userVersion, setUserVersion] = useState(() => loadUserVersion(rackId, sw));

  // One-time backfill sync: any correction saved to localStorage before the
  // server-side sync existed only ever lived in this browser — the report
  // (server-side) could never see it. On load, if there's a saved value
  // here, push it up automatically so it shows up without the user having
  // to re-type and re-save something that's already visible on screen.
  useEffect(() => {
    if (userMake || userModel || userVersion) {
      syncDeviceOverride(rackId, sw, { make: userMake, model: userModel, firmware: userVersion });
    }
    // Intentionally once-per-mount: explicit save actions elsewhere already
    // sync on every edit, this is purely a backfill for pre-existing data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [editingIdent, setEditingIdent] = useState(false);
  const [identDraftMake,  setIdentDraftMake]  = useState('');
  const [identDraftModel, setIdentDraftModel] = useState('');
  // Close-up capture — the step between "the rack photo couldn't read this"
  // and "type it yourself". captureRead holds the last close-up result so
  // the editor can say where its prefill came from and offer the runner-up
  // readings; null means the editor was opened by hand.
  const [capturingIdent, setCapturingIdent] = useState(false);
  const [captureRead, setCaptureRead] = useState(null);
  const [editingVersion, setEditingVersion] = useState(false);
  const [versionDraft, setVersionDraft] = useState('');

  // Effective values: user override wins over OCR/CMDB. This means a user
  // who corrects OCR garbage gets the corrected value flowing into the
  // specs / firmware lookups below.
  // What a person typed in outranks what a camera guessed. The OCR read
  // "V-96" off a D-Link bezel; the person standing in front of it typed
  // DGS-1024C; and the card kept showing V-96, because the typed value was
  // only used when OCR had nothing at all. A correction that loses to the
  // thing it corrects is not a correction.
  const effectiveMake  = userMake  || sw.manufacturer;
  const effectiveModel = userModel || sw.model_number;
  const makeIsUserSupplied  = !!userMake;
  const modelIsUserSupplied = !!userModel;

  const displayVendor = vendorFromCmdb(effectiveMake, effectiveModel);
  const lookupModel = cleanModel(effectiveModel);
  const effectiveVersionRaw = sw.os_version || userVersion;
  const lookupVersion = cleanVersion(effectiveVersionRaw);
  const versionIsUserSupplied = !sw.os_version && !!userVersion;

  // This card came from the scan and its label hasn't been read yet. Empty
  // make/model here means "not yet", not "couldn't" — so none of the failure
  // copy or the manual-entry prompts below apply. Telling someone we failed
  // to read a label we haven't finished reading is just wrong.
  const awaitingLabel = !!sw._awaitingLabel && !userMake && !userModel;

  // OCR/CMDB returned nothing for either field — surface the editor as
  // the primary call-to-action instead of a tiny "edit" affordance.
  const identMissing = !awaitingLabel && !effectiveMake && !effectiveModel;
  // OCR got vendor but missed model (the common case after fuzzy-match
  // recovery) or vice-versa. Still surface the editor, just less
  // prominently — the user requested manual entry whenever the pipeline
  // failed on *either* field, not just both.
  const identIncomplete = !awaitingLabel && !identMissing && (!effectiveMake || !effectiveModel);

  const loadDetails = async (overrideVersion, { firmwareOnly = false } = {}) => {
    if (!displayVendor || !lookupModel) {
      setSpecsStatus('skipped');
      setFirmwareStatus('skipped');
      return;
    }
    const versionForLookup = overrideVersion != null
      ? cleanVersion(overrideVersion)
      : lookupVersion;

    // Check the prefetch cache first — if scanPrefetch already populated
    // this (vendor, model) pair, render synchronously and skip the network.
    const specsCached = (rackId && !firmwareOnly) ? getCached(cacheKey.specs(rackId, displayVendor, lookupModel)) : null;
    if (specsCached) {
      setSpecs(specsCached);
      setSpecsStatus(specsCached.ok ? 'ready' : 'error');
    } else if (!firmwareOnly) {
      setSpecsStatus(prev => prev === 'ready' ? prev : 'loading');
    }

    // A firmware payload with ok:true is a finished check whatever its
    // status says (up to date, behind a vendor sign-in, model not listed).
    // Only ok:false means the server itself could not run the check, and
    // that is the one outcome that gets a "Try again".
    const fwKey = (rackId && versionForLookup)
      ? cacheKey.firmware(rackId, displayVendor, lookupModel, versionForLookup)
      : null;
    const firmwareCached = fwKey ? getCached(fwKey) : null;
    if (firmwareCached) {
      setFirmware(firmwareCached.ok ? firmwareCached : null);
      setFirmwareStatus(firmwareCached.ok ? 'ready' : 'error');
    } else {
      setFirmwareStatus(versionForLookup ? 'loading' : 'skipped');
    }

    // Only OCR-derived data needs the server's OCR-correction probe. A
    // manual model edit (modelIsUserSupplied) means the user has
    // confirmed the model, so we tell the server to skip the probe and
    // save a Python spawn.
    const fromOcr = !!sw._fromOcr && !modelIsUserSupplied;

    if (!firmwareOnly && !specsCached && specsStatus !== 'ready') {
      authFetch(apiUrl('/api/specs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel, fromOcr }),
      }).then(async r => {
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (data && data.ok) {
          setSpecs(data); setSpecsStatus('ready');
          if (rackId) setCached(cacheKey.specs(rackId, displayVendor, lookupModel), data);
        } else {
          setSpecs(data); setSpecsStatus('error');
        }
      }).catch(() => setSpecsStatus('error'));
    }

    if (!firmwareCached && versionForLookup) {
      authFetch(apiUrl('/api/firmware'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel, currentVersion: versionForLookup, fromOcr }),
      }).then(async r => {
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (data && data.ok) {
          setFirmware(data); setFirmwareStatus('ready');
          if (fwKey) setCached(fwKey, data);
        } else {
          setFirmware(null); setFirmwareStatus('error');
        }
      }).catch(() => { setFirmware(null); setFirmwareStatus('error'); });
    }
  };

  // "Try again" after the server failed the check. Drops whatever the
  // prefetcher or an earlier visit cached for this exact (vendor, model,
  // version) so the fetch really goes to the server again.
  const retryFirmware = () => {
    if (rackId && lookupVersion) {
      setCached(cacheKey.firmware(rackId, displayVendor, lookupModel, lookupVersion), null);
    }
    setFirmware(null);
    setFirmwareStatus('loading');
    loadDetails(undefined, { firmwareOnly: true });
  };

  // Auto-fire details on mount (rather than waiting for expand) — the
  // prefetcher has already done the network work, so this just wires the
  // cached payload into the card's render state. If the cache misses,
  // it falls back to the same on-mount fetch a one-time visit would do.
  useEffect(() => {
    if (displayVendor && lookupModel && specsStatus === 'idle') {
      loadDetails();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayVendor, lookupModel]);

  const onToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && specsStatus === 'idle' && firmwareStatus === 'idle') loadDetails();
  };

  const startEditVersion = () => {
    setVersionDraft(userVersion || '');
    setEditingVersion(true);
  };
  const cancelEditVersion = () => {
    setEditingVersion(false);
    setVersionDraft('');
  };
  const saveVersion = () => {
    const v = versionDraft.trim();
    setUserVersion(v);
    saveUserVersion(rackId, sw, v);
    syncDeviceOverride(rackId, sw, { make: userMake, model: userModel, firmware: v });
    setEditingVersion(false);
    setVersionDraft('');
    setFirmware(null);
    setFirmwareStatus(v ? 'loading' : 'skipped');
    if (v) loadDetails(v);
  };
  const clearVersion = () => {
    setUserVersion('');
    saveUserVersion(rackId, sw, '');
    syncDeviceOverride(rackId, sw, { make: userMake, model: userModel, firmware: '' });
    setEditingVersion(false);
    setVersionDraft('');
    setFirmware(null);
    setFirmwareStatus('skipped');
  };

  // Make/model editor — used when OCR couldn't pin down vendor or model.
  // Saving triggers a fresh specs/firmware lookup against the new values.
  const startEditIdent = () => {
    setIdentDraftMake(userMake || sw.manufacturer || '');
    setIdentDraftModel(userModel || sw.model_number || '');
    setEditingIdent(true);
  };
  const cancelEditIdent = () => {
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
    setCaptureRead(null);
  };

  // Photograph the device's own label instead of typing it. The rack photo
  // gives each device only a slice of the frame, so a model number that was
  // legible in person can reach OCR too small to survive — which makes a
  // second, closer photo a better recovery than a keyboard.
  const startCaptureIdent = () => {
    setCaptureRead(null);
    setCapturingIdent(true);
  };

  // A close-up read PREFILLS the editor and stops there. The user is standing
  // in front of the device and can confirm at a glance, and a confident wrong
  // model number is worse downstream than an empty one — so "read failed" and
  // "read wrong" both land on the same correction path.
  const onIdentCaptured = (read) => {
    setCapturingIdent(false);
    setCaptureRead(read);
    setIdentDraftMake(read.make || userMake || sw.manufacturer || '');
    setIdentDraftModel(read.model || userModel || sw.model_number || '');
    setEditingIdent(true);
  };

  const saveIdent = () => {
    const newMake  = identDraftMake.trim();
    const newModel = identDraftModel.trim();
    setUserMake(newMake);
    setUserModel(newModel);
    saveOverride(rackId, sw, 'make',  newMake);
    saveOverride(rackId, sw, 'model', newModel);
    syncDeviceOverride(rackId, sw, { make: newMake, model: newModel, firmware: userVersion });
    // The close-up usually catches the firmware string printed on the same
    // label. Keep it only when nothing else supplied one: an existing version
    // came from the device itself or from the user, and both outrank a photo.
    const readVersion = captureRead?.version;
    if (readVersion && !sw.os_version && !userVersion) {
      setUserVersion(readVersion);
      saveUserVersion(rackId, sw, readVersion);
    }
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
    setCaptureRead(null);
    // New values invalidate any cached spec/firmware results — re-fetch.
    setSpecs(null);
    setSpecsStatus('idle');
    setFirmware(null);
    setFirmwareStatus('idle');
    if (newMake && newModel && expanded) {
      // Trigger fresh lookup with the new values; loadDetails reads
      // displayVendor/lookupModel from state which won't have updated
      // yet, so pass the values explicitly via a microtask.
      setTimeout(() => loadDetails(), 0);
    }
  };
  const clearIdent = () => {
    setUserMake('');
    setUserModel('');
    saveOverride(rackId, sw, 'make',  '');
    saveOverride(rackId, sw, 'model', '');
    syncDeviceOverride(rackId, sw, { make: '', model: '', firmware: userVersion });
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
    setCaptureRead(null);
    setSpecs(null);
    setSpecsStatus('idle');
    setFirmware(null);
    setFirmwareStatus('idle');
  };

  // What the check found. The status names the outcome (the source's word
  // for it); the version comparison only means anything when the status is
  // 'ok'. A payload from an older server carries no status, so infer one
  // from whether a latest version came back at all.
  const fwStatus = firmware
    ? (firmware.status || firmware.statusValue || (firmware.latestVersion ? 'ok' : 'cannot_determine'))
    : null;
  // A verified outcome needs the version it was verified against. A status
  // of 'ok' without one is not something the server sends; if it ever did,
  // it reads as "latest not verified" rather than as a comparison.
  const fwVerified = fwStatus === 'ok' && !!firmware?.latestVersion;
  const fwTone =
    fwVerified && firmware?.upToDate === true ? 'ok'
    : fwVerified && firmware?.upToDate === false ? 'warn'
    : 'neutral';
  let fwHeadline;
  if (fwVerified) {
    fwHeadline = firmware.upToDate === true ? 'Up to date'
      : firmware.upToDate === false ? 'Update available'
      : `Latest ${firmware.latestVersion}`;
  } else if (fwStatus === 'auth_required') {
    fwHeadline = 'Check vendor site';
  } else if (fwStatus === 'model_not_found' || fwStatus === 'ambiguous_model') {
    fwHeadline = 'Model not listed';
  } else {
    fwHeadline = 'Latest not verified';
  }
  const fwColor =
    fwTone === 'ok' ? '#1c1c1c'
    : fwTone === 'warn' ? '#474747' : lt ? '#474747' : 'rgba(0,0,0,0.7)';

  // Accent: indigo (light) / cyan (dark) for CMDB; amber for OCR
  const accent      = sw._fromOcr ? '#474747' : lt ? '#000000' : '#000000';
  const accentDim   = sw._fromOcr ? (lt ? 'rgba(0,0,0,0.10)'  : 'rgba(0,0,0,0.15)')
                                  : (lt ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.12)');
  const accentBorder= sw._fromOcr ? (lt ? 'rgba(0,0,0,0.35)'  : 'rgba(0,0,0,0.35)')
                                  : (lt ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.25)');

  // Theme tokens
  const cardBg      = lt ? '#ffffff'                         : 'rgba(0,0,0,0.95)';
  const cardBorder  = lt ? '#c6c6c6'                         : 'rgba(255,255,255,0.08)';
  const titleColor  = lt ? '#1c1c1c'                         : '#e9e9e9';
  const subColor    = lt ? '#474747'                         : 'rgba(0,0,0,0.8)';
  const divider     = lt ? '#c6c6c6'                         : 'rgba(255,255,255,0.06)';
  const fieldBg     = lt ? '#ffffff'                         : 'rgba(255,255,255,0.03)';
  const fieldBorder = lt ? '#c6c6c6'                         : 'rgba(255,255,255,0.07)';
  const valueColor  = lt ? '#1c1c1c'                         : '#e9e9e9';
  const chevronColor= lt ? '#474747'                         : 'rgba(0,0,0,0.6)';
  const statusColor = lt ? '#474747'                         : 'rgba(0,0,0,0.7)';
  const linkColor   = lt ? '#000000'                         : '#000000';

  const displayVersion = sw.os_version || userVersion;
  const hasDetails = effectiveMake || effectiveModel || displayVersion || sw.serial_number || sw.ip_address || sw.mac_address;

  return (
    <article style={{
      borderRadius: 14,
      background: cardBg,
      border: `1px solid ${cardBorder}`,
      borderTop: `2px solid ${accent}`,
      marginBottom: 12,
      overflow: 'hidden',
      boxShadow: lt
        ? '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)'
        : '0 4px 24px rgba(0,0,0,0.35)',
    }}>

      {/* ── Header ── */}
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex', width: '100%', alignItems: 'center', gap: 12,
          background: 'transparent', border: 0, color: 'inherit', textAlign: 'left',
          cursor: 'pointer', padding: '14px 16px',
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: accentDim, border: `1px solid ${accentBorder}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2"/>
            <line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/>
            <line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/>
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '-0.01em', color: titleColor }}>
              {effectiveMake && effectiveModel
                ? `${effectiveMake} ${specs?.model || effectiveModel}`
                : effectiveMake || effectiveModel
                  || (awaitingLabel ? (sw.position ? `Switch · ${sw.position}` : 'Switch') : null)
                  || sw.name || 'Unidentified device'}
            </span>
            {awaitingLabel && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: '.68rem', fontWeight: 700, color: '#717171',
                background: '#ffffff', border: '1px solid #ececec',
                padding: '2px 8px', borderRadius: 20,
              }}>
                <span aria-hidden="true" className={desk.pulseDot}
                  style={{ width: 6, height: 6 }} />
                Reading label
              </span>
            )}
          </div>
          {(sw.position || sw.ip_address || effectiveMake) && (() => {
            // Per-vendor login portal: if we have a curated URL for this
            // vendor (from login-info.xlsx) use it; otherwise fall back to
            // a known support/site landing page; otherwise show nothing.
            const portal = effectiveMake ? findVendorLogin(effectiveMake) : null;
            return (
              <div style={{ fontSize: '.72rem', color: subColor, marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {sw.position   && <span style={{ color: accent, fontWeight: 600 }}>{sw.position}</span>}
                {sw.ip_address && <span>{sw.ip_address}</span>}
                {portal && (
                  <a
                    href={portal.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    title={portal.source === 'login'
                      ? `Log in to ${portal.name} to view device details`
                      : `Open ${portal.name} support`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: '.68rem', fontWeight: 700,
                      padding: '2px 8px', borderRadius: 999,
                      background: accentDim,
                      border: `1px solid ${accentBorder}`,
                      color: accent,
                      textDecoration: 'none',
                      letterSpacing: '.02em',
                    }}>
                    {portal.source === 'login' ? 'Login portal' : 'Vendor site'}
                    <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
            );
          })()}
        </div>

        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke={chevronColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform .2s ease' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* ── The facts, as rows ──
          Four columns of tiles clipped the serial to "222B0K40(" and broke a
          firmware string over four lines. A label and a value on one line
          each, the firmware's version first and its build underneath in
          smaller type, and nothing is cut off however long it is. */}
      {(displayVersion || sw.port_count || sw.serial_number || sw.mac_address || sw.ip_address) && (() => {
        const [ver, ...build] = String(displayVersion || '').trim().split(/\s+/);
        const rows = [
          displayVersion && ['Firmware', ver + (versionIsUserSupplied ? ' · entered' : ''), build.join(' ')],
          sw.serial_number && ['Serial', sw.serial_number],
          sw.ip_address && ['Address', sw.ip_address],
          sw.mac_address && ['MAC', sw.mac_address],
          sw.port_count && ['Ports', String(sw.port_count)],
        ].filter(Boolean);
        return (
          <dl style={{ margin: 0, padding: '6px 16px 10px', borderTop: `1px solid ${divider}`, background: fieldBg }}>
            {rows.map(([label, value, sub]) => (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', gap: 12, alignItems: 'baseline', padding: '6px 0' }}>
                <dt style={{ margin: 0, fontSize: '.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: accent }}>
                  {label}
                </dt>
                <dd style={{ margin: 0, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '.86rem', fontWeight: 650, color: valueColor, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                    {value}
                  </span>
                  {sub && (
                    <span style={{ display: 'block', fontSize: '.72rem', color: '#717171', marginTop: 1, overflowWrap: 'anywhere' }}>
                      {sub}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        );
      })()}

      {/* ── Expanded: firmware + specs ── */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${divider}`, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Identifier section — shown whenever OCR didn't pin down the
              full make + model, or whenever the user wants to correct
              what OCR returned. The user explicitly asked for manual
              entry on either-missing, not just both-missing. */}
          {/* `awaitingLabel` is in this condition deliberately. The whole
              Identification block used to be hidden while the label was still
              being read, which is the one moment a user most needs it: the read
              is slow, the card shows a pulsing "Reading label" and nothing else,
              and testers concluded there was no way to type it in and that the
              page had hung. Now the block is there throughout — reading, failed
              or done — and only the wording changes. */}
          {(awaitingLabel || identMissing || identIncomplete || editingIdent || makeIsUserSupplied || modelIsUserSupplied) && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>
                  Identification
                </span>
                {awaitingLabel && !editingIdent && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.7rem', fontWeight: 700, color: '#717171', background: '#ffffff', padding: '2px 8px', borderRadius: 20, border: '1px solid #ececec' }}>
                    <span aria-hidden="true" className={desk.pulseDot} style={{ width: 6, height: 6 }} />
                    Still reading
                  </span>
                )}
                {identMissing && !editingIdent && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#717171', background: '#ffffff', padding: '2px 8px', borderRadius: 20, border: '1px solid #ececec' }}>
                    Not detected
                  </span>
                )}
                {identIncomplete && !editingIdent && !makeIsUserSupplied && !modelIsUserSupplied && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#717171', background: '#ffffff', padding: '2px 8px', borderRadius: 20, border: '1px solid #ececec' }}>
                    {effectiveMake ? 'Model not detected' : 'Vendor not detected'}
                  </span>
                )}
                {(makeIsUserSupplied || modelIsUserSupplied) && !editingIdent && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#717171', background: '#ffffff', padding: '2px 8px', borderRadius: 20, border: '1px solid #ececec' }}>
                    Manual entry
                  </span>
                )}
                {!editingIdent && (
                  <button
                    type="button"
                    onClick={startEditIdent}
                    // Testers could not tell this was a control: transparent,
                    // borderless, no padding and .7rem, it read as ordinary
                    // label text sitting next to the value. It is a filled pill
                    // now, so "Type it in" looks like the thing you press.
                    style={{
                      marginLeft: 'auto', background: linkColor, border: 0,
                      borderRadius: 999, color: '#ffffff',
                      fontSize: '.72rem', fontWeight: 700, cursor: 'pointer',
                      padding: '6px 12px', minHeight: 30, whiteSpace: 'nowrap',
                    }}
                  >{
                    // Name the subject. "Type it in" next to a heading reading
                    // "Identification" left testers asking type WHAT in — and
                    // while the label was still being read they did not see this
                    // control at all, so nothing on the card said the make and
                    // model could be entered by hand.
                    awaitingLabel && !makeIsUserSupplied && !modelIsUserSupplied
                      ? 'Enter make / model'
                      : identMissing && !makeIsUserSupplied && !modelIsUserSupplied
                        ? 'Enter make / model'
                        : identIncomplete && !makeIsUserSupplied && !modelIsUserSupplied
                          ? (effectiveMake ? 'Enter model' : 'Enter make')
                          : 'Edit'
                  }</button>
                )}
              </div>
              {editingIdent ? (
                <IdentEditor
                  draftMake={identDraftMake}
                  setDraftMake={setIdentDraftMake}
                  draftModel={identDraftModel}
                  setDraftModel={setIdentDraftModel}
                  onSave={saveIdent}
                  onCancel={cancelEditIdent}
                  hasExisting={!!(userMake || userModel)}
                  onClear={clearIdent}
                  read={captureRead}
                  onScan={startCaptureIdent}
                  accent={accent}
                  fieldBg={fieldBg}
                  fieldBorder={fieldBorder}
                  valueColor={valueColor}
                  statusColor={statusColor}
                />
              ) : (
                <>
                  {awaitingLabel ? (
                    <StatusLine color={statusColor}>
                      Still reading the label from the rack photo. It can take a
                      minute - you don't have to wait, enter the make and model
                      above and it will use yours.
                    </StatusLine>
                  ) : identMissing ? (
                    <StatusLine color={statusColor}>
                      We couldn't identify this device from the rack photo.
                    </StatusLine>
                  ) : identIncomplete && !makeIsUserSupplied && !modelIsUserSupplied ? (
                    <StatusLine color={statusColor}>
                      {effectiveMake
                        ? `We identified "${effectiveMake}" but couldn't read the model. Specs and firmware checks need both.`
                        : `We read a model but couldn't identify the vendor.`}
                    </StatusLine>
                  ) : null}

                  {/* Close-up capture, offered ahead of the keyboard. The rack
                      photo spends its pixels on the whole rack, so this device's
                      label reached OCR too small to read — which a second photo
                      fixes and typing only works around. Weighted by how much is
                      missing: a full CTA when nothing was identified, a quiet
                      link when only one field is. */}
                  {(identMissing || identIncomplete) && !makeIsUserSupplied && !modelIsUserSupplied && (
                    identMissing ? (
                      <button
                        type="button"
                        onClick={startCaptureIdent}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                          width: '100%', marginTop: 10, padding: '10px 14px',
                          borderRadius: 8, border: 0, background: accent, color: '#ffffff',
                          fontSize: '.82rem', fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        <CameraGlyph />
                        Scan the device label
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={startCaptureIdent}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          marginTop: 8, padding: 0, background: 'transparent', border: 0,
                          color: linkColor, fontSize: '.75rem', fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        <CameraGlyph />
                        Scan the device label
                      </button>
                    )
                  )}
                  {identMissing && !makeIsUserSupplied && !modelIsUserSupplied && (
                    <p style={{ margin: '6px 0 0', fontSize: '.72rem', color: statusColor }}>
                      Photograph the model number on the device's faceplate - up close
                      it reads far better than it does in the rack photo. You can take
                      it now or upload one you already have.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Tab strip — Firmware / Hardware / Optics. Renders one focused
              section at a time so the card stays compact and each tab maps
              to a real data source (firmware lookup / vendor spec sheet /
              SFP procurement advisor). */}
          <div role="tablist" aria-label="Switch details"
            style={{
              display: 'flex', gap: 0,
              borderBottom: `1px solid ${divider}`,
              marginBottom: 4,
            }}>
            {[
              { k: 'hardware', label: 'Specifications' },
              { k: 'firmware', label: 'Firmware' },
              { k: 'optics',   label: 'SFP Advisor' },
            ].map(t => {
              const on = swTab === t.k;
              return (
                <button
                  key={t.k}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setSwTab(t.k)}
                  style={{
                    flex: 1,
                    padding: '10px 4px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `2px solid ${on ? accent : 'transparent'}`,
                    color: on ? titleColor : statusColor,
                    fontSize: '.74rem',
                    fontWeight: on ? 700 : 500,
                    letterSpacing: '.04em',
                    cursor: 'pointer',
                    transition: 'color .15s, border-color .15s',
                    marginBottom: -1,
                  }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {swTab === 'firmware' && (<>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>Firmware</span>
              {firmwareStatus === 'ready' && (
                <span style={{ fontSize: '.7rem', fontWeight: 700, color: fwColor, background: `${fwColor}18`, padding: '2px 8px', borderRadius: 20, border: `1px solid ${fwColor}40` }}>
                  {fwHeadline}
                </span>
              )}
              {versionIsUserSupplied && !editingVersion && (firmwareStatus === 'ready' || firmwareStatus === 'error') && (
                <button
                  type="button"
                  onClick={startEditVersion}
                  style={{
                    marginLeft: 'auto', background: 'transparent', border: 0,
                    color: linkColor, fontSize: '.7rem', fontWeight: 600, cursor: 'pointer',
                    padding: 0,
                  }}
                >Edit version</button>
              )}
            </div>
            {versionIsUserSupplied && editingVersion && (firmwareStatus === 'ready' || firmwareStatus === 'error') && (
              <div style={{ marginBottom: 10 }}>
                <VersionEditor
                  editing
                  draft={versionDraft}
                  setDraft={setVersionDraft}
                  onSave={saveVersion}
                  onCancel={cancelEditVersion}
                  hasExisting={!!userVersion}
                  onClear={clearVersion}
                  onStartEdit={startEditVersion}
                  accent={accent}
                  fieldBg={fieldBg}
                  fieldBorder={fieldBorder}
                  valueColor={valueColor}
                  statusColor={statusColor}
                />
              </div>
            )}
            {firmwareStatus === 'loading' && <StatusLine color={statusColor}>Checking for updates…</StatusLine>}
            {firmwareStatus === 'skipped' && lookupModel && (
              <VersionEditor
                editing={editingVersion || !displayVersion}
                draft={versionDraft}
                setDraft={setVersionDraft}
                onSave={saveVersion}
                onCancel={cancelEditVersion}
                hasExisting={!!userVersion}
                onClear={clearVersion}
                onStartEdit={startEditVersion}
                accent={accent}
                fieldBg={fieldBg}
                fieldBorder={fieldBorder}
                valueColor={valueColor}
                statusColor={statusColor}
              />
            )}
            {firmwareStatus === 'skipped' && !lookupModel && (
              <StatusLine color={statusColor}>Add a model to check for updates.</StatusLine>
            )}
            {firmwareStatus === 'error' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <StatusLine color={statusColor}>Couldn't check for updates right now.</StatusLine>
                <button
                  type="button"
                  onClick={retryFirmware}
                  style={{
                    background: 'transparent', border: 0, padding: 0,
                    color: linkColor, fontSize: '.78rem', fontWeight: 700, cursor: 'pointer',
                  }}
                >Try again</button>
              </div>
            )}
            {firmwareStatus === 'ready' && firmware && (() => {
              // Fallback download page per vendor, used when the server did
              // not send a portal link for this outcome.
              const VENDOR_FW_URL = {
                mikrotik: 'https://mikrotik.com/download',
                cisco:    'https://software.cisco.com/download/home',
                juniper:  'https://support.juniper.net/support/downloads/',
                arista:   'https://www.arista.com/en/support/software-download',
                hpe:      'https://support.hpe.com/connect/s/',
                aruba:    'https://asp.arubanetworks.com/downloads',
                dell:     'https://www.dell.com/support/home/en-in?app=drivers',
                fortinet: 'https://support.fortinet.com/Download/FirmwareImages.aspx',
                extreme:  'https://www.extremenetworks.com/support/documentation',
                netgear:  'https://www.netgear.com/support/download/',
                tplink:   'https://www.tp-link.com/support/download/',
                dlink:    'https://www.dlink.com/support/downloads/',
                ubiquiti: 'https://www.ui.com/download/',
                huawei:   'https://support.huawei.com/enterprise/en/index.html',
                ruijie:   'https://www.ruijienetworks.com/support/documents',
                zyxel:    'https://www.zyxel.com/global/en/support/download',
              };
              const norm = String(displayVendor || effectiveMake || '')
                .toLowerCase().replace(/[^a-z0-9]/g, '');
              let vendorPage = null;
              for (const k of Object.keys(VENDOR_FW_URL)) {
                if (norm.includes(k)) { vendorPage = VENDOR_FW_URL[k]; break; }
              }
              const vendorName = effectiveMake || firmware.vendor || displayVendor || 'The vendor';
              const modelName  = firmware.model || lookupModel || effectiveModel || 'this model';
              const vendorUrl  = firmware.portalUrl || vendorPage;
              // The link sits inside the sentence so the sentence says where
              // it goes. Without any URL the words stay as plain text.
              const vendorLink = (text) => vendorUrl ? (
                <a href={vendorUrl} target="_blank" rel="noreferrer noopener"
                  style={{ color: linkColor, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  {text} <span aria-hidden="true">↗</span>
                </a>
              ) : text;

              let note = null;
              if (fwStatus === 'auth_required') {
                note = (<>
                  {vendorName} keeps firmware downloads behind a sign-in.
                  {' '}Check {modelName} on the {vendorLink(`${vendorName} support site`)}
                </>);
              } else if (fwStatus === 'model_not_found' || fwStatus === 'ambiguous_model') {
                note = (<>
                  {vendorName}'s release list does not list {modelName} as read.
                  {' '}Check the {vendorLink(`${vendorName} download page`)}
                </>);
              } else if (!fwVerified) {
                note = (<>
                  No verified release list for {vendorName} {modelName}.
                  {' '}Check the {vendorLink(`${vendorName} download page`)}
                </>);
              }

              const changelog = (fwVerified && Array.isArray(firmware.changelog))
                ? firmware.changelog.filter(c => c && c.text)
                : [];
              const showMin = fwVerified && firmware.recommendedMinVersion
                && firmware.recommendedMinVersion !== firmware.latestVersion;

              return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                  <MiniField label="Current" value={firmware.currentVersion} accent={accent} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                  {fwVerified && firmware.latestVersion && (
                    <MiniField label="Latest" value={firmware.latestVersion} accent={accent} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                  )}
                  {showMin && (
                    <MiniField label="Min safe" value={firmware.recommendedMinVersion} accent={'#474747'} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                  )}
                </div>
                {fwVerified && firmware.releaseNotesUrl && (
                  <div style={{ marginTop: 10 }}>
                    <a href={firmware.releaseNotesUrl} target="_blank" rel="noreferrer noopener"
                      style={{ fontSize: '.76rem', fontWeight: 700, color: linkColor, textDecoration: 'none' }}>
                      Release notes <span aria-hidden="true">↗</span>
                    </a>
                  </div>
                )}
                {changelog.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {changelog.map((c, i) => (
                      <div key={`${c.section || ''}-${c.version || ''}-${i}`}
                        style={{ padding: '8px 10px', borderRadius: 8, background: fieldBg, border: `1px solid ${fieldBorder}` }}>
                        <span style={{ display: 'block', fontSize: '.58rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: accent, marginBottom: 3 }}>
                          {c.section || (c.version ? `Changes in ${c.version}` : 'Changes')}
                        </span>
                        <span style={{ display: 'block', fontSize: '.76rem', color: valueColor, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {c.text}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {note && (
                  <p style={{ margin: '10px 0 0', fontSize: '.78rem', color: statusColor, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
                    {note}
                  </p>
                )}
              </>
              );
            })()}
          </div>
          </>)}

          {swTab === 'hardware' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>
                Hardware
              </span>
              {specs?.productUrl && (
                <a href={specs.productUrl} target="_blank" rel="noreferrer noopener"
                  style={{ fontSize: '.72rem', fontWeight: 600, color: linkColor, textDecoration: 'none' }}>
                  View full details ↗
                </a>
              )}
            </div>
            {specsStatus === 'loading' && <StatusLine color={statusColor}>Looking up specs…</StatusLine>}
            {specsStatus === 'skipped' && <StatusLine color={statusColor}>Add vendor and model to see specs.</StatusLine>}
            {specsStatus === 'error'   && <StatusLine color={statusColor}>{looksLikeBackendNoise(specs?.error) ? 'Couldn’t load specs.' : (specs?.error || 'Couldn’t load specs.')}</StatusLine>}
            {specsStatus === 'ready' && specs?.specs && (() => {
              const rows = Object.entries(specs.specs);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 10, border: `1px solid ${fieldBorder}`, overflow: 'hidden' }}>
                  {rows.map(([k, v], i) => (
                    <div key={k} style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(110px, 42%) 1fr',
                      gap: 10,
                      padding: '9px 12px',
                      background: i % 2 === 0 ? fieldBg : 'transparent',
                      borderBottom: i < rows.length - 1 ? `1px solid ${fieldBorder}` : 'none',
                      alignItems: 'start',
                    }}>
                      <span style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: accent, lineHeight: 1.4, paddingTop: 1 }}>
                        {k}
                      </span>
                      <span style={{ fontSize: '.82rem', fontWeight: 500, color: valueColor, lineHeight: 1.45, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                        {String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
          )}

          {swTab === 'optics' && (
            <SfpAdvisor
              rackId={rackId}
              position={sw.position}
              vendor={effectiveMake || 'Unknown'}
              model={effectiveModel || 'Unknown'}
              // Without the slot count the advisor priced for zero ports and
              // fell back to listing cables alone. The camera counted the
              // cages; until a reading says which are filled, all of them are
              // the ones to buy for.
              sfpCounts={sw.sfp_count ? { total: sw.sfp_count, avail: sw.sfp_count } : undefined}
            />
          )}

        </div>
      )}

      {capturingIdent && (
        <DeviceLabelCapture
          deviceLabel={[sw.position, sw.name].filter(Boolean).join(' · ')}
          onIdentified={onIdentCaptured}
          onManualEntry={() => {
            // A photo that couldn't be read hands off to the keyboard rather
            // than dropping the user back on the button they just pressed.
            setCapturingIdent(false);
            if (!editingIdent) startEditIdent();
          }}
          onCancel={() => setCapturingIdent(false)}
        />
      )}
    </article>
  );
}

// Camera glyph for the capture CTAs. Inline rather than an icon import to
// match the rest of this page, which draws its own SVGs.
function CameraGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function VersionEditor({
  editing, draft, setDraft, onSave, onCancel, hasExisting, onClear, onStartEdit,
  accent, fieldBg, fieldBorder, valueColor, statusColor,
}) {
  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusLine color={statusColor}>No firmware version recorded.</StatusLine>
        <button
          type="button"
          onClick={onStartEdit}
          style={{
            background: 'transparent', border: `1px solid ${accent}`,
            color: accent, fontSize: '.72rem', fontWeight: 600,
            padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
          }}
        >Enter version</button>
      </div>
    );
  }
  return (
    <div style={{
      padding: 10, borderRadius: 10,
      background: fieldBg, border: `1px solid ${fieldBorder}`,
    }}>
      <span style={{
        display: 'block', fontSize: '.62rem', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '.08em',
        color: accent, marginBottom: 8,
      }}>
        Enter firmware version
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
          placeholder="e.g. 1.0.6 Build 20210323"
          style={{
            flex: '1 1 160px', minWidth: 0,
            padding: '6px 10px', borderRadius: 6,
            background: 'transparent', color: valueColor,
            border: `1px solid ${fieldBorder}`,
            fontSize: '16px', fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={!draft.trim()}
          style={{
            background: accent, color: '#ffffff', border: 0,
            padding: '6px 12px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 700, cursor: draft.trim() ? 'pointer' : 'not-allowed',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >Save</button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent', color: statusColor,
            border: `1px solid ${fieldBorder}`,
            padding: '6px 10px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
          }}
        >Cancel</button>
        {hasExisting && (
          <button
            type="button"
            onClick={onClear}
            style={{
              background: 'transparent', color: '#1c1c1c',
              border: `1px solid rgba(0,0,0,0.35)`,
              padding: '6px 10px', borderRadius: 6,
              fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
            }}
          >Clear</button>
        )}
      </div>
    </div>
  );
}

// Make + model editor. Used when OCR couldn't pin down identification
// or when the user is correcting what OCR returned. Saves both fields
// atomically — model regex resolution happens server-side at /api/specs
// time, so the UI doesn't need to validate model strings.
function IdentEditor({
  draftMake, setDraftMake, draftModel, setDraftModel,
  onSave, onCancel, hasExisting, onClear, read, onScan,
  accent, fieldBg, fieldBorder, valueColor, statusColor,
}) {
  // `read` is the last close-up result, present only when the editor was
  // opened from the camera. Its values are already in the drafts — this
  // block exists to say where they came from, because a prefilled field the
  // user didn't type is one they have to be told to check.
  const readSomething = !!(read && (read.make || read.model));
  const alternates = (read?.alternates || []).filter(a => a.make || a.model);
  const inputStyle = {
    flex: '1 1 140px', minWidth: 0,
    padding: '6px 10px', borderRadius: 6,
    background: 'transparent', color: valueColor,
    border: `1px solid ${fieldBorder}`,
    fontSize: '16px', fontFamily: 'inherit',
    outline: 'none',
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  const canSave = !!(draftMake.trim() && draftModel.trim());
  return (
    <div style={{
      padding: 10, borderRadius: 10,
      background: fieldBg, border: `1px solid ${fieldBorder}`,
    }}>
      {read && (
        <div style={{
          marginBottom: 10, paddingBottom: 10,
          borderBottom: `1px solid ${fieldBorder}`,
        }}>
          <p style={{ margin: 0, fontSize: '.75rem', fontWeight: 700, color: valueColor }}>
            {readSomething
              ? 'Read from your photo - check it before saving.'
              : "We couldn't read that photo either."}
          </p>
          {readSomething && read.version && (
            <p style={{ margin: '4px 0 0', fontSize: '.72rem', color: statusColor }}>
              Firmware {read.version} was on the same label - it'll be saved too.
            </p>
          )}
          {!readSomething && (
            <p style={{ margin: '4px 0 0', fontSize: '.72rem', color: statusColor }}>
              Enter the make and model below, or try another photo with the
              label filling more of the frame.
            </p>
          )}
          {alternates.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{
                display: 'block', fontSize: '.6rem', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '.07em',
                color: accent, marginBottom: 5,
              }}>Or did you mean</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {alternates.map((alt, i) => (
                  <button
                    key={`${alt.make}-${alt.model}-${i}`}
                    type="button"
                    onClick={() => {
                      if (alt.make)  setDraftMake(alt.make);
                      if (alt.model) setDraftModel(alt.model);
                    }}
                    style={{
                      background: 'transparent', color: valueColor,
                      border: `1px solid ${fieldBorder}`,
                      padding: '4px 9px', borderRadius: 20,
                      fontSize: '.72rem', fontWeight: 600, cursor: 'pointer',
                    }}
                  >{[alt.make, alt.model].filter(Boolean).join(' ')}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <span style={{
            display: 'block', fontSize: '.6rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.07em',
            color: accent, marginBottom: 4,
          }}>Make / Vendor</span>
          <input
            type="text"
            autoFocus
            value={draftMake}
            onChange={e => setDraftMake(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. MikroTik"
            style={inputStyle}
          />
        </div>
        <div>
          <span style={{
            display: 'block', fontSize: '.6rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.07em',
            color: accent, marginBottom: 4,
          }}>Model</span>
          <input
            type="text"
            value={draftModel}
            onChange={e => setDraftModel(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. CRS328-24P-4S+RM"
            style={inputStyle}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={{
            background: accent, color: '#ffffff', border: 0,
            padding: '6px 12px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 700, cursor: canSave ? 'pointer' : 'not-allowed',
            opacity: canSave ? 1 : 0.5,
          }}
        >Save</button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent', color: statusColor,
            border: `1px solid ${fieldBorder}`,
            padding: '6px 10px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
          }}
        >Cancel</button>
        {hasExisting && (
          <button
            type="button"
            onClick={onClear}
            style={{
              background: 'transparent', color: '#1c1c1c',
              border: `1px solid rgba(0,0,0,0.35)`,
              padding: '6px 10px', borderRadius: 6,
              fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
            }}
          >Clear</button>
        )}
        {onScan && (
          <button
            type="button"
            onClick={onScan}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'transparent', color: '#000000', border: 0,
              padding: '6px 0', fontSize: '.75rem', fontWeight: 700, cursor: 'pointer',
            }}
          >
            <CameraGlyph />
            {read ? 'Another photo' : 'Scan the label'}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusLine({ children, color }) {
  return (
    <p style={{ margin: 0, fontSize: '.78rem', color: color || 'rgba(0,0,0,0.7)', fontStyle: 'italic' }}>
      {children}
    </p>
  );
}

function MiniField({ label, value, accent, fieldBg, fieldBorder, valueColor }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: fieldBg, border: `1px solid ${fieldBorder}` }}>
      <span style={{ display: 'block', fontSize: '.58rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: accent, marginBottom: 3 }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '.8rem', fontWeight: 600, color: valueColor, wordBreak: 'break-word' }}>
        {value || '-'}
      </span>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <span style={{ display: 'block', fontSize: '.65rem', color: 'rgba(0,0,0,0.5)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '.82rem', color: '#e9e9e9', wordBreak: 'break-word' }}>
        {value || '-'}
      </span>
    </div>
  );
}

// ── Shared data + rendering logic ────────────────────────────

// A rack scan schedules per-device OCR in the background (server-side
// scheduleOcrDevices) and EasyOCR on CPU takes 1-2 minutes for a full rack.
// Until it writes ocr_devices.json the GET below answers 404. That 404 means
// "not finished yet", NOT "never coming" — so we keep checking instead of
// freezing on the first miss, which is what stranded this page on a
// permanent "Scanning…" panel that nothing would ever clear.
const OCR_POLL_INTERVAL_MS = 3_000;
const OCR_POLL_DEADLINE_MS = 4 * 60_000;   // comfortably past the server's own 5-min cap on a fresh run

// Switch Information is switches only — routers are a different device class
// and were showing up here mislabelled as switches (e.g. a Mikrotik router).
const NETWORK_CLASSES = ['switch'];
const isSwitchClass = (d) => NETWORK_CLASSES.includes((d?.class_name || '').toLowerCase());

function useSwitchData(rackId) {
  // The Switches tab is driven purely by what the rack scan saw (detection,
  // then OCR) plus any user overrides — CMDB is intentionally excluded here.
  // The user doesn't want this page to surface ServiceNow-sourced facts; the
  // page's purpose is "what's actually in front of me", not "what does the
  // asset DB claim is in front of me".
  //
  // TWO sources, deliberately, because they arrive minutes apart:
  //   scan_result.json  — written when the scan finishes. Already knows which
  //                       units hold a switch. Available immediately.
  //   ocr_devices.json  — EasyOCR over the photo, 1-2 min later on CPU. Adds
  //                       make / model / firmware to those same devices.
  // The page used to wait for the second one before drawing anything, so a
  // rack whose switches were known the whole time showed an empty panel for
  // minutes. Now the list renders from the scan and the labels fill in.
  const ocrCached  = rackId ? getCached(cacheKey.ocrDevices(rackId)) : null;
  const ocrCachedDevs = ocrCached?.devices && Array.isArray(ocrCached.devices)
    ? ocrCached.devices
    : null;
  const scanCached = rackId ? getCached(cacheKey.scanResult(rackId)) : null;
  const scanCachedDevs = Array.isArray(scanCached?.devices) ? scanCached.devices : null;

  const [ocrDevices, setOcrDevices]   = useState(ocrCachedDevs);
  const [scanDevices, setScanDevices] = useState(scanCachedDevs);
  // How the label pass is going. Only decides the footnote under the list
  // now — it no longer gates whether the list renders at all.
  //   pending — not ready yet (404); still polling
  //   ready   — labels merged in
  //   stalled — polled past the deadline; stopped
  //   error   — failed for a reason other than "not yet"
  const [ocrStatus, setOcrStatus] = useState(ocrCachedDevs ? 'ready' : 'pending');
  // What the live switches said about themselves, by rack position. A switch
  // stating its own model outranks OCR of a photograph of it, so where a
  // reading has been matched to a box in this rack, it wins.
  const [liveByU, setLiveByU] = useState(null);
  const [scanLoaded, setScanLoaded] = useState(!!scanCachedDevs);
  const [attempt, setAttempt] = useState(0);   // bumped by recheck() to re-run the effects

  // ── The fast half: the switch list, straight from the scan ──
  useEffect(() => {
    if (!rackId || scanCachedDevs) { setScanLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/result`));
        if (!r.ok) throw new Error(String(r.status));
        const text = await r.text();
        const data = text ? JSON.parse(text) : null;
        if (cancelled) return;
        if (Array.isArray(data?.devices)) {
          setScanDevices(data.devices);
          setCached(cacheKey.scanResult(rackId), data);
        }
      } catch { /* the OCR pass below can still carry the page */ }
      finally { if (!cancelled) setScanLoaded(true); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId, attempt]);

  // ── The slow half: labels, polled until they land ──
  useEffect(() => {
    if (!rackId)       { setOcrStatus('stalled'); return; }
    if (ocrCachedDevs) { setOcrStatus('ready'); return; }

    let cancelled = false;
    let timer = null;
    const deadline = Date.now() + OCR_POLL_DEADLINE_MS;

    const poll = async () => {
      let r;
      try {
        r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/ocr-devices`));
      } catch {
        if (!cancelled) setOcrStatus('error');
        return;
      }
      if (cancelled) return;

      if (r.status === 404) {
        if (Date.now() >= deadline) { setOcrStatus('stalled'); return; }
        setOcrStatus('pending');
        timer = setTimeout(poll, OCR_POLL_INTERVAL_MS);
        return;
      }
      if (!r.ok) { setOcrStatus('error'); return; }

      let ocrData = null;
      try {
        const text = await r.text();
        ocrData = text ? JSON.parse(text) : null;
      } catch { ocrData = null; }
      if (cancelled) return;

      const devs = Array.isArray(ocrData) ? ocrData
                 : (ocrData?.devices && Array.isArray(ocrData.devices)) ? ocrData.devices
                 : null;
      if (!devs) { setOcrStatus('error'); return; }

      setOcrDevices(devs);
      setCached(cacheKey.ocrDevices(rackId), ocrData);
      setOcrStatus('ready');
    };

    setOcrStatus('pending');
    poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId, attempt]);

  // ── The third source: whatever the phone read off the switches ──
  //
  // The Switches tab was the camera's view alone — detection, then OCR. But
  // for any switch somebody has actually read over SNMP, the make, model and
  // serial are not a guess from a photograph: they are the box saying what it
  // is. Where a reading has been matched to a position in this rack, those
  // values fill the card. The source of truth is whichever witness knows.
  useEffect(() => {
    if (!rackId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const a = await authFetch(apiUrl(`/api/nb/scans/adopt/${encodeURIComponent(rackId)}`), { method: 'POST' });
        if (!a.ok || cancelled) return;
        const { id } = await a.json();
        const v = await authFetch(apiUrl(`/api/nb/scans/${id}/reconcile`));
        if (!v.ok || cancelled) return;
        const view = await v.json();
        const uOf = new Map((view.devices || []).map((d) => [d.uid, d.position]));
        const byU = {};
        for (const sw of view.switches || []) {
          const u = sw.matchedTo ? uOf.get(sw.matchedTo) : null;
          if (u == null) continue;
          byU[Number(u)] = {
            make: sw.vendor || '',
            model: sw.model || '',
            serial: sw.serial || '',
            firmware: sw.firmware || '',
            hardware: sw.hardware || '',
            sysName: sw.sysName || '',
            host: sw.host || '',
            label: sw.label || '',
            // The switch's own count of its sockets. The camera counted 24
            // RJ45 on a box whose spec sheet says 28 — it cannot see the four
            // SFP cages as ports — and the card showed 24 above a table
            // saying 28. The box knows.
            ports: Number(sw.ports) || 0,
          };
        }
        if (!cancelled) setLiveByU(byU);
      } catch { /* the camera's view still stands on its own */ }
    })();
    return () => { cancelled = true; };
  }, [rackId, attempt]);

  const recheck = () => setAttempt(n => n + 1);

  // Re-read the overrides when a card saves one, so the note under the list
  // disappears as soon as the last unknown switch is named.
  const [, bumpOverrides] = useState(0);
  useEffect(() => {
    const onSaved = () => bumpOverrides((n) => n + 1);
    window.addEventListener('rt:device-override', onSaved);
    return () => window.removeEventListener('rt:device-override', onSaved);
  }, []);

  // OCR is authoritative once it lands — it covers the same devices as the
  // scan (both derive from device_unit_map.json) and adds make/model. Until
  // then the scan's switches stand in, keyed by position so React swaps the
  // labels in place rather than remounting the cards.
  const labelled = (ocrDevices || []).filter(isSwitchClass);
  const detected = (scanDevices || []).filter(isSwitchClass);
  const source   = labelled.length ? labelled : detected;
  const awaitingLabels = !labelled.length && detected.length > 0 && ocrStatus === 'pending';

  const switches = source.map((d, i) => {
    // Prefer extracting from raw_text (more complete), fall back to d.model
    const rawExtracted = extractModelFromRaw(d.raw_text, d.make);
    const model = expandPartialModel(rawExtracted || d.model || '');
    const position = (d.position || '').toUpperCase();
    // The switch's own account of itself, if one has been read and matched to
    // this position. It goes first: OCR reads a photograph of a label, this is
    // the box answering the question.
    const uNum = Number(String(position).replace(/\D/g, ''));
    const live = (liveByU && Number.isFinite(uNum)) ? liveByU[uNum] : null;
    // How many SFP cages the camera saw on this box. The scan carries it per
    // device; the OCR record does not, so it is looked up by position.
    const scanTwin = (scanDevices || []).find((x) =>
      Number(String(x.position || '').replace(/\D/g, '')) === uNum
      || (x.units && x.units.some((u) => Number(String(u).replace(/\D/g, '')) === uNum)));
    const sfpCount = Number(d.sfp_ports ?? scanTwin?.sfp_ports ?? 0) || 0;
    return {
      name: position ? `${d.class_name} (${position})` : (d.name || d.class_name || 'Detected switch'),
      manufacturer: live?.make || d.make || '',
      model_number: live?.model || model,
      os_version: live?.firmware || d.version || '',
      serial_number: live?.serial || '',
      mac_address: '',
      ip_address: live?.host || '',
      position,
      discovery_source: live ? 'switch' : (d.source || 'ocr'),
      // What the switch calls itself, and what somebody named it in RackTrack.
      live_sys_name: live?.sysName || '',
      hardware_rev: live?.hardware || '',
      live_label: live?.label || '',
      _fromSwitch: Boolean(live),
      ocr_conf: d.match_conf,
      raw_text: d.raw_text || '',
      port_count: live?.ports || d.port_count,
      sfp_count: sfpCount,
      _fromOcr: true,
      // True while this card is a scan-detected switch whose label hasn't
      // been read yet — distinct from "OCR ran and couldn't read it", which
      // is what the manual-entry prompts are for.
      _awaitingLabel: awaitingLabels && !live,
      _key: position || `i${i}`,
    };
  });

  // Only a page with nothing at all to draw is still "loading".
  const status = switches.length ? 'ready'
    : !scanLoaded || ocrStatus === 'pending' ? 'loading'
    : ocrStatus === 'error' ? 'error'
    : 'empty';

  // Whether anything on screen is still missing its make and model.
  //
  // The note under the list says the labels are being read. It was tied to
  // the OCR poll alone, so it stayed up after somebody typed the make and
  // model in themselves — the page telling a person it was busy finding out
  // the very thing they had just told it. It is about what is missing, so it
  // asks what is missing.
  const unidentified = switches.filter((sw) => (
    !(sw.manufacturer || loadOverride(rackId, sw, 'make'))
    || !(sw.model_number || loadOverride(rackId, sw, 'model'))
  )).length;

  return { status, ocrStatus, recheck, switches, unidentified };
}

// The states where work is genuinely in flight. Carries a live indicator so
// "in progress" and "given up" don't look the same on screen — the old panel
// said "Scanning…" in both cases and animated in neither.
function WorkingPanel({ title, detail }) {
  return (
    <div style={{ padding: '32px 16px', textAlign: 'center' }}>
      <span aria-hidden="true" className={desk.pulseDot} />
      <p style={{ margin: '12px 0 0', fontWeight: 600, color: '#121212', fontSize: '.92rem' }}>
        {title}
      </p>
      <p style={{ margin: '6px auto 0', maxWidth: 420, fontSize: '.78rem', color: '#717171', lineHeight: 1.5 }}>
        {detail}
      </p>
    </div>
  );
}

// The states where nothing more will happen on its own. Each says which one
// it is and offers the only useful next step, rather than dead-ending.
function RestingPanel({ title, detail, onRetry, retryLabel = 'Check again' }) {
  return (
    <div style={{
      marginTop: 18, padding: 16, borderRadius: 12,
      background: '#ffffff',
      border: '1px dashed #e6e6e6',
    }}>
      <p style={{ margin: 0, fontWeight: 600, color: '#121212', fontSize: '.92rem' }}>
        {title}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: '.78rem', color: '#717171', lineHeight: 1.5 }}>
        {detail}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 12, padding: '7px 14px', borderRadius: 8,
            border: '1px solid #121212', background: 'transparent',
            color: '#121212', fontSize: '.78rem', fontWeight: 700,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >{retryLabel}</button>
      )}
    </div>
  );
}

// A one-line footnote under the list, for when the switches are on screen but
// their labels are still being read. It belongs under the cards rather than in
// front of them — the list is already useful, and blocking it behind this
// message is the thing that made the page feel slow.
function LabelProgressNote({ ocrStatus, unidentified, onRetry }) {
  if (ocrStatus === 'ready') return null;
  // Nothing is waiting to be filled in: every switch on screen has a make and
  // a model, wherever they came from.
  if (!unidentified) return null;
  const working = ocrStatus === 'pending';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      marginTop: 14, padding: '10px 14px', borderRadius: 10,
      background: '#ffffff', border: '1px dashed #e6e6e6',
    }}>
      {working && <span aria-hidden="true" className={desk.pulseDot} />}
      <span style={{ fontSize: '.76rem', color: '#717171', lineHeight: 1.5 }}>
        {working
          ? 'Reading make and model from the device labels - they fill in here as they land.'
          : 'Couldn’t read the device labels. Positions and port counts are from the scan; add make and model yourself on any card.'}
      </span>
      {!working && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginLeft: 'auto', padding: '5px 12px', borderRadius: 8,
            border: '1px solid #121212', background: 'transparent',
            color: '#121212', fontSize: '.74rem', fontWeight: 700,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >Check again</button>
      )}
    </div>
  );
}

function SwitchInfoBody({ rackId, status, ocrStatus, switches, recheck, unidentified }) {
  if (status === 'loading') {
    return <WorkingPanel
      title="Finding switches…"
      detail="Reading what the last rack scan found in this rack." />;
  }

  if (status === 'error') {
    return <RestingPanel
      title="Couldn't load switch data"
      detail="The server didn't return this rack's devices."
      onRetry={recheck} />;
  }

  if (switches.length === 0) {
    return <RestingPanel
      title="No switches detected"
      detail="The scan of this rack didn't identify any device as a switch. If there is one here, re-run the rack scan - make and model read best when the faceplate is square-on and well lit."
      onRetry={recheck} />;
  }

  return (
    <>
      <SwitchPicker switches={switches} rackId={rackId} />
      <LabelProgressNote ocrStatus={ocrStatus} unidentified={unidentified} onRetry={recheck} />
    </>
  );
}

// ── Switch picker — replaces the old stacked-rows layout ────
// Horizontal tab strip of every detected switch. Selecting a tab swaps
// in its fully-expanded detail panel. For single-switch racks the picker
// collapses to just the panel (no point in a single tab).
function SwitchPicker({ switches, rackId }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, switches.length - 1);
  const active  = switches[safeIdx];

  // Whether the rail is scrolled, and which way it can still go.
  //
  // On a phone the rail is a horizontal strip with its scrollbar hidden, so a
  // rack with four switches looked exactly like a rack with two: the third and
  // fourth sat off the right edge with nothing to say they existed. Testers
  // reported not knowing there were more cards, which is the correct reading of
  // what was on screen. These two flags drive an arrow at each end.
  const railRef = useRef(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const readScroll = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    // A 2px slack: sub-pixel widths mean scrollLeft rarely reaches the exact
    // maximum, which would leave the right arrow lit at the end of the strip.
    const max = el.scrollWidth - el.clientWidth;
    setCanScroll({ left: el.scrollLeft > 2, right: el.scrollLeft < max - 2 });
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return undefined;
    readScroll();
    el.addEventListener('scroll', readScroll, { passive: true });
    // The rail also becomes a vertical list at container widths over 880px,
    // where none of this applies — a resize observer catches that flip as well
    // as the phone rotating.
    const ro = new ResizeObserver(readScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', readScroll); ro.disconnect(); };
  }, [readScroll, switches.length]);

  // One card's width per press, so a tap advances by a card rather than an
  // arbitrary number of pixels.
  const nudge = (dir) => () => {
    const el = railRef.current;
    if (!el) return;
    const card = el.firstElementChild;
    const step = card ? card.getBoundingClientRect().width + 10 : el.clientWidth * 0.8;
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  // Build a short label per switch — prefer position (U09 / U07) when the
  // OCR caught it, fall back to the short model, then to the index.
  const tabLabel = (sw, i) => {
    if (sw.position) return sw.position;
    if (sw.model_number) {
      const m = String(sw.model_number);
      return m.length > 18 ? m.slice(0, 16) + '…' : m;
    }
    return `Switch ${i + 1}`;
  };
  const tabSub = (sw) => {
    if (sw.model_number) {
      const m = String(sw.model_number);
      return m.length > 18 ? m.slice(0, 16) + '…' : m;
    }
    return sw.manufacturer || '';
  };

  const multi = switches.length > 1;

  return (
    // `.switchLayout` is a container-query context; `.master` (added only
    // when there's >1 switch) turns it into a rail + detail grid once the
    // container is wide enough. Narrow/embedded/mobile contexts stay stacked.
    <section className={`${desk.switchLayout} ${multi ? desk.master : ''}`}>
      {multi && (
        <div className={desk.railWrap}>
        <button
          type="button"
          className={`${desk.railArrow} ${desk.railArrowLeft}`}
          onClick={nudge(-1)}
          disabled={!canScroll.left}
          aria-label="Previous switches"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <button
          type="button"
          className={`${desk.railArrow} ${desk.railArrowRight}`}
          onClick={nudge(1)}
          disabled={!canScroll.right}
          aria-label="More switches"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
        <div
          ref={railRef}
          role="tablist"
          aria-label="Switches detected in this rack"
          className={desk.rail}>
          {switches.map((sw, i) => {
            const on = i === safeIdx;
            return (
              <button
                key={sw.serial_number || sw.name || i}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setActiveIdx(i)}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  padding: on ? '14px 14px 14px 18px' : '14px',
                  borderRadius: 14,
                  border: on
                    ? '2px solid var(--md-on-surface, #121212)'
                    : '1px solid var(--md-outline-variant, #E0E0E0)',
                  background: 'var(--md-surface-container-lowest, #FFFFFF)',
                  color: 'var(--md-on-surface, #121212)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  textAlign: 'left',
                  transition: 'border-color 0.16s, padding 0.16s',
                  overflow: 'hidden',
                  minWidth: 0,
                }}>
                {/* Left accent strip on the active card */}
                {on && (
                  <span aria-hidden="true" style={{
                    position: 'absolute',
                    left: 0, top: 0, bottom: 0,
                    width: 4,
                    background: 'var(--md-on-surface, #121212)',
                  }} />
                )}

                {/* Tiny status dot — black filled for active, hollow for inactive */}
                <span aria-hidden="true" style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: on ? 'var(--md-on-surface, #121212)' : 'transparent',
                    border: on ? 'none' : '1.5px solid var(--md-on-surface, #121212)',
                    opacity: on ? 1 : 0.55,
                    transition: 'background 0.14s, opacity 0.14s',
                  }} />
                  <span style={{
                    fontFamily: 'var(--font, inherit)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: 'var(--md-on-surface, #121212)',
                    opacity: on ? 0.7 : 0.45,
                  }}>
                    Switch {i + 1}
                  </span>
                </span>

                <span style={{
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                  lineHeight: '22px',
                  color: 'var(--md-on-surface, #121212)',
                }}>
                  {tabLabel(sw, i)}
                </span>

                {tabSub(sw) && (
                  <span style={{
                    fontFamily: 'var(--mono, ui-monospace, monospace)',
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: 0,
                    lineHeight: '14px',
                    color: 'var(--md-on-surface, #121212)',
                    opacity: 0.6,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {tabSub(sw)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </div>
      )}

      <div className={desk.detail}>
        {active && (
          <SwitchCard
            key={active.serial_number || active.name || safeIdx}
            sw={active}
            rackId={rackId}
            defaultExpanded
          />
        )}
      </div>
    </section>
  );
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function SwitchInfoContent({ rackId }) {
  const d = useSwitchData(rackId);
  return <SwitchInfoBody rackId={rackId} {...d} />;
}

// ── Standalone page (used by /switch-info route) ─────────────
export default function SwitchInformationPage() {
  const navigate = useNavigate();
  const goBack = useSmartBack();
  const location = useLocation();
  const params = useParams();
  const rackId = params.rackId || location.state?.rackId || null;
  const switchData = useSwitchData(rackId);

  // The page root is `.page.page-full` (height:100dvh, overflow:hidden), so the
  // content must scroll in its OWN container — otherwise long spec tables get
  // clipped and the page can't be scrolled on mobile. A ref on that container
  // also drives the "Back to top" button.
  const scrollRef = useRef(null);
  const [showTop, setShowTop] = useState(false);

  return (
    <div className={`page page-full ${styles.specs} ${desk.main}`}>
      <div className={styles.amb} />
      <div className={styles.amb2} />

      <header className={`${styles.header} ${desk.header}`}>
        <button className={styles.backBtn} onClick={() => goBack()} aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <h1 className={styles.title}>Switch Information</h1>
        <ThemeToggle />
      </header>

      <div
        className={styles.scrollBody}
        ref={scrollRef}
        onScroll={(e) => setShowTop(e.currentTarget.scrollTop > 320)}
      >
        <SwitchInfoBody rackId={rackId} {...switchData} />
      </div>

      {showTop && (
        <button
          type="button"
          className={styles.backToTop}
          onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Back to top"
          title="Back to top"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5"/>
            <polyline points="5 12 12 5 19 12"/>
          </svg>
        </button>
      )}
    </div>
  );
}
