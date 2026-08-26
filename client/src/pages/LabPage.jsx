import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext';
import styles from './LabPage.module.css';

// Owner-only lab view — the client side of /api/lab/*.
//
// Shows the SAME audit the live-switch Ports tab shows (identity, port
// faceplate, PoE, VLANs, LLDP neighbours, MAC table), addressed by
// monitored_devices id: the browser sends only an id and never sees or sends a
// host or credentials. This reads /api/lab/devices, which is
// requireRole('owner'), keeping the lab invisible to testers.
//
// Results are CACHED PER DEVICE (auditsRef): an audit is a live SSH pass that
// takes seconds and competes with the 60s poller for the switch's single SSH
// session, so flipping between devices must never silently re-run it or throw
// the previous result away. Switching back shows what we last saw, stamped with
// how old it is. Nothing is ever blanked just because a refresh is in flight.
//
// EXPECT EMPTY SPEED/DUPLEX/PoE ON LAB SWITCHES: Cisco IOL is virtual. It never
// negotiates a link and has no PoE hardware, so those read "—". That is the
// truth, not a parse failure. The real TP-Link fills them in.
//
// LAYOUT CONTRACT: no value is ever clipped. Fields wrap (overflow-wrap set in
// the stylesheet), tables scroll in their own wrapper. The detail is split into
// a summary head + tabbed sections rather than one long scroll of cards.

// Persist the last audit per device in localStorage so a refresh or reopening
// the page shows the last result INSTANTLY instead of blocking on a fresh SSH
// pass. The live refresh then runs in the background and updates in place. Keyed
// by device id; a few switches' worth of JSON is well under the quota.
const LS_AUDIT = (id) => `rt_lab_audit_${id}`;
function loadCachedAudit(id) {
  try {
    const j = JSON.parse(localStorage.getItem(LS_AUDIT(id)));
    return j && j.data ? { data: j.data, at: j.at || null, error: null } : null;
  } catch { return null; }
}
function saveCachedAudit(id, data, at) {
  try { localStorage.setItem(LS_AUDIT(id), JSON.stringify({ data, at })); } catch { /* quota / disabled */ }
}

function fmtAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5)     return 'just now';
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// The poller stores a raw library error in last_error ("Timed out while waiting
// for handshake", "connect ECONNREFUSED", ...). For an owner staring at dead
// lab switches that's noise, so translate the common shapes into what's actually
// wrong + what to do. These are EVE-NG IOL nodes whose running-config (its
// management IP + SSH host key) is VOLATILE — it evaporates when the node is
// stopped or the EVE-NG VM reboots. So "was Live, now dark on :22" almost always
// means the node is stopped or came back unconfigured, not a RackTrack fault.
function explainSshError(raw) {
  const m = String(raw || '').toLowerCase();
  if (!m) return null;
  if (m.includes('handshake') || m.includes('timed out') || m.includes('etimedout')) {
    return {
      plain: 'The switch isn’t answering on SSH at all.',
      hint: 'The EVE-NG node is most likely stopped, or it rebooted and came back without its config - IOL running-config (its IP and SSH host key) is volatile and is lost on stop. Start the node in the EVE-NG topology and re-apply its config; polling then recovers on its own.',
    };
  }
  if (m.includes('econnrefused') || m.includes('refused')) {
    return {
      plain: 'The switch is up, but nothing is listening on SSH.',
      hint: 'The node is running yet its SSH server isn’t - no crypto key / `ip ssh` in the running-config. Re-apply the switch config (crypto key generate rsa, ip ssh version 2, transport input ssh) from the EVE-NG console.',
    };
  }
  if (m.includes('ehostunreach') || m.includes('enetunreach') || m.includes('no route')) {
    return {
      plain: 'No network route to the switch.',
      hint: 'The node has no management IP - its config didn’t persist, or the pnet bridge isn’t attached to it. Check the node’s interface config in EVE-NG.',
    };
  }
  if (m.includes('authentication') || m.includes('all configured auth') || m.includes('password')) {
    return {
      plain: 'Reached the switch, but the login was rejected.',
      hint: 'The stored credentials don’t match the switch’s local account. Fix the username/password in the encrypted cred store.',
    };
  }
  return null; // unknown shape — caller falls back to showing the raw string
}

// "Live" needs an age bound, or it is just a claim.
//
// The poller runs hourly by default (PORT_POLL_INTERVAL_MS) and only records
// last_error when an attempt actually FAILS. So a switch that stopped being
// polled at all — credentials pulled, poller not running, host quietly
// unreachable in a way that never surfaced an error — keeps its old last_seen
// and its green pill forever. That is how the Lab page came to show five
// switches as Live whose own detail panel read "Last polled 6d ago".
//
// Two intervals of grace: one missed pass is normal (backoff, a manual audit
// holding the switch's single SSH session), two is a pattern.
const POLL_INTERVAL_MS = 60 * 60 * 1000;   // matches the server-side default
const LIVE_MAX_AGE_MS  = 2 * POLL_INTERVAL_MS;

// A device is only healthy once a poll has SUCCEEDED. last_seen is stamped on
// metadata write, so null means "never got data" even with zero failures —
// exactly what a missing-credentials device looks like, because the poller
// early-returns there without recording a failure.
function statusMeta(d, connecting) {
  if (connecting)    return { label: 'Connecting…', cls: styles.stWarn };
  if (!d.enabled)    return { label: 'Disabled',    cls: styles.stIdle };
  if (d.last_error)  return { label: 'Offline',     cls: styles.stOff };
  if (!d.last_seen)  return { label: 'No data',     cls: styles.stIdle };
  const age = Date.now() - new Date(d.last_seen).getTime();
  // NaN (unparseable stamp) must not read as fresh — compare so that only a
  // genuinely recent, genuinely parseable timestamp earns "Live".
  if (!(age < LIVE_MAX_AGE_MS)) {
    return { label: `Stale · ${fmtAgo(d.last_seen)}`, cls: styles.stIdle };
  }
  return { label: 'Live', cls: styles.stLive };
}

// parseInterfaceStatus returns { up: boolean, ... } — there is no `link`/`status`
// field. Reading those made every port render "—".
function linkOf(s) {
  if (!s || s.up === undefined) return null;
  return s.up ? 'up' : 'down';
}
function linkClass(l) {
  if (l === 'up')   return styles.up;
  if (l === 'down') return styles.down;
  return styles.unknown;
}

const dash = (v) => (v === null || v === undefined || v === '' ? '-' : v);

function Pill({ meta }) {
  return (
    <span className={`${styles.statusPill} ${meta.cls}`}>
      <span className={styles.statusDot} />
      {meta.label}
    </span>
  );
}

// Three tabs, not five. Identity moved up into the summary strip — it is a fixed
// set of facts about the device, not a collection to browse, so a whole tab for
// it just added a click. The MAC table went with it: these switches report an
// empty forwarding table, so it was a permanently empty tab.
const SECTIONS = [
  { key: 'ports', label: 'Ports' },
  { key: 'vlans', label: 'VLANs' },
  { key: 'lldp',  label: 'Neighbours' },
];

export default function LabPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [devices, setDevices] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const [selectedId, setSelected] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [tab, setTab] = useState('ports');
  const [, forceRender] = useState(0);

  // deviceId -> { data, at, error }. A ref, not state: it must survive device
  // switches without re-triggering the effects that would refetch.
  const auditsRef = useRef(new Map());
  // Devices whose live audit we've already kicked off this session — so opening
  // the page refreshes each device once in the background, not on every tab
  // switch or 15s device-list poll.
  const refreshedRef = useRef(new Set());
  const bump = () => forceRender((n) => n + 1);

  useEffect(() => {
    if (!isOwner) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await authFetch(apiUrl('/api/lab/devices'));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setDevices(data.devices || []);
        setLoadErr(null);
        setSelected((cur) => cur ?? data.devices?.[0]?.id ?? null);
      } catch (err) {
        // Keep whatever list we already have — a blip shouldn't empty the page.
        if (!cancelled) setLoadErr(err.message);
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isOwner]);

  // Re-render on a timer so the "as of" ages visibly without refetching.
  useEffect(() => { const t = setInterval(bump, 10_000); return () => clearInterval(t); }, []);

  // Auto-run the audit the first time a device is selected, so the report just
  // appears instead of needing a click.
  //
  // Deliberately ONCE per device, then cached in auditsRef: an audit is a live
  // SSH pass and these switches allow only ONE session, which the 60s poller is
  // already using. Re-auditing on every tab switch would fight the poller and
  // saturate that single session (the failure mode where the switch stops
  // accepting connections until it's rebooted). Re-running is the explicit
  // "Refresh audit" button.
  //
  // Skipped when the poller already can't reach the device: the SSH attempt
  // would just hang for the full timeout on every selection. Showing the
  // offline diagnosis immediately is more useful, and the button still forces
  // a retry by hand.
  useEffect(() => {
    if (!selectedId) return;
    // 1. Show the last saved audit INSTANTLY (survives a refresh/reopen) so the
    //    detail is never blank while a live pass runs.
    if (!auditsRef.current.has(selectedId)) {
      const cached = loadCachedAudit(selectedId);
      if (cached) { auditsRef.current.set(selectedId, cached); bump(); }
    }
    // 2. Refresh live in the BACKGROUND — once per device per session, never
    //    blocking the view. The cached data above stays on screen (marked
    //    "Refreshing…") and updates in place when the pass returns.
    if (busyId) return;                              // one SSH session at a time
    if (refreshedRef.current.has(selectedId)) return; // already kicked off this session
    const d = devices.find((x) => x.id === selectedId);
    if (!d || !d.enabled || d.last_error) return;    // disabled / known-unreachable
    refreshedRef.current.add(selectedId);
    runAudit(selectedId);
  }, [selectedId, devices, busyId]);                 // eslint-disable-line react-hooks/exhaustive-deps

  const toggleEnabled = async (d) => {
    try {
      const r = await authFetch(apiUrl(`/api/lab/devices/${d.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { device } = await r.json();
      setDevices((list) => list.map((x) => (x.id === device.id ? { ...x, ...device } : x)));
    } catch (err) {
      setLoadErr(`Could not ${d.enabled ? 'disable' : 'enable'} ${d.display_name}: ${err.message}`);
    }
  };

  const runAudit = async (id) => {
    if (!id || busyId) return;
    setBusyId(id);
    try {
      const r = await authFetch(apiUrl(`/api/lab/devices/${id}/audit`), { method: 'POST' });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const at = new Date().toISOString();
      auditsRef.current.set(id, { data, at, error: null });
      saveCachedAudit(id, data, at);   // survive refresh/reopen
    } catch (err) {
      // Preserve the previous audit — an error annotates it, never erases it.
      const prev = auditsRef.current.get(id);
      auditsRef.current.set(id, { data: prev?.data || null, at: prev?.at || null, error: err.message });
    } finally {
      setBusyId(null);
      bump();
    }
  };

  if (!isOwner) {
    return (
      <div className={styles.page}>
        <main className={styles.main}><p className={styles.sectionNote}>Restricted to platform owners.</p></main>
      </div>
    );
  }

  const selected = devices.find((d) => d.id === selectedId) || null;
  const entry = selectedId ? auditsRef.current.get(selectedId) : null;
  const audit = entry?.data || null;
  const busy = busyId === selectedId;

  const ifstatus  = audit?.ifstatus || {};
  const ifconfig  = audit?.ifconfig || {};
  const poePorts  = audit?.poe?.ports || {};
  const neighbors = audit?.neighbors || {};
  const ports = Object.keys(ifstatus).length ? Object.keys(ifstatus) : Object.keys(ifconfig);

  // (A "fleet tallies" pair lived here — unused since the strip was dropped,
  // and it counted Live the old unbounded way, so it would have disagreed with
  // the pills the moment a switch went stale. Removed rather than fixed twice:
  // statusMeta() is the single place that decides what Live means.)

  // No badge on Identity — it's a fixed field set, not a collection.
  // Neighbour count is per DEVICE seen, not per port — a port on a shared
  // segment sees several, and the tab lists them individually.
  const neighbourCount = Object.values(neighbors)
    .reduce((n, v) => n + ((v.peers && v.peers.length) || 1), 0);
  const counts = {
    ports: ports.length,
    vlans: audit?.vlans?.length || 0,
    lldp: neighbourCount,
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)} aria-label="Back">‹</button>
        <div className={styles.headerCenter}>
          <h1 className={styles.headerTitle}>Lab</h1>
          <p className={styles.headerSub}>Owner-only · EVE-NG switches</p>
        </div>
      </header>

      <main className={styles.main}>

        {loadErr && <p className={styles.errLine}>Device list stale - {loadErr}</p>}

        {/* Device cards. */}
        <div role="tablist" aria-label="Lab devices" className={styles.deviceGrid}>
          {devices.map((d) => {
            const meta = statusMeta(d, busyId === d.id);
            const active = d.id === selectedId;
            const cached = auditsRef.current.get(d.id);
            return (
              <button key={d.id} role="tab" aria-selected={active}
                      onClick={() => setSelected(d.id)}
                      className={`${styles.deviceCard} ${active ? styles.deviceCardActive : ''}`}>
                <span className={styles.dName}>{d.display_name}</span>
                <span className={styles.dHost}>{d.host}</span>
                <Pill meta={meta} />
                {cached?.data && <span className={styles.dFoot}>audit {fmtAgo(cached.at)}</span>}
              </button>
            );
          })}
          {!devices.length && !loadErr && <p className={styles.sectionNote}>No lab devices registered.</p>}
        </div>

        {/* Detail. */}
        {selected && (
          <div className={styles.detail}>
            <div className={styles.detailHead}>
              <div className={styles.detailTitleWrap}>
                <span className={styles.detailName}>{selected.display_name}</span>
                <Pill meta={statusMeta(selected, busy)} />
              </div>
              <div className={styles.detailActions}>
                <button className={styles.btn} onClick={() => toggleEnabled(selected)}>
                  {selected.enabled ? 'Disable polling' : 'Enable polling'}
                </button>
                <button className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={busy || !selected.enabled}
                        title={!selected.enabled ? 'Polling is disabled for this device' : undefined}
                        onClick={() => runAudit(selectedId)}>
                  {busy ? 'Connecting…' : audit ? 'Refresh audit' : 'Run full audit'}
                </button>
              </div>
            </div>

            {/* Key facts — every value complete, wraps instead of truncating. */}
            <div className={styles.factGrid}>
              <div className={styles.fact}>
                <span className={styles.factKey}>IP address</span>
                <span className={`${styles.factVal} ${styles.factMono}`}>{dash(selected.host)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>Vendor</span>
                <span className={styles.factVal}>{dash(selected.vendor)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>Model</span>
                <span className={`${styles.factVal} ${styles.factMono}`}>{dash(audit?.identity?.model)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>Firmware</span>
                <span className={`${styles.factVal} ${styles.factMono}`}>{dash(audit?.identity?.firmware)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>Serial</span>
                <span className={`${styles.factVal} ${styles.factMono}`}>{dash(audit?.identity?.serial)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>MAC</span>
                <span className={`${styles.factVal} ${styles.factMono}`}>{dash(audit?.identity?.mac)}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>Last polled</span>
                <span className={styles.factVal}>{fmtAgo(selected.last_seen)}</span>
              </div>
            </div>

            {!selected.enabled && (
              <p className={`${styles.banner} ${styles.bannerWarn}`}>
                <span className={styles.bannerStrong}>Polling disabled.</span> The poller skips this
                device entirely, so its data goes stale and no drift is recorded. Enable it to resume.
              </p>
            )}

            {selected.last_error && (
              <div className={`${styles.banner} ${styles.bannerWarn}`}>
                <span className={styles.bannerStrong}>
                  Offline - the switch isn’t answering
                  {selected.consecutive_failures
                    ? ` (${selected.consecutive_failures} failed attempt${selected.consecutive_failures === 1 ? '' : 's'})`
                    : ''}.
                </span>{' '}
                It’s likely stopped or unreachable; polling recovers on its own once it’s back.
              </div>
            )}

            {/* Only worth its own line when it says something the poller banner
                above doesn't: either it's annotating cached data we're still
                showing, or there's no poller banner up to explain the failure. */}
            {entry?.error && (audit || !selected.last_error) && (
              <p className={`${styles.banner} ${styles.bannerWarn}`}>
                <span className={styles.bannerStrong}>Last audit failed.</span> {entry.error}
                {audit && ' - showing the previous result below.'}
              </p>
            )}

            {/* Sections — tabs when we have data; a prompt otherwise. */}
            {audit ? (
              <>
                <div role="tablist" aria-label="Audit sections" className={styles.tabs}>
                  {SECTIONS.map((s) => (
                    <button key={s.key} role="tab" aria-selected={tab === s.key}
                            className={`${styles.tab} ${tab === s.key ? styles.tabActive : ''}`}
                            onClick={() => setTab(s.key)}>
                      {s.label}
                      {counts[s.key] !== undefined && <span className={styles.tabCount}>{counts[s.key]}</span>}
                    </button>
                  ))}
                </div>

                <div className={styles.section}>
                  <p className={styles.asOf}>
                    {busy ? 'Refreshing…' : `Audit as of ${fmtAgo(entry.at)}`} · live SSH pass, not polled
                  </p>

                  {tab === 'ports' && (
                    <>
                      <div className={styles.legend}>
                        <span className={styles.legendItem}><span className={`${styles.legendPeg} ${styles.pegUp}`} /> up</span>
                        <span className={styles.legendItem}><span className={`${styles.legendPeg} ${styles.pegDown}`} /> down</span>
                        <span className={styles.legendItem}><span className={`${styles.legendPeg} ${styles.pegUnknown}`} /> unknown</span>
                      </div>
                      <div className={styles.portGrid}>
                        {ports.map((p) => {
                          const l = linkOf(ifstatus[p]);
                          return (
                            <div key={p} className={`${styles.portCell} ${l === 'up' ? styles.up : l === 'down' ? styles.down : ''}`}
                                 title={`${p} - ${dash(l)}`}>
                              <span className={styles.portName}>{p}</span>
                            </div>
                          );
                        })}
                        {!ports.length && <p className={styles.sectionNote}>No ports returned.</p>}
                      </div>
                      {!!ports.length && (
                        <div className={styles.tableWrap}>
                          <table className={styles.table}>
                            <thead><tr>
                              {['Port', 'Link', 'Admin', 'Speed', 'Duplex', 'Type', 'PoE (W)', 'Neighbour'].map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr></thead>
                            <tbody>
                              {ports.map((p) => {
                                const s = ifstatus[p] || {}, c = ifconfig[p] || {};
                                const pe = poePorts[p] || {}, n = neighbors[p] || {};
                                const l = linkOf(s);
                                return (
                                  <tr key={p}>
                                    <td className={styles.mono}>{p}</td>
                                    <td><span className={linkClass(l)}>{dash(l)}</span></td>
                                    <td>{c.enabled === undefined ? '-' : (c.enabled ? 'enabled' : 'disabled')}</td>
                                    <td>{dash(s.speed)}</td>
                                    <td>{dash(s.duplex)}</td>
                                    <td>{dash(s.medium)}</td>
                                    <td>{dash(pe.power)}</td>
                                    {/* `also` counts extra neighbours on the same local port —
                                        every lab switch's e0/3 shares one pnet0 bridge, so a port
                                        can genuinely see several devices. Showing only the first
                                        would misrepresent the link as point-to-point. */}
                                    <td>
                                      {dash(n.system_name || n.chassis_id)}
                                      {n.also > 0 && (
                                        <span className={styles.alsoCount} title={`${n.also} more device(s) seen on this port`}>
                                          {` +${n.also}`}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {audit.poe?.budget != null && (
                        <p className={styles.asOf} style={{ marginTop: 8, marginBottom: 0 }}>
                          PoE budget {audit.poe.budget}W · used {audit.poe.used ?? 0}W
                        </p>
                      )}
                    </>
                  )}

                  {tab === 'vlans' && (
                    audit.vlans?.length ? (
                      <div className={styles.tableWrap}>
                        <table className={styles.table}>
                          <thead><tr>{['VLAN', 'Name', 'Status', 'Ports'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                          <tbody>
                            {audit.vlans.map((v) => (
                              <tr key={v.id}>
                                <td className={styles.mono}>{v.id}</td>
                                <td>{dash(v.name)}</td>
                                <td>{dash(v.status)}</td>
                                <td>{(v.ports || []).map((p) => (typeof p === 'string' ? p : `${p.port}${p.tagged ? ' (T)' : ''}`)).join(', ') || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className={styles.sectionNote}>
                        None. Expected on CoreSW - it runs the L3 IOL image, where interfaces are routed
                        and there are no switchports to put in a VLAN.
                      </p>
                    )
                  )}

                  {tab === 'lldp' && (
                    Object.keys(neighbors).length ? (
                      <div className={styles.tableWrap}>
                        <table className={styles.table}>
                          <thead><tr>{['Local port', 'Device', 'Address', 'Its port'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                          <tbody>
                            {/* One row per NEIGHBOUR, not per port. A port on a shared segment
                                sees several devices — listing only the first hid the other
                                switches and the desk phone entirely. */}
                            {Object.entries(neighbors).flatMap(([p, n]) =>
                              (n.peers && n.peers.length ? n.peers : [n]).map((peer, i) => (
                                <tr key={`${p}-${i}`}>
                                  <td className={styles.mono}>{i === 0 ? p : ''}</td>
                                  <td>{dash(peer.system_name || peer.chassis_id)}</td>
                                  <td className={styles.mono}>{dash(peer.management_address)}</td>
                                  <td className={styles.mono}>{dash(peer.port_id)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className={styles.sectionNote}>
                        None. IOS needs <code>lldp run</code> globally, and the IOL l2-ipbase image may
                        not support LLDP at all - Cisco defaults to CDP.
                      </p>
                    )
                  )}

                </div>
              </>
            ) : (
              /* No audit data. The offline / polling-disabled cases already have
                 a banner above saying exactly why, so don't repeat it here —
                 only render a section when there's something new to say. */
              busy ? (
                <div className={styles.section}>
                  <p className={styles.sectionNote}>
                    Auditing {selected.host} over SSH - identity, ports, PoE, VLANs, LLDP and the MAC table…
                  </p>
                </div>
              ) : selected.enabled && !selected.last_error && !entry?.error ? (
                <div className={styles.section}>
                  <p className={styles.sectionNote}>Starting audit…</p>
                </div>
              ) : null
              /* `!entry?.error` matters: the poller records last_error, but an
                 on-demand audit failure lands in entry.error instead. Without it
                 the panel showed "Last audit failed …" and "Starting audit…"
                 stacked together — claiming to be mid-attempt when the attempt
                 had already returned, and nothing further was scheduled. */
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Id({ label, value, mono }) {
  return (
    <div className={styles.idTile}>
      <span className={styles.idKey}>{label}</span>
      <span className={`${styles.idVal} ${mono ? styles.idMono : ''}`}>{dash(value)}</span>
    </div>
  );
}
