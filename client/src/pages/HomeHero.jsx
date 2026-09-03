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

/* The subject of the product, drawn rather than photographed: a 12U elevation
   with two switches, a patch panel, servers and a PDU — the same classes the
   scanner labels. Line art at one weight, one blue accent on the ports of the
   device a scan would key on. Decorative: the claim beside it carries the
   meaning, so it is hidden from assistive tech. */
const RackFigure = () => (
  <svg className={styles.rackArt} viewBox="0 0 260 400" fill="none" aria-hidden="true"
       xmlns="http://www.w3.org/2000/svg">
    {/* frame */}
    <rect x="24" y="16" width="212" height="368" rx="7" stroke="currentColor" strokeWidth="2" />
    <line x1="42" y1="16" x2="42" y2="384" stroke="currentColor" strokeWidth="1" opacity=".28" />
    <line x1="218" y1="16" x2="218" y2="384" stroke="currentColor" strokeWidth="1" opacity=".28" />
    {/* rack-unit ticks down both rails */}
    {Array.from({ length: 12 }).map((_, i) => (
      <g key={i} opacity=".3">
        <line x1="30" y1={40 + i * 29} x2="36" y2={40 + i * 29} stroke="currentColor" strokeWidth="1.5" />
        <line x1="224" y1={40 + i * 29} x2="230" y2={40 + i * 29} stroke="currentColor" strokeWidth="1.5" />
      </g>
    ))}

    {/* 1U switch — the one a scan has keyed on, so its ports carry the accent */}
    <rect x="50" y="34" width="160" height="26" rx="3" stroke="currentColor" strokeWidth="1.6" />
    {Array.from({ length: 12 }).map((_, i) => (
      <rect key={i} x={60 + i * 12} y="42" width="8" height="10" rx="1.5" fill="var(--home-accent)" opacity={i % 3 === 2 ? '.28' : '.9'} />
    ))}

    {/* 1U switch */}
    <rect x="50" y="68" width="160" height="26" rx="3" stroke="currentColor" strokeWidth="1.6" />
    {Array.from({ length: 12 }).map((_, i) => (
      <rect key={i} x={60 + i * 12} y="76" width="8" height="10" rx="1.5" fill="currentColor" opacity=".22" />
    ))}

    {/* patch panel */}
    <rect x="50" y="102" width="160" height="24" rx="3" stroke="currentColor" strokeWidth="1.6" />
    {Array.from({ length: 16 }).map((_, i) => (
      <line key={i} x1={58 + i * 9.5} y1="108" x2={58 + i * 9.5} y2="120" stroke="currentColor" strokeWidth="1.4" opacity=".35" />
    ))}

    {/* blanking / cable management */}
    <rect x="50" y="134" width="160" height="18" rx="3" stroke="currentColor" strokeWidth="1.4" opacity=".5" />

    {/* servers */}
    {[160, 196, 232].map((y) => (
      <g key={y}>
        <rect x="50" y={y} width="160" height="28" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="64" cy={y + 14} r="2.6" fill="currentColor" opacity=".4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <rect key={i} x={82 + i * 22} y={y + 8} width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" opacity=".33" />
        ))}
      </g>
    ))}

    {/* 2U PDU */}
    <rect x="50" y="272" width="160" height="34" rx="3" stroke="currentColor" strokeWidth="1.6" />
    {Array.from({ length: 6 }).map((_, i) => (
      <circle key={i} cx={70 + i * 24} cy="289" r="5" stroke="currentColor" strokeWidth="1.4" opacity=".42" />
    ))}

    {/* blank + vented base */}
    <rect x="50" y="314" width="160" height="26" rx="3" stroke="currentColor" strokeWidth="1.4" opacity=".5" />
    <rect x="50" y="348" width="160" height="22" rx="3" stroke="currentColor" strokeWidth="1.4" opacity=".35" />
  </svg>
);

export default function HomeHero() {
  const navigate = useNavigate();
  const auth = useAuth();
  const authed = auth?.isAuthed;

  return createPortal(
    <section className={styles.hero}>
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
            Photograph a rack and <strong>every switch, patch panel, port and
            cable</strong> becomes a live inventory you can search — kept true
            across every site you run.
          </p>

          {/* One action, whatever the state. Signed out it opens sign-in, which
              is also where an organization is created; signed in it goes
              straight to the thing the app is for. */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cta}
              onClick={() => navigate(authed ? '/scan' : '/login')}
            >
              {authed ? 'Start a scan' : 'Get started'}
              <ArrowR />
            </button>
          </div>

          <ul className={styles.proof}>
            <li>Scan a rack in one photograph</li>
            <li>Ports, cables and labels read automatically</li>
            <li>Every site in one searchable record</li>
          </ul>
        </div>

        <div className={styles.figure} aria-hidden="true">
          <RackFigure />
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
