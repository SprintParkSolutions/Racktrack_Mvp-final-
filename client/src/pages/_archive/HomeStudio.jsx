import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import styles from './HomeStudio.module.css';
import { useAuth } from '../AuthContext.jsx';

/* ──────────────────────────────────────────────────────────────────────
   HomeStudio — iPad + desktop (≥768px) welcome.

   Simple, attractive split: a bold headline + one CTA on the left, and a
   real rack photo on the right with a light "AI is scanning it" treatment
   (sweeping scan line + detection boxes + LIVE badge). Flat white surface,
   subtle-black accents, generous whitespace — fills the viewport with zero
   scroll. Phones stay on HomeLight, untouched. Portalled to <body> so it
   escapes #root's 540px column cap at ≥1024px.
   ────────────────────────────────────────────────────────────────────── */

const Arrow = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
       strokeLinecap="round" strokeLinejoin="round" {...p}>
    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
  </svg>
);
const SignIcon = ({ out, ...p }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
       strokeLinecap="round" strokeLinejoin="round" {...p}>
    {out
      ? (<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>)
      : (<><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></>)}
  </svg>
);

export default function HomeStudio() {
  const navigate = useNavigate();
  const auth = useAuth();
  const authed = !!auth?.isAuthed;
  const name =
    auth?.user?.username
    || auth?.user?.name
    || (auth?.user?.email && String(auth.user.email).split('@')[0])
    || null;

  // Same reasoning as HomeLight: signed out, the primary action signs you in.
  // Creating an organization is the rarer path and sits as the secondary.
  const start = () => navigate(authed ? '/scan' : '/login');

  return createPortal(
    <div className={styles.shell}>
      {/* ── top bar ── */}
      <header className={styles.top}>
        <div className={styles.brand}>
          <img src="/logo.jpg" alt="" className={styles.mark} aria-hidden="true" />
          <span className={styles.word}>RackTrack</span>
        </div>
        <button
          type="button"
          className={styles.signBtn}
          onClick={authed ? () => { auth.logout(); navigate('/'); } : () => navigate('/login')}
        >
          <SignIcon out={authed} width="15" height="15" />
          {authed ? 'Sign out' : 'Sign in'}
        </button>
      </header>

      {/* ── split hero ── */}
      <main className={styles.main}>
        <div className={styles.left}>
          <span className={styles.kicker}>
            {authed && name ? `Welcome back, ${name}` : 'AI rack intelligence'}
          </span>
          <h1 className={styles.head}>
            See every port.<br /><span className={styles.headMute}>Know every rack.</span>
          </h1>
          <p className={styles.sub}>
            Point your phone at any rack. RackTrack maps every switch, patch
            panel and cable into a live inventory you can search - in seconds.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={start}>
              {authed ? 'Start a scan' : 'Sign in'}
              <Arrow width="17" height="17" />
            </button>
            {!authed && (
              <button type="button" className={styles.secondary} onClick={() => navigate('/signup')}>
                Create an organization
              </button>
            )}
            {authed && (
              <button type="button" className={styles.secondary} onClick={() => navigate('/profile')}>
                Past scans
              </button>
            )}
          </div>
          <div className={styles.stats}>
            <div className={styles.stat}><b>30+</b><span>device classes</span></div>
            <span className={styles.statDiv} />
            <div className={styles.stat}><b>0.3s</b><span>per rack</span></div>
            <span className={styles.statDiv} />
            <div className={styles.stat}><b>98%</b><span>accuracy</span></div>
          </div>
        </div>

        {/* Black racks receding into a white room (Pexels, free license) under
            the AI scan-viewfinder — white-focused with black accents, the
            product's aesthetic. */}
        <div className={styles.deck}>
          <img src="/hero-rack.jpg" alt="A row of equipment racks being scanned by RackTrack" className={styles.photo} />
          <div className={styles.shade} aria-hidden="true" />
          <div className={styles.scan} aria-hidden="true" />

          {/* viewfinder corner brackets */}
          <span className={`${styles.corner} ${styles.cTL}`} aria-hidden="true" />
          <span className={`${styles.corner} ${styles.cTR}`} aria-hidden="true" />
          <span className={`${styles.corner} ${styles.cBL}`} aria-hidden="true" />
          <span className={`${styles.corner} ${styles.cBR}`} aria-hidden="true" />

          <span className={styles.live}><i className={styles.livePip} />LIVE SCAN</span>

          <div className={styles.hud}>
            <span className={styles.hudLoc}>CHENNAI&#8209;DC1</span>
            <span className={styles.hudDiv} />
            <span>24 racks</span>
            <span className={styles.hudDiv} />
            <span>1,048 ports mapped</span>
          </div>
        </div>
      </main>
    </div>,
    document.body
  );
}
