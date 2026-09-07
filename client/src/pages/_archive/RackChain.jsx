import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styles from './RackChain.module.css';
import { getJSON } from '../utils/safeStorage';

/**
 * A rack's menu after the scan, as a chain:
 *
 *   Overview → Network → Topology → Drift → Report
 *
 * Overview is what the camera saw. Network is the live switches, read from the
 * phone over SNMP. Topology and Drift are views of both. Report puts rack and
 * network on one page and carries the Export button. Each step shows whether
 * it has run: a finished step carries a tick, the one you are on is lit, and a
 * step that cannot mean anything yet is locked and says why.
 *
 * Route-based on purpose. On a phone the Overview and Drift are hash views of
 * ResultsPage; on a desktop everything is a sidebar route. A step that is a
 * URL works in both — ResultsPage already reads its tab from the hash, so
 * navigating to `#drift` or to the bare rack path is enough.
 *
 * `chainSteps` is exported on its own so the desktop sidebar can draw the same
 * steps in its own style: one definition, two renderings, no drift.
 */

const NETWORK_STATE = (rackId) => `rt_network_state_${rackId}`;

/** What the Network step last did for this rack, written by the Network page. */
export function networkState(rackId) {
  return rackId ? (getJSON(NETWORK_STATE(rackId), null) || null) : null;
}

/** Which steps have a page yet; a step without one shows locked, not broken. */
export const STEPS_READY = { report: true };

export function chainSteps(rackId, location, opts = {}) {
  const { reportReady = STEPS_READY.report } = opts;
  const base = `/results/${encodeURIComponent(rackId)}`;
  const path = location?.pathname || '';
  const hash = (location?.hash || '').toLowerCase();
  const net = networkState(rackId);
  const netDone = Boolean(net && net.read > 0);
  const onBase = path === base;
  const cur = (p) => (path === p ? 'current' : 'todo');

  return [
    { key: 'overview', label: 'Overview', to: base,
      state: onBase && hash !== '#drift' ? 'current' : 'done',
      hint: 'What the camera saw' },
    { key: 'network', label: 'Network', to: `${base}/network`,
      state: path === `${base}/network` ? 'current' : netDone ? 'done' : 'todo',
      hint: netDone ? `${net.read} switch${net.read === 1 ? '' : 'es'} · ${net.up} up` : 'Read the switches' },
    { key: 'topology', label: 'Topology', to: `${base}/topology`,
      state: cur(`${base}/topology`), hint: 'Cables and layout' },
    { key: 'drift', label: 'Drift', to: `${base}#drift`,
      state: onBase && hash === '#drift' ? 'current' : 'todo', hint: 'What changed' },
    { key: 'report', label: 'Report', to: reportReady ? `${base}/report` : null,
      state: reportReady ? cur(`${base}/report`) : 'locked',
      hint: reportReady ? 'Rack + network · export' : 'Coming next' },
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

/** The strip. Horizontal, full width, scrolls sideways if it must. */
export default function RackChain({ rackId, className = '' }) {
  const location = useLocation();
  const navigate = useNavigate();
  const steps = chainSteps(rackId, location);
  const currentKey = steps.find((s) => s.state === 'current')?.key || null;
  const currentEl = useRef(null);

  // Five steps fit a 390px phone; on a narrower one the strip scrolls, so
  // bring the step you are on into view rather than leaving it off the edge.
  useEffect(() => {
    currentEl.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [currentKey]);

  return (
    <nav className={`${styles.chain} ${className}`} aria-label="Rack menu">
      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={s.key} className={styles.item}>
            {i > 0 && <span className={`${styles.spine} ${steps[i - 1].state === 'done' ? styles.spineOn : ''}`} aria-hidden="true" />}
            <button
              type="button"
              ref={s.key === currentKey ? currentEl : undefined}
              className={`${styles.step} ${styles[s.state]}`}
              disabled={s.state === 'locked' || !s.to}
              aria-current={s.state === 'current' ? 'step' : undefined}
              title={s.state === 'locked' ? `${s.label} — ${s.hint}` : s.label}
              onClick={() => s.to && navigate(s.to)}
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
    </nav>
  );
}
