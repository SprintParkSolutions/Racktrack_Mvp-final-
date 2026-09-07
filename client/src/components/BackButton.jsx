import { useSmartBack } from '../hooks/useSmartBack';
import styles from './BackButton.module.css';

/**
 * The back arrow, on its own.
 *
 * Exported because several pages render their own button — a header where the
 * control is one of three items in a row, not a standalone control — and they
 * were each drawing a bare chevron while this component drew an arrow with a
 * tail. Two different marks for the same action, on adjacent screens. One mark
 * now, wherever it is drawn.
 */
export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

/**
 * A back control for pages that are reachable both as a destination and from
 * somewhere deeper in the app.
 *
 * Scan, Profile, Marketplace and the Console had no back affordance at all —
 * fine when you tap them in the nav, a dead end when you arrive from a link
 * inside another page, which is what testers were hitting.
 *
 * By default it renders nothing when there is no previous entry, so a page
 * you opened directly from the nav does not grow a back arrow that would
 * either do nothing or throw you somewhere you were never coming from. Pass
 * `always` for pages that are only ever reached from somewhere else.
 */
export default function BackButton({ fallback = '/', always = false, label = 'Back', className = '', onBack = null }) {
  const goBack = useSmartBack(fallback);
  // `onBack` is for the pages whose "back" is a state change rather than a
  // navigation — the org console steps out of an open organization into the
  // list without touching history. They used to hand-roll their own button for
  // that, which is how the app ended up with three back controls that looked
  // different from each other. Passing the behaviour in keeps one control.
  const handle = onBack || goBack;

  // React Router stamps its stack position on history.state.idx; 0 or null
  // means this is the first entry and there is nothing behind it.
  const idx = typeof window !== 'undefined' && window.history.state
    ? window.history.state.idx : null;
  const hasHistory = typeof idx === 'number' && idx > 0;
  // `always` still renders the control on pages that are only ever reached
  // from somewhere else, even on a cold start — it falls back to the given
  // route in that case rather than doing nothing.
  // A page-local back (onBack) is always meaningful — there is somewhere to go
  // by definition — so the history check only governs the navigating kind.
  if (!onBack && !always && !hasHistory) return null;

  return (
    <button
      type="button"
      onClick={handle}
      className={`${styles.back} ${className}`}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
    </button>
  );
}
