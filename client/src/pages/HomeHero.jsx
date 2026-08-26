import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import styles from './HomeHero.module.css';

/**
 * Home hero — one full-bleed frame: cold-aisle footage behind the claim.
 *
 * The page is the room. Footage fills the viewport edge to edge, the mark sits
 * on a hairline at the top, and the claim and its two actions are the only
 * other things on the screen.
 *
 * Portalled to <body> so it escapes #root's 540px frame and fills the viewport.
 */

const ArrowR = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
  </svg>
);

const ArrowUpR = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="7" y1="17" x2="17" y2="7" /><polyline points="8 7 17 7 17 16" />
  </svg>
);

/* A speech bubble with a single dot — reads as "ask" without needing the word,
   and the dot ties it to the assistant's name. Deliberately not a cartoon face:
   the bot's character is being replaced separately, and an icon that outlives
   that change is the safer thing to ship here. */
const DotMark = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
    <circle cx="12" cy="11.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export default function HomeHero() {
  const navigate = useNavigate();
  const auth = useAuth();
  const authed = auth?.isAuthed;
  const filmRef = useRef(null);

  /* The footage is the page's only motion, and it loops forever — which is
     exactly what "reduce motion" is asking us not to do. The poster frame is
     already the right image, so pausing leaves the design intact. Handled here
     rather than in CSS because `animation`/`transition` rules can't stop video
     playback. */
  useEffect(() => {
    const film = filmRef.current;
    if (!film) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => { if (mq.matches) film.pause(); else film.play?.().catch(() => {}); };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  return createPortal(
    <section className={styles.hero}>
      {/* Decorative: the room, not information. Muted + playsInline is what
          lets it autoplay on iOS at all; the poster is the still the old hero
          used, so a slow connection in an aisle still gets the right frame. */}
      <video
        ref={filmRef}
        className={styles.film}
        src="/racktrack-coldaisle.mp4"
        poster="/home-bg.jpg"
        autoPlay muted loop playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className={styles.scrim} aria-hidden="true" />

      <nav className={styles.nav}>
        <div className={styles.brand}>
          <img src="/logo.jpg" alt="" className={styles.mark} />
          <span className={styles.brandName}>RackTrack</span>
          <span className={styles.rule} aria-hidden="true" />
          <span className={styles.tag}>System of record</span>
        </div>
        <button
          type="button"
          className={styles.navBtn}
          onClick={authed ? () => { auth.logout(); navigate('/'); } : () => navigate('/login')}
        >
          {authed ? 'Sign out' : 'Sign in'}
        </button>
      </nav>

      <main className={styles.stage}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>
            <span className={styles.dot} aria-hidden="true" />
            Physical infrastructure · documented
          </p>

          {/* Broken by hand rather than left to wrap: the claim turns on the
              preposition, so the break falls there and the second half steps
              back a tone. Letting it wrap on its own would orphan a word
              somewhere different at every viewport width. */}
          <h1 className={styles.h1}>
            Turn infrastructure<br />
            <span className={styles.dim}>to intelligence</span>
          </h1>

          <p className={styles.lede}>
            RackTrack is the system of record for your physical infrastructure.
            Photograph a rack and <strong>every switch, patch panel, port and
            cable</strong> becomes a live inventory you can search - kept true
            across every site you run.
          </p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cta}
              onClick={() => navigate(authed ? '/scan' : '/login')}
            >
              {authed ? 'Start a scan' : 'Sign in'}
              <ArrowR />
            </button>
            {/* Signed in, the second action used to be "Past scans" → /history.
                It's gone: /history and the Profile page both listed the user's
                scans, so the app offered the same thing under two names and
                testers read them as one screen duplicated. Profile owns that
                list now, and it has a permanent slot in the phone's bottom bar,
                so nothing became harder to reach. Signed out, the second action
                still matters — it's how an organization gets created. */}
            {!authed && (
              <button
                type="button"
                className={styles.link}
                onClick={() => navigate('/signup')}
              >
                Create an organization
                <ArrowUpR />
              </button>
            )}
          </div>
        </div>
      </main>

      {/* Ask DOT, reachable from the home screen.
          Home is the one route mounted without the bottom nav, so until now it
          had no navigation of any kind — DOT lived behind a menu that isn't on
          this screen, and testers reported not knowing a support bot existed at
          all. A corner button is the standard place people look for help, and
          with no bottom bar here there is nothing for it to collide with; it
          still clears the iOS home indicator via safe-area-inset.
          Signed out it is hidden rather than disabled: /help is a protected
          route, so offering it would only bounce the user to the login page. */}
      {authed && (
        <button
          type="button"
          className={styles.askDot}
          onClick={() => navigate('/help')}
          aria-label="Ask DOT — get help"
          title="Ask DOT"
        >
          <DotMark />
          <span className={styles.askDotLabel}>Ask DOT</span>
        </button>
      )}
    </section>,
    document.body,
  );
}
