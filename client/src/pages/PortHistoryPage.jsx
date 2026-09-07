import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSmartBack } from '../hooks/useSmartBack';
import { apiUrl, authFetch } from '../utils/api';
import styles from './PortHistoryPage.module.css';

// "Continuous polling & port drift" view — the client side of
// /api/ports/*. Auto-targets the single monitored switch (host /
// credentials live server-side and are intentionally not exposed).
// The interface-detail panel mirrors the Arista CloudVision layout:
// Interface Details + Interface Status (stacked-bar timeline) +
// Interface Configuration + Maintenance State + change log.

/** The number written above the socket: the last run of digits in its name.
 *  Was `p.port.replace('Gi1/0/', '')`, which is one vendor's spelling — the
 *  D-Link calls its ports Slot0/1..52, so nothing was stripped and every tile
 *  read "ot0/" with the number clipped off the end. */
const portNum = (name) => {
  const m = String(name || '').match(/(\d+)(?!.*\d)/);
  return m ? m[1] : String(name || '').slice(-3);
};

const OVERVIEW_REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS  = 15_000;
const TIMELINE_REFRESH_MS = 20_000;

const WINDOW_OPTIONS = [
  { key: '1h',  label: 'Last 1 Hour',  sec: 3600 },
  { key: '3h',  label: 'Last 3 Hours', sec: 3  * 3600 },
  { key: '12h', label: 'Last 12 Hours',sec: 12 * 3600 },
  { key: '1d',  label: 'Last 1 Day',   sec: 24 * 3600 },
  { key: '1w',  label: 'Last 1 Week',  sec: 7  * 24 * 3600 },
];
const OFFSET_KEYS = ['1h', '3h', '12h', '1d', '1w'];

// Bars rendered in the Interface Status timeline. Mirrors the four
// rows in the Arista screenshot — we just substitute Flow Control for
// "Auto Negotiation Status" since TP-Link surfaces the former, not the
// latter. Each bar has a colour function so transitions are obvious at
// a glance.
const TIMELINE_BARS = [
  {
    label: 'Administrative State', field: 'admin',
    colorOf: (v) => v === 'enabled'  ? '#1c1c1c'
                  : v === 'disabled' ? '#1c1c1c'
                  : '#1c1c1c',
    formatValue: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '-',
  },
  {
    label: 'Flow Control',         field: 'flowctrl',
    colorOf: (v) => v === 'Enable'  ? '#474747'
                  : v === 'Disable' ? '#1c1c1c'
                  : '#1c1c1c',
    formatValue: (v) => v || 'Off',
  },
  {
    label: 'Operational Status',   field: 'oper',
    colorOf: (v) => v === 'up'   ? '#22c55e'
                  : v === 'down' ? '#ef4444'
                  : '#d5d5d5',
    // Render label as Up / Down — the colour itself signals state
    formatValue: (v) => v ? v.toUpperCase() : '-',
  },
  {
    label: 'Speed',                field: 'speed_mbps',
    colorOf: (v) => v ? '#c6c6c6' : '#1c1c1c',
    formatValue: (v) => fmtSpeed(v),
  },
  {
    label: 'LLDP Neighbor',        field: 'lldp_system',
    // Hash the neighbor name to a stable colour so identity is obvious
    // at a glance — different segments → different colours → cable was
    // re-routed to a different switch / host.
    colorOf: (v) => v ? hashColor(v) : '#1c1c1c',
    formatValue: (v) => v || 'none',
  },
];

// Stable string → hex colour map used by the LLDP bar so each neighbour
// name gets a consistent hue across renders. Deliberately avoids the
// reds/greens used by the operational bar so the two are distinguishable.
function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palette = ['#000000', '#474747', '#474747', '#474747', '#1c1c1c', '#c6c6c6', '#474747', '#f3f3f3'];
  return palette[h % palette.length];
}

function fmtTs(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtAgo(iso) {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60)     return `${s}s ago`;
  if (s < 3600)   return `${Math.floor(s/60)}m ago`;
  if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function fmtSpeed(mbps) {
  if (mbps == null) return '-';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(0)} Gbps`;
  return `${mbps} Mbps`;
}

// Plain-English summary of a change-log event. Treats null / 0 / empty
// string as "no value" since the poller emits "∅"-equivalent values when
// the port had no negotiated state. Falls back to a generic phrasing for
// any field we haven't taught it about so new fields still get a sentence.
function humanizeEvent(e) {
  const from = e.from_val, to = e.to_val;
  const empty = (v) => v == null || v === '' || v === '0' || v === 0;
  const speed = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(0)} Gbps` : `${n} Mbps`;
  };
  switch (e.field) {
    case 'oper':
      if (to === 'up')   return empty(from) ? 'Link came up' : 'Link came back up';
      if (to === 'down') return 'Link went down';
      return `Operational state → ${to ?? 'unknown'}`;
    case 'admin':
      if (to === 'enabled')  return 'Port administratively enabled';
      if (to === 'disabled') return 'Port administratively disabled';
      return `Admin state → ${to ?? 'unknown'}`;
    case 'speed_mbps': {
      const t = speed(to), f = speed(from);
      if (!t && f) return 'Speed lost (link gone)';
      if (t && !f) return `Speed negotiated at ${t}`;
      if (t && f)  return `Speed changed ${f} → ${t}`;
      return 'Speed cleared';
    }
    case 'duplex':
      if (empty(to))   return 'Duplex cleared';
      if (empty(from)) return `Duplex negotiated as ${to}`;
      return `Duplex changed ${from} → ${to}`;
    case 'flowctrl':
      if (to === 'Enable')  return 'Flow control enabled';
      if (to === 'Disable') return empty(from) ? 'Flow control set to Disable' : 'Flow control disabled';
      if (empty(to))        return 'Flow control cleared';
      return `Flow control → ${to}`;
    case 'medium':
      if (empty(to)) return 'Active medium cleared';
      return `Active medium → ${to}`;
    case 'descr':
      if (empty(to))   return 'Description cleared';
      if (empty(from)) return `Description set to "${to}"`;
      return 'Description updated';
    case 'lldp_system':
      if (empty(to))   return 'LLDP neighbor lost';
      if (empty(from)) return `LLDP neighbor seen: ${to}`;
      return `LLDP neighbor changed: ${from} → ${to}`;
    case 'lldp_chassis':
      return empty(to) ? 'LLDP chassis ID cleared' : 'LLDP chassis ID changed';
    case 'lldp_port':
      return empty(to) ? 'LLDP remote port cleared' : `LLDP remote port → ${to}`;
    default:
      return `${e.field} changed`;
  }
}
/** One change, as a person would say it. */
function describeEvent(e) {
  const f = String(e.field || '');
  const from = e.from_val ?? null;
  const to = e.to_val ?? null;
  if (f === 'oper') return to === 'up' ? 'came up' : to === 'down' ? 'went down' : `link ${from ?? '?'} → ${to ?? '?'}`;
  if (f === 'admin') return to === 'disabled' ? 'was switched off' : to === 'enabled' ? 'was switched on' : `admin ${from} → ${to}`;
  if (f === 'speed_mbps') return `${fmtSpeed(Number(from))} → ${fmtSpeed(Number(to))}`;
  if (f === 'duplex') return `${from || '?'} → ${to || '?'} duplex`;
  if (f === 'lldp_system' || f === 'lldp_chassis') {
    if (!from && to) return `neighbour appeared: ${to}`;
    if (from && !to) return `neighbour gone: ${from}`;
    return `neighbour ${from} → ${to}`;
  }
  if (f === 'lldp_port') return `neighbour port ${from || '—'} → ${to || '—'}`;
  if (f === 'descr') return `renamed “${from || ''}” → “${to || ''}”`;
  return `${f}: ${from ?? '—'} → ${to ?? '—'}`;
}

function agoShort(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function operClass(oper) {
  if (oper === 'up')   return styles.up;
  if (oper === 'down') return styles.down;
  return styles.unknown;
}
// Collapse offset lookups that resolve to the same snapshot into one row.
// Without this, a port whose only stored snapshot is from before all five
// windows shows five identical rows (the same DB row returned five times,
// since snapshots are written only on change).
function dedupedOffsets(offsets) {
  if (!offsets) return [];
  const seen = new Map();
  const order = [];
  for (const k of OFFSET_KEYS) {
    const s = offsets[k];
    if (!s) continue;
    const sig = s.id != null ? `id:${s.id}` : `ts:${s.ts}`;
    if (seen.has(sig)) {
      seen.get(sig).lastKey = k;
    } else {
      const entry = { sig, snap: s, firstKey: k, lastKey: k };
      seen.set(sig, entry);
      order.push(entry);
    }
  }
  return order.map((e) => ({
    sig: e.sig,
    snap: e.snap,
    label: e.firstKey === e.lastKey ? e.firstKey : `${e.firstKey}+`,
  }));
}
// Time-axis tick formatter — short HH:MM for windows ≤ 1d, otherwise
// includes the date so day-boundary transitions read correctly.
function fmtTick(ms, windowSec) {
  const d = new Date(ms);
  if (windowSec <= 24 * 3600) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// Build {startMs,endMs,value} segments for one field across the window.
function buildSegments(initial, snapshots, field, windowStartMs, windowEndMs) {
  const points = [];
  if (initial && initial[field] != null) {
    points.push({ ms: windowStartMs, value: initial[field] });
  }
  for (const s of snapshots) {
    const ms = new Date(s.ts).getTime();
    if (ms < windowStartMs || ms > windowEndMs) continue;
    points.push({ ms, value: s[field] });
  }
  if (points.length === 0) return [];
  // Collapse adjacent identical values, then turn into segments by
  // pairing each point with the next point (or the window end).
  const segs = [];
  let cur = points[0];
  for (let i = 1; i < points.length; i++) {
    if (String(points[i].value) === String(cur.value)) continue;
    segs.push({ startMs: cur.ms, endMs: points[i].ms, value: cur.value });
    cur = points[i];
  }
  segs.push({ startMs: cur.ms, endMs: windowEndMs, value: cur.value });
  return segs;
}

// ─────────────────────────────────────────────────────────────────────
// Routable page wrapper — used by /port-history.
// Embeddable content — used by the ResultsPage "Drift" tab.
// ─────────────────────────────────────────────────────────────────────
export function PortHistoryContent({ rackId = null }) {
  return <PortHistoryInner rackId={rackId} embedded />;
}

export default function PortHistoryPage() {
  const navigate = useNavigate();
  const goBack = useSmartBack();
  return (
    <div className={styles.page}>
      <div className={styles.amb} aria-hidden />
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => goBack()} aria-label="Back">‹</button>
        <div className={styles.headerCenter}>
          <h1 className={styles.headerTitle}>Port history &amp; drift</h1>
          <p className={styles.headerSub}>Continuous SSH telemetry</p>
        </div>
        <span className={styles.spacer} />
      </header>
      <main className={styles.main}>
        <PortHistoryInner embedded={false} />
      </main>
    </div>
  );
}

function PortHistoryInner({ embedded, rackId = null }) {
  const [devices, setDevices]   = useState([]);
  const [loadErr, setLoadErr]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewErr, setOverviewErr] = useState(null);
  const [selectedPort, setSelectedPort] = useState(null);
  const [events, setEvents] = useState([]);
  const [showAllEvents, setShowAllEvents] = useState(false);

  // The change log for the chosen switch — what this page is for. Refreshed
  // on the same cadence as the overview so a port going down shows up here
  // as soon as it shows up there.
  useEffect(() => {
    if (!selectedId) { setEvents([]); return undefined; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(`/api/ports/${selectedId}/events?limit=300`));
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setEvents(Array.isArray(data.events) ? data.events : []);
      } catch { /* the overview above still stands */ }
    };
    tick();
    const id = setInterval(tick, OVERVIEW_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedId]);

  // Which switches this view is about.
  //
  // Inside a rack: the switches filed for THAT rack on the Network step, each
  // resolved to its Drift row by address — the Drift table withholds hosts
  // from its list on purpose, so the join runs through the by-host route that
  // exists for exactly this. Three switches added on Network are three
  // switches here; the page used to show only whichever device happened to
  // be first in the platform-wide list.
  //
  // Outside a rack (the standalone page): every device in scope, as before.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list = [];
        if (rackId) {
          const r = await authFetch(apiUrl(`/api/nb/switches?rackId=${encodeURIComponent(rackId)}`));
          const filed = r.ok ? await r.json() : [];
          const found = await Promise.all(filed.map(async (sw) => {
            try {
              const o = await authFetch(apiUrl(`/api/ports/by-host/${encodeURIComponent(sw.host)}/overview`));
              if (!o.ok) return null;
              const { device } = await o.json();
              // The name a person gave it on Network is the one they know.
              return device ? { ...device, display_name: sw.label || device.display_name } : null;
            } catch { return null; }
          }));
          list = found.filter(Boolean);
        } else {
          const r = await authFetch(apiUrl('/api/ports/devices'));
          const data = await r.json();
          list = data.devices || [];
        }
        if (cancelled) return;
        setDevices(list);
        setSelectedId(list.length ? list[0].id : null);
      } catch (err) {
        if (!cancelled) setLoadErr(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  // Poll overview while a device is selected (live port grid).
  useEffect(() => {
    if (!selectedId) { setOverview(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(`/api/ports/${selectedId}/overview`));
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          if (!cancelled) { setOverviewErr(text || `HTTP ${r.status}`); }
          return;
        }
        const data = await r.json();
        if (!cancelled) { setOverview(data); setOverviewErr(null); }
      } catch (err) {
        if (!cancelled) setOverviewErr(err.message);
      }
    };
    tick();
    const id = setInterval(tick, OVERVIEW_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedId]);

  const triggerPoll = async () => {
    if (!selectedId) return;
    try { await authFetch(apiUrl(`/api/ports/${selectedId}/poll`), { method: 'POST' }); }
    catch (_) {}
  };

  const device = overview?.device;

  return (
    <div className={embedded ? styles.embeddedWrap : ''}>
      {/* ── Which switch ── one row of names; the chosen one is filled. */}
      {devices.length > 1 && (
        <div className={styles.switcher} role="tablist" aria-label="Switches in this rack">
          {devices.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={d.id === selectedId}
              className={[styles.switcherBtn, d.id === selectedId ? styles.switcherOn : ''].join(' ')}
              onClick={() => { setSelectedId(d.id); setSelectedPort(null); }}
            >
              {d.display_name || d.model || `Switch ${d.id}`}
            </button>
          ))}
        </div>
      )}

      {/* ── The switch, as a band: what it is, when it was last read ── */}
      <section className={styles.band}>
        {loadErr && <div className={styles.errorLine}>{loadErr}</div>}
        {!device ? (
          <p className={styles.muted}>
            {rackId && devices.length === 0 && !loadErr
              ? 'No switch reading has reached the server for this rack yet. Read one on the Network step and it appears here.'
              : 'Waiting for the first reading…'}
          </p>
        ) : (() => {
          const ago = (iso) => {
            if (!iso) return null;
            const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
            if (m < 1) return 'just now';
            if (m < 60) return `${m} min ago`;
            const h = Math.round(m / 60);
            return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
          };
          const when = ago(device.last_polled_at || device.last_success_at);
          const ports = overview?.ports || [];
          const up = ports.filter((p) => p.oper === 'up').length;
          const down = ports.filter((p) => p.oper === 'down').length;
          const unknown = ports.length - up - down;
          const ident = [device.model, device.serial ? `serial ${device.serial}` : null,
            device.sw_version ? `firmware ${String(device.sw_version).split(' ')[0]}` : null].filter(Boolean).join(' · ');
          return (
            <>
              <div className={styles.bandTop}>
                <div className={styles.bandWho}>
                  <h2 className={styles.bandName}>{device.display_name || device.model || 'Switch'}</h2>
                  {ident && <p className={styles.bandIdent}>{ident}</p>}
                  <p className={styles.bandWhen}>
                    {when ? `Last read ${when}` : 'Not read yet'}
                    {device.system_name && device.system_name !== device.display_name ? ` · ${device.system_name}` : ''}
                  </p>
                </div>
                <button type="button" className={styles.readBtn} onClick={triggerPoll} aria-label="Read again">
                  Read again
                </button>
              </div>

              {ports.length > 0 && (
                <div className={styles.counts}>
                  <div><b>{ports.length}</b><span>ports</span></div>
                  <div><b className={styles.upNum}>{up}</b><span>up</span></div>
                  <div><b>{down}</b><span>down</span></div>
                  {unknown > 0 && <div><b>{unknown}</b><span>unknown</span></div>}
                </div>
              )}
            </>
          );
        })()}
      </section>

      {/* ── The faceplate ── */}
      {selectedId && overview && overview.ports.length > 0 && (
        <section className={styles.band}>
          <div className={styles.bandHead}><h3>Ports</h3><span>tap one for its history</span></div>
          {overviewErr && <div className={styles.errorLine}>{overviewErr}</div>}
          <div
            className={styles.portGrid}
            style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.ceil(overview.ports.length / 2))}, minmax(0, 1fr))` }}
          >
            {[...overview.ports].sort((a, b) => {
              const num = (x) => { const m = String(x).match(/(\d+)\s*$/); return m ? Number(m[1]) : Number.POSITIVE_INFINITY; };
              return num(a.port) - num(b.port);
            }).map((p) => (
              <button
                key={p.port}
                className={[styles.portCell, operClass(p.oper), selectedPort === p.port ? styles.portCellActive : '',
                  p.admin === 'disabled' ? styles.portDisabled : ''].join(' ')}
                onClick={() => setSelectedPort(p.port === selectedPort ? null : p.port)}
                title={`${p.port} · ${p.oper} · ${fmtSpeed(p.speed_mbps)}`}
              >
                <span className={styles.portName}>{portNum(p.port)}</span>
              </button>
            ))}
          </div>
          <p className={styles.key}>
            <i className={styles.keyUp} /> up <i className={styles.keyDown} /> down <i className={styles.keyUnknown} /> not answered
          </p>
        </section>
      )}
      {selectedId && overview && overview.ports.length === 0 && (
        <section className={styles.band}>
          <p className={styles.muted}>No port data has arrived for this switch yet.</p>
        </section>
      )}

      {/* ── What changed — the point of the page ── */}
      {selectedId && (
        <section className={styles.band}>
          <div className={styles.bandHead}>
            <h3>What changed</h3>
            <span>{events.length ? `${events.length} change${events.length === 1 ? '' : 's'}` : ''}</span>
          </div>
          {events.length === 0 ? (
            <p className={styles.muted}>Nothing has changed between readings.</p>
          ) : (
            <>
              <ul className={styles.evts}>
                {(showAllEvents ? events : events.slice(0, 12)).map((e) => (
                  <li key={e.id || `${e.port}-${e.field}-${e.at}`} className={styles.evt}>
                    <button type="button" className={styles.evtPort} onClick={() => setSelectedPort(e.port)}>{e.port}</button>
                    <span className={styles.evtWhat}>{describeEvent(e)}</span>
                    <span className={styles.evtWhen}>{agoShort(e.at)}</span>
                  </li>
                ))}
              </ul>
              {events.length > 12 && (
                <button type="button" className={styles.viewAll} onClick={() => setShowAllEvents((v) => !v)}>
                  {showAllEvents ? 'Show fewer' : `View all ${events.length}`}
                </button>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Per-port detail — rendered as a bottom sheet so the page
          stops being one long vertical column. Tap a tile to slide in
          the detail; close button (or backdrop) dismisses it. ─────── */}
      {selectedId && selectedPort && (
        <InterfaceDetail
          deviceId={selectedId}
          device={device}
          port={selectedPort}
          onClose={() => setSelectedPort(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-port detail — Arista CloudVision-style layout:
//   Header (port + close)
//   Interface Details
//   Interface Status  (stacked-bar timeline + window selector)
//   Interface Configuration
//   Maintenance State
//   Value at 1h/3h/12h/1d/1w ago
//   Change log
// ─────────────────────────────────────────────────────────────────────
function InterfaceDetail({ deviceId, device, port, onClose }) {
  const [history, setHistory]   = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [windowKey, setWindowKey] = useState('1h');
  // Inner section selector — splits Specs / Timeline / History so the
  // panel renders one block at a time instead of one tall scroll.
  const [detailTab, setDetailTab] = useState('specs');
  const windowSec = useMemo(
    () => WINDOW_OPTIONS.find((o) => o.key === windowKey)?.sec ?? 3600,
    [windowKey],
  );

  // Poll the textual history (current + offsets + events)
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(
          `/api/ports/${deviceId}/${encodeURIComponent(port)}/history`));
        const data = await r.json();
        if (!cancelled) setHistory(data);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, HISTORY_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [deviceId, port]);

  // Poll the timeline data — rebuilds when the window selector changes
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(
          `/api/ports/${deviceId}/${encodeURIComponent(port)}/timeline?window=${windowSec}`));
        const data = await r.json();
        if (!cancelled) setTimeline(data);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, TIMELINE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [deviceId, port, windowSec]);

  const current = history?.current;
  const events  = history?.events || [];
  const offsets = history?.offsets || {};

  const offsetRows = dedupedOffsets(offsets);

  return (
    <section className={styles.card}>
      {/* ── Sticky head: port chip + Specs/Timeline/History tabs + close ── */}
      <div className={styles.detailHead}>
        <div className={styles.detailHeadTitle}>
          <span className={styles.portChip}>{port}</span>
          <span className={styles.portSubtitle}>
            on {device?.display_name || 'switch'}
          </span>
        </div>
        <button className={styles.detailClose} onClick={onClose} aria-label="Close port detail">×</button>
      </div>

      <div className={styles.detailTabs} role="tablist" aria-label="Port detail sections">
        {[
          { k: 'specs',    label: 'Specs' },
          { k: 'timeline', label: 'Timeline' },
          { k: 'history',  label: `History${events.length ? ` · ${events.length}` : ''}` },
        ].map(t => (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={detailTab === t.k}
            className={`${styles.detailTab} ${detailTab === t.k ? styles.detailTabActive : ''}`}
            onClick={() => setDetailTab(t.k)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Specs tab: merged Interface details ─────────────────── */}
      {detailTab === 'specs' && (
        <div className={styles.kvGrid}>
          <KV label="Operational"   value={current?.oper || '-'} cls={operClass(current?.oper)} />
          <KV label="Admin State"   value={current?.admin || '-'} />
          <KV label="Speed"         value={fmtSpeed(current?.speed_mbps)} />
          <KV label="Duplex"        value={current?.duplex || '-'} />
          <KV label="Flow Control"  value={current?.flowctrl || '-'} />
          <KV label="Active Medium" value={current?.medium || '-'} />
          <KV label="MAC"           value={device?.mac || '-'} mono />
          <KV label="Description"   value={current?.descr || '(none)'} />
          <KV label="Last change"   value={current?.ts ? fmtAgo(current.ts) : '-'} />
          <KV label="Last poll"     value={device?.last_seen ? fmtAgo(device.last_seen) : '-'} />
        </div>
      )}

      {/* ── Timeline tab: window selector + stacked-bar timeline ── */}
      {detailTab === 'timeline' && (
        <>
          <div className={styles.statusBlockHead}>
            <span className={styles.detailMutedLabel}>Window</span>
            <select
              className={styles.select}
              value={windowKey}
              onChange={(e) => setWindowKey(e.target.value)}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>
          <StackedTimeline timeline={timeline} windowSec={windowSec} />
        </>
      )}

      {/* ── History tab: "Value at" offsets + change log ────────── */}
      {detailTab === 'history' && (
        <>
          {offsetRows.length > 0 && (
            <>
              <h3 className={styles.subTitle}>Value at</h3>
              <div className={styles.offsetTableWrap}>
                <table className={styles.offsetTable}>
                  <thead>
                    <tr><th>Ago</th><th>Oper</th><th>Admin</th><th>Speed</th><th>Recorded</th></tr>
                  </thead>
                  <tbody>
                    {offsetRows.map(({ sig, snap: s, label }) => (
                      <tr key={sig}>
                        <td>{label}</td>
                        <td className={operClass(s.oper)}>{s.oper ?? '-'}</td>
                        <td>{s.admin ?? '-'}</td>
                        <td>{fmtSpeed(s.speed_mbps)}</td>
                        <td className={styles.tsCell}>{fmtTs(s.ts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 className={styles.subTitle}>Change log ({events.length})</h3>
          {events.length === 0 ? (
            <div className={styles.muted}>No changes recorded yet.</div>
          ) : (
            <ul className={styles.eventList}>
              {events.map((e) => (
                <li key={e.id} className={styles.eventRow}>
                  <div className={styles.eventMain}>
                    <div className={styles.eventHuman}>{humanizeEvent(e)}</div>
                    <div className={styles.eventRaw}>
                      <span className={styles.eventField}>{e.field}</span>
                      <code className={styles.eventVal}>{e.from_val ?? '∅'}</code>
                      <span className={styles.arrow}>→</span>
                      <code className={styles.eventVal}>{e.to_val ?? '∅'}</code>
                    </div>
                  </div>
                  <span className={styles.eventTime} title={fmtTs(e.at)}>{fmtAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function KV({ label, value, cls = '', mono = false }) {
  return (
    <div className={styles.kvRow}>
      <div className={styles.kvLabel}>{label}</div>
      <div className={[styles.kvValue, mono ? styles.kvMono : '', cls].join(' ')}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// StackedTimeline — four horizontal bars (one per tracked field) with
// transition segments coloured by value, plus a tick axis. Reproduces
// the Interface Status panel from the Arista CV screenshot.
// ─────────────────────────────────────────────────────────────────────
function StackedTimeline({ timeline, windowSec }) {
  const data = useMemo(() => {
    if (!timeline) return null;
    const startMs = new Date(timeline.start_at).getTime();
    const endMs   = new Date(timeline.end_at).getTime();
    return { startMs, endMs };
  }, [timeline]);

  if (!timeline || !data) {
    return <div className={styles.timelineEmpty}>Loading timeline…</div>;
  }
  const { startMs, endMs } = data;
  const totalMs = endMs - startMs;
  const noData  = !timeline.initial && timeline.snapshots.length === 0;

  // Build 5 evenly-spaced ticks for the axis.
  const ticks = Array.from({ length: 5 }, (_, i) =>
    startMs + (totalMs * i) / 4
  );

  return (
    <div className={styles.timelineCard}>
      {/* time axis on top */}
      <div className={styles.timelineAxis}>
        {ticks.map((t, i) => (
          <span key={i} className={styles.timelineTick}>{fmtTick(t, windowSec)}</span>
        ))}
      </div>

      {noData ? (
        <div className={styles.timelineEmpty}>
          No snapshots in this window yet - let the poller run for a few
          cycles and the bars below will fill in.
        </div>
      ) : (
        <div className={styles.timelineStack}>
          {TIMELINE_BARS.map((bar) => {
            const segments = buildSegments(
              timeline.initial, timeline.snapshots, bar.field, startMs, endMs,
            );
            const last = segments[segments.length - 1];
            return (
              <div key={bar.field} className={styles.timelineRow}>
                <div className={styles.timelineRowHead}>
                  <span className={styles.timelineRowLabel}>{bar.label}</span>
                  {last && (
                    <span
                      className={styles.timelineRowValue}
                      style={{ '--seg-color': bar.colorOf(last.value) }}
                    >
                      {bar.formatValue(last.value)}
                    </span>
                  )}
                </div>
                <div className={styles.timelineTrack}>
                  {segments.length === 0 && (
                    <div className={styles.timelineEmptyBar}>no data</div>
                  )}
                  {segments.map((seg, i) => {
                    const left  = ((seg.startMs - startMs) / totalMs) * 100;
                    const width = ((seg.endMs   - seg.startMs) / totalMs) * 100;
                    return (
                      <div
                        key={i}
                        className={styles.timelineSegment}
                        style={{
                          left:   `${Math.max(0, left)}%`,
                          width:  `${Math.max(0.5, width)}%`,
                          background: bar.colorOf(seg.value),
                        }}
                        title={`${bar.label}: ${bar.formatValue(seg.value)} from ${fmtTs(new Date(seg.startMs).toISOString())}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
