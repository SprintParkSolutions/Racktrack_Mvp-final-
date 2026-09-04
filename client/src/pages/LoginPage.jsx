import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import s from './LoginPage.module.css';
import { IcAlert, IcEye } from '../components/AuthLayout.jsx';
import { useAuth } from '../AuthContext.jsx';
import { safeRedirect } from '../utils/safeRedirect.js';

// Login: logo, name, two fields, one button.
//
// The previous screen carried an optional organisation field, social sign-in,
// and two paragraphs on how teams are joined. All of it was true and none of
// it was what a person opening the app wants to read. The organisation field
// is gone from view — login() falls back to the global username lookup when it
// is blank, which is what almost everyone needs; the rare same-name-in-two-orgs
// case still has the invite link. Everything else is one line at the bottom.

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  // A failed social sign-in used to land here with its reason; keep honouring
  // that state so an old deep link still explains itself.
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
      const u = await login(username.trim(), password, '');
      // Everyone lands on Home; a deep link that bounced here is still honoured.
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
    <div className={s.page}>
      <div className={s.blobA} aria-hidden="true" />
      <div className={s.blobB} aria-hidden="true" />

      <main className={s.card}>
        <img src="/logo.jpg" alt="" className={s.logo} width="108" height="108" />
        <h1 className={s.brand}>RackTrack</h1>
        <p className={s.tag}>Scan a rack. Know what's in it.</p>

        <form className={s.form} onSubmit={submit} autoComplete="on" noValidate>
          <div className={s.field}>
            <input
              className={s.input}
              type="text"
              placeholder="Username or email"
              aria-label="Username or email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(null); }}
              autoFocus
            />
          </div>

          <div className={s.field}>
            <input
              className={`${s.input} ${s.inputPw}`}
              type={showPw ? 'text' : 'password'}
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
            />
            <button
              type="button"
              className={s.eye}
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
            >
              <IcEye off={showPw} />
            </button>
          </div>

          {error && (
            <div className={s.err} role="alert"><IcAlert width="14" height="14" />{error}</div>
          )}

          <button type="submit" className={s.cta} disabled={loading}>
            {loading && <span className={s.spinner} />}
            <span>Get started</span>
          </button>
        </form>

        <div className={s.links}>
          <Link to="/forgot-password" state={{ email: username.includes('@') ? username.trim() : '' }}>
            Forgot password?
          </Link>
          <span className={s.dot}>·</span>
          <Link to="/signup" state={{ from }}>New here? Create an organization</Link>
        </div>
      </main>

      <footer className={s.foot}>
        Joining a team? Ask your admin for an invite link or a username and password.
      </footer>
    </div>
  );
}
