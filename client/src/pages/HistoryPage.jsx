import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './HistoryPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import BackButton from '../components/BackButton.jsx';
import { HeaderActions } from '../components/ShellHeader.jsx';
import Icon from '../components/Icon';
import AssetImg from '../components/AssetImg';

/**
 * Scan history — the full archive, on its own page.
 *
 * Profile shows the five most recent scans; "View all" used to expand that
 * list in place, which on an account with a hundred racks turned the profile
 * into one endless scroll with no way to find a particular rack. This page is
 * the destination instead: the same /api/scans data, but searchable, filtered
 * by age, sorted, grouped by day and cut into fixed pages so the list always
 * ends on a screen and the pager is what moves you, not the scrollbar.
 *
 * One markup, two layouts: a phone gets stacked rows (thumbnail, rack, counts
 * on a meta line), a tablet or desktop gets the same rows as aligned columns
 * under a header strip. The numeric cells and the phone meta line are exact
 * alternates — at any width exactly one of the two is in the DOM's a11y tree.
 */

// Deliberately small: the point of this page is that a page ENDS. Twelve rows
// fit a phone screen and a desktop column without scrolling far.
// A gallery page, so this is tiles-per-page: 18 fills two rows of nine on a
// wide screen and three rows of six on a phone, and still ENDS.
const PAGE_SIZE = 18;

const RANGES = [
  { key: 'all', label: 'All time', days: null },
  { key: '7d',  label: '7 days',   days: 7 },
  { key: '30d', label: '30 days',  days: 30 },
  { key: '90d', label: '90 days',  days: 90 },
];

const SORTS = [
  { key: 'recent', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'rack',   label: 'Rack ID' },
];

const DAY_MS = 86400000;

function time(d) {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return isNaN(t) ? 0 : t;
}

function formatRelative(d) {
  const t = time(d);
  if (!t) return '-';
  const ms = Date.now() - t;
  if (ms < 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Wall-clock time of day — the precise half of "3d ago".
function formatClock(d) {
  const t = time(d);
  if (!t) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Local calendar day, so a scan at 23:50 and one at 00:10 land in different
// groups the way the person who took them remembers it.
function dayKey(d) {
  const t = time(d);
  if (!t) return 'unknown';
  const x = new Date(t);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
}

function dayLabel(d) {
  const t = time(d);
  if (!t) return 'Undated';
  const day  = new Date(t); day.setHours(0, 0, 0, 0);
  const today = new Date();  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(undefined, {
    weekday: diff < 7 ? 'long' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
}

// 1 … 4 5 6 … 20 — never more than seven controls, however deep the archive,
// and always three numbers in the middle: at the ends the window slides inward
// instead of collapsing (page 1 of 8 shows 1 2 3 4 … 8, not 1 2 … 8).
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  let start, end;
  if (current <= 3)             { start = 2;         end = 4; }
  else if (current >= total - 2) { start = total - 3; end = total - 1; }
  else                           { start = current - 1; end = current + 1; }
  const out = [1];
  if (start > 2) out.push('gap-start');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push('gap-end');
  out.push(total);
  return out;
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [rangeKey, setRangeKey] = useState('all');
  const [sortKey, setSortKey] = useState('recent');
  const [page, setPage] = useState(1);
  const listTop = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(apiUrl('/api/scans'))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => { if (!cancelled) { setScans(data.scans || []); setError(null); } })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Any change to what's being listed puts you back on page 1 — otherwise a
  // search that narrows 90 scans to 3 leaves you on page 5, looking at nothing.
  useEffect(() => { setPage(1); }, [query, rangeKey, sortKey]);

  const totals = useMemo(() => scans.reduce((acc, s) => ({
    devices: acc.devices + (s.deviceCount || 0),
    ports:   acc.ports   + (s.portCount   || 0),
  }), { devices: 0, ports: 0 }), [scans]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const days = RANGES.find(r => r.key === rangeKey)?.days;
    const cutoff = days ? Date.now() - days * DAY_MS : null;
    const out = scans.filter(s => {
      if (term && !String(s.rackId || '').toLowerCase().includes(term)) return false;
      if (cutoff && time(s.timestamp) < cutoff) return false;
      return true;
    });
    const by = {
      recent: (a, b) => time(b.timestamp) - time(a.timestamp),
      oldest: (a, b) => time(a.timestamp) - time(b.timestamp),
      // Natural order, so RK-9 sorts before RK-10 rather than after it.
      rack:   (a, b) => String(a.rackId).localeCompare(String(b.rackId), undefined, { numeric: true }),
    }[sortKey];
    return out.sort(by);
  }, [scans, query, rangeKey, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current   = Math.min(page, pageCount);
  const from      = (current - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(from, from + PAGE_SIZE);

  // Day headings only make sense while the gallery is IN day order — sorting
  // by rack ID would otherwise scatter one day across the page. Every tile
  // still carries both its date and its ID, so nothing is lost when the
  // headings go.
  const byDay  = sortKey === 'recent' || sortKey === 'oldest';
  const groups = useMemo(() => {
    if (!byDay) return [{ key: 'flat', label: null, items: pageItems }];
    const out = [];
    const seen = new Map();
    for (const s of pageItems) {
      const k = dayKey(s.timestamp);
      if (!seen.has(k)) { seen.set(k, out.length); out.push({ key: k, label: dayLabel(s.timestamp), items: [] }); }
      out[seen.get(k)].items.push(s);
    }
    return out;
  }, [pageItems, byDay]);

  const goToPage = (n) => {
    setPage(n);
    // Land at the top of the list, not wherever the previous page's row 12 was.
    listTop.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const openScan = (rackId) => navigate(`/results/${rackId}`);
  const filtering = query.trim() !== '' || rangeKey !== 'all';

  return (
    <div className={`page page-full ${styles.history}`}>
      {/* Desktop: the shell header already says "Scan history", so only the
          New scan action portals up. No-op on a phone, which uses the bar
          below instead. */}
      <HeaderActions>
        <button className={styles.newScanBtn} onClick={() => navigate('/scan')}>New scan</button>
      </HeaderActions>

      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <BackButton fallback="/profile" always />
          <h1 className={styles.topbarTitle}>Scan history</h1>
        </div>
        <span className={styles.countPill}>{scans.length}</span>
      </header>

      <main className={styles.main}>
        {/* ── One panel: the archive's totals over the controls that narrow
             it. They were two floating strips with a lake of white between
             them; as a single surface the band reads as one instrument and
             the four totals can spread the full width instead of huddling
             on the left. ── */}
        <section className={styles.panel}>
        <div className={styles.stats} aria-label="Totals">
          <div className={styles.stat}>
            <span className={styles.statValue}>{scans.length}</span>
            <span className={styles.statLabel}>Scans</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{totals.devices}</span>
            <span className={styles.statLabel}>Devices</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{totals.ports}</span>
            <span className={styles.statLabel}>Ports</span>
          </div>
          <div className={styles.stat}>
            <span className={`${styles.statValue} ${styles.statValueWord}`}>
              {scans.length ? formatRelative(scans[0].timestamp) : '-'}
            </span>
            <span className={styles.statLabel}>Last scan</span>
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.searchWrap}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              type="search"
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rack ID"
              aria-label="Search scans by rack ID"
              /* Chrome draws its own autofill chevron inside a text field that
                 has saved entries — a stray control in the middle of the
                 toolbar that isn't ours. */
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setQuery('')}
                aria-label="Clear search">
                <Icon name="close" />
              </button>
            )}
          </div>

          <div className={styles.chips} role="group" aria-label="Filter by age">
            {RANGES.map(r => (
              <button
                key={r.key}
                type="button"
                className={`${styles.chip} ${rangeKey === r.key ? styles.chipOn : ''}`}
                aria-pressed={rangeKey === r.key}
                onClick={() => setRangeKey(r.key)}>
                {r.label}
              </button>
            ))}
          </div>

          <label className={styles.sortWrap}>
            <span className={styles.sortLabel}>Sort</span>
            <select
              className={styles.sort}
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}>
              {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        </div>
        </section>

        {error && <div className={styles.errBanner}>{error}</div>}

        <div className={styles.resultLine} ref={listTop} aria-live="polite">
          {loading ? 'Loading scans…'
            : filtered.length === 0 ? 'No matching scans'
            : `Showing ${from + 1}-${Math.min(from + PAGE_SIZE, filtered.length)} of ${filtered.length}${filtering ? ' matching' : ''} scan${filtered.length === 1 ? '' : 's'}`}
        </div>

        {loading && (
          <ul className={styles.grid} aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className={styles.skeletonTile}>
                <span className={styles.skeletonFrame} />
                <span className={styles.skeletonBar} />
              </li>
            ))}
          </ul>
        )}

        {!loading && filtered.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}><Icon name="history" /></div>
            {scans.length === 0 ? (
              <>
                <p className={styles.emptyTitle}>No scans yet</p>
                <p className={styles.emptyText}>Scanned racks land here - every one you capture, kept.</p>
                <button className={styles.startBtn} onClick={() => navigate('/scan')}>Start your first scan</button>
              </>
            ) : (
              <>
                <p className={styles.emptyTitle}>Nothing matches</p>
                <p className={styles.emptyText}>No scan matches that search in this time range.</p>
                <button
                  className={styles.clearFilters}
                  onClick={() => { setQuery(''); setRangeKey('all'); }}>
                  Clear filters
                </button>
              </>
            )}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <>
            {groups.map(group => (
              <section key={group.key} className={styles.group}>
                {group.label && (
                  <div className={styles.groupHead}>
                    <span className={styles.groupDot} aria-hidden="true" />
                    <h2 className={styles.groupLabel}>{group.label}</h2>
                    <span className={styles.groupRule} aria-hidden="true" />
                    <span className={styles.groupCount}>
                      {group.items.length} scan{group.items.length === 1 ? '' : 's'}
                    </span>
                  </div>
                )}
                {/* The gallery. A tile is the scan's own photograph, captioned
                    with the two things that identify it: the rack ID and when
                    it was taken. No metric columns — the counts belong on the
                    scan's own page, not repeated across a wall of thumbnails. */}
                <ul className={styles.grid}>
                  {group.items.map((s, i) => (
                    <li
                      key={s.rackId}
                      className={styles.tile}
                      /* Staggers the tiles in as a page lands — 18ms apart, so
                         it reads as one movement rather than eighteen. */
                      style={{ '--i': i }}
                      role="button"
                      tabIndex={0}
                      onClick={() => openScan(s.rackId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openScan(s.rackId); }
                      }}>
                      <div className={`${styles.frame} ${s.image ? '' : styles.frameEmpty}`}>
                        {s.image
                          ? <AssetImg path={s.image} alt="" loading="lazy" />
                          : <Icon name="rack" className={styles.framePlaceholder} />}
                        {s.qualityWarning && (
                          <span className={styles.warnChip}>Image quality</span>
                        )}
                      </div>

                      <div className={styles.caption}>
                        <h3 className={styles.rackId}>{s.rackId}</h3>
                        {/* Under a day heading the date would just repeat it,
                            so grouped tiles carry the clock time alone and the
                            flat (Rack ID) sort carries the full date. */}
                        <p className={styles.stamp}>
                          {!byDay && <span className={styles.stampDay}>{dayLabel(s.timestamp)}</span>}
                          <span className={styles.stampTime}>{formatClock(s.timestamp)}</span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {pageCount > 1 && (
              <nav className={styles.pager} aria-label="Scan history pages">
                <button
                  type="button"
                  className={styles.pageArrow}
                  onClick={() => goToPage(current - 1)}
                  disabled={current === 1}
                  aria-label="Previous page">
                  <Icon name="chevron_left" />
                </button>

                <div className={styles.pageNums}>
                  {pageWindow(current, pageCount).map(n =>
                    typeof n === 'number' ? (
                      <button
                        key={n}
                        type="button"
                        className={`${styles.pageNum} ${n === current ? styles.pageNumOn : ''}`}
                        aria-current={n === current ? 'page' : undefined}
                        onClick={() => goToPage(n)}>
                        {n}
                      </button>
                    ) : (
                      <span key={n} className={styles.pageGap} aria-hidden="true">…</span>
                    )
                  )}
                </div>

                <button
                  type="button"
                  className={styles.pageArrow}
                  onClick={() => goToPage(current + 1)}
                  disabled={current === pageCount}
                  aria-label="Next page">
                  <Icon name="chevron_right" />
                </button>
              </nav>
            )}
          </>
        )}
      </main>
    </div>
  );
}
