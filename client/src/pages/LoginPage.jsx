import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import AuthLayout, { AuthAside, IcAlert, IcEye } from '../components/AuthLayout.jsx';
import { useAuth } from '../AuthContext.jsx';
import SocialSignIn from '../components/SocialSignIn.jsx';
import { safeRedirect } from '../utils/safeRedirect.js';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loading } = useAuth();
  const [org,      setOrg]      = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  // A failed social sign-in redirects back here carrying its reason, so the
  // user learns "no account uses that address" instead of silently landing on
  // an empty login form.
  const [error,    setError]    = useState(location.state?.socialError || null);

  const from = safeRedirect(location.state?.from, '/scan');

  const submit = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    try {
      // Organization is optional: given, it scopes the lookup (needed when the
      // same username exists in more than one org); left blank, we fall back to
      // the global username/email lookup. Either way we route by the account's
      // REAL role once the credentials resolve — no role picker.
      const u = await login(username.trim(), password, org.trim());
      // Everyone lands on Home after signing in. Owner / org-admin used to be
      // sent straight to the organization dashboard; they now start on Home
      // like everyone else and reach the dashboard from the Profile page or the
      // sidebar. A deep link that bounced them to login is still honoured.
      if (u?.role === 'owner' || u?.role === 'org_admin') {
        navigate(safeRedirect(location.state?.from, '/'), { replace: true });
      } else {
        navigate(from, { replace: true });
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <AuthLayout
      onBack={() => navigate('/')}
      backLabel="Back to home"
      aside={
        <AuthAside text="New to RackTrack?">
          <Link to="/signup" state={{ from }} className={styles.asideLink}>Create account</Link>
        </AuthAside>
      }
    >
      <h1 className={styles.heading}>Welcome back</h1>
      <p className={styles.subheading}>Sign in to continue to your RackTrack workspace.</p>

      <SocialSignIn mode="login" />

      <form className={styles.form} onSubmit={submit} autoComplete="on">
        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-org">
            Organization <span className={styles.labelOpt}>· optional</span>
          </label>
          <div className={styles.inputWrap}>
            <input
              id="login-org"
              className={styles.input}
              type="text"
              autoComplete="organization"
              value={org}
              onChange={e => { setOrg(e.target.value); setError(null); }}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-user">Username or email</label>
          <div className={styles.inputWrap}>
            <input
              id="login-user"
              className={styles.input}
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(null); }}
              autoFocus
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-pw">Password</label>
          <div className={styles.inputWrap}>
            <input
              id="login-pw"
              className={`${styles.input} ${styles.inputPw}`}
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(null); }}
            />
            <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}>
              <IcEye off={showPw} />
            </button>
          </div>
        </div>

        <div className={styles.forgotRow}>
          <Link
            to="/forgot-password"
            state={{ email: username.includes('@') ? username.trim() : '' }}
            className={styles.forgotLink}
          >
            Forgot password?
          </Link>
        </div>

        {error && (
          <div className={styles.errBox}><IcAlert width="14" height="14" />{error}</div>
        )}

        <button type="submit" className={styles.primaryBtn} disabled={loading}>
          {loading && <span className={styles.spinner} />}
          <span>Sign in</span>
        </button>
      </form>

      <div className={styles.altRow}>
        Don't have an account?
        <Link to="/signup" state={{ from }} className={styles.altLink}>Create an organization</Link>
      </div>

      {/* A brand-new user otherwise has no way to know that joining an
          existing team is invite/credentials-only — spell out both paths. */}
      <div className={styles.note}>
        <div className={styles.noteLine}>
          <b>Setting up your own team</b> - create an organization above.
        </div>
        <div className={styles.noteLine}>
          <b>Joining an existing team</b> - ask your organization admin for an
          invite link, or a username and password. New sign-ups can’t join an
          existing organization on their own.
        </div>
      </div>
    </AuthLayout>
  );
}
