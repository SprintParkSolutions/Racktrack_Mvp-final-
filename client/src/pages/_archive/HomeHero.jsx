import { createPortal } from 'react-dom';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import styles from './HomeHero.module.css';

/**
 * Home — built to the owner's second reference: a centred serif claim over a
 * rounded photographic card, on a pale ground.
 *
 * Portalled to <body> so it escapes #root's 540px frame and fills the viewport.
 */

const MenuGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </svg>
);

const PersonGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const SlidersGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <line x1="4" y1="8" x2="20" y2="8" /><circle cx="10" cy="8" r="2.2" />
    <line x1="4" y1="16" x2="20" y2="16" /><circle cx="16" cy="16" r="2.2" />
  </svg>
);

const CameraGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8a2 2 0 0 1 2-2h2.2l1.3-2h6l1.3 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </svg>
);

export default function HomeHero() {
  const navigate = useNavigate();
  const auth = useAuth();
  const authed = auth?.isAuthed;
  const [menuOpen, setMenuOpen] = useState(false);

  const go = (to) => () => { setMenuOpen(false); navigate(to); };

  return createPortal(
    <section className={styles.hero}>
      <header className={styles.bar}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          <MenuGlyph />
        </button>

        <div className={styles.brandBlock}>
          <span className={styles.brandName}>RackTrack</span>
          <span className={styles.tagline}>System of record</span>
        </div>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={authed ? go('/profile') : go('/login')}
          aria-label={authed ? 'Your profile' : 'Sign in'}
        >
          <PersonGlyph />
        </button>
      </header>

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
                >Sign out</button>
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
        <p className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          Physical infrastructure
        </p>

        <h1 className={styles.h1}>Your Datacenter</h1>

        <p className={styles.lede}>
          One simple view of your physical infrastructure.
        </p>

        <figure className={styles.plate}>
          <img className={styles.shot} src="/home-aisle.jpg" alt="" />
          <figcaption className={styles.caption}>
            <span className={styles.captionHead}>Every rack, every port</span>
            <span className={styles.captionSub}>Read from one photograph</span>
          </figcaption>
        </figure>

        <div className={styles.metaRow}>
          <span className={styles.meta}><CameraGlyph /> Photograph a rack</span>
          <span className={styles.metaDot} aria-hidden="true" />
          <span className={styles.meta}><SlidersGlyph /> Searchable inventory</span>
        </div>

        <button
          type="button"
          className={styles.cta}
          onClick={() => navigate(authed ? '/scan' : '/login')}
        >
          {authed ? 'Start a scan' : 'Get started'}
        </button>
      </main>
    </section>,
    document.body,
  );
}
