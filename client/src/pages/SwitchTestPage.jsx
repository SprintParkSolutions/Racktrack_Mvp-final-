import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { BackIcon } from '../components/BackButton.jsx';
import PlacePicker from '../components/PlacePicker.jsx';
import { getJSON, setJSON } from '../utils/safeStorage';
import { apiUrl, authFetch } from '../utils/api';
import { testLogin, readSwitch, toServerReading, canReadSwitches } from '../utils/snmpClient';
import styles from './SwitchTestPage.module.css';

// Switch test — the phone talking to a switch directly, over SNMP.
//
// This screen exists to answer one question: can the handset reach a managed
// switch on the network it is standing on? Every previous attempt went
// phone → our server → switch, and the server sits in a data centre with no
// route to a private address inside somebody's building. Here the phone sends
// the packets itself.
//
// Two dialects, both without cryptography: v2c with a community string (the
// D-Link), and v3 with a user name at noAuthNoPriv (the TP-Links, which is how
// they are configured and how every stored reading of them was taken). Nothing
// on this screen can fail for a reason we would have to separate from the
// reachability question we are actually asking. v3 with a password is written
// and proven on the server; it comes to the phone once these switches need it.
//
// The switches a tester adds are kept ON THE PHONE, in local storage, and are
// never sent anywhere. This is a throwaway test screen and the addresses are
// somebody's real infrastructure; storing them on the server would mean asking
// permission we have not asked for.

// Switches are filed against a rack when the page is opened as a rack's
// Network step (/results/:rackId/network); the rack-less menu entry keeps the
// original list. A rack that has none yet inherits the rack-less list once, so
// the switches someone already typed in show up where the chain needs them.
// The switches a person adds are THEIR switches — the ones standing on the
// network they are standing on. They were kept per rack, so three typed in
// from the menu were invisible on a rack's Network step and vice versa: the
// same lab, two lists, and no way to tell from the screen which one you were
// looking at. One list now, on the phone, whichever door you came in by.
// Readings are kept with them for the same reason.
const STORE = 'rt_snmp_test_switches';
const RESULTS = 'rt_snmp_results';
const NETWORK_STATE = (rackId) => `rt_network_state_${rackId}`;

/**
 * Fold every per-rack list this phone wrote before into the one list, once.
 *
 * Matching on address, because that is what identifies a switch; a switch
 * already in the list keeps its entry (and its server ids) and the older
 * duplicate is dropped.
 */
function foldOldLists() {
  let list = getJSON(STORE, []) || [];
  let results = getJSON(RESULTS, {}) || {};
  let keys = [];
  try { keys = Object.keys(window.localStorage); } catch { return { list, results }; }

  const seen = new Set(list.map((s) => `${s.host}:${s.port}`));
  let moved = false;
  for (const k of keys) {
    if (k.startsWith('rt_snmp_switches_')) {
      for (const sw of getJSON(k, []) || []) {
        const at = `${sw.host}:${sw.port}`;
        if (seen.has(at)) continue;
        seen.add(at);
        list = [...list, sw];
        moved = true;
      }
    } else if (k.startsWith('rt_snmp_results_')) {
      results = { ...(getJSON(k, {}) || {}), ...results };
      moved = true;
    }
  }
  if (moved) { setJSON(STORE, list); setJSON(RESULTS, results); }
  return { list, results };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * File the phone's reading on the server, so Report, Review and Export see
 * what the switch said and not only what the camera saw.
 *
 * The phone took the reading because the server cannot reach the switch; the
 * server still keeps the record, because that is where the rest of the chain
 * reads from. The first time a switch is filed, a server-side record is made
 * for it (credentials go up over HTTPS and are stored encrypted there — never
 * shown back), and its id is remembered on the phone so the next reading
 * lands on the same record. A server that cannot be reached is not an error
 * in the reading: the result is kept on the phone and marked "phone only".
 */
/**
 * The server's record for this switch, made if it does not exist yet.
 *
 * Credentials travel here over HTTPS and are stored encrypted; the server
 * never hands them back to a browser. Returns the server's id, or null when
 * the record could not be made.
 */
const serverIdFor = (sw, rackId) => (rackId && sw.serverIds ? sw.serverIds[rackId] : null) || null;

async function ensureServerSwitchId(rackId, sw) {
  if (!rackId) return null;
  // One switch, one record PER RACK: the server files a reading against the
  // rack it was taken for. Remembering a single id would file the second
  // rack's reading against the first rack's switch.
  const known = serverIdFor(sw, rackId);
  if (known) return known;
  const list = await authFetch(apiUrl(`/api/nb/switches?rackId=${encodeURIComponent(rackId)}`));
  if (list.ok) {
    const found = (await list.json()).find((s) => s.host === sw.host && Number(s.port) === Number(sw.port));
    if (found) return found.id;
  }
  const body = { rackId, label: sw.label, host: sw.host, port: sw.port, version: sw.version || 'v2c' };
  if (body.version === 'v3') { body.username = sw.username; body.securityLevel = 'noAuthNoPriv'; }
  else body.community = sw.community ?? 'public';
  const made = await authFetch(apiUrl('/api/nb/switches'), {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  if (!made.ok) return null;
  return (await made.json()).id;
}

async function fileOnServer(rackId, sw, data, rememberServerId) {
  if (!rackId) return { ok: false, why: 'This page is not attached to a rack.' };
  try {
    const serverId = await ensureServerSwitchId(rackId, sw);
    if (!serverId) return { ok: false, why: 'The server would not file this switch.' };
    if (serverId !== serverIdFor(sw, rackId)) rememberServerId(serverId);

    const filed = await authFetch(apiUrl(`/api/nb/switches/${serverId}/reading`), {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(toServerReading(data)),
    });
    if (!filed.ok) return { ok: false, why: `The server would not take the reading (HTTP ${filed.status}).` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message || 'The server could not be reached.' };
  }
}

/** The person pressed Stop. Not an error: nothing went wrong. */
class Stopped extends Error {}

/** A failure that reads like the SNMP client's, so one renderer handles both. */
class SnmpishError extends Error {
  constructor(message, hint = '') { super(message); this.hint = hint; }
}

/**
 * A server-side reading, in the shape this screen draws.
 *
 * The server's collector returns the record it stores — the same one
 * toServerReading() produces from a phone reading — so this is that
 * conversion run backwards, and the screen never learns which machine asked.
 */
function fromServerReading(body) {
  const d = body?.data || body || {};
  const sys = d.system || {};
  const ident = d.identity || {};
  const ifaces = (d.interfaces || []).map((i) => ({
    index: i.ifIndex, name: i.name, descr: i.alias ?? null,
    up: i.operStatus === 'up', enabled: i.adminStatus === 'up',
    speedMbps: i.speedMbps ?? null,
    mac: i.mac ?? null, duplex: i.duplex ?? null,
    type: i.type === 'ethernet' ? 6 : null,
  }));
  const neigh = (d.neighbours || []).map((n) => ({
    sysName: n.remoteSysName ?? n.chassisId ?? null,
    port: n.remotePortId ?? null,
    localPort: n.localPortName ?? n.localPort ?? null,
    named: Boolean(n.remoteSysName),
  }));
  // Everything the switch has learned, as the phone's own reading shapes it.
  const nameOf = new Map(ifaces.map((i) => [i.index, i.name]));
  const attached = (d.macs || []).map((m) => ({
    mac: m.mac, vlan: m.vlan ?? null, ifIndex: m.ifIndex ?? null,
    port: m.port || nameOf.get(m.ifIndex) || (m.ifIndex != null ? String(m.ifIndex) : null),
    ip: m.ip ?? (d.arp || []).find((a) => a.mac === m.mac)?.ip ?? null,
  }));
  for (const i of ifaces) i.attached = attached.filter((a) => a.ifIndex === i.index).length;
  return {
    sysName: sys.sysName ?? d.sysName ?? null,
    sysDescr: sys.sysDescr ?? null,
    vendor: sys.vendor ?? ident.manufacturer ?? d.vendor ?? null,
    model: ident.model ?? sys.derivedModel ?? d.model ?? null,
    serial: ident.serial ?? null,
    uptime: sys.uptimeSeconds != null ? sys.uptimeSeconds * 100 : null,
    interfaces: ifaces,
    neighbours: neigh,
    attached,
    gaps: d.gaps || [],
    counts: {
      ports: ifaces.length,
      up: ifaces.filter((i) => i.up).length,
      neighbours: neigh.length,
      attached: attached.length,
    },
    filed: true,
  };
}

/** What the chain shows for this rack's Network step: how much has been read. */
function saveNetworkState(rackId, resultsMap) {
  if (!rackId) return;
  const full = Object.values(resultsMap).filter((r) => r && r.kind === 'full');
  setJSON(NETWORK_STATE(rackId), {
    read: full.length,
    ports: full.reduce((n, r) => n + (r.counts?.ports || 0), 0),
    up: full.reduce((n, r) => n + (r.counts?.up || 0), 0),
    at: new Date().toISOString(),
  });
}

// Nothing is filled in. A pre-filled 161 and "public" are guesses about
// somebody else's network wearing the clothes of a fact — and a person who
// taps past them has told us nothing while the screen looks like they did.
const BLANK = {
  label: '', host: '', port: '',
  version: '', community: '',
  username: '', securityLevel: 'noAuthNoPriv',
};

/** The number a person reads off the faceplate: "1/0/24" is port 24. */
const portNum = (name) => {
  const m = String(name || '').match(/(\d+)(?!.*\d)/);
  return m ? m[1] : String(name || '').slice(-3);
};

/** Seconds of uptime, as something a person would say. */
function uptimeText(ticks) {
  if (!ticks && ticks !== 0) return null;
  const secs = Math.floor(Number(ticks) / 100);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `up ${d} day${d === 1 ? '' : 's'}`;
  if (h > 0) return `up ${h} hour${h === 1 ? '' : 's'}`;
  return `up ${Math.max(1, Math.floor(secs / 60))} min`;
}

/** A link speed as a network person says it. */
function speedText(mbps) {
  const n = Number(mbps || 0);
  if (!n) return '';
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000} Gb`;
  return `${n} Mb`;
}

// A VLAN interface is not a socket on the front of the box. New readings are
// filtered by ifType where the switch states it; a reading taken before the
// phone kept the type falls back to what the interface is called.
const VIRTUAL_NAME = /vlan|loopback|^lo\d|tunnel|null ?0|port-?channel|^po\d|aggregat|^ae\d/i;
const isSocket = (i) => (i.type ? Number(i.type) === 6 : !VIRTUAL_NAME.test(i.name || ''));
const socketsOf = (r) => (r?.interfaces || []).filter(isSocket);

/** Ports that are up, gathered by the speed they are running at. */
function speedGroups(sockets) {
  const by = new Map();
  for (const i of sockets) {
    if (!i.up) continue;
    const label = speedText(i.speedMbps) || 'up';
    if (!by.has(label)) by.set(label, []);
    by.get(label).push(i);
  }
  return [...by.entries()]
    .map(([label, ports]) => ({ label, ports, rank: Number(ports[0].speedMbps) || 0 }))
    .sort((a, b) => b.rank - a.rank);
}

/** The ports somebody has written a name on. */
const labelled = (sockets) => sockets.filter((i) => i.descr);

/** What LLDP saw on one of our ports, if anything. */
const neighbourOn = (r, name) =>
  (r.neighbours || []).find((n) => n.localPort && String(n.localPort) === String(name)) || null;

export default function SwitchTestPage() {
  const navigate = useNavigate();
  const { rackId } = useParams();

  const [switches, setSwitches] = useState([]);
  const [form, setForm] = useState(null);        // null, or the switch being added
  const [busy, setBusy] = useState(null);        // switch id currently talking
  const [step, setStep] = useState('');          // what it is doing right now
  const [results, setResults] = useState({});    // id -> what came back
  const [errors, setErrors] = useState({});      // id -> what went wrong

  // Where each switch sits in the rack.
  //
  // The camera knows WHERE a device is and guesses what it is; the switch
  // states exactly what it is and has no idea where it sits. Neither can be
  // matched to the other with certainty — two identical switches in one rack
  // look the same to both — so the server proposes a match by port count and a
  // person confirms it here, next to the reading, rather than on a separate
  // screen. Nothing is written until Save.
  const [scanId, setScanId] = useState(null);
  const [places, setPlaces] = useState(null);    // { devices, switches, matches }
  const [match, setMatch] = useState({});        // serverSwitchId -> deviceUid | ''
  const [savingMatch, setSavingMatch] = useState(false);

  // Per-switch view state: whose action menu is open, which port was tapped on
  // the faceplate, and whether the port list is showing everything or only the
  // ports that are actually carrying something.
  const [menuFor, setMenuFor] = useState(null);
  const stopRef = useRef(new Set());
  const [pin, setPin] = useState({});
  const [more, setMore] = useState({});
  const [formErr, setFormErr] = useState(null);
  const [matchNote, setMatchNote] = useState(null);

  // The switches and what they last said, from the one list, folding in
  // anything an older build filed per rack.
  useEffect(() => {
    const { list, results: kept } = foldOldLists();
    setSwitches(list);
    setResults(kept);
    setErrors({});
  }, []);

  // Persist every result as it changes, so the page reopens in its read state.
  useEffect(() => {
    if (Object.keys(results).length) setJSON(RESULTS, results);
  }, [results]);

  /** Ask the server where each read switch sits, and what it proposes. */
  const loadPlaces = useCallback(async () => {
    if (!rackId) return;
    try {
      const a = await authFetch(apiUrl(`/api/nb/scans/adopt/${encodeURIComponent(rackId)}`), { method: 'POST' });
      if (!a.ok) return;
      const { id } = await a.json();
      setScanId(id);
      const v = await authFetch(apiUrl(`/api/nb/scans/${id}/reconcile`));
      if (!v.ok) return;
      const view = await v.json();
      setPlaces(view);
      // Start from what is stored; otherwise take what the server proposes.
      //
      // Only a HIGH-confidence proposal used to be taken, which in practice
      // meant almost none: the camera reads "Unidentified Switch, make
      // unknown" off most boxes, so the port count is the only evidence and
      // the score never reached high — and the screen said "Not placed yet"
      // about a rack the server had already worked out. Every proposal is
      // taken now; it is shown as a suggestion, and one tap changes it.
      // Once places have been saved they are the truth, including "not in
      // this rack": falling back to the server's proposal for an empty stored
      // place made a saved "none" spring back to the suggestion the moment
      // Save finished, which read as Save not working.
      const start = {};
      for (const s of view.switches || []) {
        start[s.id] = view.suggested ? (s.autoMatch?.deviceUid || '') : (s.matchedTo || '');
      }
      setMatch(start);

      // Nothing has ever been stored for this rack and the server has
      // proposed something: store it, so the report and the export show the
      // rack as matched without anyone having to press Save on a screen they
      // agreed with. A person who disagrees changes it and saves again.
      if (view.suggested && Object.values(start).some(Boolean)) {
        authFetch(apiUrl(`/api/nb/scans/${id}/reconcile`), {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ matches: Object.fromEntries(
            Object.entries(start).map(([k, v]) => [k, v || null])) }),
        }).catch(() => { /* it stays a suggestion until someone saves it */ });
      }
    } catch { /* the rack simply has no places to offer yet */ }
  }, [rackId]);

  useEffect(() => { loadPlaces(); }, [loadPlaces]);


  /** Save the places; returns true when the server took them. */
  const savePlaces = async () => {
    if (!scanId) {
      setMatchNote({ ok: false, text: 'This rack is not on the server yet. Open it from Scan once, then save.' });
      return false;
    }
    setSavingMatch(true); setMatchNote(null);
    try {
      const r = await authFetch(apiUrl(`/api/nb/scans/${scanId}/reconcile`), {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ matches: Object.fromEntries(Object.entries(match).map(([k, v]) => [k, v || null])) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Say exactly what was saved, switch by switch, so a wrong place is seen here.
      const devName = (uid) => {
        const d = (places?.devices || []).find((x) => x.uid === uid);
        return d ? `U${String(d.u ?? d.position ?? '').padStart(2, '0')}` : null;
      };
      const said = (places?.switches || []).map((s) => {
        const where = match[s.id] ? (devName(match[s.id]) || 'placed') : 'not in this rack';
        return `${s.label || s.name || s.host || s.id} → ${where}`;
      });
      setMatchNote({ ok: true, text: said.length ? `Saved: ${said.join(' · ')}.` : 'Saved.' });
      loadPlaces();
      return true;
    } catch (e) {
      setMatchNote({ ok: false, text: `Not saved: ${e.message}` });
      return false;
    } finally {
      setSavingMatch(false);
    }
  };

  const persist = useCallback((next) => {
    setSwitches(next);
    setJSON(STORE, next);
  }, []);

  // Add and edit share one form. Editing exists because a DHCP lease moves:
  // the TP-Links went from .101/.102 to .11/.12 between one week and the next,
  // and "remove it and type everything again" is the wrong answer to that.
  const openEdit = (sw) => { setFormErr(null); setForm({ ...BLANK, ...sw }); };

  const save = () => {
    const host = String(form.host || '').trim();
    const version = form.version === 'v3' ? 'v3' : form.version === 'v2c' ? 'v2c' : '';
    const port = String(form.port || '').trim();
    const community = String(form.community || '').trim();
    const username = String(form.username || '').trim();

    // Say what is missing. Returning quietly made Save look broken.
    const missing = [];
    if (!String(form.label || '').trim()) missing.push('a name');
    if (!host) missing.push('the address');
    if (!Number(port)) missing.push('the port');
    if (!version) missing.push('how it is set up');
    else if (version === 'v3' && !username) missing.push('the user name');
    else if (version === 'v2c' && !community) missing.push('the community');
    if (missing.length) { setFormErr(`Still needed: ${missing.join(', ')}.`); return; }
    setFormErr(null);

    const entry = {
      id: form.id || `sw_${Date.now()}`,
      label: String(form.label).trim(),
      host,
      port: Number(port),
      version,
      community: version === 'v2c' ? community : undefined,
      username: version === 'v3' ? username : undefined,
      securityLevel: version === 'v3' ? 'noAuthNoPriv' : undefined,
    };
    if (form.id) {
      persist(switches.map((x) => (x.id === form.id ? entry : x)));
      clearFor(form.id);                // what it said before is about the old address
    } else {
      persist([...switches, entry]);
    }
    setForm(null);
    // Saving IS the instruction to go and read it. Nobody adds a switch in
    // order to look at its address; they add it to find out what it is.
    doRead(entry);
  };

  const remove = (sw) => {
    persist(switches.filter((x) => x.id !== sw.id));
    setResults((m) => { const n = { ...m }; delete n[sw.id]; return n; });
    setErrors((m) => { const n = { ...m }; delete n[sw.id]; return n; });
  };

  const clearFor = (id) => {
    setErrors((m) => ({ ...m, [id]: null }));
    setResults((m) => ({ ...m, [id]: null }));
  };

  // Test login — one question, answered in one round trip. If this works, the
  // phone can reach the switch and the community string is right; everything
  // else is detail.
  // Who talks to the switch.
  //
  // On a phone, this phone does — it is the thing standing on the customer's
  // network. In a browser it cannot: a web page is not allowed a UDP socket.
  // But the server can, whenever it is itself on that network, which is the
  // case for a local install. So the browser asks the server to read instead
  // of refusing, and only says "use the app" when the server cannot reach it
  // either. Same screen, same result, whichever machine did the asking.
  const viaServer = !canReadSwitches();

  /** Remember the server's id for this switch ON THIS RACK. */
  const rememberServerId = useCallback((sw, id) => {
    setSwitches((prev) => {
      const next = prev.map((x) => (x.id === sw.id
        ? { ...x, serverIds: { ...(x.serverIds || {}), [rackId]: id } }
        : x));
      setJSON(STORE, next);
      return next;
    });
  }, [rackId]);

  /** Ask the server to talk to a switch, and shape its answer like the phone's. */
  const serverRead = async (sw, path) => {
    const id = await ensureServerSwitchId(rackId, sw);
    if (!id) throw new SnmpishError('This switch could not be filed on the server.',
      'Open this rack from a scan so the switch has a rack to belong to.');
    if (id !== serverIdFor(sw, rackId)) rememberServerId(sw, id);
    const r = await authFetch(apiUrl(`/api/nb/switches/${id}/${path}`), {
      method: 'POST', headers: JSON_HEADERS, body: '{}',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new SnmpishError(body.error || `The server could not read it (HTTP ${r.status}).`, body.hint);
    return body;
  };

  const doTest = async (sw) => {
    setBusy(sw.id); setStep(viaServer ? 'Asking the server to say hello' : 'Saying hello'); clearFor(sw.id);
    try {
      const info = viaServer ? fromServerReading(await serverRead(sw, 'test')) : await testLogin(sw);
      setResults((m) => ({ ...m, [sw.id]: { kind: 'hello', ...info } }));
    } catch (e) {
      setErrors((m) => ({ ...m, [sw.id]: { message: e.message, hint: e.hint } }));
    } finally {
      setBusy(null); setStep('');
    }
  };

  const doRead = async (sw) => {
    setBusy(sw.id); setStep('Starting'); clearFor(sw.id);
    stopRef.current.delete(sw.id);
    // A full read is a dozen conversations with the switch, each with its own
    // timeout; a switch that has gone away keeps the screen busy for a long
    // while and there was no way out of it but to close the app. The progress
    // callback is the one thing the read touches between conversations, so
    // stopping is a matter of refusing to report the next step.
    const onStep = (msg) => {
      if (stopRef.current.has(sw.id)) throw new Stopped();
      setStep(msg);
    };
    try {
      let data;
      let filed = { ok: false, why: 'Kept on this device.' };
      if (viaServer) {
        // The server reads it and files it in the same call.
        onStep('Asking the server to read it');
        data = fromServerReading(await serverRead(sw, 'collect'));
        filed = { ok: true };
      } else {
        // Paint what the switch has already said, while it is still saying
        // the rest. The make and model land in a fraction of a second; the
        // forwarding table takes seconds longer, and there is no reason to
        // withhold the first until the second arrives.
        data = await readSwitch(sw, onStep, (partial) => {
          setResults((m) => ({ ...m, [sw.id]: { ...(m[sw.id] || {}), ...partial } }));
        });
        if (rackId) {
          onStep('Filing the reading');
          filed = await fileOnServer(rackId, sw, data, (serverId) => rememberServerId(sw, serverId));
        }
      }
      setResults((m) => {
        const next = { ...m, [sw.id]: { kind: 'full', ...data, filed: filed.ok, filedWhy: filed.why } };
        saveNetworkState(rackId, next);   // lights the Network step in the chain
        return next;
      });
    } catch (e) {
      // Stopping is not a failure and does not deserve a red box.
      if (!(e instanceof Stopped)) {
        setErrors((m) => ({ ...m, [sw.id]: { message: e.message, hint: e.hint } }));
      }
    } finally {
      stopRef.current.delete(sw.id);
      setBusy(null); setStep('');
    }
  };

  /**
   * File anything this phone has read but the server has not been told about.
   *
   * A reading is filed at the moment it is taken, for the rack whose Network
   * step took it. Two ordinary things break that: a switch read from the menu
   * entry, which belongs to no rack, and a filing that failed because the
   * server was not reachable at that second. Either way the phone shows the
   * reading and the report says none has been filed — which is exactly what
   * happened, and is fixable without asking anyone to read anything again.
   *
   * So: on opening a rack's Network step, everything read and not yet filed
   * FOR THIS RACK goes up. Tried once per switch per visit, never in a loop.
   */
  const filedTried = useRef(new Set());
  useEffect(() => { filedTried.current = new Set(); }, [rackId]);
  useEffect(() => {
    if (!rackId || viaServer) return undefined;
    let live = true;
    (async () => {
      for (const sw of switches) {
        if (!live) return;
        const r = results[sw.id];
        if (r?.kind !== 'full' || r.filed) continue;
        if (filedTried.current.has(sw.id)) continue;
        filedTried.current.add(sw.id);
        const filed = await fileOnServer(rackId, sw, r, (id) => rememberServerId(sw, id));
        // Recorded even if this pass has been torn down. Remembering the
        // server's id changes `switches`, which is in this effect's dependency
        // array — so filing the first switch cancels the very pass doing the
        // filing, and skipping the write here left the reading filed on the
        // server while the phone went on saying it was not. The next pass
        // skips what this one has already tried.
        setResults((m) => (m[sw.id] ? {
          ...m,
          [sw.id]: { ...m[sw.id], filed: filed.ok, filedWhy: filed.ok ? undefined : filed.why },
        } : m));
        if (filed.ok) loadPlaces();
        if (!live) return;
      }
    })();
    return () => { live = false; };
  }, [rackId, viaServer, switches, results, rememberServerId, loadPlaces]);

  // Testers need to be able to send this back without retyping it.
  const copyResult = async (sw) => {
    const r = results[sw.id];
    const err = errors[sw.id];
    const text = JSON.stringify(
      { switch: { label: sw.label, host: sw.host, port: sw.port }, result: r, error: err },
      null, 2,
    );
    try { await navigator.clipboard.writeText(text); } catch { /* nothing to do */ }
  };

  // The add / edit form. Rendered where the person asked for it: under the
  // switch they pressed Edit on, or at the button they pressed Add on. It used
  // to live at the foot of the page, so editing the first of four switches
  // opened a form two screens below with nothing to say it had happened.
  const renderForm = () => (
    <section className={styles.form}>
      <h2>{form.id ? `Edit ${form.label || 'switch'}` : 'Add a switch'}</h2>

      <label className={styles.field}>
        <span>Name it</span>
        <input
          value={form.label}
          placeholder="Core switch"
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span>Address</span>
        <input
          value={form.host}
          placeholder="10.10.1.33"
          inputMode="decimal"
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setForm({ ...form, host: e.target.value })}
        />
      </label>

      {/* Which dialect. Offered by what the switch's own settings page calls
          them, because that is what the person adding it will be reading. */}
      <div className={styles.field}>
        <span>How it is set up</span>
        <div className={styles.seg} role="radiogroup" aria-label="SNMP version">
          <button
            type="button"
            role="radio"
            aria-checked={form.version === 'v2c'}
            className={`${styles.segBtn} ${form.version === 'v2c' ? styles.segOn : ''}`}
            onClick={() => setForm({ ...form, version: 'v2c' })}
          >
            <b>v2c</b><small>community string</small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={form.version === 'v3'}
            className={`${styles.segBtn} ${form.version === 'v3' ? styles.segOn : ''}`}
            onClick={() => setForm({ ...form, version: 'v3' })}
          >
            <b>v3</b><small>user name</small>
          </button>
        </div>
      </div>

      <div className={styles.pair}>
        <label className={styles.field}>
          <span>Port</span>
          <input
            value={form.port}
            inputMode="numeric"
            onChange={(e) => setForm({ ...form, port: e.target.value })}
          />
        </label>
        {form.version === 'v3' ? (
          <label className={styles.field}>
            <span>User name</span>
            <input
              value={form.username}
              placeholder="racktrack"
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
        ) : (
          <label className={styles.field}>
            <span>Community</span>
            <input
              value={form.community}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => setForm({ ...form, community: e.target.value })}
            />
          </label>
        )}
      </div>

      {form.version === 'v3' ? (
        <p className={styles.fieldNote}>
          The SNMPv3 user your network team created on the switch, at the
          <b> noAuthNoPriv</b> level — no password, no encryption. That is how
          the TP-Links are set up today. A user with a password comes in the
          next build. The name stays on this phone.
        </p>
      ) : form.version === 'v2c' ? (
        <p className={styles.fieldNote}>
          The community is the read-only password your network team set on the
          switch. It is often <code>public</code>. It stays on this phone.
        </p>
      ) : (
        <p className={styles.fieldNote}>
          Choose how this switch is set up — your network team knows which, and
          the switch's own SNMP settings page says so too.
        </p>
      )}

      {formErr && <p className={styles.formErr}>{formErr}</p>}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => { setFormErr(null); setForm(null); }}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={save}>
          Save and read
        </button>
      </div>
    </section>
  );

  return (
    <div className={`page page-full ${styles.page}`}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className={styles.title}>Network</h1>
        <ThemeToggle />
      </header>

      <div className={styles.scroll}>
        {/* The phone does the reading, so say so before anyone presses a button
            they cannot use. Only ever shown in a browser. */}
        {viaServer && (
          <p className={styles.notice}>
            <b>The server is reading these switches.</b> A browser cannot open the kind of
            network connection SNMP needs, so this asks the server to do it — which works
            whenever the server is on the same network as the switches. On a phone, the
            phone reads them itself.
          </p>
        )}

        {switches.length === 0 && !form && (
          <div className={styles.empty}>
            <p>No switches on this rack yet.</p>
            <p className={styles.emptySub}>
              Add one and it is read straight away — every value comes from the switch itself.
            </p>
            <button type="button" className={styles.primary} onClick={() => setForm(BLANK)}>
              Add a switch
            </button>
          </div>
        )}

        {/* ── The switches ──
            Each one is a band across the full width of the screen, parted from
            the next by a hairline and marked down its left edge by how it went.
            Nothing floats and nothing nests: the reading IS the row. */}
        {switches.map((sw, idx) => {
          const r = results[sw.id];
          const err = errors[sw.id];
          const working = busy === sw.id;
          const editing = form && form.id === sw.id;
          const state = working ? 'busy' : err ? 'bad' : r?.kind === 'full' ? 'good' : r ? 'ok' : 'idle';

          // What the faceplate has to say about the port someone tapped.
          const tapped = r?.kind === 'full'
            ? (r.interfaces || []).find((i) => i.index === pin[sw.id]) : null;

          // The sockets on the front of the box. The switch also reports its
          // VLAN interfaces and its loopback; they are not ports and drawing
          // them on a faceplate says the box has sockets it does not have.
          const sockets = r?.kind === 'full' ? socketsOf(r) : [];
          const upCount = sockets.filter((i) => i.up).length;

          const open = Boolean(more[sw.id]);

          return (
            <section key={sw.id} className={styles.row} data-state={state}>
              <div className={styles.rowTop}>
                <div className={styles.who}>
                  <h2><span className={styles.num} aria-hidden="true">{idx + 1}</span>{sw.label}</h2>
                  {r && (
                    <p className={styles.model}>
                      {r.vendor && <span className={styles.make}>{r.vendor}</span>}
                      {r.model || r.sysName || 'model not stated'}
                    </p>
                  )}
                  <p className={styles.meta}>
                    {[
                      Number(sw.port) === 161 ? sw.host : `${sw.host}:${sw.port}`,
                      r?.uptime != null ? uptimeText(r.uptime) : null,
                      r?.serial ? `serial ${r.serial}` : null,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>

                {/* The one number worth reading from arm's length. */}
                {r?.kind === 'full' ? (
                  <div className={styles.count}>
                    <b>{upCount}<i>/</i>{sockets.length}</b>
                    <span>ports up</span>
                  </div>
                ) : (
                  <span className={styles.state}>
                    {working ? 'Reading' : err ? 'No answer' : r ? 'Answered' : 'Not read'}
                  </span>
                )}

                {/* Read again, Edit, Copy, Remove. Housekeeping, not content:
                    it belongs at the switch's name, not strung across the foot
                    of everything the switch had to say. */}
                <div className={styles.menuWrap}>
                  <button
                    type="button"
                    className={styles.kebab}
                    aria-label={`Actions for ${sw.label}`}
                    aria-expanded={menuFor === sw.id}
                    disabled={working}
                    onClick={() => setMenuFor(menuFor === sw.id ? null : sw.id)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
                    </svg>
                  </button>
                  {menuFor === sw.id && (
                    <>
                      <button
                        type="button" tabIndex={-1} aria-hidden="true"
                        className={styles.menuScrim} onClick={() => setMenuFor(null)}
                      />
                      <div className={styles.menu} role="menu">
                        <button type="button" role="menuitem"
                          onClick={() => { setMenuFor(null); doRead(sw); }}>
                          {r || err ? 'Read again' : 'Read this switch'}
                        </button>
                        <button type="button" role="menuitem"
                          onClick={() => { setMenuFor(null); openEdit(sw); }}>
                          Edit
                        </button>
                        {(r || err) && (
                          <button type="button" role="menuitem"
                            onClick={() => { setMenuFor(null); copyResult(sw); }}>
                            Copy result
                          </button>
                        )}
                        <button type="button" role="menuitem" className={styles.menuBad}
                          onClick={() => { setMenuFor(null); remove(sw); }}>
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Edit opens here, under the switch it edits. */}
              {editing && renderForm()}

              {working && (
                <p className={styles.working}>
                  <span className={styles.spinner} />
                  <span className={styles.workingStep}>{step || 'Working'}…</span>
                  <button
                    type="button"
                    className={styles.stop}
                    onClick={() => { stopRef.current.add(sw.id); setStep('Stopping'); }}
                  >
                    Stop
                  </button>
                </p>
              )}

              {/* ── The faceplate ──
                  Every port on the switch, two rows, fitted to the width of
                  the screen however many there are — the shape of the front of
                  the box. Lit means up. Tap one and the line underneath says
                  which it is and what is on it. */}
              {r?.kind === 'full' && sockets.length > 0 && !editing && (
                <div className={styles.plate}>
                  <div
                    className={styles.pins}
                    style={{ '--cols': Math.ceil(sockets.length / 2) }}
                    role="list"
                    aria-label="Ports"
                  >
                    {sockets.map((i) => (
                      <button
                        type="button"
                        key={i.index}
                        role="listitem"
                        aria-label={`Port ${i.name}, ${i.up ? 'up' : 'down'}`}
                        aria-pressed={pin[sw.id] === i.index}
                        className={`${styles.pinCell} ${i.up ? styles.pinUp : ''} ${pin[sw.id] === i.index ? styles.pinOn : ''}`}
                        onClick={() => setPin((m) => ({ ...m, [sw.id]: m[sw.id] === i.index ? null : i.index }))}
                      >
                        {portNum(i.name)}
                      </button>
                    ))}
                  </div>

                  <p className={styles.plateNote}>
                    {tapped ? (
                      <>
                        <b>{tapped.name}</b>
                        {' · '}{tapped.up ? 'up' : 'down'}
                        {tapped.speedMbps ? ` · ${speedText(tapped.speedMbps)}` : ''}
                        {tapped.duplex ? ` · ${tapped.duplex} duplex` : ''}
                        {tapped.descr ? ` · ${tapped.descr}` : ''}
                        {neighbourOn(r, tapped.name) ? ` · to ${neighbourOn(r, tapped.name).sysName}` : ''}
                        {tapped.attached
                          ? ` · ${tapped.attached} device${tapped.attached === 1 ? '' : 's'} seen`
                          : ''}
                      </>
                    ) : (
                      <>
                        <span className={styles.key}><i className={styles.keyUp} />up</span>
                        <span className={styles.key}><i className={styles.keyDown} />down</span>
                        <span className={styles.keyHint}>tap a port</span>
                      </>
                    )}
                  </p>
                </div>
              )}

              {err && !editing && (
                <div className={styles.bad}>
                  <p>{err.message}</p>
                  {err.hint && <p className={styles.hint}>{err.hint}</p>}
                  {/* A switch added before v3 existed is stored as v2c and will
                      never answer a community string. Name the likely cause
                      rather than leaving "did not answer" to be puzzled over. */}
                  {sw.version !== 'v3' && /did not answer/i.test(err.message || '') && (
                    <p className={styles.hint}>
                      This switch is saved as <b>v2c</b>. A switch set up for SNMPv3
                      does not answer a community string.
                    </p>
                  )}
                </div>
              )}

              {/* A reading the server has not been told about is not in the
                  report, and the report is where this goes. Say so where the
                  reading is, and offer the retry. */}
              {rackId && r?.kind === 'full' && !r.filed && !editing && (
                <p className={styles.unfiled}>
                  Not in the report yet{r.filedWhy ? ` — ${r.filedWhy}` : ''}
                  <button type="button" onClick={() => doRead(sw)}>Read and file it</button>
                </p>
              )}

              {/* Where this switch sits, once it has been read and the rack has
                  places to offer. The camera found the boxes; this says which
                  box this switch is — from the list, or off the photo. */}
              {r?.kind === 'full' && serverIdFor(sw, rackId) && places?.devices?.length > 0 && !editing && (
                <PlacePicker
                  devices={places.devices}
                  image={places.image}
                  value={match[serverIdFor(sw, rackId)] ?? ''}
                  name={sw.label}
                  suggestion={(places.switches || []).find((x) => x.id === serverIdFor(sw, rackId))?.autoMatch || null}
                  takenBy={Object.fromEntries(
                    Object.entries(match)
                      .filter(([id, uid]) => uid && id !== String(serverIdFor(sw, rackId)))
                      .map(([id, uid]) => [uid, (places.switches || []).find((x) => String(x.id) === id)?.label || 'another switch']),
                  )}
                  onChange={(uid) => setMatch((m) => ({ ...m, [serverIdFor(sw, rackId)]: uid }))}
                />
              )}

              {/* ── What the switch actually said ──
                  One line of it by default. The faceplate above already says
                  which ports are up; the detail is a tap away for whoever came
                  for it. */}
              {r?.kind === 'full' && !editing && (
                <div className={styles.data}>
                  <button
                    type="button"
                    className={styles.moreBtn}
                    aria-expanded={open}
                    onClick={() => setMore((m) => ({ ...m, [sw.id]: !m[sw.id] }))}
                  >
                    <span className={styles.moreSum}>
                      {upCount} in use · {sockets.length - upCount} free
                      {r.attached?.length
                        ? ` · ${r.attached.length} device${r.attached.length === 1 ? '' : 's'} seen`
                        : ''}
                    </span>
                    <span className={styles.moreLink}>{open ? 'Less' : 'Read more'}</span>
                  </button>

                  {open && (
                    <>
                      {/* What is running, by speed. Fourteen rows of
                          "no description · 1 Gb" is a register, not a report:
                          it says the same thing fourteen times and buries the
                          three ports that differ. Two lines say it instead,
                          and the ports that carry a name or a neighbour get
                          their own line below because they carry something. */}
                      <div className={styles.dataHead}>
                        <h3>In use</h3>
                        <span className={styles.dataCount}>{upCount}</span>
                      </div>
                      {upCount === 0 ? (
                        <p className={styles.none}>All {sockets.length} ports are down.</p>
                      ) : (
                        <div className={styles.speeds}>
                          {speedGroups(sockets).map((g) => (
                            <div className={styles.speedRow} key={g.label}>
                              <span className={styles.speedTag}>{g.label}</span>
                              <span className={styles.speedPorts}>
                                {g.ports.map((i) => portNum(i.name)).join('  ')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className={styles.dataHead}>
                        <h3>Connected to</h3>
                        <span className={styles.dataCount}>{r.neighbours.length}</span>
                      </div>
                      {r.neighbours.length === 0 ? (
                        <p className={styles.none}>No end devices.</p>
                      ) : (
                        <ul className={styles.nbrRows}>
                          {r.neighbours.map((n, k) => (
                            <li key={k}>
                              <span className={styles.nbrName}>{n.sysName}</span>
                              <span className={styles.nbrWhere}>
                                {n.localPort || '—'}{n.port ? ` → ${n.port}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* Everything the switch has learned the address of, and
                          the port it learned it on. LLDP is a courtesy the far
                          end has to offer; this is the switch's own bookkeeping,
                          so it sees the laptops and cameras that announce
                          nothing. */}
                      {r.attached?.length > 0 && (
                        <>
                          <div className={styles.dataHead}>
                            <h3>Plugged in</h3>
                            <span className={styles.dataCount}>{r.attached.length}</span>
                          </div>
                          <ul className={styles.nbrRows}>
                            {[...r.attached]
                              .sort((a, b) => String(a.port).localeCompare(String(b.port), undefined, { numeric: true }))
                              .map((d) => (
                                <li key={`${d.mac}-${d.ifIndex}`}>
                                  <span className={styles.nbrName}>{d.ip || d.mac}</span>
                                  <span className={styles.nbrWhere}>
                                    {d.ip ? `${d.mac} · ` : ''}{d.port}
                                  </span>
                                </li>
                              ))}
                          </ul>
                        </>
                      )}

                      {labelled(sockets).length > 0 && (
                        <>
                          <div className={styles.dataHead}><h3>Labelled</h3></div>
                          <ul className={styles.nbrRows}>
                            {labelled(sockets).map((i) => (
                              <li key={i.index}>
                                <span className={styles.nbrName}>{i.descr}</span>
                                <span className={styles.nbrWhere}>{i.name}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      {!r.model && r.sysDescr && (
                        <>
                          <div className={styles.dataHead}><h3>What it calls itself</h3></div>
                          <p className={styles.descr}>{r.sysDescr}</p>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

            </section>
          );
        })}

        {/* ── Add ──
            The form opens at the button, so it is on screen the moment it exists. */}
        {form && !form.id ? renderForm() : switches.length > 0 && !form && (
          <button type="button" className={styles.addMore} onClick={() => setForm(BLANK)}>
            <span aria-hidden="true">+</span> Add another switch
          </button>
        )}

        {/* Save the places, then go on to the report. Only once something has
            been read and the rack has boxes to put it in. */}
        {!form && places?.devices?.length > 0 && Object.values(results).some((x) => x?.kind === 'full') && (
          <div className={styles.finish}>
            {matchNote && (
              <p className={matchNote.ok ? styles.finishOk : styles.finishBad}>{matchNote.text}</p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={savingMatch} onClick={savePlaces}>
                {savingMatch ? 'Saving…' : 'Save places'}
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={savingMatch}
                onClick={async () => { if (await savePlaces()) navigate(`/results/${encodeURIComponent(rackId)}/report`); }}
              >
                Go to report
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
