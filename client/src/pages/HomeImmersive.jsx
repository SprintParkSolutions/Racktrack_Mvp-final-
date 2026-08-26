import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import styles from './HomeImmersive.module.css';

// Full-screen immersive home — a dark data-center hero with the content
// bottom-anchored over a scrim. Matches the immersive-home reference. Portalled
// to <body> so it escapes #root's mobile frame and fills the viewport.
export default function HomeImmersive() {
  const navigate = useNavigate();
  const auth = useAuth();
  const authed = auth?.isAuthed;
  const start = () => navigate(authed ? '/scan' : '/login');

  return createPortal(
    <section className={styles.hero}>
      <div className={styles.bg}>
        <img src="/home-bg.jpg" alt="" />
      </div>
      <div className={styles.scrim} aria-hidden="true" />

      <nav className={styles.nav}>
        <div className={styles.logo}><img src="/logo.jpg" alt="" className={styles.logoMark} />RackTrack</div>
        <button
          type="button"
          className={styles.signout}
          onClick={authed ? () => { auth.logout(); navigate('/'); } : () => navigate('/login')}
        >
          {authed ? 'Sign out' : 'Sign in'}
        </button>
      </nav>

      <div className={styles.body}>
        <h1 className={styles.h1}>See every port.<br />Know every rack.</h1>
        <p className={styles.lede}>
          Point your phone at any rack. RackTrack maps every switch, patch panel
          and cable into a live inventory you can search - in seconds.
        </p>
        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={start}>
            {authed ? 'Start a scan →' : 'Sign in →'}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.ghost}`}
            onClick={() => navigate(authed ? '/profile' : '/signup')}
          >
            {authed ? 'Past scans' : 'Create an organization'}
          </button>
        </div>
      </div>
    </section>,
    document.body,
  );
}
