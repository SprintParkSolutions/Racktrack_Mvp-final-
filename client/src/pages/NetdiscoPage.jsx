import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import styles from './NetdiscoPage.module.css';

// Spot raw protocol-level / Python-level error text leaking from the
// Netdisco proxy (ECONNREFUSED, JSONDecodeError, tracebacks, generic HTTP
// numbers, etc.) so we can hide it behind the friendly offline banner
// instead of dumping it into the UI. Same idea as the CMDB page filter.
// Patch panels are passive — they don't show up as LLDP/CDP neighbours in
// real network discovery (no MAC, no agent). When our rack-derived data
// surfaces one as a "neighbour", it's misleading because the user expects
// network-layer adjacency, not physical cabling. Treat these as "no
// neighbour" in the port table so the column stays semantically honest.
function isPatchPanelLabel(name) {
  if (!name) return false;
  const s = String(name).trim().toUpperCase();
  // Matches "PP-U12", "PP-U13", "PP01", "PP_3", "PP 7", "PATCHPANEL",
  // "Patch Panel 3", etc. The previous version required PP- to be
  // followed by a digit; real rack labels usually inject a unit token
  // first (PP-U13), so we now accept any separator or digit after PP.
  return /^PP(?:[-_ ]|\d)|PATCH\s*PANEL|PATCHPANEL|^PATCH[-_ ]/i.test(s);
}

function looksLikeNetdiscoNoise(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return (
    m.includes('expecting value') ||
    m.includes('traceback') ||
    m.includes('jsondecode') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('fetch failed') ||
    m.includes('failed to fetch') ||
    m.startsWith('http ') ||
    /^\d{3}$/.test(m.trim())   // bare status code
  );
}

/**
 * Netdisco view scoped to a RackTrack scan.
 *
 * The page is a single scrollable list of cards — one per scan device —
 * that show live data joined from Netdisco. Each card is collapsible and
 * reveals the device's full port table with up/down state, VLAN, LLDP/CDP
 * neighbours and the count of MACs learned per port. A "Sync to Netdisco"
 * button at the top force-pushes the scan into Netdisco's DB.
 *
 * Below the device cards is a free-form MAC lookup that hits the whole
 * Netdisco database, not just this rack — useful for "where did this MAC
 * end up?" questions while looking at the rack.
 */
// ── Embeddable content (used as a tab in ResultsPage) ────────
export function NetdiscoContent({ rackId }) {
  return <NetdiscoInner rackId={rackId} embedded />;
}

export default function NetdiscoPage() {
  const navigate = useNavigate();
  const { rackId } = useParams();

  return <NetdiscoInner rackId={rackId} embedded={false} />;
}

function NetdiscoInner({ rackId, embedded }) {
  const navigate = useNavigate();

  const [health, setHealth]       = useState(null);
  const [match, setMatch]         = useState(null);
  const [matchLoading, setMatchLoading] = useState(true);
  const [matchError, setMatchError] = useState(null);

  // Per-device expansion + cached port detail (keyed by Netdisco IP).
  const [openIp, setOpenIp]       = useState(null);
  const [portsByIp, setPortsByIp] = useState({});      // ip -> ports[]
  const [loadingIps, setLoadingIps] = useState({});    // ip -> bool

  const [macInput, setMacInput] = useState('');
  const [macReport, setMacReport] = useState(null);
  const [macLoading, setMacLoading] = useState(false);
  const [macError, setMacError] = useState(null);

  // ── Health probe ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/netdisco/health'));
        const data = await r.json();
        if (!cancelled) setHealth(data);
      } catch (err) {
        if (!cancelled) setHealth({ ok: false, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Match list (one fetch per rack) ───────────────────────────────────
  const fetchMatch = async () => {
    setMatchLoading(true);
    setMatchError(null);
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/scan/${rackId}/match`));
      // Defensive parse: Netdisco's proxy can return empty body on cold
      // start, which would otherwise throw "Unexpected end of JSON input"
      // straight into the UI.
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!r.ok || !data) {
        // Suppress raw protocol-level chatter (ECONNREFUSED, traceback,
        // JSONDecodeError, etc.) — the on-screen "backend is unreachable"
        // banner already says what the user needs to know.
        const msg = data?.error || '';
        setMatchError(looksLikeNetdiscoNoise(msg) ? null : (msg || null));
        setMatch(data || { netdisco_reachable: false });
      } else {
        setMatch(data);
      }
    } catch (err) {
      // Network failure (proxy down, etc.) — render the friendly offline
      // state rather than the raw "Failed to fetch" exception text.
      setMatchError(null);
      setMatch({ netdisco_reachable: false });
      void err;
    } finally {
      setMatchLoading(false);
    }
  };

  useEffect(() => {
    if (!rackId) return;
    fetchMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId]);

  // ── On expand: lazy-load that device's port detail ────────────────────
  const togglePorts = async (ip) => {
    if (!ip) return;
    if (openIp === ip) {
      setOpenIp(null);
      return;
    }
    setOpenIp(ip);
    if (portsByIp[ip] !== undefined) return;
    setLoadingIps(s => ({ ...s, [ip]: true }));
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/devices/${encodeURIComponent(ip)}/ports`));
      const data = await r.json();
      setPortsByIp(s => ({ ...s, [ip]: data.ports || [] }));
    } catch {
      setPortsByIp(s => ({ ...s, [ip]: [] }));
    } finally {
      setLoadingIps(s => ({ ...s, [ip]: false }));
    }
  };

  // ── MAC lookup ────────────────────────────────────────────────────────
  const runMacLookup = async (e) => {
    e?.preventDefault?.();
    const mac = macInput.trim();
    if (!mac) return;
    setMacLoading(true);
    setMacError(null);
    setMacReport(null);
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/mac/${encodeURIComponent(mac)}`));
      const data = await r.json();
      if (!r.ok) {
        setMacError(data.error || `HTTP ${r.status}`);
      } else {
        setMacReport(data);
      }
    } catch (err) {
      setMacError(err.message);
    } finally {
      setMacLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  const mainContent = (
    <main className={embedded ? undefined : styles.main}>

        {/* ── Devices ─────────────────────────────────────────────────── */}
        <section className={styles.nvSection}>
          <div className={styles.nvHead}>
            <h3 className={styles.nvTitle}>Devices</h3>
            {match && match.netdisco_reachable !== false && (
              <span className={styles.nvCount}>{match.matched_count} live</span>
            )}
          </div>

          {matchLoading && <div className={styles.loading}>Loading…</div>}
          {matchError && <div className={styles.error}>{matchError}</div>}

          {match && match.netdisco_reachable === false && (
            <div className={styles.warn}>
              <strong>Network view is being prepared.</strong>
              <br />This updates automatically from your scan - check back in a moment.
            </div>
          )}

          {match && match.netdisco_reachable !== false && match.matches?.length > 0 && (
            <div className={styles.nvList}>
              {match.matches
                .filter(m => m.scan.class_name !== 'Patch Panel')
                .map((m, i) => (
                <DeviceItem
                  key={i}
                  m={m}
                  open={openIp === m.netdisco?.ip}
                  ports={m.netdisco?.ip ? portsByIp[m.netdisco.ip] : null}
                  loading={m.netdisco?.ip ? !!loadingIps[m.netdisco.ip] : false}
                  onToggle={() => togglePorts(m.netdisco?.ip)}
                  onMacClick={(mac) => { setMacInput(mac); runMacLookup(); }}
                />
              ))}
            </div>
          )}

          {/* Reachable, done loading, but nothing to show — say so instead of
              rendering a blank panel. Covers both "no matches at all" and
              "everything found was a patch panel (filtered out above)". */}
          {match && match.netdisco_reachable !== false && !matchLoading && !matchError &&
            (match.matches || []).filter(m => m.scan.class_name !== 'Patch Panel').length === 0 && (
            <div className={styles.warn}>
              <strong>No switches detected</strong>
              <br />No network switches were found for this rack yet. When one is discovered it will appear here.
            </div>
          )}
        </section>


      </main>
  );

  if (embedded) return mainContent;

  return (
    <div className={styles.page}>
      <div className={styles.amb} />

      <header className={styles.header}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate(-1)} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>Network View</h2>
          <span className={styles.headerMono}>{rackId} · live network view</span>
        </div>
        <HealthPill health={health} />
      </header>

      {mainContent}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// One device = a clean full-width row. Click to expand its ports inline.
// ─────────────────────────────────────────────────────────────────────────
function deviceModelText(nd) {
  if (!nd) return '';
  const vendor = nd.vendor, model = nd.model;
  if (model && vendor && !model.toLowerCase().includes(vendor.toLowerCase())) return `${vendor} ${model}`;
  return model || vendor || '';
}
function DeviceItem({ m, open, ports, loading, onToggle, onMacClick }) {
  const live = !!m.netdisco;
  const stats = m.netdisco?.stats;
  const total = stats?.total ?? (m.scan.port_count || 0);
  const up = stats?.up ?? 0;
  const connected = stats?.connected ?? (m.scan.connected_count || 0);
  const upPct = total ? Math.round((up / total) * 100) : 0;
  const model = deviceModelText(m.netdisco);

  return (
    <div className={`${styles.nvItem} ${open ? styles.nvItemOpen : ''} ${!live ? styles.nvItemDim : ''}`}>
      <button className={styles.nvRow} onClick={live ? onToggle : undefined} disabled={!live} type="button">
        <span className={styles.nvIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="8" width="20" height="8" rx="2"/><circle cx="6" cy="12" r="0.9"/><circle cx="9.5" cy="12" r="0.9"/><circle cx="13" cy="12" r="0.9"/>
          </svg>
        </span>

        <span className={styles.nvIdent}>
          <span className={styles.nvL1}>
            <span className={styles.nvName}>{m.scan.cmdb_name || '-'}</span>
            <span className={styles.nvType}>{m.scan.class_name}</span>
          </span>
          <span className={styles.nvL2}>
            {live ? (
              <>
                {model && <span>{model}</span>}
                {m.netdisco.ip && <><span className={styles.nvSep}>·</span><span className={styles.nvIp}>{m.netdisco.ip}</span></>}
              </>
            ) : (
              <span className={styles.nvOff}>not in Network View</span>
            )}
          </span>
        </span>

        {live && total > 0 && (
          <span className={styles.nvUtil}>
            <span className={styles.nvNums}><b>{up}</b>/{total}<span className={styles.nvSep2}>·</span>{connected} links</span>
            <span className={styles.nvBar}><i style={{ width: `${upPct}%` }} /></span>
          </span>
        )}

        {live && <span className={styles.nvChev} aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>

      {open && live && (
        <div className={styles.nvPorts}>
          {loading && <div className={styles.loading}>Loading ports…</div>}
          {!loading && (!ports || ports.length === 0) && (
            <div className={styles.empty}>No ports reported by Network View for this device.</div>
          )}
          {!loading && ports && ports.length > 0 && (
            <PortTable ports={ports} onMacClick={onMacClick} />
          )}
        </div>
      )}
    </div>
  );
}

function PortTable({ ports, onMacClick }) {
  const [filter, setFilter] = useState('live');
  const visible = useMemo(() => {
    if (!ports) return [];
    if (filter === 'live') return ports.filter(p => p.neighbor || p.active_mac_count > 0 || isUp(p.up));
    if (filter === 'up')   return ports.filter(p => isUp(p.up));
    if (filter === 'down') return ports.filter(p => !isUp(p.up));
    return ports;
  }, [ports, filter]);

  const upCount   = ports.filter(p => isUp(p.up)).length;
  const downCount = ports.filter(p => !isUp(p.up)).length;
  const liveCount = ports.filter(p => p.neighbor || p.active_mac_count > 0 || isUp(p.up)).length;

  // Only show the MACs column when at least one port has node data —
  // otherwise it's a sea of dashes that adds noise.
  const anyMacs = ports.some(p => p.active_mac_count > 0);

  return (
    <>
      <div className={styles.portFilter}>
        <FilterBtn active={filter === 'live'} onClick={() => setFilter('live')}>Live ({liveCount})</FilterBtn>
        <FilterBtn active={filter === 'up'}   onClick={() => setFilter('up')}>Up ({upCount})</FilterBtn>
        <FilterBtn active={filter === 'down'} onClick={() => setFilter('down')}>Down ({downCount})</FilterBtn>
        <FilterBtn active={filter === 'all'}  onClick={() => setFilter('all')}>All ({ports.length})</FilterBtn>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>No ports match this filter.</div>
      ) : (() => {
        // Group ports by VLAN so the user sees a clean per-VLAN breakdown
        // instead of repeating "VLAN 1" on every row. Ports with no VLAN
        // fall into an "Untagged" bucket. Groups are ordered by numeric
        // VLAN id when possible, with "Untagged" last.
        const groups = new Map();
        for (const p of visible) {
          const key = p.vlan != null && p.vlan !== '' ? String(p.vlan) : '__none__';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(p);
        }
        const orderedKeys = [...groups.keys()].sort((a, b) => {
          if (a === '__none__') return 1;
          if (b === '__none__') return -1;
          const na = Number(a), nb = Number(b);
          if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });

        return (
          <div className={styles.nports}>
            {orderedKeys.map((vlanKey) => {
              const rows = groups.get(vlanKey);
              const label = vlanKey === '__none__' ? 'Untagged' : `VLAN ${vlanKey}`;
              return (
                <div key={vlanKey} className={styles.nvlan}>
                  <div className={styles.nvlanHead}>
                    <span>{label}</span>
                    <span className={styles.nvlanCount}>{rows.length}</span>
                  </div>
                  {rows.map((p, i) => {
                    const up = isUp(p.up);
                    return (
                      <div key={`${vlanKey}-${i}`} className={styles.nport}>
                        <span className={styles.nportName}>{p.name || p.port}</span>
                        <span className={styles.nportFill} />
                        {anyMacs && p.active_mac_count > 0 && (
                          <button
                            className={styles.nportMac}
                            onClick={() => {
                              const m = p.learned_macs?.find(mm => mm.active) || p.learned_macs?.[0];
                              if (m?.mac && onMacClick) onMacClick(m.mac);
                            }}
                            title="Look up the first active MAC behind this port"
                          >{p.active_mac_count} MAC</button>
                        )}
                        <span
                          className={`${styles.nportState} ${up ? styles.nportUp : styles.nportDown}`}
                          title={stateLabel(p.up, p.up_admin)}
                        >{up ? 'up' : 'down'}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })()}
    </>
  );
}


// ── Small helpers ─────────────────────────────────────────────────────────

function HealthPill({ health }) {
  if (!health) return <span className={styles.healthPill}>checking…</span>;
  const ok = !!health.ok;
  return (
    <span className={`${styles.healthPill} ${ok ? styles.healthOk : styles.healthBad}`}>
      <span className={styles.healthDot} />
      {ok ? 'Network View online' : 'Network View offline'}
    </span>
  );
}

function FilterBtn({ active, onClick, children }) {
  return (
    <button
      className={`${styles.filterBtn} ${active ? styles.filterBtnActive : ''}`}
      onClick={onClick}
      type="button"
    >{children}</button>
  );
}

function isUp(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return /^(up|true|t|1)$/i.test(v.trim());
  return false;
}

function stateLabel(up, up_admin) {
  const oper = isUp(up) ? 'up' : 'down';
  const admin = isUp(up_admin) ? 'up' : (up_admin ? 'down' : null);
  if (!admin || admin === oper) return oper;
  return `${oper} (admin ${admin})`;
}

function fmtTime(t) {
  if (!t) return '-';
  return String(t).slice(0, 19).replace('T', ' ');
}

function stripPrefix(text, prefix) {
  if (!text || !prefix) return text || '';
  let out = String(text).trim();
  while (out.toLowerCase().startsWith(prefix.toLowerCase())) {
    out = out.slice(prefix.length).trim();
  }
  return out;
}
