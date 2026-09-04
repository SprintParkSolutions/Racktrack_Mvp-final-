import styles from './ScanTabBar.module.css';
import RackChain from './RackChain.jsx';

// The rack's bottom bar on a phone: the chain, and nothing else.
//
// It used to be four equal tabs with the rest behind More — where Network and
// Drift lived, and testers reported not knowing they existed. Now the bar IS
// the rack's menu: Overview → Network → Topology → Drift → Report, each step
// showing whether it has run. Nothing is behind a More button any more.
//
// activeTab / onTabChange are accepted for compatibility with ResultsPage but
// not needed: Overview and Drift are reached by URL (the bare rack path and
// #drift), which ResultsPage already turns into its tab.
export default function ScanTabBar({ rackId }) {
  return (
    <nav className={styles.tabBar} role="navigation" aria-label="Rack menu">
      <div className={styles.bar}>
        <div className={styles.chainWrap}>
          <RackChain rackId={rackId} className={styles.chainInBar} />
        </div>
      </div>
    </nav>
  );
}
