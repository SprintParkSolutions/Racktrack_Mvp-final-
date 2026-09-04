import { useEffect, useRef, useState } from 'react';
import styles from './ScanTabBar.module.css';
import RackChain from './RackChain.jsx';

// The rack's bottom bar on a phone.
//
// It used to be four equal tabs (Overview, Switches, Ports, Topology) with the
// rest behind More — where Network and Drift lived, and testers reported not
// knowing they existed. Now the bar IS the chain: Scan → Physical → Network →
// Compare → Review → Export → Report, each step showing whether it has run.
// The views that are not steps — things you look at rather than complete —
// sit behind More: Topology, Switches, Discovery, Drift, and the old Ports.
//
// Physical is the one step that is an in-page tab (the Overview) rather than a
// route, so it switches the tab through onTabChange; everything else navigates.

const MORE_TABS = [
  { key: 'topology',  label: 'Topology',  icon: <IconTopology /> },
  { key: 'switches',  label: 'Switches',  icon: <IconSwitch /> },
  { key: 'network',   label: 'Discovery', icon: <IconNetwork /> },
  { key: 'drift',     label: 'Drift',     icon: <IconDrift /> },
  { key: 'ports',     label: 'Ports',     icon: <IconPorts /> },
];

export default function ScanTabBar({ rackId, activeTab, onTabChange }) {
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

  const selectTab = (key) => {
    onTabChange(key);
    setMoreOpen(false);
  };

  // Physical = the Overview tab of the page we are already on.
  const onStep = (step) => {
    if (step.key === 'physical') { selectTab('overview'); return true; }
    return false;
  };

  return (
    <nav className={styles.tabBar} role="navigation" aria-label="Rack workflow">
      <div className={styles.bar}>
        <div className={styles.chainWrap}>
          <RackChain rackId={rackId} onStep={onStep} className={styles.chainInBar} />
        </div>

        {/* More — opens a sheet anchored above this button */}
        <div className={styles.moreWrap} ref={moreRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className={`${styles.tab} ${moreActive ? styles.tabActive : ''}`}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span className={styles.tabIcon}><IconMore /></span>
            <span className={styles.tabLabel}>More</span>
          </button>

          {moreOpen && (
            <div className={styles.moreSheet} role="menu">
              {MORE_TABS.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    role="menuitem"
                    className={`${styles.moreItem} ${isActive ? styles.moreItemActive : ''}`}
                    onClick={() => selectTab(tab.key)}
                    type="button"
                  >
                    <span className={styles.moreItemIcon}>{tab.icon}</span>
                    <span className={styles.moreItemLabel}>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Icons (20×20, clean stroke style) ───────────────────────────

function IconPorts() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2.5"/>
      <line x1="6" y1="10" x2="6" y2="14"/>
      <line x1="10" y1="10" x2="10" y2="14"/>
      <line x1="14" y1="10" x2="14" y2="14"/>
      <line x1="18" y1="10" x2="18" y2="14"/>
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
      <circle cx="5" cy="5" r="2"/>
      <circle cx="19" cy="5" r="2"/>
      <circle cx="5" cy="19" r="2"/>
      <circle cx="19" cy="19" r="2"/>
      <line x1="7" y1="7" x2="10" y2="10"/>
      <line x1="17" y1="7" x2="14" y2="10"/>
      <line x1="7" y1="17" x2="10" y2="14"/>
      <line x1="17" y1="17" x2="14" y2="14"/>
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
