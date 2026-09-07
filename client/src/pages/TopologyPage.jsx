import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSmartBack } from '../hooks/useSmartBack';
import { apiUrl, authFetch } from '../utils/api';
import { getCached, setCached, cacheKey } from '../utils/scanPrefetch';
import RackTabs from '../components/RackTabs.jsx';
import styles from './TopologyPage.module.css';
import { getItem, setItem } from '../utils/safeStorage';

const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));

const TIER_COLOR = {
  core: '#4f46e5',          // indigo — uplink / core
  distribution: '#2563eb',  // blue — switches
  access: '#0d9488',        // teal — patch panels
  endpoint: '#f59e0b',      // amber — servers / hosts
};

const CLASS_LABEL = {
  switch: 'Switch',
  router: 'Router',
  patch_panel: 'Patch Panel',
  server: 'Server',
};

// The detector emits free-form class names - "Switch", "Patch Panel",
// "Server": Title Case, with spaces. Every comparison on this page tested
// `dev.class === 'switch'` / `'patch_panel'`, which matches none of them, so
// the rack banner counted zero of everything, every device fell through to no
// tier, and they all drew the default glyph. Normalise both sides rather than
// trusting the exact casing of upstream data. `class_name` is accepted too,
// since that is the field name the scan pipeline uses.
const clsOf = (dev) => String(dev?.class ?? dev?.class_name ?? '')
  .trim().toLowerCase().replace(/[\s-]+/g, '_');

function tierOf(dev) {
  const c = clsOf(dev);
  if (!dev.in_rack && c === 'switch') return 'core';
  if (c === 'router') return 'core';
  if (c === 'switch') return 'distribution';
  if (c === 'patch_panel') return 'access';
  if (c === 'server') return 'endpoint';
  return null;
}

const TIER_ORDER = ['core', 'distribution', 'access', 'endpoint'];
const TIER_LABEL = {
  core: 'CORE / UPLINK',
  distribution: 'SWITCHES',
  access: 'PATCH PANELS',
  endpoint: 'END HOSTS',
};

const VIEW_KEY = 'topology.view';

// Cable-type filter — matches the same buckets as cableColor() in TopologyScene3D.
function matchesCableType(cable_type, filter) {
  if (filter === 'all') return true;
  const t = (cable_type || '').toLowerCase();
  if (filter === 'fiber') return /fiber|mm|sm/.test(t);
  if (filter === 'dac')   return /dac|twinax/.test(t);
  if (filter === 'cat')   return t.startsWith('cat');
  return true;
}

// Capacity → color: green (lots free) → amber → red (nearly full).
function heatmapColor(freePct) {
  if (freePct === null || freePct === undefined) return '#535353';
  if (freePct >= 0.5)  return '#22c55e';
  if (freePct >= 0.25) return '#f59e0b';
  return '#ef4444';
}

// ── Rack Elevation view helpers ──────────────────────────────
// Physical rack diagram: every device drawn at its real U position with its
// ports, plus cables, so it matches the scan and shows everything at once.
const CLASS_COLOR_RACK = {
  switch: '#2563eb', patch_panel: '#0d9488', server: '#f59e0b',
  pdu: '#ec4899', router: '#6366f1', firewall: '#ef4444',
  gateway: '#8b5cf6', ups: '#14b8a6', psu: '#a3a3a3',
  unidentified: '#727272',
};
const rackClassColor = (c) => CLASS_COLOR_RACK[c] || '#727272';

// Port square colour by kind + connected state.
function rackPortColor(p) {
  if (p.is_uplink) return '#f59e0b';
  if (p.kind === 'sfp')     return p.connected ? '#22d3ee' : '#155e75';
  if (p.kind === 'console') return '#a855f7';
  if (p.kind === 'usb' || p.kind === 'other') return '#f97316';
  return p.connected ? '#22c55e' : '#3f3f3f';   // main RJ45: green connected / dark free
}

function rackCableColor(t) {
  const s = (t || '').toLowerCase();
  if (/fiber|mm|sm/.test(s)) return '#22d3ee';
  if (/dac|twinax/.test(s))  return '#f59e0b';
  if (s.startsWith('cat'))   return '#38bdf8';
  return '#a1a1a1';
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function TopologyContent({ rackId }) {
  return <TopologyInner rackId={rackId} embedded />;
}

// ── Standalone page (used by /results/:rackId/topology route) ───
export default function TopologyPage() {
  const { rackId } = useParams();
  return <TopologyInner rackId={rackId} embedded={false} />;
}

function TopologyInner({ rackId, embedded }) {
  const navigate = useNavigate();
  // Declared HERE, not in TopologyPage: this is the component that renders the
  // Back button. It used to live in the parent, so every "← Back" tap threw
  // ReferenceError: goBack is not defined and stranded the user on the page.
  const goBack = useSmartBack(rackId ? `/results/${rackId}` : '/scan');
  // Hydrate from the prefetch cache so that a tab/page switch into
  // /results/:rackId/topology after a fresh analyze renders the 3D scene
  // immediately, without the "Loading topology…" spinner. ScanPage fired
  // prefetchScan(rackId) at analyze time so this is normally already
  // resolved by the time the user gets here.
  const cachedTopo = rackId ? getCached(cacheKey.topology(rackId)) : null;
  const [topo, setTopo] = useState(cachedTopo);
  const [err, setErr] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // bump to re-fetch (Retry button)
  const [selected, setSelected] = useState(null); // { kind: 'node'|'edge', id }
  const [view, setView] = useState(() => {
    try { return getItem(VIEW_KEY) || '2d'; } catch { return '2d'; }
  });
  const [cableFilter, setCableFilter] = useState('all'); // 'all' | 'cat' | 'fiber' | 'dac'
  const [heatmap, setHeatmap]         = useState(false);
  const [traceMode, setTraceMode]     = useState(false);
  const [traceA, setTraceA]           = useState(null);
  const [traceB, setTraceB]           = useState(null);
  const [hoverInfo, setHoverInfo]     = useState(null); // { name, dev, freePct, tier }

  useEffect(() => {
    try { setItem(VIEW_KEY, view); } catch {}
  }, [view]);

  useEffect(() => {
    if (!rackId) return;
    // If we already hydrated from the prefetch cache, no fetch needed.
    if (topo) return;
    let cancelled = false;
    let timer = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 15;   // ~60s of polling while the snapshot generates
    const RETRY_MS = 4000;

    const load = async () => {
      try {
        const r = await authFetch(apiUrl(`/api/topology/${rackId}`));
        // 404 = the server just kicked off snapshot generation; keep polling
        // instead of dead-ending on the "being prepared" screen.
        if (r.status === 404) {
          attempts += 1;
          if (!cancelled) {
            if (attempts < MAX_ATTEMPTS) timer = setTimeout(load, RETRY_MS);
            else setErr('Topology could not be prepared. Try rescanning this rack.');
          }
          return;
        }
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        if (!cancelled) {
          setErr(null);
          setTopo(data);
          setCached(cacheKey.topology(rackId), data);
        }
      } catch (e) {
        // Transient (server restarting, network blip) — retry a few times
        // before giving up so a brief hiccup doesn't strand the page.
        attempts += 1;
        if (!cancelled) {
          if (attempts < MAX_ATTEMPTS) timer = setTimeout(load, RETRY_MS);
          else setErr(e.message);
        }
      }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId, reloadKey]);

  const retry = () => { setErr(null); setReloadKey(k => k + 1); };

  // Filtered topology — same shape, just with cables narrowed by the active
  // pill. Filter at the topo level so both 2D + 3D + bottom-panel agree.
  const filteredTopo = useMemo(() => {
    if (!topo) return null;
    if (cableFilter === 'all') return topo;
    return {
      ...topo,
      edges: topo.edges.filter(e => matchesCableType(e.cable_type, cableFilter)),
    };
  }, [topo, cableFilter]);

  // Per-cable-type counts for the filter pill labels.
  const cableCounts = useMemo(() => {
    const c = { all: 0, cat: 0, fiber: 0, dac: 0 };
    if (!topo) return c;
    c.all = topo.edges.length;
    for (const e of topo.edges) {
      const t = (e.cable_type || '').toLowerCase();
      if (t.startsWith('cat'))           c.cat++;
      else if (/fiber|mm|sm/.test(t))    c.fiber++;
      else if (/dac|twinax/.test(t))     c.dac++;
    }
    return c;
  }, [topo]);

  // Free-port % per device — drives the capacity heatmap when toggled on.
  const freePctByDevice = useMemo(() => {
    const m = new Map();
    if (!topo) return m;
    for (const d of topo.devices) {
      const total = (d.ports || []).length;
      if (total === 0) { m.set(d.name, null); continue; }
      const connected = d.ports.filter(p => p.connected !== false).length;
      m.set(d.name, (total - connected) / total);
    }
    return m;
  }, [topo]);

  // Aggregate edges by unordered device pair: 24 cables SW-U10↔PP-U12 -> 1 edge with count=24.
  const aggEdges = useMemo(() => {
    if (!filteredTopo) return [];
    const m = new Map();
    for (const e of filteredTopo.edges) {
      const a = e.src.device, b = e.dst.device;
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      if (!m.has(key)) m.set(key, { a: a < b ? a : b, b: a < b ? b : a, count: 0, cables: [] });
      const v = m.get(key);
      v.count += 1;
      v.cables.push(e);
    }
    return Array.from(m.values());
  }, [filteredTopo]);

  // BFS the device-pair graph to find a connection path A → B.
  const tracePath = useMemo(() => {
    if (!traceMode || !traceA || !traceB) return null;
    const adj = new Map();
    for (const e of aggEdges) {
      if (!adj.has(e.a)) adj.set(e.a, new Set());
      if (!adj.has(e.b)) adj.set(e.b, new Set());
      adj.get(e.a).add(e.b);
      adj.get(e.b).add(e.a);
    }
    if (traceA === traceB) return [traceA];
    const visited = new Set([traceA]);
    const queue   = [[traceA]];
    while (queue.length) {
      const path = queue.shift();
      const node = path[path.length - 1];
      for (const next of (adj.get(node) || [])) {
        if (visited.has(next)) continue;
        visited.add(next);
        const newPath = [...path, next];
        if (next === traceB) return newPath;
        queue.push(newPath);
      }
    }
    return [];   // empty array = no path found
  }, [traceMode, traceA, traceB, aggEdges]);

  // Set of edge keys ("a::b" sorted) that make up the trace path.
  const traceEdgeKeys = useMemo(() => {
    if (!tracePath || tracePath.length < 2) return null;
    const keys = new Set();
    for (let i = 0; i < tracePath.length - 1; i++) {
      const a = tracePath[i], b = tracePath[i+1];
      keys.add(a < b ? `${a}::${b}` : `${b}::${a}`);
    }
    return keys;
  }, [tracePath]);

  const tracePathSet = useMemo(
    () => (tracePath && tracePath.length > 0 ? new Set(tracePath) : null),
    [tracePath]
  );

  // Wrap setSelected so trace mode intercepts clicks: 1st click → A, 2nd → B,
  // 3rd → resets to a new A. Click-empty (PointerMissed) clears trace too.
  const handleSelect = (sel) => {
    if (traceMode && sel?.kind === 'node') {
      if (!traceA || (traceA && traceB)) { setTraceA(sel.id); setTraceB(null); }
      else if (sel.id !== traceA)        { setTraceB(sel.id); }
      return;
    }
    setSelected(sel);
  };

  // Selection details (used by BottomPanel — works for both 2D and 3D views)
  const selectionInfo = useMemo(() => {
    if (!topo || !selected) return null;
    const deviceMap = new Map(topo.devices.map(d => [d.name, d]));
    if (selected.kind === 'node') {
      const dev = deviceMap.get(selected.id);
      if (!dev) return null;
      const peers = aggEdges
        .filter(e => e.a === dev.name || e.b === dev.name)
        .map(e => ({ peer: e.a === dev.name ? e.b : e.a, count: e.count, cables: e.cables }))
        .sort((x, y) => y.count - x.count);
      return { kind: 'node', dev, peers };
    }
    if (selected.kind === 'cable') {
      const cable = topo.edges.find(c => c.cable_id === selected.id);
      return cable ? { kind: 'cable', cable } : null;
    }
    const e = aggEdges.find(x => `${x.a}::${x.b}` === selected.id);
    return e ? { kind: 'edge', edge: e } : null;
  }, [topo, selected, aggEdges]);

  if (err) {
    const errBody = (
      <>
        <div className={styles.error}>Topology is being prepared</div>
        <div className={styles.errorHint}>
          The topology snapshot for this rack isn't ready yet - it generates in the background after a scan. It should appear on its own; tap Retry if it doesn't, or rescan to regenerate it.
        </div>
        <button
          type="button"
          onClick={retry}
          style={{ marginTop: 14, alignSelf: 'flex-start', padding: '10px 18px', borderRadius: 10,
                   border: '1px solid #000000', background: '#000000', color: '#fff',
                   fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >Retry</button>
      </>
    );
    if (embedded) return errBody;
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => goBack()} />
        {errBody}
      </div>
    );
  }
  if (!topo) {
    if (embedded) return <div className={styles.loading}>Loading topology…</div>;
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => goBack()} />
        <div className={styles.loading}>Loading topology…</div>
      </div>
    );
  }

  const topoBody = (
    <>
      {!embedded && (
        <PageHeader
          rackId={rackId}
          onBack={() => goBack()}
          stats={topo.stats}
          view={view}
          setView={(v) => { setView(v); setSelected(null); }}
          showCables={view !== '3d'}
        />
      )}
      <RackBanner
        topo={topo}
        view={embedded ? view : null}
        setView={embedded ? ((v) => { setView(v); setSelected(null); }) : null}
      />

      {traceMode && (
        <TraceBanner
          traceA={traceA} traceB={traceB} tracePath={tracePath}
          clear={() => { setTraceA(null); setTraceB(null); }}
        />
      )}

      <div className={styles.graphWrap}>
        {view === '3d' ? (
          <Suspense fallback={<div className={styles.loading}>Initializing 3D scene…</div>}>
            <div className={styles.scene3dWrap}>
              <TopologyScene3D
                topo={filteredTopo}
                selected={selected}
                setSelected={handleSelect}
                aggEdges={aggEdges}
                heatmap={heatmap}
                freePctByDevice={freePctByDevice}
                traceMode={traceMode}
                traceA={traceA}
                traceB={traceB}
                tracePathSet={tracePathSet}
                traceEdgeKeys={traceEdgeKeys}
                onHoverDevice={setHoverInfo}
              />
              <SceneOverlay traceMode={traceMode} />
              {hoverInfo && <HoverInfoCard info={hoverInfo} />}
            </div>
          </Suspense>
        ) : (
          <RackElevation topo={topo} selected={selected} setSelected={handleSelect} />
        )}

        <BottomPanel
          info={selectionInfo}
          clear={() => setSelected(null)}
          topo={filteredTopo}
          aggEdges={aggEdges}
        />
      </div>
    </>
  );

  if (embedded) return topoBody;
  return <div className={styles.page}>{topoBody}</div>;
}

// The rack's identity and the view switch. It used to carry a strip of five
// counted tiles under that — size, switches, panels, servers, cables — which is
// what a dashboard does, not what a diagram does: every one of those numbers is
// visible by looking at the drawing directly below, and the strip pushed the
// drawing itself off the top of a phone screen.
function RackBanner({ topo, view, setView }) {
  const showToggle = !!(view && setView);
  return (
    <div className={styles.rackBanner}>
      <div className={styles.rackBannerHead}>
        <span className={styles.rackBadge}>RACK</span>
        <div className={styles.rackBannerCol}>
          <span className={styles.rackBannerName}>{topo.rackName}</span>
          <span className={styles.rackBannerId}>{topo.rackId}</span>
        </div>
        {showToggle && (
          <div className={styles.viewToggle} role="tablist" aria-label="Topology view">
            <button
              type="button"
              className={`${styles.viewBtn} ${view !== '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('2d')}
              aria-pressed={view !== '3d'}
            >2D</button>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('3d')}
              aria-pressed={view === '3d'}
            >3D</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PageHeader({ rackId, onBack, stats, view, setView, showCables = true }) {
  const subtitle = stats
    ? `${rackId} · ${stats.device_count_in_rack} devices${showCables ? ` · ${stats.edge_count} cables` : ''}`
    : rackId;
  return (
    <>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>← Back</button>
        <div className={styles.headerCenter}>
          <h2>Rack Topology</h2>
          <span className={styles.headerMono}>{subtitle}</span>
        </div>
        {view ? (
          <div className={styles.viewToggle} role="tablist" aria-label="Topology view">
            <button
              type="button"
              className={`${styles.viewBtn} ${view !== '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('2d')}
              aria-pressed={view !== '3d'}
            >2D</button>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('3d')}
              aria-pressed={view === '3d'}
            >3D</button>
          </div>
        ) : (
          <div style={{ width: 64 }} />
        )}
      </header>
      <RackTabs rackId={rackId} />
    </>
  );
}

// ── Toolbar: cable-type filter pills + capacity-heatmap + trace ─────────────
function Toolbar({ cableFilter, setCableFilter, cableCounts, heatmap, setHeatmap,
                   traceMode, toggleTrace }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.filterPills}>
        <FilterPill active={cableFilter==='all'}   onClick={() => setCableFilter('all')}
                    label="All"   count={cableCounts.all} />
        <FilterPill active={cableFilter==='cat'}   onClick={() => setCableFilter('cat')}
                    label="Cat"   count={cableCounts.cat}   color="#6366f1" />
        <FilterPill active={cableFilter==='fiber'} onClick={() => setCableFilter('fiber')}
                    label="Fiber" count={cableCounts.fiber} color="#fbbf24" />
        <FilterPill active={cableFilter==='dac'}   onClick={() => setCableFilter('dac')}
                    label="DAC"   count={cableCounts.dac}   color="#a78bfa" />
      </div>
      <div className={styles.toolbarRight}>
        <button
          type="button"
          className={`${styles.heatmapBtn} ${heatmap ? styles.heatmapBtnActive : ''}`}
          onClick={() => setHeatmap(v => !v)}
          title="Color devices by free-port %"
        >
          {heatmap ? 'Capacity ON' : 'Capacity'}
        </button>
        <button
          type="button"
          className={`${styles.heatmapBtn} ${traceMode ? styles.traceBtnActive : ''}`}
          onClick={toggleTrace}
          title="Click two devices to trace the cable path between them"
        >
          {traceMode ? 'Trace ON' : 'Trace'}
        </button>
      </div>
    </div>
  );
}

// Trace banner — appears under the toolbar when trace mode is on. Shows
// which endpoints are picked + path summary + clear button.
function TraceBanner({ traceA, traceB, tracePath, clear }) {
  let body;
  if (!traceA) {
    body = <span className={styles.traceHint}>Click the <b>first</b> device.</span>;
  } else if (!traceB) {
    body = (
      <span className={styles.traceHint}>
        From <code>{traceA}</code> · click the <b>second</b> device.
      </span>
    );
  } else if (!tracePath || tracePath.length === 0) {
    body = (
      <span className={styles.traceHint} style={{ color: '#000000' }}>
        No cable path between <code>{traceA}</code> and <code>{traceB}</code>.
      </span>
    );
  } else {
    body = (
      <span className={styles.traceHint}>
        <code>{traceA}</code>
        <span className={styles.peerArrow}> → </span>
        <code>{traceB}</code>
        <span style={{ marginLeft: 8, color: '#000000' }}>
          {tracePath.length - 1} hop{tracePath.length - 1 === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 6, color: '#717171' }}>
          ({tracePath.join(' → ')})
        </span>
      </span>
    );
  }
  return (
    <div className={styles.traceBanner}>
      {body}
      {(traceA || traceB) && (
        <button className={styles.clearBtn} onClick={clear}>clear</button>
      )}
    </div>
  );
}

function FilterPill({ active, onClick, label, count, color }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.filterPill} ${active ? styles.filterPillActive : ''}`}
    >
      {color && <span className={styles.filterPillDot} style={{ background: color }} />}
      <span>{label}</span>
      <span className={styles.filterPillCount}>{count}</span>
    </button>
  );
}

// ── 3D scene chrome: a single orbit hint pinned to the bottom-right corner.
// (Tier legend is already in the bottom panel — no need to duplicate it here.)
// Pinned hover card in the top-left of the 3D scene — never overlaps devices.
function HoverInfoCard({ info }) {
  const ports     = info.dev.ports || [];
  const total     = ports.length;
  const connected = ports.filter(p => p.connected !== false).length;
  const free      = total - connected;
  const tierLabel = CLASS_LABEL[info.dev.class] || info.dev.class;
  return (
    <div className={styles.hoverCard} aria-hidden="true">
      <div className={styles.hoverCardName}>{info.dev.name}</div>
      <div className={styles.hoverCardSub}>
        {tierLabel}{info.dev.u_position ? ` · U${String(info.dev.u_position).padStart(2,'0')}` : ''}
        {info.dev.model ? ` · ${info.dev.model}` : ''}
      </div>
      {total > 0 && (
        <div className={styles.hoverCardPorts}>
          <span style={{ color: '#000000' }}>{connected}/{total}</span> connected
          <span style={{ color: '#717171', marginLeft: 6 }}>· {free} free</span>
        </div>
      )}
    </div>
  );
}


function SceneOverlay({ traceMode }) {
  const hint = traceMode
    ? 'TRACE MODE · click two devices to find the cable path between them'
    : 'right click and drag to orbit · scroll to zoom · zoom in to switch to hand-pan';
  return (
    <div className={styles.sceneOverlay} aria-hidden="true">
      <div className={styles.sceneHint}>{hint}</div>
    </div>
  );
}

// ── 2D graph (the original SVG view) ───────────────────────────────────────
// Ports laid out as a wrapped grid of squares inside a device bar.
function RackPortStrip({ ports, x, y, w, h }) {
  if (!ports || !ports.length) return null;
  const gap = 2;
  let sq = 9;
  const layout = (s) => {
    const cols = Math.max(1, Math.floor((w + gap) / (s + gap)));
    const rows = Math.ceil(ports.length / cols);
    return { cols, rows, ok: rows * (s + gap) - gap <= h };
  };
  while (sq > 4 && !layout(sq).ok) sq -= 1;
  const { cols } = layout(sq);
  const maxRows = Math.max(1, Math.floor((h + gap) / (sq + gap)));
  const shown = Math.min(ports.length, cols * maxRows);
  return (
    <g>
      {ports.slice(0, shown).map((p, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        return (
          <rect key={i} x={x + c * (sq + gap)} y={y + r * (sq + gap)} width={sq} height={sq} rx={1.5}
            fill={rackPortColor(p)} stroke="rgba(0,0,0,0.4)" strokeWidth={0.5}>
            <title>{`${p.label || p.name}${p.connected ? ' · connected' : ' · free'}${p.is_uplink ? ' · uplink' : ''}${p.kind && p.kind !== 'main' ? ` · ${p.kind}` : ''}`}</title>
          </rect>
        );
      })}
      {shown < ports.length && (
        <text x={x + cols * (sq + gap) + 2} y={y + sq} className={styles.rackElevPortMore}>+{ports.length - shown}</text>
      )}
    </g>
  );
}

function RackElevLegend() {
  const items = [
    ['#22c55e', 'connected'], ['#3f3f3f', 'free RJ45'], ['#22d3ee', 'SFP'],
    ['#a855f7', 'console'], ['#f59e0b', 'uplink'],
  ];
  const cables = [['#38bdf8', 'Cat'], ['#22d3ee', 'Fiber'], ['#f59e0b', 'DAC']];
  return (
    <div className={styles.rackElevLegend}>
      <span className={styles.rackElevLegendGroup}>Ports:</span>
      {items.map(([c, l]) => (
        <span key={l} className={styles.rackElevLegendItem}>
          <span className={styles.rackElevSwatch} style={{ background: c }} />{l}
        </span>
      ))}
      <span className={styles.rackElevLegendGroup}>Cables:</span>
      {cables.map(([c, l]) => (
        <span key={l} className={styles.rackElevLegendItem}>
          <span className={styles.rackElevLine} style={{ background: c }} />{l}
        </span>
      ))}
    </div>
  );
}

// Physical rack elevation: numbered U slots (incl. empties), every device at
// its real U position with its ports, off-rack uplink devices, and cables.
export function RackElevation({ topo, selected, setSelected }) {
  const U = Math.max(1, topo.u_size || 24);
  const U_H = 34, PAD = 18, TITLE_H = 34;
  const GUTTER = 42, RACK_X = PAD + GUTTER, RACK_W = 440, CHANNEL = 80;
  const EXT_X = RACK_X + RACK_W + CHANNEL, EXT_W = 184;
  const W = EXT_X + EXT_W + PAD;
  const rackTop = PAD + TITLE_H, rackH = U * U_H, H = rackTop + rackH + PAD + 6;
  const yTopUnit = (u) => rackTop + (U - u) * U_H;

  const inRack = (topo.devices || []).filter(d => d.in_rack);
  const offRack = (topo.devices || []).filter(d => !d.in_rack);
  const anchor = new Map();

  const rects = inRack.map(d => {
    const s = Math.max(1, d.u_size || 1), p = Math.max(1, d.u_position || 1);
    const y = yTopUnit(p + s - 1), h = s * U_H;
    anchor.set(d.name, { x: RACK_X + RACK_W, y: y + h / 2 });
    return { d, x: RACK_X, y, w: RACK_W, h, p, s };
  });
  const OFF_H = 50, OFF_GAP = 16;
  const offRects = offRack.map((d, i) => {
    const y = rackTop + i * (OFF_H + OFF_GAP);
    anchor.set(d.name, { x: EXT_X, y: y + OFF_H / 2 });
    return { d, x: EXT_X, y, w: EXT_W, h: OFF_H };
  });

  const occupied = new Set();
  for (const { p, s } of rects) for (let u = p; u < p + s; u++) occupied.add(u);

  const edges = topo.edges || [];
  const isSel = (name) => selected?.kind === 'node' && selected.id === name;

  return (
    <div className={styles.rackElevWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.rackElevSvg} preserveAspectRatio="xMidYMin meet">
        <text x={RACK_X - GUTTER} y={PAD + 12} className={styles.rackElevTitle}>{(topo.rackName || topo.rackId)} · {U}U</text>
        <rect x={RACK_X - 7} y={rackTop - 7} width={RACK_W + 14} height={rackH + 14} rx={9} className={styles.rackElevFrame} />

        {/* U rows + numbers + empty markers */}
        {Array.from({ length: U }, (_, i) => {
          const u = U - i;
          const y = yTopUnit(u);
          return (
            <g key={`u${u}`}>
              {i > 0 && <line x1={RACK_X} y1={y} x2={RACK_X + RACK_W} y2={y} className={styles.rackElevRule} />}
              <text x={RACK_X - 12} y={y + U_H * 0.64} textAnchor="end" className={styles.rackElevUNum}>U{String(u).padStart(2, '0')}</text>
              {!occupied.has(u) && (
                <text x={RACK_X + RACK_W / 2} y={y + U_H * 0.66} textAnchor="middle" className={styles.rackElevEmpty}>empty</text>
              )}
            </g>
          );
        })}

        {/* cables (under devices so nodes stay legible) */}
        {edges.map((e, i) => {
          const a = anchor.get(e.src?.device), b = anchor.get(e.dst?.device);
          if (!a || !b) return null;
          const midX = (a.x + b.x) / 2 + 8;
          const d = `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`;
          return (
            <path key={`c${i}`} d={d} fill="none" stroke={rackCableColor(e.cable_type)} strokeWidth={2} opacity={0.8}>
              <title>{`${e.src?.device} → ${e.dst?.device}${e.cable_type ? ` · ${e.cable_type}` : ''}${e.length ? ` · ${e.length}` : ''}`}</title>
            </path>
          );
        })}

        {/* off-rack / uplink devices */}
        {offRects.length > 0 && <text x={EXT_X} y={rackTop - 12} className={styles.rackElevColLabel}>UPLINK · EXTERNAL</text>}
        {offRects.map(({ d, x, y, w, h }) => (
          <g key={`off-${d.name}`} onClick={() => setSelected({ kind: 'node', id: d.name })} style={{ cursor: 'pointer' }}>
            <rect x={x} y={y} width={w} height={h} rx={8} fill={rackClassColor(d.class)}
              opacity={isSel(d.name) ? 1 : 0.9} stroke={isSel(d.name) ? '#fff' : 'rgba(0,0,0,0.3)'} strokeWidth={isSel(d.name) ? 2.5 : 1} />
            <text x={x + 11} y={y + 20} className={styles.rackElevDevName}>{d.name}</text>
            <text x={x + 11} y={y + 37} className={styles.rackElevDevMeta}>{(CLASS_LABEL[d.class] || d.class)}{d.model ? ` · ${d.model}` : ''}</text>
          </g>
        ))}

        {/* in-rack devices */}
        {rects.map(({ d, x, y, w, h }) => {
          const ports = d.ports || [];
          const twoLine = h >= U_H * 1.4 || !ports.length;
          return (
            <g key={d.name} onClick={() => setSelected({ kind: 'node', id: d.name })} style={{ cursor: 'pointer' }}>
              <rect x={x} y={y + 2} width={w} height={h - 4} rx={7} fill={rackClassColor(d.class)}
                opacity={isSel(d.name) ? 1 : 0.94} stroke={isSel(d.name) ? '#fff' : 'rgba(0,0,0,0.35)'} strokeWidth={isSel(d.name) ? 2.5 : 1} />
              <text x={x + 12} y={twoLine ? y + h / 2 - 5 : y + h / 2 + 4} dominantBaseline="middle" className={styles.rackElevDevName}>{d.name}</text>
              {twoLine && (
                <text x={x + 12} y={y + h / 2 + 12} className={styles.rackElevDevMeta}>
                  {(CLASS_LABEL[d.class] || d.class)}{d.model ? ` · ${d.model}` : ''}{d.summary ? ` · ${d.summary}` : ''}
                </text>
              )}
              <RackPortStrip ports={ports} x={x + w * 0.46} y={y + 6} w={w * 0.5} h={h - 12} />
            </g>
          );
        })}
      </svg>
      <RackElevLegend />
    </div>
  );
}

function Graph2D({ topo, selected, setSelected, aggEdges, heatmap, freePctByDevice,
                   traceMode, traceA, traceB, tracePathSet, traceEdgeKeys }) {
  // Map devices into tiers; drop closed-units / unidentified (no cables, no value).
  const tiers = useMemo(() => {
    const t = { core: [], distribution: [], access: [], endpoint: [] };
    for (const d of topo.devices) {
      const tier = tierOf(d);
      if (!tier) continue;
      t[tier].push(d);
    }
    // Order by U-position descending within each tier so SW-U15 sits leftmost (matches rack top).
    for (const k of Object.keys(t)) {
      t[k].sort((a, b) => (b.u_position ?? -1) - (a.u_position ?? -1));
    }
    return t;
  }, [topo]);

  // Layout: each tier laid out across the canvas width.
  const W = 1180, H = 760;
  const TIER_Y = { core: 110, distribution: 300, access: 490, endpoint: 660 };

  const positions = useMemo(() => {
    const pos = new Map();
    for (const tier of TIER_ORDER) {
      const list = tiers[tier];
      if (!list.length) continue;
      const y = TIER_Y[tier];
      const gap = W / (list.length + 1);
      list.forEach((d, i) => {
        pos.set(d.name, { x: gap * (i + 1), y, tier });
      });
    }
    return pos;
  }, [tiers]);

  // Helper: stroke width grows (sub-linearly) with cable count.
  const strokeForCount = (n) => Math.max(1.6, Math.min(7, 1.4 + Math.log2(n + 1) * 1.4));

  // Compute selected highlight set.
  const highlightedDevices = new Set();
  const highlightedEdgeKeys = new Set();
  if (selected?.kind === 'node') {
    highlightedDevices.add(selected.id);
    for (const e of aggEdges) {
      if (e.a === selected.id || e.b === selected.id) {
        highlightedEdgeKeys.add(`${e.a}::${e.b}`);
        highlightedDevices.add(e.a);
        highlightedDevices.add(e.b);
      }
    }
  } else if (selected?.kind === 'edge') {
    const [a, b] = selected.id.split('::');
    highlightedEdgeKeys.add(selected.id);
    highlightedDevices.add(a);
    highlightedDevices.add(b);
  }

  // Trace mode overrides selection dimming when a path is active.
  const traceActive = traceMode && tracePathSet && tracePathSet.size > 0;
  const isDimmed = (deviceName) => {
    if (traceActive) return !tracePathSet.has(deviceName);
    return selected && !highlightedDevices.has(deviceName);
  };
  const isEdgeDimmed = (key) => {
    if (traceActive) return !traceEdgeKeys?.has(key);
    return selected && !highlightedEdgeKeys.has(key);
  };

  const deviceMap = useMemo(() => new Map(topo.devices.map(d => [d.name, d])), [topo]);

  return (
    <svg className={styles.graphSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
         onClick={() => setSelected(null)}>
      <defs>
        <filter id="topoGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="nodeShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#0f0f0f" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Coloured tier bands — make the hierarchy read at a glance */}
      {TIER_ORDER.map(tier => (
        tiers[tier].length > 0 && (
          <g key={tier}>
            <rect x={14} y={TIER_Y[tier] - 62} width={W - 28} height={124} rx={18}
                  fill={TIER_COLOR[tier]} fillOpacity="0.045" />
            <rect x={14} y={TIER_Y[tier] - 62} width={5} height={124} rx={2.5}
                  fill={TIER_COLOR[tier]} fillOpacity="0.55" />
            <text x={30} y={TIER_Y[tier] - 42}
                  fill={TIER_COLOR[tier]} fontSize="12.5" fontWeight="700"
                  fontFamily="ui-monospace, Menlo, monospace" letterSpacing="0.12em">
              {TIER_LABEL[tier]}
            </text>
            <text x={30} y={TIER_Y[tier] - 27}
                  fill={TIER_COLOR[tier]} fillOpacity="0.65" fontSize="10"
                  fontFamily="ui-monospace, Menlo, monospace" letterSpacing="0.04em">
              {tiers[tier].length} device{tiers[tier].length === 1 ? '' : 's'}
            </text>
          </g>
        )
      ))}

      {/* Rack name tag, top-right */}
      <text x={W - 24} y={40} textAnchor="end"
            fill="#a1a1a1" fontSize="12"
            fontFamily="ui-monospace, Menlo, monospace" letterSpacing="0.08em">
        {topo.rackName} · {topo.u_size}U
      </text>

      {/* Edges (drawn first so they sit under nodes) */}
      <g>
        {aggEdges.map(e => {
          const pa = positions.get(e.a);
          const pb = positions.get(e.b);
          if (!pa || !pb) return null;
          const key = `${e.a}::${e.b}`;
          const dimmed = isEdgeDimmed(key);
          const highlighted = highlightedEdgeKeys.has(key);
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const c1 = { x: pa.x + dx * 0.35, y: pa.y + dy * 0.55 };
          const c2 = { x: pb.x - dx * 0.35, y: pb.y - dy * 0.55 };
          const path = `M ${pa.x} ${pa.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${pb.x} ${pb.y}`;
          const sw = strokeForCount(e.count);
          const tierA = positions.get(e.a)?.tier;
          const tierB = positions.get(e.b)?.tier;
          const stroke = (tierA === 'core' || tierB === 'core')
            ? TIER_COLOR.core
            : ((tierA === 'endpoint' || tierB === 'endpoint') ? TIER_COLOR.endpoint : TIER_COLOR.access);
          return (
            <g key={key}
               onClick={(ev) => { ev.stopPropagation(); setSelected({ kind: 'edge', id: key }); }}
               style={{ cursor: 'pointer' }}>
              <path d={path} stroke="transparent" strokeWidth={Math.max(14, sw + 8)} fill="none" />
              <path d={path}
                    stroke={stroke}
                    strokeWidth={highlighted ? sw + 1.8 : sw}
                    strokeOpacity={dimmed ? 0.12 : (highlighted ? 0.95 : 0.55)}
                    fill="none"
                    filter={highlighted ? 'url(#topoGlow)' : undefined}
                    strokeLinecap="round" />
              {e.count >= 2 && (
                <g>
                  <rect x={mx - 16} y={my - 9} width="32" height="18" rx="9"
                        fill="#ffffff"
                        stroke="#ececec"
                        strokeOpacity={dimmed ? 0.5 : 1}
                        strokeWidth="1" />
                  <text x={mx} y={my + 4}
                        textAnchor="middle"
                        fontFamily="ui-monospace, Menlo, monospace"
                        fontSize="10"
                        fontWeight="700"
                        fill={dimmed ? '#c4c4c4' : '#000000'}>
                    {e.count}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>

      {/* Nodes (on top of edges) */}
      <g>
        {Array.from(positions.entries()).map(([name, p]) => {
          const dev = deviceMap.get(name);
          if (!dev) return null;
          const dimmed = isDimmed(name);
          const isSel = selected?.kind === 'node' && selected.id === name;
          const color = heatmap
            ? heatmapColor(freePctByDevice?.get(name))
            : TIER_COLOR[p.tier];
          const traceEndpoint = traceMode && (name === traceA || name === traceB);
          return (
            <NodeShape key={name}
                       dev={dev} pos={p} color={color}
                       dimmed={dimmed} selected={isSel || traceEndpoint}
                       onClick={(ev) => { ev.stopPropagation(); setSelected({ kind: 'node', id: name }); }} />
          );
        })}
      </g>
    </svg>
  );
}

function NodeShape({ dev, pos, color, dimmed, selected, onClick }) {
  const w = 184, h = 78;
  const x = pos.x - w / 2;
  const y = pos.y - h / 2;
  const opacity = dimmed ? 0.28 : 1;
  const cy = h / 2 + 3;

  const devCls = clsOf(dev);
  const glyph = devCls === 'switch'      ? <SwitchGlyph color={color} /> :
                devCls === 'router'      ? <RouterGlyph color={color} /> :
                devCls === 'patch_panel' ? <PatchGlyph color={color} /> :
                devCls === 'server'      ? <ServerGlyph color={color} /> :
                null;

  return (
    <g transform={`translate(${x} ${y})`} onClick={onClick} style={{ cursor: 'pointer', opacity }}>
      {/* card with a coloured left accent bar */}
      <rect x="0" y="0" width={w} height={h} rx="15"
            fill="#ffffff"
            stroke={selected ? '#000000' : color}
            strokeWidth={selected ? 2.8 : 1.8}
            filter={selected ? 'url(#topoGlow)' : 'url(#nodeShadow)'} />
      <rect x="1.5" y="14" width="5" height={h - 28} rx="2.5" fill={color} />
      {/* glyph in a tinted circle */}
      <circle cx="30" cy={cy} r="19" fill={color} fillOpacity="0.13" />
      <g transform={`translate(${30 - 14} ${cy - 14})`}>{glyph}</g>
      {/* name + sub */}
      <text x="58" y={cy - 6} fontFamily="ui-monospace, Menlo, monospace"
            fontSize="14.5" fontWeight="800" fill="#000000" letterSpacing="-0.01em">
        {dev.name}
      </text>
      <text x="58" y={cy + 12} fontFamily="ui-monospace, Menlo, monospace"
            fontSize="10.5" fill="#727272" letterSpacing="0.03em">
        {dev.u_position ? `U${String(dev.u_position).padStart(2, '0')} · ` : ''}
        {CLASS_LABEL[dev.class] || dev.class}
      </text>
      {/* port-count pill, top-right */}
      {dev.ports?.length ? (
        <g>
          <rect x={w - 46} y="15" width="34" height="19" rx="9.5"
                fill={color} fillOpacity="0.14" />
          <text x={w - 29} y="28.5" textAnchor="middle"
                fontFamily="ui-monospace, Menlo, monospace"
                fontSize="10.5" fontWeight="800" fill={color}>
            {dev.ports.length}p
          </text>
        </g>
      ) : null}
    </g>
  );
}

function SwitchGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="9" width="24" height="10" rx="2" stroke={color} strokeWidth="1.6" />
      <rect x="5" y="12" width="3" height="4" fill={color} />
      <rect x="10" y="12" width="3" height="4" fill={color} />
      <rect x="15" y="12" width="3" height="4" fill={color} />
      <rect x="20" y="12" width="3" height="4" fill={color} opacity="0.6" />
    </svg>
  );
}
// A router: the same chassis as a switch, fewer sockets, and the arrows that
// say traffic leaves the rack through it.
function RouterGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="9" width="24" height="10" rx="2" stroke={color} strokeWidth="1.6" />
      <rect x="5" y="12" width="3" height="4" fill={color} />
      <rect x="10" y="12" width="3" height="4" fill={color} />
      <path d="M17 12.5h6M21 10.5l2 2-2 2" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23 16.5h-6M19 14.5l-2 2 2 2" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}
function PatchGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="8" width="24" height="12" rx="1.5" stroke={color} strokeWidth="1.6" />
      <line x1="5" y1="14" x2="23" y2="14" stroke={color} strokeWidth="0.8" />
      {[5,9,13,17,21].map(cx => (
        <circle key={cx} cx={cx} cy="14" r="1.2" fill={color} />
      ))}
    </svg>
  );
}
function ServerGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="3" y="4"  width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <rect x="3" y="11" width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <rect x="3" y="18" width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <circle cx="6" cy="7"  r="1" fill={color} />
      <circle cx="6" cy="14" r="1" fill={color} />
      <circle cx="6" cy="21" r="1" fill={color} />
    </svg>
  );
}

function BottomPanel({ info, clear, topo, aggEdges }) {
  if (!info) {
    const hasCables = topo.stats.edge_count > 0;
    return (
      <div className={styles.bottomBar}>
        <div className={styles.legend}>
          <Legend color={TIER_COLOR.core}         label="core / uplink" />
          <Legend color={TIER_COLOR.distribution} label="switches" />
          <Legend color={TIER_COLOR.access}       label="patch panels" />
          <Legend color={TIER_COLOR.endpoint}     label="end hosts" />
        </div>
        <div className={styles.bottomHint}>
          {hasCables ? (
            <>Click any node or edge to inspect. {topo.stats.edge_count} cables aggregated into {aggEdges.length} links.</>
          ) : (
            <>No cables detected on this rack yet. Tap a device to inspect it.</>
          )}
        </div>
      </div>
    );
  }

  if (info.kind === 'node') {
    const { dev, peers } = info;
    return (
      <div className={styles.bottomBar}>
        <div className={styles.detailRow}>
          <div className={styles.detailMain}>
            <span className={styles.detailName}>{dev.name}</span>
            <span className={styles.detailSub}>
              {CLASS_LABEL[dev.class] || dev.class}
              {dev.u_position ? ` · U${String(dev.u_position).padStart(2,'0')}` : ''}
              {dev.model ? ` · ${dev.model}` : ''}
              {dev.mgmt_ip ? ` · ${dev.mgmt_ip}` : ''}
            </span>
          </div>
          <button className={styles.clearBtn} onClick={clear}>clear</button>
        </div>
        <div className={styles.peerStrip}>
          {peers.length === 0 && <span className={styles.bottomHint}>No connected peers.</span>}
          {peers.map(p => (
            <span key={p.peer} className={styles.peerChip}>
              <code>{p.peer}</code>
              <span className={styles.peerCount}>{p.count}×</span>
            </span>
          ))}
        </div>
        <PortsTable dev={dev} topo={topo} />
      </div>
    );
  }

  // Single cable selected — drilled in from the 3D scene's tube click.
  if (info.kind === 'cable') {
    const c = info.cable;
    return (
      <div className={styles.bottomBar}>
        <div className={styles.detailRow}>
          <div className={styles.detailMain}>
            <span className={styles.detailName}>
              <span className={styles.cableId}>{c.cable_id}</span>
            </span>
            <span className={styles.detailSub}>
              {c.cable_type}
              {c.length ? ` · ${c.length}` : ''}
              {c.color ? ` · ${c.color}` : ''}
            </span>
          </div>
          <button className={styles.clearBtn} onClick={clear}>clear</button>
        </div>
        <div className={styles.cableMini} style={{ marginTop: 10 }}>
          <code>{c.src.device}:{c.src.port}</code>
          <span className={styles.peerArrow}>↔</span>
          <code>{c.dst.device}:{c.dst.port}</code>
          <span className={styles.cableMeta}>
            {c.is_uplink ? 'uplink' : (c.kind || 'patch')}
          </span>
        </div>
      </div>
    );
  }

  // Edge selected
  const { edge } = info;
  return (
    <div className={styles.bottomBar}>
      <div className={styles.detailRow}>
        <div className={styles.detailMain}>
          <span className={styles.detailName}>
            <code>{edge.a}</code>
            <span className={styles.peerArrow}>↔</span>
            <code>{edge.b}</code>
          </span>
          <span className={styles.detailSub}>{edge.count} cable{edge.count > 1 ? 's' : ''}</span>
        </div>
        <button className={styles.clearBtn} onClick={clear}>clear</button>
      </div>
      <div className={styles.cableScroll}>
        {edge.cables.slice(0, 50).map(c => (
          <div key={`${c.cable_id}-${c.src.port}-${c.dst.port}`} className={styles.cableMini}>
            <span className={styles.cableId}>{c.cable_id}</span>
            <code>{c.src.port}</code>
            <span className={styles.peerArrow}>↔</span>
            <code>{c.dst.port}</code>
            <span className={styles.cableMeta}>{c.cable_type} · {c.length}</span>
          </div>
        ))}
        {edge.cables.length > 50 && (
          <div className={styles.bottomHint}>+ {edge.cables.length - 50} more cables…</div>
        )}
      </div>
    </div>
  );
}

function PortsTable({ dev, topo }) {
  const byPort = useMemo(() => {
    const m = new Map();
    for (const e of topo.edges) {
      for (const side of ['src', 'dst']) {
        const k = e[side].port;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ self: e[side], peer: side === 'src' ? e.dst : e.src, edge: e });
      }
    }
    return m;
  }, [topo]);

  const rows = useMemo(() => {
    return (dev.ports || []).map(p => {
      const links = byPort.get(p.name) || [];
      const primary = links[0];
      const connector = primary ? guessConnector(p, primary.edge) : null;
      return { port: p, links, primary, connector };
    });
  }, [dev, byPort]);

  if (!rows.length) {
    return <div className={styles.bottomHint} style={{ marginTop: 12 }}>No ports on this device.</div>;
  }

  const connected = rows.filter(r => r.links.length > 0).length;
  const free = rows.length - connected;

  return (
    <div className={styles.portsTableWrap}>
      <div className={styles.portsTableHead}>
        <span className={styles.detailSub}>Ports</span>
        <span className={styles.bottomHint}>
          {rows.length} total · <span style={{color:'#000000'}}>{connected} connected</span> · <span style={{color:'#717171'}}>{free} free</span>
        </span>
      </div>
      <div className={styles.portsTableScroll}>
        <table className={styles.portsTable}>
          <thead>
            <tr>
              <th>Port</th>
              <th>Status</th>
              <th>Cable</th>
              <th>Connector</th>
              <th>Type · Length</th>
              <th>Other end</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ port, links, primary, connector }) => {
              const isConnected = links.length > 0;
              const extras = links.length - 1;
              return (
                <tr key={port.name} className={isConnected ? styles.rowConnected : styles.rowFree}>
                  <td>
                    <code className={styles.tdPort}>{port.label}</code>
                    {port.kind === 'sfp'    && <span className={styles.tag}>SFP</span>}
                    {port.kind === 'nic'    && <span className={styles.tag}>NIC</span>}
                    {port.is_uplink         && <span className={styles.tagUplink}>uplink</span>}
                  </td>
                  <td>
                    {isConnected
                      ? <span className={styles.statusDotConnected}>●</span>
                      : <span className={styles.statusDotFree}>○</span>}
                    {isConnected ? 'connected' : 'free'}
                  </td>
                  <td>
                    {primary
                      ? <code className={styles.cableId}>{primary.edge.cable_id}</code>
                      : <span className={styles.tdDim}>-</span>}
                  </td>
                  <td>{connector || <span className={styles.tdDim}>-</span>}</td>
                  <td>
                    {primary
                      ? <span className={styles.tdMono}>{primary.edge.cable_type} · {primary.edge.length}</span>
                      : <span className={styles.tdDim}>-</span>}
                  </td>
                  <td>
                    {primary ? (
                      <div className={styles.tdPeer}>
                        <code>{primary.peer.port}</code>
                        <span className={styles.tdDim}>{primary.peer.device}</span>
                        {extras > 0 && <span className={styles.peerCount}>+{extras}</span>}
                      </div>
                    ) : <span className={styles.tdDim}>-</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function guessConnector(port, edge) {
  const t = (edge.cable_type || '').toLowerCase();
  if (port.kind === 'sfp') return 'LC';
  if (t.startsWith('cat') || t.includes('utp')) return 'RJ45';
  if (t.includes('fiber') || t.includes('mm') || t.includes('sm')) return 'LC';
  if (t.includes('dac') || t.includes('twinax')) return 'SFP+';
  return 'RJ45';
}

function Legend({ color, label }) {
  return (
    <span className={styles.legendItem}>
      <span className={styles.legendDot} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}
