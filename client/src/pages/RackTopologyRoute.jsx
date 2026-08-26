import { useEffect, useState, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { useGroupView } from '../hooks/useGroupView';
import TopologyPage, { RackElevation } from './TopologyPage.jsx';
import styles from './SideBySideRacks.module.css';
import { getItem, setItem } from '../utils/safeStorage';

// Lazy, and it matters: this route IS eagerly imported by App.jsx, so importing
// the 3D page here statically pulled three.js and drei back into the initial
// bundle and quietly undid the code splitting everywhere else.
const MultiRackTopologyPage = lazy(() => import('./MultiRackTopologyPage.jsx'));

// Topology for a rack group: a single 2D / 3D toggle over BOTH racks.
//   3D → the existing combined 3D scene (both racks in one space + inter-rack cables)
//   2D → each rack's flat elevation, side by side
// A standalone rack falls through to the normal single-rack TopologyPage.
export default function RackTopologyRoute() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const { data, loading, isGroup, members } = useGroupView(rackId);

  const [view, setView] = useState(() => {
    try { return getItem('rt_topo_view') || '2d'; } catch { return '2d'; }
  });
  const pick = (v) => { setView(v); try { setItem('rt_topo_view', v); } catch (_) {} };

  // Inter-rack links (the same synthesized uplinks the 3D scene draws) so the
  // 2D view can show the connection between the racks too.
  const [links, setLinks] = useState([]);
  useEffect(() => {
    if (!isGroup || !data?.group?.id) return;
    let alive = true;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/rack-group/${encodeURIComponent(data.group.id)}/links`));
        const j = await r.json().catch(() => ({}));
        if (alive && r.ok && Array.isArray(j.links)) setLinks(j.links);
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, [isGroup, data?.group?.id]);

  const [topos, setTopos] = useState({});
  useEffect(() => {
    if (!isGroup || view !== '2d') return;
    let alive = true;
    (async () => {
      const out = {};
      await Promise.all(members.map(async (m) => {
        try {
          const r = await authFetch(apiUrl(`/api/topology/${m.rack_id}`));
          out[m.rack_id] = r.ok ? await r.json() : { __err: `HTTP ${r.status}` };
        } catch (e) { out[m.rack_id] = { __err: e.message }; }
      }));
      if (alive) setTopos(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroup, view, members.map(m => m.rack_id).join(',')]);

  if (loading || !isGroup) return <TopologyPage />;

  return (
    <div className={styles.wrap}>
      <header className={styles.topoBar}>
        <button className={styles.back} onClick={() => navigate(-1)} aria-label="Back">←</button>
        <span className={styles.topoTitle}>Topology · {members.length} racks</span>
        <div className={styles.toggle}>
          <button className={`${styles.tglBtn} ${view !== '3d' ? styles.tglOn : ''}`} onClick={() => pick('2d')}>2D</button>
          <button className={`${styles.tglBtn} ${view === '3d' ? styles.tglOn : ''}`} onClick={() => pick('3d')}>3D</button>
        </div>
      </header>

      {view === '3d' ? (
        <div className={styles.scene3d}>
          <Suspense fallback={null}>
            <MultiRackTopologyPage groupId={data.group.id} hideHeader />
          </Suspense>
        </div>
      ) : (
        <>
          <div className={styles.cols2d}>
            {members.map((m) => {
              const topo = topos[m.rack_id];
              return (
                <section key={m.rack_id} className={styles.col2d}>
                  <header className={styles.colHead}>
                    <span className={styles.pos}>#{m.position}</span>
                    <span className={styles.title}>{m.label || m.rack_id}</span>
                    <code className={styles.id}>{m.rack_id}</code>
                  </header>
                  {!topo ? <div className={styles.center}>Loading topology…</div>
                    : topo.__err ? <div className={styles.err}>{topo.__err === 'HTTP 404' ? 'Topology still generating - refresh shortly.' : topo.__err}</div>
                    : <Rack2D topo={topo} />}
                </section>
              );
            })}
            {/* Connector rail down the gap between the two racks. */}
            {links.length > 0 && (
              <div className={styles.linkRail} aria-hidden="true">
                {links.map((l, i) => (
                  <span key={l.cable_id || i}
                    className={`${styles.linkWire} ${l.cable_type === 'fiber' ? styles.wireFiber : styles.wireDac}`} />
                ))}
              </div>
            )}
          </div>

          {links.length > 0 && (
            <div className={styles.linkPanel}>
              <div className={styles.linkPanelHead}>
                Inter-rack connections
                <span className={styles.linkCount}>{links.length} cross-rack cable{links.length === 1 ? '' : 's'}</span>
              </div>
              {links.map((l, i) => (
                <div key={l.cable_id || i} className={styles.linkRow}>
                  <span className={`${styles.dot} ${l.cable_type === 'fiber' ? styles.wireFiber : styles.wireDac}`} />
                  <span className={styles.linkRole}>{l.role || 'Uplink'}</span>
                  <span className={styles.linkEnd}><b>{labelFor(members, l.src?.rackId)}</b> · {l.src?.device} <code>{l.src?.port}</code></span>
                  <span className={styles.linkArrow}>⇄</span>
                  <span className={styles.linkEnd}><b>{labelFor(members, l.dst?.rackId)}</b> · {l.dst?.device} <code>{l.dst?.port}</code></span>
                  <span className={styles.linkType}>{(l.cable_type || '').toUpperCase()}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Rack2D({ topo }) {
  const [selected, setSelected] = useState(null);
  return <RackElevation topo={topo} selected={selected} setSelected={setSelected} />;
}

function labelFor(members, rackId) {
  const m = members.find((x) => x.rack_id === rackId);
  return m ? (m.label || `Rack ${m.position}`) : rackId;
}
