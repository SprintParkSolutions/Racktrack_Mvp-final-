import { useLocation, useNavigate } from 'react-router-dom';
import styles from './RackChain.module.css';
import { getJSON } from '../utils/safeStorage';

/**
 * The chain: a rack as one job with steps, not a row of equal tabs.
 *
 *   Scan → Physical → Network → Compare → Review → Export → Report
 *
 * Each step knows whether it has run. A finished step carries a tick, the
 * one you are on is lit, and a step that cannot mean anything yet is locked
 * and says why. The order is the point: you cannot review disagreements
 * before the switches have been read, and you cannot export before someone
 * has settled them. Tabs said "go anywhere"; this says what comes next.
 *
 * Route-based on purpose. On a phone the rack's views are hash tabs inside
 * ResultsPage; on a desktop they are routes in the sidebar. A step that is a
 * route works in both, and the one step that IS an in-page tab (Physical =
 * the Overview) is handed to the caller through onStep so it can switch the
 * tab instead of navigating.
 *
 * `chainSteps` is exported on its own so the desktop sidebar can draw the same
 * steps in its own style: one definition, two renderings, no drift.
 */

const NETWORK_STATE = (rackId) => `rt_network_state_${rackId}`;

/** What the Network step last did for this rack, written by the Network page. */
export function networkState(rackId) {
  return rackId ? (getJSON(NETWORK_STATE(rackId), null) || null) : null;
}

// Which downstream steps have a page yet. Flipped as each lands; a step
// without one shows locked with "Coming next" rather than a broken link.
export const STEPS_READY = { report: false, export: false };

export function chainSteps(rackId, location, opts = {}) {
  const { reportReady = STEPS_READY.report, exportReady = STEPS_READY.export } = opts;
  const base = `/results/${encodeURIComponent(rackId)}`;
  const path = location?.pathname || '';
  const net = networkState(rackId);
  const netDone = Boolean(net && net.read > 0);

  const at = (p) => path === p;
  const stateFor = (p, done) => (at(p) ? 'current' : done ? 'done' : 'todo');

  // Scan → Physical → Network → Report → Export. Compare and Review return to
  // the chain when they are built; until then they would only be locked
  // entries between steps that work, which is noise.
  return [
    { key: 'scan', label: 'Scan', to: '/scan', state: 'done',
      hint: 'Photographed' },
    { key: 'physical', label: 'Physical', to: base, state: stateFor(base, true),
      hint: 'What the camera saw' },
    { key: 'network', label: 'Network', to: `${base}/network`, state: stateFor(`${base}/network`, netDone),
      hint: netDone ? `${net.read} read · ${net.up} up` : 'Read the switches' },
    { key: 'report', label: 'Report', to: reportReady ? `${base}/report` : null,
      state: reportReady ? stateFor(`${base}/report`, false) : 'locked',
      hint: reportReady ? 'Rack + network, one page' : 'Coming next' },
    { key: 'export', label: 'Export', to: exportReady ? `${base}/export` : null,
      state: exportReady ? stateFor(`${base}/export`, false) : 'locked',
      hint: exportReady ? 'To NetBox' : 'Coming next' },
  ];
}

export const Mark = ({ state, n }) => {
  if (state === 'done') {
    return (
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    );
  }
  if (state === 'locked') {
    return (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />
      </svg>
    );
  }
  return <span>{n}</span>;
};

/**
 * The strip. Horizontal, full width, scrolls if it must. `onStep(step)` may
 * return true to say "handled" (the Overview tab case); otherwise the step
 * navigates to its route.
 */
export default function RackChain({ rackId, onStep, reportReady, exportReady, className = '' }) {
  const location = useLocation();
  const navigate = useNavigate();
  const steps = chainSteps(rackId, location, { reportReady, exportReady });
  const done = steps.filter((s) => s.state === 'done').length;

  const go = (s) => {
    if (s.state === 'locked' || !s.to) return;
    if (onStep && onStep(s) === true) return;
    navigate(s.to);
  };

  return (
    <nav className={`${styles.chain} ${className}`} aria-label="Rack workflow">
      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={s.key} className={styles.item}>
            {i > 0 && <span className={`${styles.spine} ${steps[i - 1].state === 'done' ? styles.spineOn : ''}`} aria-hidden="true" />}
            <button
              type="button"
              className={`${styles.step} ${styles[s.state]}`}
              disabled={s.state === 'locked'}
              aria-current={s.state === 'current' ? 'step' : undefined}
              title={s.state === 'locked' ? `${s.label} — ${s.hint}` : s.label}
              onClick={() => go(s)}
            >
              <span className={styles.mark}><Mark state={s.state} n={i + 1} /></span>
              <span className={styles.text}>
                <span className={styles.label}>{s.label}</span>
                <span className={styles.hint}>{s.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <span className={styles.count} aria-label={`${done} of ${steps.length} steps done`}>{done}/{steps.length}</span>
    </nav>
  );
}
