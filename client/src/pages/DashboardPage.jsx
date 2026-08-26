import { useEffect, useRef, useState, useCallback } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import { LogsView } from './LogsPage.jsx';
import styles from './DashboardPage.module.css';
import BackButton from '../components/BackButton.jsx';
import { HeaderActions } from '../components/ShellHeader.jsx';

// A short, human label for each audit action so the feed reads in plain
// English instead of dotted machine keys.
const ACTION_LABELS = {
  'scan.create':            'Scanned a rack',
  'scan.select_port':       'Located a port',
  'scan.analyze_for_ticket':'Analyzed for ticket',
  'scan.share.outlook':     'Shared (Outlook)',
  'scan.share.teams':       'Shared (Teams)',
  'feedback.submit':        'Gave feedback',
  'console.run_manual':     'Ran console command',
  'incident.verify_rack':   'Verified rack (incident)',
  'auth.login':             'Signed in',
  'auth.signup.start':      'Started sign-up',
  'auth.signup.verify':     'Verified sign-up',
  'auth.resend':            'Resent verification',
  'auth.forgot_password.start':  'Requested reset',
  'auth.forgot_password.verify': 'Reset password',
  'invite.accept':          'Accepted invite',
  'member.create':          'Added a member',
  'member.update':          'Updated a member',
  'member.remove':          'Removed a member',
  'org.approve':            'Approved an org',
  'org.remove':             'Removed an org',
  'org.create':             'Created an org',
  'org.update':             'Updated an org',
  'org.reject':             'Rejected an org',
  'invite.create':          'Created an invite',
  'rack_group.create':      'Grouped two racks',
  'report.regen':           'Regenerated a report',
  'scan.confirm_layout':    'Confirmed rack layout',
  'scan.ocr_devices':       'Read device labels',
  'scan.analyze_for_ticket.rack_mismatch': 'Ticket rack didn’t match',
  'feedback.verified_ports':'Verified ports',
  'console.run_auto':       'Ran a check',
  'console.run_auto_stream':'Ran a live check',
  'auth.forgot_password.login_with_code': 'Signed in with a code',
  'active_learning.cycle':  'Retrained the model',
  'agent.post_work_note':   'Posted a work note',
  'agent.feedback_refresh': 'Refreshed feedback',
  'agent.proactive_refresh':'Refreshed data',
  'logs.clear':             'Cleared the log',
  'port_poller.reset':      'Reset a switch poll',
  'orphan_gc.run':          'Cleaned up storage',
  'orphan_gc.scheduled':    'Scheduled cleanup',
};

// Anything still unmapped becomes readable rather than raw ("rack_group.create"
// → "Rack group create") — no dotted machine names leak into the dashboard.
const humanizeAction = (a) =>
  String(a || '')
    .replace(/[._]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

const labelFor = (a) => ACTION_LABELS[a] || humanizeAction(a);

// audit_log timestamps are UTC "YYYY-MM-DD HH:MM:SS" (no zone) → parse as UTC.
function parseTs(ts) {
  if (!ts) return null;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function relTime(ts) {
  const d = parseTs(ts);
  if (!d) return '';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 5)     return 'just now';
  if (s < 60)    return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60)    return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24)    return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

function StatCard({ label, value, sub, tone }) {
  return (
    <div className={`${styles.stat} ${tone ? styles[tone] : ''}`}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {sub != null && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

// The operations view — headline stats, live feed, errors, rankings, users,
// and organizations. The console (below) owns the page chrome and the
// Live / Refresh controls, driving this via `live` and `refreshTick`.
function OperationsView({ live = true, refreshTick = 0 }) {
  const [data,    setData]    = useState(null);
  const [error,   setError]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [, setTick]           = useState(0);   // re-render so "x ago" stays fresh
  const liveRef = useRef(live);
  liveRef.current = live;

  const load = useCallback(async () => {
    try {
      const res = await authFetch(apiUrl('/api/admin/dashboard'));
      if (res.status === 403) { setError('Owner access required to view this dashboard.'); setLoading(false); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Reload when the console's Refresh button is pressed.
  useEffect(() => { if (refreshTick) load(); }, [refreshTick, load]);

  // Poll every 5s while "live" is on.
  useEffect(() => {
    const id = setInterval(() => { if (liveRef.current) load(); }, 5000);
    return () => clearInterval(id);
  }, [load]);

  // Independent 1s tick keeps relative timestamps current between polls.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return <div className={styles.center}>Loading dashboard…</div>;
  }
  if (error && !data) {
    return <div className={styles.center}>{error}</div>;
  }

  const t  = data?.totals   || {};
  const fb = data?.feedback || {};

  return (
    <div className={styles.opsWrap}>
      {/* Headline stats */}
      <section className={styles.stats}>
        <StatCard label="Scans today"      value={t.scansToday ?? 0} tone="accent" />
        <StatCard label="Active users today" value={t.activeToday ?? 0} />
        <StatCard label="Total scans"      value={t.scansOk ?? 0} sub={t.scansFail ? `${t.scansFail} failed` : null} />
        <StatCard label="Success rate"     value={t.successRate != null ? `${t.successRate}%` : '-'}
                  tone={t.successRate != null && t.successRate < 90 ? 'warn' : 'good'} />
        <StatCard label="Accuracy (feedback)" value={fb.accuracy != null ? `${fb.accuracy}%` : '-'}
                  sub={fb.right + fb.wrong ? `${fb.right} right · ${fb.wrong} wrong` : 'no feedback yet'}
                  tone={fb.accuracy != null && fb.accuracy < 80 ? 'warn' : 'good'} />
        <StatCard label="Users"            value={t.users ?? 0} />
        <StatCard label="Organizations"    value={t.orgs ?? 0} />
        <StatCard label="Failures (all)"   value={t.totalFails ?? 0} tone={t.totalFails ? 'warn' : undefined} />
      </section>

      <div className={styles.grid}>
        {/* Live activity feed */}
        <section className={`${styles.card} ${styles.feedCard}`}>
          <div className={styles.cardHead}>
            <h2>Live activity</h2>
            <span className={styles.cardMeta}>
              {data?.generatedAt ? `updated ${relTime(data.generatedAt)}` : ''}
            </span>
          </div>
          <div className={styles.feed}>
            {(data?.recent || []).map((e, i) => (
              <div key={i} className={styles.feedRow}>
                <span className={`${styles.statusPill} ${e.status === 'fail' ? styles.pillFail : styles.pillOk}`}>
                  {e.status === 'fail' ? 'fail' : 'ok'}
                </span>
                <div className={styles.feedBody}>
                  <div className={styles.feedLine}>
                    <span className={styles.feedUser}>{e.username || 'guest'}</span>
                    {e.actor_id
                      ? <span className={styles.feedId}>{e.actor_id}</span>
                      : e.guest ? <span className={styles.feedGuest}>not signed in</span> : null}
                    <span className={styles.feedAction}>{labelFor(e.action)}</span>
                    {e.org && <span className={styles.feedOrg}>{e.org}</span>}
                  </div>
                  {e.status === 'fail' && e.error && <div className={styles.feedError}>{e.error}</div>}
                  {e.target_id && e.status !== 'fail' && <div className={styles.feedTarget}>{e.target_id}</div>}
                </div>
                <span className={styles.feedTime}>{relTime(e.ts)}</span>
              </div>
            ))}
            {!(data?.recent || []).length && <div className={styles.empty}>No activity yet.</div>}
          </div>
        </section>

        <div className={styles.sideCol}>
          {/* Recent errors */}
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>Recent errors</h2></div>
            <div className={styles.errorList}>
              {(data?.errors || []).map((e, i) => (
                <div key={i} className={styles.errorRow}>
                  <div className={styles.errorTop}>
                    <span className={styles.errorAction}>{labelFor(e.action)}</span>
                    <span className={styles.feedTime}>{relTime(e.ts)}</span>
                  </div>
                  <div className={styles.errorMsg}>{e.error}</div>
                  <div className={styles.errorWho}>
                    {e.username || 'anonymous'}{e.org ? ` · ${e.org}` : ''}
                  </div>
                </div>
              ))}
              {!(data?.errors || []).length && <div className={styles.empty}>No errors. 🎉</div>}
            </div>
          </section>

          {/* Top scanners */}
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>Top scanners</h2></div>
            <div className={styles.rankList}>
              {(data?.topUsers || []).map((u, i) => (
                <div key={i} className={styles.rankRow}>
                  <span className={styles.rankName}>{u.username}</span>
                  <span className={styles.rankBarWrap}>
                    <span className={styles.rankBar}
                      style={{ width: `${Math.max(6, (u.scans / (data.topUsers[0]?.scans || 1)) * 100)}%` }} />
                  </span>
                  <span className={styles.rankNum}>{u.scans}</span>
                </div>
              ))}
              {!(data?.topUsers || []).length && <div className={styles.empty}>-</div>}
            </div>
          </section>

          {/* Scans by org */}
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>Scans by organization</h2></div>
            <div className={styles.rankList}>
              {(data?.byOrg || []).map((o, i) => (
                <div key={i} className={styles.rankRow}>
                  <span className={styles.rankName}>{o.org}</span>
                  <span className={styles.rankBarWrap}>
                    <span className={styles.rankBar}
                      style={{ width: `${Math.max(6, (o.scans / (data.byOrg[0]?.scans || 1)) * 100)}%` }} />
                  </span>
                  <span className={styles.rankNum}>{o.scans}</span>
                </div>
              ))}
              {!(data?.byOrg || []).length && <div className={styles.empty}>-</div>}
            </div>
          </section>

          {/* Scans by site */}
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>Scans by site</h2></div>
            <div className={styles.rankList}>
              {(data?.bySite || []).map((s, i) => (
                <div key={i} className={styles.rankRow}>
                  <span className={styles.rankName}>{s.site}</span>
                  <span className={styles.rankBarWrap}>
                    <span className={styles.rankBar}
                      style={{ width: `${Math.max(6, (s.scans / (data.bySite[0]?.scans || 1)) * 100)}%` }} />
                  </span>
                  <span className={styles.rankNum}>{s.scans}</span>
                </div>
              ))}
              {!(data?.bySite || []).length && <div className={styles.empty}>-</div>}
            </div>
          </section>

          {/* Action mix */}
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>What users are doing</h2></div>
            <div className={styles.actionList}>
              {(data?.actions || []).map((a, i) => {
                const total = a.ok + a.fail;
                const failPct = total ? (a.fail / total) * 100 : 0;
                return (
                  <div key={i} className={styles.actionRow}>
                    <span className={styles.actionName}>{labelFor(a.action)}</span>
                    <span className={styles.actionMeter}>
                      <span className={styles.actionOk}  style={{ width: `${100 - failPct}%` }} />
                      <span className={styles.actionFail} style={{ width: `${failPct}%` }} />
                    </span>
                    <span className={styles.actionNum}>
                      {total}{a.fail ? <em className={styles.actionFailNum}> · {a.fail} fail</em> : null}
                    </span>
                  </div>
                );
              })}
              {!(data?.actions || []).length && <div className={styles.empty}>-</div>}
            </div>
          </section>
        </div>
      </div>

      {/* ── The scans themselves — who scanned what, where ── */}
      <section className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.cardHead}>
          <h2>Recent scans</h2>
          <span className={styles.cardMeta}>last {(data?.recentScans || []).length}</span>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Rack</th><th>User</th><th>Site</th><th>Organization</th><th>When</th></tr></thead>
            <tbody>
              {(data?.recentScans || []).map((s, i) => (
                <tr key={i}>
                  <td><code className={styles.userId}>{s.rack || '-'}</code></td>
                  <td>{s.username}</td>
                  <td>{s.site || '-'}</td>
                  <td>{s.org || '-'}</td>
                  <td className={styles.dim}>{relTime(s.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(data?.recentScans || []).length && <div className={styles.empty}>No scans yet.</div>}
        </div>
      </section>

      {/* ── Authentication activity ── */}
      <section className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.cardHead}><h2>Authentication</h2></div>
        <div className={styles.authRow}>
          <div className={styles.authStat}><b>{data?.auth?.logins_ok ?? 0}</b><span>logins</span></div>
          <div className={styles.authStat}><b className={styles.authFail}>{data?.auth?.logins_fail ?? 0}</b><span>failed logins</span></div>
          <div className={styles.authStat}><b>{data?.auth?.signups ?? 0}</b><span>sign-ups</span></div>
          <div className={styles.authStat}><b>{data?.auth?.invites ?? 0}</b><span>invites accepted</span></div>
          <div className={styles.authStat}><b>{data?.auth?.resets ?? 0}</b><span>password resets</span></div>
        </div>
      </section>

      {/* ── Every user ── */}
      <section className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.cardHead}>
          <h2>All users</h2>
          <span className={styles.cardMeta}>{(data?.allUsers || []).length} total</span>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>ID</th><th>User</th><th>Role</th><th>Org</th><th className={styles.thNum}>Scans</th><th className={styles.thNum}>Events</th><th className={styles.thNum}>Fails</th><th>Last active</th></tr></thead>
            <tbody>
              {(data?.allUsers || []).map((u, i) => (
                <tr key={i}>
                  <td><code className={styles.userId}>{u.public_id || '-'}</code></td>
                  <td>{u.username}{u.active === 0 && <span className={styles.inactive}> · inactive</span>}</td>
                  <td><span className={styles.roleTag}>{u.role}</span></td>
                  <td>{u.org || '-'}</td>
                  <td className={styles.num}>{u.scans}</td>
                  <td className={styles.num}>{u.events}</td>
                  <td className={styles.num}>{u.fails ? <b className={styles.authFail}>{u.fails}</b> : 0}</td>
                  <td className={styles.dim}>{u.last_active ? relTime(u.last_active) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(data?.allUsers || []).length && <div className={styles.empty}>No users.</div>}
        </div>
      </section>

      {/* ── Every organization ── */}
      <section className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.cardHead}>
          <h2>All organizations</h2>
          <span className={styles.cardMeta}>{(data?.allOrgs || []).length} total</span>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Organization</th><th>Status</th><th className={styles.thNum}>Members</th><th className={styles.thNum}>Scans</th></tr></thead>
            <tbody>
              {(data?.allOrgs || []).map((o, i) => (
                <tr key={i}>
                  <td>{o.name}</td>
                  <td><span className={styles.roleTag}>{o.status}</span></td>
                  <td className={styles.num}>{o.members}</td>
                  <td className={styles.num}>{o.scans}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(data?.allOrgs || []).length && <div className={styles.empty}>No organizations.</div>}
        </div>
      </section>
    </div>
  );
}

const TABS = [
  { key: 'ops',  label: 'Operations', sub: "Everything happening across RackTrack - who's scanning, what's working, what's failing." },
  { key: 'logs', label: 'Logs',       sub: 'Live application log - email delivery, errors, and requests as the server records them.' },
];

// The owner console: one place for all operations AND logs. A shared header
// (title + Live / Refresh) sits above a tab switcher; each tab mounts its own
// self-contained view, so only the visible tab polls.
export default function DashboardPage() {
  const [tab,  setTab]  = useState('ops');
  const [live, setLive] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const active = TABS.find(t => t.key === tab) || TABS[0];

  return (
    <div className={styles.page}>
      {/* On desktop the page header is hidden (the shared shell header shows
          "Operations Console"); the Live / Refresh controls portal into the
          shell header's right slot. No-op on mobile, so nothing duplicates. */}
      <HeaderActions>
        <button
          className={`${styles.liveBtn} ${live ? styles.liveOn : ''}`}
          onClick={() => setLive(v => !v)}
          title={live ? 'Auto-refresh on' : 'Auto-refresh paused'}
        >
          <span className={styles.liveDot} />
          {live ? 'Live' : 'Paused'}
        </button>
        <button className={styles.refreshBtn} onClick={() => setRefreshTick(n => n + 1)}>Refresh</button>
      </HeaderActions>

      <header className={styles.header}>
        <BackButton fallback="/" />
        <div>
          <h1 className={styles.title}>Operations Console</h1>
          <p className={styles.subtitle}>{active.sub}</p>
        </div>
        <div className={styles.headerRight}>
          <button
            className={`${styles.liveBtn} ${live ? styles.liveOn : ''}`}
            onClick={() => setLive(v => !v)}
            title={live ? 'Auto-refresh on' : 'Auto-refresh paused'}
          >
            <span className={styles.liveDot} />
            {live ? 'Live' : 'Paused'}
          </button>
          <button className={styles.refreshBtn} onClick={() => setRefreshTick(n => n + 1)}>Refresh</button>
        </div>
      </header>

      <nav className={styles.tabBar}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'ops'
        ? <OperationsView live={live} refreshTick={refreshTick} />
        : <LogsView live={live} refreshTick={refreshTick} />}
    </div>
  );
}
