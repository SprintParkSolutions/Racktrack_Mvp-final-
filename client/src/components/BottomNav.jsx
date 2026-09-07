import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import styles from './BottomNav.module.css';
import { useShutter } from '../ShutterContext.jsx';
import { useAuth } from '../AuthContext.jsx';
import { usePrimaryNav, MoreIcon } from '../nav/navLinks.jsx';
import MoreSheet from './MoreSheet.jsx';
import ScanTabBar from './ScanTabBar.jsx';

/* ──────────────────────────────────────────────────────────────────────
   BottomNav — the phone navigation: HOME / SCAN / MORE / PROFILE.

   The three permanent slots come from the shared destination list in
   nav/navLinks.jsx, and MORE opens a sheet with everything else that list
   contains. This used to be three hardcoded constants while the sidebar
   built eight role-gated links, which is how Lab and Marketplace ended up
   with no tappable route on a phone at all.
   ────────────────────────────────────────────────────────────────────── */

/**
 * Inside a rack, the bar is the rack's own tabs.
 *
 * The results page renders that bar itself; its sub-pages — Network, Report,
 * Topology and the rest — are separate routes, and they used to fall through
 * to the app's navigation instead. Tapping Network therefore swapped the whole
 * bottom bar underneath you, which is exactly the kind of thing that makes an
 * app feel like several apps. Same bar on every page of a rack.
 */
function RackTabs({ rackId, pathname, hash }) {
  const navigate = useNavigate();
  const active = pathname.endsWith('/network') ? 'network'
    : pathname.endsWith('/report') ? 'report'
      : pathname.endsWith('/topology') ? 'topology'
        : pathname.startsWith('/switch-info') ? 'switches'
          : hash === '#drift' ? 'drift'
            : 'overview';
  const base = `/results/${encodeURIComponent(rackId)}`;
  const go = (key) => navigate(
    key === 'overview' ? base
      : key === 'drift' ? `${base}#drift`
        : key === 'switches' ? `/switch-info/${encodeURIComponent(rackId)}`
          : `${base}/${key}`,
  );
  return <ScanTabBar rackId={rackId} activeTab={active} onTabChange={go} />;
}

export default function BottomNav() {
  const { fn: shutterFn, canShoot } = useShutter();
  const { isAuthed } = useAuth();
  const links = usePrimaryNav();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  if (!isAuthed) return null;

  // A rack's own pages keep the rack's tabs. (/results/:rackId itself draws
  // them inside the page, so it never reaches here.)
  const rack = location.pathname.match(/^\/(?:results|switch-info)\/([^/]+)/);
  if (rack) {
    return (
      <RackTabs
        rackId={decodeURIComponent(rack[1])}
        pathname={location.pathname}
        hash={location.hash}
      />
    );
  }

  const barLinks = links.filter((l) => l.inBar);
  const overflow = links.filter((l) => !l.inBar);

  // While the camera viewfinder is live on the Scan page, ScanPage registers
  // a shutter handler. We hijack the SCAN tab onClick to fire it instead of
  // navigating, so the user can capture without losing this nav.
  const handleScanClick = (e) => {
    if (typeof shutterFn === 'function') {
      e.preventDefault();
      if (canShoot) shutterFn();
    }
  };

  // Highlight MORE while the user is actually on one of the pages it holds,
  // so the bar never looks like nothing is selected.
  const onOverflowPage = overflow.some(
    (l) => location.pathname === l.to || location.pathname.startsWith(l.to + '/'),
  );

  const tab = (l) => (
    <NavLink
      key={l.to}
      to={l.to}
      end={l.end}
      onClick={l.to === '/scan' ? handleScanClick : undefined}
      className={({ isActive }) => `${styles.tab} ${isActive && !moreOpen ? styles.active : ''}`}
    >
      <span className={styles.icon} aria-hidden="true">{l.icon}</span>
      {/* barLabel lets a destination carry a shorter name in the bar than in
          the sidebar, where there is room for the full one. */}
      <span className={styles.label}>{(l.barLabel || l.label).toUpperCase()}</span>
      <span className={styles.dot} aria-hidden="true" />
    </NavLink>
  );

  return (
    <>
      <nav className={styles.nav}>
        <div className={styles.bar}>
          {/* Menu sits LAST, not in the middle. Wedged between Scan and
              Profile it read as a peer destination and pushed Profile out of
              the corner people reach for. It is also "Menu", not "More" — the
              rack results screen has its own More tab, and two different More
              buttons on adjacent screens is a naming collision. */}
          {barLinks.map(tab)}

          {overflow.length > 0 && (
            <button
              type="button"
              className={`${styles.tab} ${moreOpen || onOverflowPage ? styles.active : ''}`}
              onClick={() => setMoreOpen((o) => !o)}
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
            >
              <span className={styles.icon} aria-hidden="true"><MoreIcon /></span>
              <span className={styles.label}>MENU</span>
              <span className={styles.dot} aria-hidden="true" />
            </button>
          )}
        </div>
      </nav>

      {moreOpen && <MoreSheet links={overflow} onClose={() => setMoreOpen(false)} />}
    </>
  );
}
