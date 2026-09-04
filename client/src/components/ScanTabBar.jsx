import { useEffect, useRef, useState } from 'react';
import styles from './ScanTabBar.module.css';

// The rack's tab bar on a phone: Overview, Topology, Drift, and More.
//
// Ports is gone — the Network step reads the switches themselves over SNMP,
// which is what Ports was trying to do over SSH from a server that could never
// reach them. Network and Report are not tabs of this page: they are their own
// screens, reached from the buttons under the rack (Go to Network) and from
// Network's own footer, so the order of the work stays visible where the work
// is rather than as a menu to be decoded.
const PRIMARY_TABS = [
  { key: 'overview',  label: 'Overview',  icon: <IconRack /> },
  { key: 'topology',  label: 'Topology',  icon: <IconTopology /> },
  { key: 'drift',     label: 'Drift',     icon: <IconDrift /> },
];

const MORE_TABS = [
  { key: 'switches',  label: 'Switches',  icon: <IconSwitch /> },
  { key: 'network',   label: 'Discovery', icon: <IconNetwork /> },
];

export default function ScanTabBar({ activeTab, onTabChange, badges = {} }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  // Close the More sheet on outside click / Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const moreActive = MORE_TABS.some((t) => t.key === activeTab);
  const selectTab = (key) => { onTabChange(key); setMoreOpen(false); };

  return (
    <nav className={styles.tabBar} role="tablist" aria-label="Scan results tabs">
      <div className={styles.bar}>
        {PRIMARY_TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          const badge = badges[tab.key];
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
              onClick={() => selectTab(tab.key)}
              type="button"
            >
              <span className={styles.tabIcon}>{tab.icon}</span>
              <span className={styles.tabLabel}>{tab.label}</span>
              {badge != null && badge > 0 && <span className={styles.tabBadge}>{badge}</span>}
            </button>
          );
        })}

        <div className={styles.moreWrap} ref={moreRef}>
          <button
            role="tab"
            aria-selected={moreActive}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className={`${styles.tab} ${moreActive ? styles.tabActive : ''}`}
            onClick={() => setMoreOpen((o) => !o)}
            type="button"
          >
            <span className={styles.tabIcon}><IconMore /></span>
            <span className={styles.tabLabel}>More</span>
          </button>

          {moreOpen && (
            <div className={styles.moreSheet} role="menu">
              {MORE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  role="menuitem"
                  className={`${styles.moreItem} ${activeTab === tab.key ? styles.moreItemActive : ''}`}
                  onClick={() => selectTab(tab.key)}
                  type="button"
                >
                  <span className={styles.moreItemIcon}>{tab.icon}</span>
                  <span className={styles.moreItemLabel}>{tab.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Tab icons (20×20, clean stroke style) ───────────────────────

function IconRack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2"/>
      <line x1="8" y1="6" x2="16" y2="6"/>
      <line x1="8" y1="10" x2="16" y2="10"/>
      <line x1="8" y1="14" x2="16" y2="14"/>
      <line x1="8" y1="18" x2="16" y2="18"/>
    </svg>
  );
}

function IconTopology() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="6" rx="1.5"/>
      <rect x="2" y="16" width="6" height="6" rx="1.5"/>
      <rect x="16" y="16" width="6" height="6" rx="1.5"/>
      <path d="M12 8v4M5 16v-4h14v4"/>
    </svg>
  );
}

function IconNetwork() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/>
      <circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
      <line x1="7" y1="7" x2="10" y2="10"/><line x1="17" y1="7" x2="14" y2="10"/>
      <line x1="7" y1="17" x2="10" y2="14"/><line x1="17" y1="17" x2="14" y2="14"/>
    </svg>
  );
}

function IconSwitch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="5" rx="1.5"/>
      <rect x="2" y="10" width="20" height="5" rx="1.5"/>
      <rect x="2" y="17" width="20" height="5" rx="1.5"/>
      <circle cx="18" cy="5.5" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="12.5" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="19.5" r="1.2" fill="currentColor" stroke="none"/>
    </svg>
  );
}

function IconDrift() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h3v-5h4v-4h4v8h4v-3h3"/>
      <line x1="3" y1="21" x2="21" y2="21"/>
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5"  cy="12" r="1.6" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
  );
}
