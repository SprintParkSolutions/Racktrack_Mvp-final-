import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useSmartBack } from '../hooks/useSmartBack';
import { apiUrl, authFetch } from '../utils/api';
import {
  subscribeProbe,
  triggerBackgroundProbe,
  logicalVerdict,
} from '../utils/portsProbe';
import RackTabs from '../components/RackTabs.jsx';
import { useIsDesktop } from '../hooks/useIsDesktop';
import styles from './PortsPage.module.css';

// "6d ago" / "just now" — same phrasing the Lab page uses, so a recorded
// timestamp reads identically wherever it appears.
function fmtAgo(iso) {
  if (!iso) return 'a while ago';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return 'a while ago';
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(2)} s`;
}

// ── Port classification ─────────────────────────────────────
function classifyPorts(probePorts, scan) {
  if (!probePorts?.length) return { rj45: [], sfp: [] };

  // Best signal: the switch told us the medium (TP-Link Active-Medium column)
  const hasMedium = probePorts.some(p => p.medium === 'fiber' || p.medium === 'copper');
  if (hasMedium) {
    const rj45 = [], sfp = [];
    for (const p of probePorts) {
      if (p.medium === 'fiber') sfp.push(p);
      else rj45.push(p);
    }
    return { rj45, sfp };
  }

  // Cisco-style: classify by interface prefix
  const hasCiscoNames = probePorts.some(p =>
    /^(Gi|Fa|Te|Fo|Hu)/i.test(p.iface)
  );
  if (hasCiscoNames) {
    const rj45 = [], sfp = [];
    for (const p of probePorts) {
      if (/^(Te|Fo|Hu)/i.test(p.iface)) sfp.push(p);
      else rj45.push(p);
    }
    return { rj45, sfp };
  }

  // Fallback: the scan photo. port_count / sfp_ports come from what the model
  // actually detected on the faceplate, so this is evidence about THIS switch.
  const switchDev = scan?.devices?.find(d =>
    d.class_name === 'Switch' && d.port_count > 0
  );
  const cvMainCount = switchDev?.port_count || 0;
  const cvSfpCount = switchDev?.sfp_ports?.length || 0;
  const total = probePorts.length;

  if (cvMainCount > 0 && cvMainCount < total) {
    return { rj45: probePorts.slice(0, cvMainCount), sfp: probePorts.slice(cvMainCount) };
  }
  if (cvSfpCount > 0 && (total - cvSfpCount) > 0) {
    const splitAt = total - cvSfpCount;
    return { rj45: probePorts.slice(0, splitAt), sfp: probePorts.slice(splitAt) };
  }

  // Nothing told us which ports are fibre: not the switch (no Active-Medium
  // column), not the interface names, not the scan. This used to GUESS from the
  // port count — "more than 24 ports, so the last 4 are SFP" — and the faceplate
  // then drew those as SFP slots, indistinguishable from ports the switch had
  // actually reported as fibre. It was right for a 24+4 JetStream and wrong for
  // everything else, and nothing on screen said it was an assumption.
  //
  // Report them all as they came instead. An SFP section that is absent because
  // we do not know is honest; one that is populated by arithmetic is not.
  return { rj45: probePorts, sfp: [] };
}

function shortLabel(iface) {
  const tpMatch = iface.match(/^1\/0\/(\d+)$/);
  if (tpMatch) return tpMatch[1];
  const ciscoMatch = iface.match(/^[A-Za-z]{1,2}\d+\/\d+\/(\d+)$/);
  if (ciscoMatch) return ciscoMatch[1];
  const nums = iface.match(/(\d+)$/);
  return nums ? nums[1] : iface;
}

function countByVerdict(portList) {
  let avail = 0, used = 0, reserved = 0;
  for (const p of portList) {
    const v = logicalVerdict(p);
    if (v === 'available') avail++;
    else if (v === 'used') used++;
    else reserved++;
  }
  return { avail, used, reserved };
}

// ── Ports summary card ───────────────────────────────────────
function PortsSummaryCard({ totalPorts, sfpCount, availableCount, availablePorts, sfpPortIfaces }) {
  const [showTable, setShowTable] = useState(false);

  // Breakdown so the card can show ETH vs SFP availability at a glance
  // — a single "5 ports free" doesn't tell you whether you can plug in
  // an SFP+ uplink.
  const availSfp = availablePorts.filter(p => sfpPortIfaces.has(p.iface)).length;
  const availEth = availableCount - availSfp;
  const usedCount = Math.max(0, totalPorts - availableCount);
  const utilizationPct = totalPorts > 0
    ? Math.round((usedCount / totalPorts) * 100)
    : 0;
  const hasAny = availableCount > 0;

  return (
    <section className={styles.summaryCard}>
      <div className={styles.summaryHero}>
        {/* Big count badge */}
        <div className={`${styles.heroBadge} ${hasAny ? '' : styles.heroBadgeEmpty}`}>
          <span className={styles.heroCount}>{availableCount}</span>
          <span className={styles.heroOf}>of {totalPorts}</span>
        </div>

        {/* Label + breakdown chips */}
        <div className={styles.heroBody}>
          <span className={styles.heroLabel}>Available ports</span>
          <div className={styles.heroChips}>
            <span className={`${styles.heroChip} ${styles.heroChipEth}`}>
              <span className={styles.heroChipDot} />
              <span className={styles.heroChipNum}>{availEth}</span>
              <span className={styles.heroChipLabel}>ETH</span>
            </span>
            {sfpCount > 0 && (
              <span className={`${styles.heroChip} ${styles.heroChipSfp}`}>
                <span className={styles.heroChipDot} />
                <span className={styles.heroChipNum}>{availSfp}</span>
                <span className={styles.heroChipLabel}>SFP</span>
              </span>
            )}
            <span className={styles.heroUsed}>· {usedCount} in use</span>
          </div>
        </div>

        {/* Toggle to show full list */}
        {hasAny && (
          <button
            type="button"
            className={`${styles.summaryInlineToggle} ${showTable ? styles.summaryInlineToggleOpen : ''}`}
            onClick={() => setShowTable(v => !v)}
            aria-label={showTable ? 'Hide port list' : 'Show port list'}
            aria-expanded={showTable}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showTable ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Utilization bar — visual context for "how full is this switch" */}
      {totalPorts > 0 && (
        <div className={styles.utilWrap} role="img" aria-label={`${utilizationPct}% utilized`}>
          <div className={styles.utilBar}>
            <div
              className={styles.utilFill}
              style={{ width: `${utilizationPct}%` }}
            />
          </div>
          <span className={styles.utilPct}>{utilizationPct}%</span>
        </div>
      )}

      {/* Available ports table — only shown when toggled */}
      {showTable && (
        availableCount === 0
          ? <div className={styles.summaryNone}>None available</div>
          : (
            <div className={styles.portTable}>
              <div className={styles.portTableHead}>
                <span>Port</span>
                <span>Type</span>
                <span>Interface</span>
                <span>Status</span>
              </div>
              {availablePorts.map((p, i) => {
                const isSfp = sfpPortIfaces.has(p.iface);
                return (
                  <div key={p.iface} className={`${styles.portTableRow} ${i % 2 === 1 ? styles.portTableRowAlt : ''}`}>
                    <span className={styles.portTableNum}>{shortLabel(p.iface)}</span>
                    <span className={`${styles.portTableType} ${isSfp ? styles.portTableTypeSfp : styles.portTableTypeEth}`}>
                      {isSfp ? 'SFP' : 'ETH'}
                    </span>
                    <span className={styles.portTableIface}>{p.iface}</span>
                    <span className={styles.portTableStatus}>Available</span>
                  </div>
                );
              })}
            </div>
          )
      )}
    </section>
  );
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function PortsContent({ rackId }) {
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);

  const [probe, setProbe] = useState({ status: 'idle' });
  useEffect(() => subscribeProbe(setProbe), []);
  useEffect(() => {
    triggerBackgroundProbe({ force: true });
  }, []);

  useEffect(() => {
    if (!rackId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${rackId}/result`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setScan(data);
      } catch (err) {
        if (!cancelled) setScanErr(err.message || 'Failed to load scan');
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  if (scanErr) return <div className={styles.error}>Failed to load scan: {scanErr}</div>;
  if (!scan) return <div className={styles.loading}>Loading rack...</div>;

  return <LogicalView probe={probe} scan={scan} scanDurationMs={null} />;
}

// ── Standalone page (used by /results/:rackId/ports route) ───
export default function PortsPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const goBack = useSmartBack(rackId ? `/results/${rackId}` : '/scan');
  const { state } = useLocation();

  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);

  const scanDurationMs = state?.result?.timings?.total_ms ?? null;

  const [probe, setProbe] = useState({ status: 'idle' });
  useEffect(() => subscribeProbe(setProbe), []);
  useEffect(() => {
    triggerBackgroundProbe({ force: true });
  }, []);

  useEffect(() => {
    if (!rackId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${rackId}/result`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setScan(data);
      } catch (err) {
        if (!cancelled) setScanErr(err.message || 'Failed to load scan');
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  if (scanErr) {
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={goBack} />
        <div className={styles.error}>Failed to load scan: {scanErr}</div>
      </div>
    );
  }
  if (!scan) {
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={goBack} />
        <div className={styles.loading}>Loading rack...</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader rackId={rackId} onBack={goBack} />
      <LogicalView probe={probe} scan={scan} scanDurationMs={scanDurationMs} />
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────
// On desktop the DesktopShell already renders the single top bar (title +
// back button), so this page must NOT draw a second one. On mobile there is
// no shell, so this header is the one bar.
function PageHeader({ rackId, onBack }) {
  const isDesktop = useIsDesktop();
  return (
    <>
      {!isDesktop && (
        <header className={styles.header}>
          <button className={styles.backBtn} onClick={onBack}>← Back</button>
          <div className={styles.headerCenter}>
            <h2>Live Network Switch</h2>
            <span className={styles.headerMono}>{rackId}</span>
          </div>
          <div style={{ width: 64 }} />
        </header>
      )}
      {/* Renders nothing when this rack is standalone */}
      <RackTabs rackId={rackId} />
    </>
  );
}

// ── Filter chip ──────────────────────────────────────────────
function FilterChip({ active, onClick, label, count, color }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
    >
      {color && <span className={styles.filterChipDot} style={{ background: color }} />}
      <span>{label}</span>
      <span className={styles.filterChipCount}>{count}</span>
    </button>
  );
}

// ── Port tile ────────────────────────────────────────────────
function PortTile({ port, onClick }) {
  const verdict = logicalVerdict(port);
  const label = shortLabel(port.iface);
  return (
    <button
      type="button"
      className={`${styles.portTile} ${styles[`tile_${verdict}`]}`}
      onClick={onClick}
      title={port.iface}
    >
      <span className={styles.tileLabel}>{label}</span>
    </button>
  );
}

// ── Port detail popover ──────────────────────────────────────
function PortDetail({ port, onClose }) {
  const verdict = logicalVerdict(port);
  const verdictLabel = verdict.charAt(0).toUpperCase() + verdict.slice(1);
  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailCard} onClick={e => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <span className={`${styles.detailStatus} ${styles[`detail_${verdict}`]}`}>
            {verdictLabel}
          </span>
          <button className={styles.detailClose} onClick={onClose}>&times;</button>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailKey}>Interface</span>
          <span className={styles.detailVal}>{port.iface}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailKey}>Status</span>
          <span className={styles.detailVal}>{port.status || '\u2014'}</span>
        </div>
        {port.description && (
          <div className={styles.detailRow}>
            <span className={styles.detailKey}>Description</span>
            <span className={styles.detailVal}>{port.description}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Logical view ─────────────────────────────────────────────
// "Gi1/0/1" / "gigabitEthernet 1/0/1" → "1/0/1" so we can join the interface
// list to the LLDP neighbor map (which is keyed by port number path).
function portNumKey(iface) {
  const m = String(iface || '').match(/(\d+\/\d+(?:\/\d+)?)\s*$/);
  return m ? m[1] : null;
}

function LogicalView({ probe, scan, scanDurationMs }) {
  const [filter, setFilter] = useState('all');
  const [neighbors, setNeighbors] = useState({});
  const [portMacs, setPortMacs] = useState({});
  const [audit, setAudit] = useState(null);     // { identity, ifstatus, poe, vlans }

  // Last recorded state, for when the switch is unreachable right now.
  //
  // The poller has been writing every port's state to the drift store all along
  // — the same rows the Drift page reads. An unreachable switch is no reason to
  // show an empty page when we know what it last looked like.
  //
  // It is still LABELLED, just quietly: one muted line above the faceplate
  // rather than the banner that used to sit here. A stored port table with no
  // marker at all reads as current state, which is the thing this page was
  // cleaned up to stop — so the label is small, not absent.
  //
  // Ports page only. Lab stays live-or-nothing: it is the owner's diagnostic
  // view, where a cached table could be mistaken for proof a switch is answering.
  const [lastKnown, setLastKnown] = useState(null);   // { device, ports }
  useEffect(() => {
    if (probe.status !== 'error' || !probe.triedHost) { setLastKnown(null); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(
          `/api/ports/by-host/${encodeURIComponent(probe.triedHost)}/overview`));
        if (!r.ok) return;                    // 404 = not a monitored switch
        const d = await r.json();
        if (!cancelled && d?.ports?.length) setLastKnown(d);
      } catch { /* no history — the plain message stands on its own */ }
    })();
    return () => { cancelled = true; };
  }, [probe.status, probe.triedHost]);

  // Pull the full switch audit in one pass — identity, per-port live status,
  // PoE, VLANs, LLDP neighbours and the MAC table — then join it into the port
  // list so each view shows what's really on the switch. We query the CURRENT
  // switch (server default-host) rather than probe.host, which can be a stale
  // cached IP from an earlier scan — the port numbers (Gi1/0/N) match regardless.
  useEffect(() => {
    if (probe.status !== 'ok') return;
    let cancelled = false;
    (async () => {
      // The probe already succeeded, so probe.host is a known-reachable switch —
      // use it directly. (Never the /default-host "suggested" value: that's the
      // network gateway, not the switch, and would send the audit to the wrong box.)
      const host = probe.host;
      if (!host) return;
      // The switch allows ~1 SSH session, so this can lose to the port probe /
      // poller and come back empty. Retry a few times — once the switch frees
      // the session it succeeds.
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const r = await authFetch(apiUrl('/api/switch/audit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, vendor: 'tplink' }),
          });
          const d = await r.json();
          if (!cancelled && d?.ok) {
            setNeighbors(d.neighbors || {});
            setPortMacs(d.macs || {});
            setAudit({ identity: d.identity || {}, ifstatus: d.ifstatus || {}, ifconfig: d.ifconfig || {}, poe: d.poe || null, vlans: d.vlans || [] });
            return;
          }
        } catch { /* transient — retry */ }
        if (!cancelled) await new Promise(res => setTimeout(res, 4000));
      }
    })();
    return () => { cancelled = true; };
  }, [probe.status, probe.host]);

  if (probe.status === 'running' || probe.status === 'idle') {
    return <ProbeWaiting probe={probe} onRetry={() => triggerBackgroundProbe({ force: true })} />;
  }
  // Unreachable AND nothing on record — the message is all there is to say.
  // With history, fall through and render it below under a muted "as of" line.
  if (probe.status === 'error' && !lastKnown) {
    // "Probe failed: <raw server string>" led with the word failure and then
    // handed over jargon. Lead with the plain situation instead, and let the
    // detail sit underneath as explanation rather than as the headline. The
    // server messages are already written for a person (switchRequestBlocker),
    // so they read as a next step, not a stack trace.
    return (
      <div className={styles.errorBox}>
        <div className={styles.errorMsg}>
          <strong className={styles.errorMsgHead}>No switch data yet</strong>
          <div className={styles.errorMsgBody}>{probe.error}</div>
        </div>
        <button className={styles.retryBtn} onClick={() => triggerBackgroundProbe({ force: true })}>
          Try again
        </button>
      </div>
    );
  }

  // Live rows when we have them; otherwise the poller's last snapshot, mapped
  // into the same shape so everything below works unchanged. port_snapshots
  // stores oper as 'up'/'down' — exactly what logicalVerdict and the faceplate
  // test for — and keeps the LLDP columns, so neighbours survive. Nothing is
  // invented: a column the poller never recorded stays empty.
  const stale = probe.status === 'error' && !!lastKnown;
  const sourceRows = stale
    ? (lastKnown.ports || []).map(s => ({
        iface:       s.port,
        status:      s.oper || '',
        medium:      (s.medium || '').toLowerCase(),
        description: s.descr || '',
        neighbor:    (s.lldp_system || s.lldp_chassis)
          ? { found: true, system_name: s.lldp_system, chassis_id: s.lldp_chassis, port_id: s.lldp_port }
          : undefined,
      }))
    : (Array.isArray(probe.ports) ? probe.ports : []);

  const ports = sourceRows.map(p => {
    const k = portNumKey(p.iface);
    const patch = {};
    // Live joins only — the audit didn't run in the stale case, and the
    // snapshot's own LLDP is already mapped above.
    if (!stale && k && neighbors[k]?.found) patch.neighbor = neighbors[k];
    if (!stale && k && portMacs[k]) patch.macInfo = portMacs[k];
    return Object.keys(patch).length ? { ...p, ...patch } : p;
  });
  const { rj45, sfp } = classifyPorts(ports, scan);
  const sfpPortIfaces = new Set(sfp.map(p => p.iface));

  const verdicts = ports.map(p => ({ p, v: logicalVerdict(p) }));
  const linkedCount = ports.filter(p => p.neighbor?.found).length;
  const counts = {
    all:       ports.length,
    available: verdicts.filter(x => x.v === 'available').length,
    used:      verdicts.filter(x => x.v === 'used').length,
    reserved:  verdicts.filter(x => x.v === 'reserved').length,
    linked:    linkedCount,
  };

  const filtered = filter === 'all'    ? ports
    : filter === 'linked'              ? ports.filter(p => p.neighbor?.found)
    : ports.filter(p => logicalVerdict(p) === filter);

  const ethFiltered = filtered.filter(p => !sfpPortIfaces.has(p.iface));
  const sfpFiltered = filtered.filter(p =>  sfpPortIfaces.has(p.iface));

  return (
    <div className={styles.invWrap}>
      <div className={styles.hero}>
        {audit?.identity && <IdentityCard identity={audit.identity} host={probe.host} poe={audit.poe} />}
      </div>

      {/* A timestamp, not a warning. "Last recorded … — not live" read as an
          apology for the page; Drift shows recorded data plainly and so does
          this. Three words of muted text is still enough that a stored table is
          never mistaken for a live one, which is the one thing worth keeping. */}
      {stale && (
        <p className={styles.asOfLine}>As of {fmtAgo(lastKnown.device?.last_seen)}</p>
      )}

      <FaceplateMap ports={ports} sfpPortIfaces={sfpPortIfaces} />

      <div className={styles.invFilters}>
        <FilterPill label="All"        count={counts.all}       active={filter === 'all'}       onClick={() => setFilter('all')} />
        <FilterPill label="In Use"     count={counts.used}      active={filter === 'used'}      onClick={() => setFilter('used')} />
        <FilterPill label="Available"  count={counts.available} active={filter === 'available'} onClick={() => setFilter('available')} />
        <FilterPill label="Linked"     count={counts.linked}    active={filter === 'linked'}    onClick={() => setFilter('linked')} />
        {counts.reserved > 0 && (
          <FilterPill label="Errors"   count={counts.reserved}  active={filter === 'reserved'}  onClick={() => setFilter('reserved')} />
        )}
      </div>

      <div className={styles.portsLayout}>
        <div className={styles.portsMain}>
          {ethFiltered.length > 0 && (
            <PortGroup title="Ethernet (ETH) Modules" ports={ethFiltered} variant="eth" />
          )}
          {sfpFiltered.length > 0 && (
            <PortGroup title="SFP Modules" ports={sfpFiltered} variant="sfp" />
          )}
          {ethFiltered.length === 0 && sfpFiltered.length === 0 && (
            <div className={styles.invEmpty}>No ports match this filter.</div>
          )}
        </div>
        <PoeVlanAside audit={audit} />
      </div>
    </div>
  );
}

// ── Reachability check — ping / traceroute from the switch ───
function ReachabilityTool({ host }) {
  const [target, setTarget] = useState('');
  const [running, setRunning] = useState(null);   // 'ping' | 'traceroute' | null
  const [result, setResult] = useState(null);     // { kind, command, output } | { error }

  // Suggested targets: the internet (shows the full multi-hop path) and the
  // switch's own gateway (the local .1) for a quick local-link check.
  const gateway = host && /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.replace(/\.\d+$/, '.1') : null;
  const presets = [
    { ip: '8.8.8.8', label: '8.8.8.8 · internet' },
    ...(gateway ? [{ ip: gateway, label: `${gateway} · gateway` }] : []),
  ];

  const run = async (kind, override) => {
    const t = (override != null ? override : target).trim();
    if (override != null) setTarget(override);
    if (!t) { setResult({ error: 'Enter an IP address or hostname first.' }); return; }
    if (!host) { setResult({ error: 'The switch isn’t reachable yet - wait for it to load.' }); return; }
    setRunning(kind); setResult(null);
    try {
      const r = await authFetch(apiUrl('/api/switch/trace'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, vendor: 'tplink', target: t, kind }),
      });
      const d = await r.json();
      setResult(d.ok ? { kind: d.kind, command: d.command, output: d.output } : { error: d.error || 'Check failed.' });
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(null);
    }
  };

  return (
    <section className={styles.rchCard}>
      <div className={styles.rchHead}>
        <span className={styles.rchTitle}>Reachability check</span>
        <span className={styles.rchSub}>ping, run from the switch</span>
      </div>
      {/* Ping only. Traceroute is deliberately not offered: on TP-Link `tracert`
          requires a privilege above the read-only "User" role, and we run the
          switch with a read-only account. `ping` works at that level. */}
      <p className={styles.rchHintLine}>
        Type where you want to test <b>to</b> - an IP or hostname - and RackTrack pings it
        <b> from the switch</b>, so you can confirm the switch itself can reach it.
      </p>
      <div className={styles.rchRow}>
        <input
          className={styles.rchInput}
          value={target}
          onChange={e => setTarget(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !running) run('ping'); }}
          placeholder="IP or hostname - e.g. 192.168.1.1"
          spellCheck="false"
          autoCapitalize="off"
        />
        <button type="button" className={`${styles.rchBtn} ${styles.rchBtnPrimary}`} disabled={!!running} onClick={() => run('ping')}>
          {running === 'ping' ? 'Pinging…' : 'Ping'}
        </button>
      </div>
      {presets.length > 0 && (
        <div className={styles.rchPresets}>
          <span className={styles.rchPresetLbl}>Quick ping:</span>
          {presets.map(p => (
            <button key={p.ip} type="button" className={styles.rchChip} disabled={!!running} onClick={() => run('ping', p.ip)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {result && (
        result.error
          ? <div className={styles.rchErr}>{result.error}</div>
          : <pre className={styles.rchOut}>{result.output || '(no output)'}</pre>
      )}
    </section>
  );
}

// ── Switch identity card ─────────────────────────────────────
// Model / firmware / uptime / mgmt IP pulled live from system-info, plus the
// live PoE draw. No raw command text — just the parsed facts.
function IdentityCard({ identity, host, poe }) {
  const model = identity.name || (identity.description || '').replace(/JetStream\s*/i, '') || 'Switch';
  const poeUsed = poe && typeof poe.used === 'number' ? poe.used : null;
  const rows = [
    identity.fwVersion && { k: 'Firmware', v: identity.fwVersion },
    identity.uptime    && { k: 'Uptime',   v: identity.uptime },
    host               && { k: 'Mgmt IP',  v: host, mono: true },
    identity.mac       && { k: 'MAC',      v: identity.mac, mono: true },
    poeUsed != null    && { k: 'PoE draw', v: `${poeUsed} W${poe.budget ? ` / ${poe.budget} W` : ''}` },
  ].filter(Boolean);
  return (
    <section className={styles.idCard}>
      <div className={styles.idTop}>
        <span className={styles.idName}>{model}</span>
        <span className={styles.idLive}><i className={styles.idDot} aria-hidden="true" />live</span>
      </div>
      {identity.description && <p className={styles.idDesc}>{identity.description}</p>}
      <dl className={styles.idRows}>
        {rows.map(r => (
          <div key={r.k} className={styles.idRow}>
            <dt className={styles.idK}>{r.k}</dt>
            <dd className={`${styles.idV} ${r.mono ? styles.idMono : ''}`}>{r.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── Faceplate map + PoE + VLAN ───────────────────────────────
function portNumOf(iface) {
  const m = String(iface || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// The physical faceplate: one cell per port, coloured by live state. Ethernet
// and SFP split into their own rows, mirroring the real switch front panel.
function FaceplateMap({ ports, sfpPortIfaces }) {
  const cells = ports.map(p => {
    const linkUp = /(linkup|connected|^up$)/i.test((p.status || '').trim());
    const mi = p.macInfo, n = p.neighbor;
    const uplink = !!(mi && mi.count > 1);
    const endpoint = n?.found ? (n.system_name || n.chassis_id) : null;
    return {
      iface: p.iface,
      num: portNumOf(p.iface),
      isSfp: sfpPortIfaces.has(p.iface),
      state: uplink ? 'uplink' : linkUp ? 'up' : 'down',
      endpoint,
    };
  }).filter(c => c.num != null).sort((a, b) => a.num - b.num);

  const eth = cells.filter(c => !c.isSfp);
  const sfp = cells.filter(c => c.isSfp);

  const cell = (c) => (
    <div
      key={c.iface}
      className={`${styles.fpPort} ${
        c.state === 'up' ? styles.fpUp : c.state === 'uplink' ? styles.fpUplink : styles.fpDown
      }`}
      title={`${c.iface} · ${c.state === 'uplink' ? 'uplink' : c.state}${c.endpoint ? ' · ' + c.endpoint : ''}`}
    >
      <span className={styles.fpNum}>{c.num}</span>
    </div>
  );

  return (
    <section className={styles.fpCard}>
      <div className={styles.fpHead}>
        <span className={styles.fpTitle}>Faceplate</span>
        <div className={styles.fpLegend}>
          <span className={styles.fpLg}><i className={`${styles.fpSw} ${styles.fpUp}`} />Up</span>
          <span className={styles.fpLg}><i className={`${styles.fpSw} ${styles.fpUplink}`} />Uplink</span>
          <span className={styles.fpLg}><i className={`${styles.fpSw} ${styles.fpDown}`} />Free</span>
        </div>
      </div>
      <div className={styles.fpBody}>
        {eth.length > 0 && (
          <div className={styles.fpZone}>
            <div className={styles.fpRowLabel}>Ethernet · {eth.length}</div>
            <div className={styles.fpWrap}><div className={styles.fpGrid}>{eth.map(cell)}</div></div>
          </div>
        )}
        {sfp.length > 0 && (
          <div className={styles.fpZoneSfp}>
            <div className={styles.fpRowLabel}>SFP · {sfp.length}</div>
            <div className={styles.fpWrap}><div className={styles.fpGridSfp}>{sfp.map(cell)}</div></div>
          </div>
        )}
      </div>
    </section>
  );
}

// Sidebar next to the port list: PoE draw per powered port + VLAN membership.
function PoeVlanAside({ audit }) {
  const vlans = audit?.vlans || [];
  const poePorts = audit?.poe?.ports || {};
  const powered = Object.entries(poePorts).filter(([, v]) => v.on).map(([k, v]) => ({ port: k, ...v }));

  if (!audit) return <aside className={styles.portsAside}><div className={styles.cblFoot}>Reading the switch…</div></aside>;
  if (powered.length === 0 && vlans.length === 0) return null;

  return (
    <aside className={styles.portsAside}>
      {powered.length > 0 && (
        <div className={styles.asideBlock}>
          <div className={styles.asideHead}>PoE · powered</div>
          <div className={styles.asideList}>
            {powered.map(pp => (
              <div key={pp.port} className={styles.asideRow}>
                <span className={styles.asidePort}>{shortLabel(pp.port)}</span>
                <span className={styles.asideMid}>{pp.class || 'Powered'}</span>
                <span className={styles.asideVal}>{pp.power} W</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {vlans.length > 0 && (
        <div className={styles.asideBlock}>
          <div className={styles.asideHead}>VLANs</div>
          <div className={styles.asideList}>
            {vlans.map(v => (
              <div key={v.id} className={styles.asideRow}>
                <span className={styles.asidePort}>VLAN {v.id}</span>
                <span className={styles.asideMid}>{v.name}</span>
                <span className={styles.asideVal}>{v.ports.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Filter pill ──────────────────────────────────────────────
function FilterPill({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.invPill} ${active ? styles.invPillActive : ''}`}
    >
      <span>{label}</span>
      <span className={styles.invPillCount}>{count}</span>
    </button>
  );
}

// ── Port group (ETH / SFP section) ───────────────────────────
function PortGroup({ title, ports, variant }) {
  return (
    <section className={styles.invSection}>
      <div className={styles.invSectionHead}>
        <h3 className={styles.invSectionTitle}>{title}</h3>
        <span className={styles.invSectionCount}>
          {ports.length} {ports.length === 1 ? 'PORT' : 'PORTS'}
        </span>
      </div>
      <div className={styles.ptList}>
        {ports.map(p => <PortCard key={p.iface} port={p} variant={variant} />)}
      </div>
    </section>
  );
}

// ── Port row — 3-column detail layout with left accent ───────
function PortCard({ port, variant }) {
  const verdict     = logicalVerdict(port);
  const accentClass = verdict === 'available' ? styles.invAccentAvail
                    : verdict === 'used'      ? styles.invAccentUsed
                    :                            styles.invAccentErr;
  const statusClass = verdict === 'available' ? styles.invStatusAvail
                    : verdict === 'used'      ? styles.invStatusUsed
                    :                            styles.invStatusErr;
  const verdictLabel =
      verdict === 'available' ? 'Available'
    : verdict === 'used'      ? 'In use'
    :                            'Reserved';

  // Raw status text from the switch — e.g. "connected", "notconnect",
  // "err-disabled". Title-cased for display, falls back to the verdict.
  const statusRaw  = (port.status || '').trim();
  const statusText = statusRaw
    ? statusRaw
        .replace(/notconnect/i, 'Not connected')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
    : verdictLabel;

  const shortName  = shortLabel(port.iface).padStart(2, '0');
  const medium     = port.medium === 'fiber' ? 'Fiber'
                   : port.medium === 'copper' ? 'Copper'
                   : (variant === 'sfp' ? 'Fiber' : 'Copper');
  const linkUp     = /(linkup|connected|^up$)/i.test((port.status || '').trim());
  const n          = port.neighbor;
  const mi         = port.macInfo;                 // { macs:[], vlan, count }
  const endpoint   = n?.found ? (n.system_name || n.chassis_id || 'device') : null;
  const vlan       = n?.vlan_id || mi?.vlan || null;
  const primaryMac = n?.port_id || mi?.macs?.[0] || null;

  // Build the "who's on the other end" line, logical layer only.
  let title, sub;
  if (endpoint) {                                  // LLDP-identified device
    title = endpoint;
    sub = [primaryMac, vlan && `VLAN ${vlan}`, medium].filter(Boolean).join(' · ');
  } else if (mi && mi.count > 1) {                 // many MACs = uplink / trunk
    title = `${mi.count} devices`;
    sub = ['uplink', vlan && `VLAN ${vlan}`, medium].filter(Boolean).join(' · ');
  } else if (mi && mi.count === 1) {               // single MAC, no LLDP name
    title = mi.macs[0];
    sub = [vlan && `VLAN ${vlan}`, medium].filter(Boolean).join(' · ');
  } else if (linkUp) {
    title = null; sub = null;                       // connected but silent
  } else {
    title = null; sub = null;                       // down
  }

  return (
    <article className={styles.ptRow} title={`${port.iface} · ${verdictLabel}`}>
      {/* status rail: filled = link up, faint = down */}
      <span className={`${styles.ptRail} ${linkUp ? styles.ptRailUp : styles.ptRailDown}`} aria-hidden="true" />

      {/* port number + interface */}
      <div className={styles.ptNumCol}>
        <span className={styles.ptNum}>{shortName}</span>
        <span className={styles.ptIf}>{port.iface}</span>
      </div>

      {/* logical endpoint on this port */}
      <div className={styles.ptMid}>
        {title ? (
          <>
            <span className={styles.ptLink}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>
              </svg>
              {title}
            </span>
            {sub && <span className={styles.ptSub}>{sub}</span>}
          </>
        ) : linkUp ? (
          <span className={styles.ptNone}>Connected device<span className={styles.ptMed}> · {medium}</span></span>
        ) : (
          <span className={styles.ptNone}>-<span className={styles.ptMed}> · {medium}</span></span>
        )}
      </div>

      {/* link state + verdict */}
      <div className={styles.ptRight}>
        <span className={`${styles.ptStatTxt} ${linkUp ? styles.ptUp : styles.ptDown}`}>{linkUp ? 'Up' : 'Down'}</span>
        <span className={styles.ptVerdict}>{verdictLabel}</span>
      </div>
    </article>
  );
}

// ── Cables view ──────────────────────────────────────────────
// A cable is a live port with something identified on the other end. We only
// know the LOGICAL layer (LLDP neighbour + MAC table) — passive patch panels
// have no chip and are invisible — so each row is: this switch port ↔ the
// endpoint we can see, with its kind, VLAN and medium.
const MAC_RE = /^[0-9a-f]{2}([:.-])[0-9a-f]{2}(?:\1?[0-9a-f]{2}){4}$/i;

function deriveCables(ports, sfpPortIfaces) {
  return ports
    .filter(p => {
      const up = /(linkup|connected|^up$)/i.test((p.status || '').trim());
      return up && (p.neighbor?.found || p.macInfo);
    })
    .map(p => {
      const n  = p.neighbor;
      const mi = p.macInfo;
      const medium = p.medium === 'fiber' ? 'Fiber'
                   : p.medium === 'copper' ? 'Copper'
                   : (sfpPortIfaces.has(p.iface) ? 'Fiber' : 'Copper');
      const vlan = n?.vlan_id || mi?.vlan || null;

      let remoteName, remotePort = null, mac = null, kind;
      if (n?.found) {
        remoteName = n.system_name || n.chassis_id || 'Unknown device';
        remotePort = n.port_id && !MAC_RE.test(n.port_id) ? n.port_id : null;
        mac = MAC_RE.test(n.chassis_id || '') ? n.chassis_id : (mi?.macs?.[0] || null);
        const infra = /switch|bridge|router|jetstream|catalyst|mikrotik|ubiquiti|\bios\b/i
          .test([n.system_description, n.system_name].filter(Boolean).join(' '));
        kind = infra ? 'trunk' : (mi && mi.count > 1 ? 'uplink' : 'device');
      } else if (mi && mi.count > 1) {
        remoteName = `${mi.count} devices`;
        kind = 'uplink';
      } else {
        remoteName = mi.macs[0];
        mac = mi.macs[0];
        kind = 'device';
      }
      return {
        iface: p.iface,
        num: shortLabel(p.iface).padStart(2, '0'),
        remoteName, remotePort, mac, vlan, medium, kind,
        // trace extras
        macs: (mi?.macs || []),
        mgmt: (n?.management_address && !/^\s*$/.test(n.management_address)) ? n.management_address : null,
        desc: n?.system_description || null,
      };
    })
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
}

const KIND_META = {
  device: { label: 'Device', cls: 'kindDevice' },
  uplink: { label: 'Uplink', cls: 'kindUplink' },
  trunk:  { label: 'Switch link', cls: 'kindTrunk' },
};

function CablesView({ ports, sfpPortIfaces, switchName }) {
  const cables = deriveCables(ports, sfpPortIfaces);
  const [open, setOpen] = useState(null);   // iface of the expanded trace

  if (cables.length === 0) {
    return (
      <div className={styles.invEmpty}>
        No cables identified yet - reading the switch. Live ports with an
        LLDP neighbour or a known MAC appear here.
      </div>
    );
  }

  return (
    <section className={styles.invSection}>
      <div className={styles.invSectionHead}>
        <h3 className={styles.invSectionTitle}>Connected cables</h3>
        <span className={styles.invSectionCount}>
          {cables.length} {cables.length === 1 ? 'LINK' : 'LINKS'}
        </span>
      </div>
      <div className={styles.cblList}>
        {cables.map(c => {
          const meta = KIND_META[c.kind] || KIND_META.device;
          const remoteMeta = [c.remotePort, c.mac, c.vlan && `VLAN ${c.vlan}`, c.medium]
            .filter(Boolean).join(' · ');
          const isOpen = open === c.iface;
          return (
            <div key={c.iface} className={styles.cblItem}>
              <button
                type="button"
                className={`${styles.cblRow} ${styles.cblRowBtn} ${isOpen ? styles.cblRowOpen : ''}`}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : c.iface)}
              >
                <div className={styles.cblLocal}>
                  <span className={styles.cblNum}>{c.num}</span>
                  <span className={styles.cblIf}>{c.iface}</span>
                </div>
                <span className={styles.cblArrow} aria-hidden="true">→</span>
                <div className={styles.cblRemote}>
                  <span className={styles.cblName}>{c.remoteName}</span>
                  {remoteMeta && <span className={styles.cblMeta}>{remoteMeta}</span>}
                </div>
                <span className={`${styles.cblKind} ${styles[meta.cls]}`}>{meta.label}</span>
                <span className={`${styles.cblChev} ${isOpen ? styles.cblChevOpen : ''}`} aria-hidden="true">⌄</span>
              </button>
              {isOpen && <CableTrace cable={c} switchName={switchName} />}
            </div>
          );
        })}
      </div>
      <p className={styles.cblFoot}>
        Logical layer only - read live from the switch (LLDP + MAC table).
        Passive patch panels and wall cabling between the ends have no chip, so
        they aren't visible to the switch.
      </p>
    </section>
  );
}

// The first three octets of a MAC are the manufacturer's IEEE-registered block.
// Pull them out so each downstream device can be labelled with who built it.
function ouiKey(mac) {
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex.slice(0, 6) : null;
}

// Vendor names are looked up once per prefix and memoised for the session — the
// switch re-reports the same MACs on every poll, and the table lives server-side.
const vendorCache = new Map();

async function lookupVendors(prefixes) {
  const missing = prefixes.filter(p => !vendorCache.has(p));
  if (missing.length) {
    try {
      const r = await authFetch(apiUrl('/api/oui/lookup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: missing }),
      });
      const d = await r.json();
      // Cache misses too, as null — an unregistered prefix must not be re-asked.
      for (const p of missing) vendorCache.set(p, d?.vendors?.[p] || null);
    } catch (_) {
      for (const p of missing) vendorCache.set(p, null);
    }
  }
  return Object.fromEntries(prefixes.map(p => [p, vendorCache.get(p) || null]));
}

const DEVICES_SHOWN = 12;

function DownstreamMacs({ macs }) {
  const [vendors, setVendors] = useState(() => Object.fromEntries(
    macs.map(m => [ouiKey(m), vendorCache.get(ouiKey(m)) || null]).filter(([k]) => k)));
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const prefixes = useMemo(
    () => [...new Set(macs.map(ouiKey).filter(Boolean))], [macs]);

  useEffect(() => {
    let cancelled = false;
    lookupVendors(prefixes).then(v => { if (!cancelled) setVendors(v); });
    return () => { cancelled = true; };
  }, [prefixes]);

  // One row per device — each MAC is a distinct machine on the far side. Sorting
  // by vendor puts same-make devices together without merging their identities.
  const devices = useMemo(() => macs
    .map(mac => {
      const up = String(mac).toUpperCase();
      const key = ouiKey(up);
      return { mac: up, vendor: (key && vendors[key]) || null };
    })
    .sort((a, b) =>
      // Named vendors first, alphabetical; unknown makers sink to the bottom.
      (!a.vendor - !b.vendor) ||
      (a.vendor || '').localeCompare(b.vendor || '') ||
      a.mac.localeCompare(b.mac)), [macs, vendors]);

  const hidden = showAll ? 0 : Math.max(0, devices.length - DEVICES_SHOWN);
  const shown = hidden ? devices.slice(0, DEVICES_SHOWN) : devices;

  // "4 Dell · 3 Realtek · …" — the make-up of the far side at a glance.
  const mix = useMemo(() => {
    const counts = new Map();
    for (const d of devices) {
      const name = d.vendor || 'Unknown';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [devices]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(devices.map(d => d.mac).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_) { /* clipboard unavailable */ }
  }

  return (
    <>
      <div className={styles.dsHead}>
        <div className={styles.dsHeadText}>
          <div className={styles.traceT}>
            Downstream network · {devices.length} device{devices.length === 1 ? '' : 's'}
          </div>
          <div className={styles.dsSub}>Reachable through this port - one row per device</div>
        </div>
        <button type="button" className={styles.dsCopy} onClick={copyAll}>
          {copied ? 'Copied' : 'Copy MACs'}
        </button>
      </div>

      {mix.length > 1 && (
        <div className={styles.dsMix}>
          {mix.map(([name, n]) => (
            <span key={name} className={styles.dsMixChip}>
              <span className={styles.dsMixNum}>{n}</span>{name}
            </span>
          ))}
        </div>
      )}

      <div className={styles.dsList}>
        {shown.map(d => (
          <div key={d.mac} className={styles.dsRow}>
            <span className={styles.dsMac}>{d.mac}</span>
            <span className={`${styles.dsVendor} ${d.vendor ? '' : styles.dsVendorNone}`}>
              {d.vendor || 'Unknown maker'}
            </span>
          </div>
        ))}
      </div>

      {(hidden > 0 || showAll) && (
        <button type="button" className={styles.dsMore} onClick={() => setShowAll(!showAll)}>
          {hidden > 0 ? `Show ${hidden} more device${hidden === 1 ? '' : 's'}` : 'Show fewer'}
        </button>
      )}
    </>
  );
}

// The end-to-end logical trace for one cable: this switch · port → endpoint.
// For an uplink, the endpoint is a downstream network and we list every MAC
// reachable through the port (the "everything on the far side").
function CableTrace({ cable, switchName }) {
  const c = cable;
  const isUplink = c.kind === 'uplink' || c.kind === 'trunk' || c.macs.length > 1;
  const endMeta = [c.remotePort && `port ${c.remotePort}`, c.mgmt, c.vlan && `VLAN ${c.vlan}`]
    .filter(Boolean).join(' · ');

  return (
    <div className={styles.trace}>
      <div className={styles.traceHop}>
        <div className={styles.traceRail}>
          <span className={`${styles.traceNode} ${styles.traceNodeSw}`}>▤</span>
          <span className={styles.traceStem} />
        </div>
        <div className={styles.traceBody}>
          <div className={styles.traceT}>{switchName || 'This switch'}</div>
          <div className={styles.traceD}>{c.iface} · {c.medium}{c.vlan ? ` · VLAN ${c.vlan}` : ''}</div>
        </div>
      </div>

      <div className={styles.traceHop}>
        <div className={styles.traceRail}>
          <span className={`${styles.traceNode} ${isUplink ? styles.traceNodeUp : styles.traceNodeDev}`}>
            {isUplink ? '⇅' : '▢'}
          </span>
        </div>
        <div className={styles.traceBody}>
          {isUplink ? (
            <DownstreamMacs macs={c.macs} />
          ) : (
            <>
              <div className={styles.traceT}>{c.remoteName}</div>
              <div className={styles.traceD}>{[c.mac, endMeta].filter(Boolean).join(' · ') || 'endpoint device'}</div>
              {c.desc && <div className={styles.traceDesc}>{c.desc}</div>}
            </>
          )}
        </div>
      </div>

      <p className={styles.traceNote}>
        Any patch panel or wall outlet along this run is passive - invisible to the
        switch - so it can't appear here. Add those from the port label if you keep a cable schedule.
      </p>
    </div>
  );
}

// ── Orbital loader ───────────────────────────────────────────
// The probe sits in `idle` forever when no switch is configured for this
// deployment at all — which is the normal state on the demo, where there is no
// switch on the network to read. OrbitalLoader only counts up when `startedAt`
// is set, so with no probe actually running it span with no text and no end,
// and testers reported the Ports page as simply blank.
//
// Wait a short while (a real probe against a slow switch does take a few
// seconds), then stop spinning and say what is going on. A page that explains
// why it is empty is not a broken page.
function ProbeWaiting({ probe, onRetry }) {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setWaited(w => w + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (waited < 12) return <OrbitalLoader startedAt={probe.startedAt} />;

  return (
    <div className={styles.errorBox}>
      <div className={styles.errorMsg}>
        <strong className={styles.errorMsgHead}>No live switch connected</strong>
        <div className={styles.errorMsgBody}>
          This page reads live port status straight off a real switch - which
          ports are up, what is plugged into each one, and which are free. That
          needs a switch on the network for RackTrack to reach.
          {' '}
          There is no switch connected to this deployment, so there is nothing
          to show here. Your rack scans, devices and reports are unaffected -
          only live port status depends on a switch being reachable.
        </div>
      </div>
      <button className={styles.retryBtn} onClick={onRetry}>Try again</button>
    </div>
  );
}

function OrbitalLoader({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className={styles.orbitalWrap}>
      <div className={styles.orbital}>
        <span className={styles.orbitalRing} />
        <span className={styles.orbitalRing} />
        <span className={styles.orbitalCore} />
      </div>
      <div className={styles.orbitalLabel}>
        Loading<span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span>
      </div>
      {startedAt && <div className={styles.orbitalElapsed}>{elapsed}s</div>}
    </div>
  );
}
