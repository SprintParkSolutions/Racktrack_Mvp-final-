import { useEffect, useState } from 'react';
import styles from './Splash.module.css';

/**
 * The first thing the app shows: the mark, the name, and nothing else.
 *
 * It covers the screen while the app boots — restoring a session, loading the
 * first route — and then leaves. The timing is deliberate: long enough to read
 * as a considered opening rather than a flash, short enough that nobody waits
 * for it. It is also honest about what it is: it does not pretend to load
 * anything, so it never sits there after the app is ready.
 *
 * Rendered once per launch, above everything, and removed from the tree when
 * it is done rather than left as an invisible overlay swallowing taps.
 */
const HOLD_MS = 1250;     // on screen at full strength
const FADE_MS = 420;      // the dissolve

export default function Splash() {
  const [phase, setPhase] = useState('in');   // in → out → gone

  useEffect(() => {
    // Respect a device set to reduce motion: no dissolve, just get out of
    // the way quickly.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const hold = setTimeout(() => setPhase('out'), reduced ? 300 : HOLD_MS);
    const gone = setTimeout(() => setPhase('gone'), (reduced ? 300 : HOLD_MS) + (reduced ? 0 : FADE_MS));
    return () => { clearTimeout(hold); clearTimeout(gone); };
  }, []);

  if (phase === 'gone') return null;

  return (
    <div className={`${styles.splash} ${phase === 'out' ? styles.out : ''}`} aria-hidden="true">
      <div className={styles.mark}>
        <img src="/logo.jpg" alt="" width="112" height="112" />
      </div>
      <h1 className={styles.name}>RackTrack</h1>
      <span className={styles.rule} />
    </div>
  );
}
