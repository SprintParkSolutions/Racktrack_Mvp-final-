import { useEffect, useRef } from 'react';
import { useIsDesktop } from '../hooks/useIsDesktop';
import styles from '../pages/AuthPages.module.css';

/**
 * The frame every auth page sits in.
 *
 * On a laptop the screen is split 57 / 43: footage of a real datacenter hall
 * on the left, the form on plain white to the right of a hard edge. On a phone
 * the footage drops away — it would only sit behind the keyboard — and the
 * form is the screen.
 *
 * Pages pass their form as children and never think about the chrome: the
 * mark, the one line of product copy, the back arrow and the contextual
 * top-right link all live here, so the five auth screens cannot drift apart
 * from each other.
 *
 * Note the class names in AuthPages.module.css deliberately avoid `panel`,
 * `card`, `tile` and `surface` — index.css matches those substrings and hands
 * anything wearing one a raised fill and a soft shadow.
 */

const ic = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round', strokeLinejoin: 'round',
};

export const IcEye = ({ off, ...p }) => off
  ? (<svg {...ic} {...p}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>)
  : (<svg {...ic} {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>);

export const IcAlert = (p) => (<svg {...ic} {...p} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>);
export const IcInfo  = (p) => (<svg {...ic} {...p} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>);

const IcBack = (p) => (<svg {...ic} width="18" height="18" strokeWidth="1.7" {...p}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>);

/**
 * @param {React.ReactNode} children   the form
 * @param {() => void} [onBack]        renders the back arrow when given
 * @param {string} [backLabel]
 * @param {React.ReactNode} [aside]    top-right slot (contextual link / stepper)
 */
export default function AuthLayout({ children, onBack, backLabel = 'Back', aside }) {
  // #root is capped at 540px and centred (index.css) — the frame that makes the
  // app feel like an app on a phone. On a desktop it would also render these
  // pages as a phone-width strip, so lift the cap for as long as an auth page
  // is mounted and put it back on the way out. The same class is what scopes
  // the flat-field rules in index.css to these pages.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.classList.add('rt-auth-wide');
    return () => root?.classList.remove('rt-auth-wide');
  }, []);

  // The footage is only ON SCREEN at ≥1024px — below that the form is the whole
  // page and .media is display:none. A hidden <video> still downloads, so this
  // decides in JS rather than CSS: a phone signing in over cell data must not
  // pull megabytes for something it will never show. useIsDesktop is the same
  // 1024px line the module CSS breaks on, so the two cannot drift.
  const wide = useIsDesktop();
  // And when it IS shown, "reduce motion" gets the poster frame instead of a
  // loop. CSS can't pause playback, so the ref does it.
  const film = useRef(null);
  useEffect(() => {
    const el = film.current;
    if (!el) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => { if (mq.matches) el.pause(); else el.play?.().catch(() => {}); };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [wide]);

  return (
    <div className={styles.authPage}>
      <div className={styles.media} aria-hidden="true">
        {/* Footage of a real hall, not a still. Decorative, so it is muted and
            silent by definition; muted + playsInline is also what lets it
            autoplay at all. The poster is the photograph it replaced, so a slow
            connection still gets the right frame — and so does anyone who asks
            for reduced motion, since the effect above pauses to it. The parent
            is aria-hidden, so none of this reaches the accessibility tree. */}
        {wide && (
          <video
            ref={film}
            className={styles.mediaImg}
            src="/racktrack-greenrow.mp4"
            poster="/hero-rack.jpg"
            autoPlay muted loop playsInline
            preload="auto"
            tabIndex={-1}
          />
        )}
        <div className={styles.mediaWash} />

        <div className={styles.mediaBrand}>
          <img src="/logo.jpg" alt="" className={styles.mediaMark} />
          <span className={styles.mediaName}>RackTrack</span>
        </div>

        {/* One claim and one sentence explaining how it is met. Anything more
            here is a landing page, and this is a sign-in screen. */}
        <div className={styles.mediaCopy}>
          <p className={styles.mediaTitle}>Know what's actually in the rack.</p>
          <p className={styles.mediaSub}>
            A photo returns the unit map, switch model, port layout and live
            port state - reconciled against the CMDB record.
          </p>
        </div>
      </div>

      <section className={styles.formSide}>
        {/* The mark rides the top bar rather than sitting above the heading:
            that bar is otherwise a back arrow and empty space, and the block
            it replaces was pushing the sign-in button under the fold on a
            phone. Above 1024px the photograph carries the mark instead. */}
        <header className={styles.topBar}>
          {onBack && (
            <button type="button" className={styles.backArrow} onClick={onBack} aria-label={backLabel}>
              <IcBack />
            </button>
          )}
          <div className={styles.brand}>
            <img src="/logo.jpg" alt="" className={styles.brandMark} />
            <span className={styles.brandName}>RackTrack</span>
          </div>
          {aside}
        </header>

        <div className={styles.formScroll}>
          <main className={styles.authShell}>
            {children}
          </main>
        </div>
      </section>
    </div>
  );
}

/** The "already have an account? / new here?" pair in the top-right slot. */
export function AuthAside({ text, children }) {
  return (
    <div className={styles.asideNote}>
      <span className={styles.asideText}>{text}</span>
      {children}
    </div>
  );
}
