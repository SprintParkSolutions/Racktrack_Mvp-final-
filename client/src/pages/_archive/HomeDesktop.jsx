import { createPortal } from 'react-dom';
import { NavLink, useNavigate } from 'react-router-dom';
import styles from './HomeDesktop.module.css';
import { useAuth } from '../AuthContext.jsx';

// HomeDesktop — landscape (≥1024px) layout. Mobile stays on HomePage /
// HomeLight / HomeDark, completely untouched. This file is rendered only
// when useIsDesktop() returns true.
//
// Structure:
//   - Top sticky nav with brand + section links + theme toggle + Start CTA
//   - Hero: side-by-side copy ↔ rack visual with live "scanning" animation
//   - 4 "How it works" feature cards below the fold

const STEPS = [
  {
    n: 1, title: 'Snap a photo', desc:
      'Point your phone at any rack. RackTrack accepts a single shot, a multi-photo stitch, or a sweeping video.',
  },
  {
    n: 2, title: 'AI detects every unit', desc:
      'Switches, patch panels, PDUs, servers — each device is boxed and classified directly on the image in under a second.',
  },
  {
    n: 3, title: 'Find any port instantly', desc:
      'Type a port number and the rack image zooms into the exact module, with live LLDP and MAC data alongside.',
  },
  {
    n: 4, title: 'Sync to your CMDB', desc:
      'Push the inventory delta to ServiceNow or any backend you connect. Source of truth stays current automatically.',
  },
];

export default function HomeDesktop() {
  const navigate = useNavigate();
  const auth = useAuth();
  const userName =
    auth?.user?.username
    || auth?.user?.name
    || (auth?.user?.email && String(auth.user.email).split('@')[0])
    || null;

  return createPortal(
    <div className={styles.page}>
      {/* ── Top nav ─────────────────────────────────────────────── */}
      <nav className={styles.nav}>
        <div className={styles.brand}>
          <img src="/logo.jpg" alt="" className={styles.brandMark} />
          <span>RackTrack</span>
        </div>
        <ul className={styles.navLinks}>
          <li><NavLink end to="/"        className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>Home</NavLink></li>
          <li><NavLink to="/scan"        className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>Scan</NavLink></li>
          <li><NavLink to="/profile"     className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>Profile</NavLink></li>
        </ul>
        <div className={styles.navRight}>
          {auth?.isAuthed ? (
            <button type="button" className={styles.startBtn} onClick={() => { auth.logout(); navigate('/'); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Sign out
            </button>
          ) : (
            <button type="button" className={styles.startBtn} onClick={() => navigate('/login')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
              Sign in
            </button>
          )}
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.heroBadge}>
            {userName ? `Welcome back, ${userName}` : 'AI ready · scans in seconds'}
          </span>
          <h1 className={styles.heroTitle}>
            Scan the rack.
            <span className={styles.heroTitleAccent}>Know everything.</span>
          </h1>
          <p className={styles.heroSub}>
            RackTrack uses on-device computer vision to identify every switch,
            patch panel, server, and cable in your datacenter racks — and turns
            it into a live inventory you can search the moment you take the photo.
          </p>
          <div className={styles.heroCtaRow}>
            <button type="button" className={styles.heroCta} onClick={() => navigate('/scan')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              Start a new scan
            </button>
            <button type="button" className={styles.heroSecondary} onClick={() => navigate('/profile')}>
              View past scans
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </button>
          </div>

          <div className={styles.heroStats}>
            <div>
              <span className={styles.statValue}>30+</span>
              <span className={styles.statLabel}>Device classes</span>
            </div>
            <div>
              <span className={styles.statValue}>0.3s</span>
              <span className={styles.statLabel}>Per-rack analyze</span>
            </div>
            <div>
              <span className={styles.statValue}>98%</span>
              <span className={styles.statLabel}>Port accuracy</span>
            </div>
          </div>
        </div>

        {/* Rack visual */}
        <div className={styles.heroVisual}>
          <div className={styles.heroVisualHalo} aria-hidden="true" />
          <div className={styles.heroRackFrame}>
            <div className={styles.heroRackHead}>
              <span className={styles.heroRackId}>RACK-U42-DEMO</span>
              <span className={styles.heroRackLive}>Live</span>
            </div>
            {/* 9 stacked rack units — mix of switches, patch panels, servers */}
            {[
              { label: 'U42', kind: 'switch',   ports: 24, lit: [0,2,3,5,7,8,10,11,14,16,18,20,21,23] },
              { label: 'U41', kind: 'switch',   ports: 24, lit: [1,2,4,6,9,12,13,15,17,19] },
              { label: 'U40', kind: 'scanning', ports: 24, lit: [0,3,6,9,12,15,18,21], warn: [4,5] },
              { label: 'U39', kind: 'panel',    ports: 24, lit: [] },
              { label: 'U38', kind: 'switch',   ports: 24, lit: [0,1,2,7,8,15,22,23] },
              { label: 'U37', kind: 'panel',    ports: 24, lit: [] },
              { label: 'U36', kind: 'server',   ports: 12, lit: [0,3,4,6,7,10] },
              { label: 'U35', kind: 'server',   ports: 12, lit: [1,2,5,8,9,11] },
              { label: 'U34', kind: 'panel',    ports: 24, lit: [] },
            ].map((u, i) => (
              <div
                key={i}
                className={[
                  styles.heroRackUnit,
                  u.kind === 'switch'   ? styles.switch   : '',
                  u.kind === 'scanning' ? styles.scanning : '',
                ].filter(Boolean).join(' ')}
              >
                <span className={styles.heroRackUnitLabel}>{u.label}</span>
                <div className={styles.heroRackUnitPorts}>
                  {Array.from({ length: u.ports }).map((_, p) => {
                    const cls = (u.warn || []).includes(p)
                      ? styles.warn
                      : (u.lit || []).includes(p)
                        ? styles.lit
                        : u.kind === 'panel' ? styles.empty : '';
                    return <span key={p} className={`${styles.heroRackPort} ${cls}`} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────── */}
      <section className={styles.steps}>
        {STEPS.map(s => (
          <div key={s.n} className={styles.stepCard}>
            <span className={styles.stepNum}>{s.n}</span>
            <h3 className={styles.stepTitle}>{s.title}</h3>
            <p className={styles.stepDesc}>{s.desc}</p>
          </div>
        ))}
      </section>
    </div>,
    document.body
  );
}
