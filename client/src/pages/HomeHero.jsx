import { createPortal } from 'react-dom';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import styles from './HomeHero.module.css';

/**
 * Home hero — white room, wordmark, one claim.
 *
 * Built to the reference the owner supplied: a bright aisle photograph running
 * off the top-right corner and dissolving into the page, a letterspaced
 * eyebrow, a large claim with a blue full stop, a grey line under it, and a
 * text link rather than a filled button. No panels, no cards, no shadows — the
 * white IS the design, and the photograph is the only mass on the page.
 *
 * Portalled to <body> so it escapes #root's 540px frame and fills the viewport.
 */

const ArrowR = () => (
  <svg width="26" height="12" viewBox="0 0 26 12" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="0" y1="6" x2="24" y2="6" /><polyline points="19 1 24 6 19 11" />
  </svg>
);

/* A speech bubble with a single dot — reads as "ask" without needing the word,
   and the dot ties it to the assistant's name. */
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
  const [menuOpen, setMenuOpen] = useState(false);

  /* The reference puts a hamburger where the Sign in button used to be. It
     cannot just BE sign-in — a hamburger that fires a navigation is a lie — so
     it opens the two or three destinations this screen actually has. Sign in
     stays one tap from the top of the page either way. */
  const go = (to) => () => { setMenuOpen(false); navigate(to); };

  return createPortal(
    <section className={styles.hero}>
      {/* The room. Decorative: the claim carries the meaning. */}
      <div className={styles.film} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />

      <nav className={styles.nav}>
        <button type="button" className={styles.brand} onClick={go('/')}>
          RackTrack<span className={styles.stop}>.</span>
        </button>

        <button
          type="button"
          className={styles.burger}
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          <span /><span /><span />
        </button>
      </nav>

      {menuOpen && (
        <>
          <div className={styles.menuScrim} onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className={styles.menu} role="menu">
            {authed ? (
              <>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={go('/scan')}>Start a scan</button>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={go('/profile')}>Your scans</button>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={go('/help')}>Ask DOT</button>
                <button
                  type="button" role="menuitem" className={styles.menuItem}
                  onClick={() => { setMenuOpen(false); auth.logout(); navigate('/'); }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={go('/login')}>Sign in</button>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={go('/signup')}>Create an organization</button>
              </>
            )}
          </div>
        </>
      )}

      <main className={styles.stage}>
        <p className={styles.eyebrow}>See it. Understand it. Manage it.</p>

        <h1 className={styles.h1}>
          Know your<br />
          infrastructure<span className={styles.stop}>.</span>
        </h1>

        <p className={styles.lede}>
          RackTrack gives you complete visibility of every rack, device, port
          and connection across your data center.
        </p>

        <button
          type="button"
          className={styles.cta}
          onClick={() => navigate(authed ? '/scan' : '/login')}
        >
          {authed ? 'Start a scan' : 'Get started'}
          <ArrowR />
        </button>
      </main>

      {/* Ask DOT stays: home is the one route without the bottom nav, and
          testers reported not knowing the assistant existed at all. Hidden
          signed out, because /help is a protected route. */}
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
