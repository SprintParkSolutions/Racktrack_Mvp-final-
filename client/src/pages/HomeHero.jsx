import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import styles from './HomeHero.module.css';

/**
 * Home hero — a white frame with the claim on the left and a rack drawn on the
 * right.
 *
 * Replaces the full-bleed cold-aisle video. The footage was stock: it said
 * "data centre", not "RackTrack", and every word on the page had to be dropped
 * onto a scrim to stay readable, which is what made the screen feel heavy. The
 * rack here is drawn, so it is the product's own subject rather than a picture
 * of someone else's room, it costs no download, and it needs no scrim.
 *
 * One action. The bottom of the page used to carry a second "Sign in" and a
 * "Create an organization" link while the top bar already held Sign in — three
 * routes into two destinations, which testers read as clutter.
 *
 * Portalled to <body> so it escapes #root's 540px frame and fills the viewport.
 */

const ArrowR = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
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

  return createPortal(
    <section className={styles.hero}>
      {/* The room, as a photograph rather than a drawing. Decorative: the
          claim carries the meaning, and the wash over it in CSS takes it back
          to near-white so the page stays light and the type stays black. */}
      <div className={styles.film} aria-hidden="true" />
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
          {/* Broken by hand rather than left to wrap: the claim turns on the
              preposition, so the break falls there and the second half steps
              back a tone. Left to wrap it orphans a different word at every
              viewport width. */}
          <h1 className={styles.h1}>
            Turn infrastructure<br />
            <span className={styles.dim}>to intelligence</span>
          </h1>

          <p className={styles.lede}>
            Photograph a rack. Every switch, port and cable becomes a record you can search.
          </p>

          <button
            type="button"
            className={styles.cta}
            onClick={() => navigate(authed ? '/scan' : '/login')}
          >
            {authed ? 'Start a scan' : 'Get started'}
            <ArrowR />
          </button>
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
          aria-label="Ask DOT - get help"
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
