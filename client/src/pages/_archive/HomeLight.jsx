import { useNavigate } from 'react-router-dom';
import styles from './HomeLight.module.css';
import { useAuth } from '../AuthContext.jsx';
import Icon from '../components/Icon';

/* ──────────────────────────────────────────────────────────────────────
   HomeLight — the single Welcome screen for RackTrack.
   White-focused Material 3 design with black accent, Geist typography,
   Inline SVG icons. There is no dark variant — this is the only
   theme.
   ────────────────────────────────────────────────────────────────────── */

const HERO_IMG = 'https://lh3.googleusercontent.com/aida-public/AB6AXuA9qzSoVcsJ-4HGhCOcqgUzBX0CSqr_-40SPsEPEMHx1u-KcEcGJ8Lmz8HrJrLRDElFBzaGBFzwZ3jadymB0fD6Mew7ZuOwGJkoqatVb9apgYGue2JcBbjP1gNWI6L18ZncAYXlRtAJWoh2WaUMJ7aFrJrWdPw87QI_6rE7vbdqbaa9P90ExbCmwc2TfkYtpA6ohrvh9rfSOIs7C_UWn-9zVVGXjeWsg93sy53aJGyk5yoSnnvncyTr9TEt2Jv3XsKvUGvceUqXolQ';

export default function HomeLight() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();

  // Signed out, the prominent action is SIGN IN, not sign up. Almost everyone
  // arriving here already has an account — testers especially — and sending
  // them to a registration form reads as "you don't have an account", which is
  // wrong and makes them think they need to create one.
  const handleGetStarted = () => navigate(isAuthed ? '/scan' : '/login');
  const handleCreateOrg  = () => navigate('/signup');

  return (
    <div className={styles.wrap}>
      {/* TopAppBar */}
      <header className={styles.appBar}>
        <div className={styles.brand}>
          <img src="/logo.jpg" alt="" className={styles.brandLogo} aria-hidden="true" />
          <span className={styles.brandName}>RackTrack</span>
        </div>
        {!isAuthed && (
          <button type="button" className={styles.signInBtn} onClick={handleCreateOrg}>
            Create account
          </button>
        )}
      </header>

      {/* Main canvas */}
      <main className={styles.main}>
        {/* Hero image card */}
        <div className={styles.hero}>
          <img
            src={HERO_IMG}
            alt="Data center aisle with black server racks"
            className={styles.heroImg}
          />
        </div>

        {/* Headline + sub */}
        <div className={styles.content}>
          <h1 className={styles.title}>
            Manage your datacenter.<br />From anywhere.
          </h1>
          <p className={styles.sub}>
            Track racks, ports, and assets in real time.
          </p>
        </div>

        {/* CTA */}
        <div className={styles.ctaArea}>
          <button
            type="button"
            className={styles.primaryCta}
            onClick={handleGetStarted}
          >
            {isAuthed ? 'Start a scan' : 'Sign in'}
            <Icon name="arrow_forward" className={`${styles.primaryCtaIcon}`} />
          </button>
        </div>
      </main>
    </div>
  );
}
