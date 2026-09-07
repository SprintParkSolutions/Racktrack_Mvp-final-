import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import AuthLayout, { AuthAside, IcAlert, IcEye, IcInfo } from '../components/AuthLayout.jsx';
import { useAuth } from '../AuthContext.jsx';
import { CodeGrid, PW_RULES, STRENGTH_COLORS } from '../components/PasswordFields.jsx';
import { safeRedirect } from '../utils/safeRedirect.js';

// Four-step password reset:
//   1. 'email'  — enter address, server emails a 6-digit code (1 min TTL).
//   2. 'code'   — enter the code; server *verifies* without consuming it.
//   3. 'choice' — "Code verified. Want to change your password?" Yes/No.
//   4. 'reset'  — collect new password and consume the reset row.
// The code stays valid through steps 2→3→4 (single password_resets row,
// not deleted until the final reset). If the user picks "No" we send them
// back to /login without resetting anything.
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { forgotPassword, verifyResetCode, resetPassword, loginWithCode, loading } = useAuth();

  const [step, setStep] = useState('email');   // 'email' | 'code' | 'choice' | 'reset'
  const [email, setEmail] = useState(location.state?.email || '');
  const [code, setCode]   = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError]   = useState(null);
  const [info, setInfo]     = useState(null);

  const from = safeRedirect(location.state?.from, '/scan');

  const pwInfo = useMemo(() => {
    const checks = PW_RULES.map(r => ({ ...r, ok: r.test(password) }));
    const satisfied = checks.filter(c => c.ok).length;
    const missing   = checks.filter(c => !c.ok).map(c => c.label);
    const color = STRENGTH_COLORS[satisfied] || '#067647';
    let label;
    if (password.length === 0)     label = '';
    else if (satisfied < 5)        label = `Need ${missing[0]}`;
    else                           label = '✓ Strong password';
    return { satisfied, total: checks.length, color, label, allOk: satisfied === 5 };
  }, [password]);

  const matchOk = confirm.length > 0 && confirm === password;

  const submitEmail = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email.');
      return;
    }
    try {
      await forgotPassword(email.trim());
      setStep('code');
      // We always show the same message regardless of whether the email is
      // registered — the server doesn't leak that distinction either.
      setInfo('If an account exists for that email, a 6-digit code is on its way.');
    } catch (err) { setError(err.message); }
  };

  // Verifies the 6-digit code WITHOUT consuming it. The code remains valid
  // for the final /reset-password call in the 'reset' step.
  const submitCode = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your email.'); return; }
    try {
      await verifyResetCode(email.trim(), code);
      setStep('choice');
    } catch (err) { setError(err.message); }
  };

  const submitReset = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!pwInfo.allOk) { setError('Password is too weak.'); return; }
    if (!matchOk)      { setError('Passwords do not match.'); return; }
    try {
      await resetPassword(email.trim(), code, password);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  // "No, keep current password" — the OTP already proved identity, so issue
  // a token without touching the password. The server consumes the reset row.
  const skipAndLogin = async () => {
    setError(null);
    try {
      await loginWithCode(email.trim(), code);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  const resend = async () => {
    setError(null); setInfo(null);
    try {
      await forgotPassword(email.trim());
      setInfo('Sent a fresh code.');
    } catch (err) { setError(err.message); }
  };

  const errorBox = error && (
    <div className={styles.errBox}><IcAlert width="14" height="14" />{error}</div>
  );

  return (
    <AuthLayout
      onBack={() => navigate('/login')}
      backLabel="Back to sign in"
      aside={
        <AuthAside text="Remembered it?">
          <Link to="/login" state={{ from }} className={styles.asideLink}>Sign in</Link>
        </AuthAside>
      }
    >
      {step === 'email' && (
        <>
          <h1 className={styles.heading}>Reset your password</h1>
          <p className={styles.subheading}>
            Enter the email on your account and we'll send a 6-digit code.
          </p>

          <form className={styles.form} onSubmit={submitEmail} autoComplete="on">
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fp-email">Email</label>
              <div className={styles.inputWrap}>
                <input
                  id="fp-email"
                  className={styles.input}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(null); }}
                  autoFocus
                />
              </div>
            </div>

            {errorBox}

            <button type="submit" className={styles.primaryBtn} disabled={loading}>
              {loading && <span className={styles.spinner} />}
              <span>Send reset code</span>
            </button>
          </form>
          {/* No "Remembered it? Sign in" row here — the top bar already
              carries exactly that link, word for word. */}
        </>
      )}

      {step === 'code' && (
        <>
          <h1 className={styles.heading}>Enter your code</h1>
          <p className={styles.sentTo}>
            Sent to <span className={styles.sentToEmail}>{email}</span> · expires in 1 minute.
          </p>

          <form className={styles.form} onSubmit={submitCode} autoComplete="off">
            <CodeGrid value={code} onChange={(v) => { setCode(v); setError(null); }} disabled={loading} />

            {info && !error && (
              <div className={styles.infoBox}><IcInfo width="14" height="14" />{info}</div>
            )}
            {errorBox}

            <button type="submit" className={styles.primaryBtn} disabled={loading}>
              {loading && <span className={styles.spinner} />}
              <span>Verify code</span>
            </button>
          </form>

          <div className={styles.altRow}>
            Didn't get a code?
            <button type="button" className={styles.altLink} onClick={resend}>Resend</button>
          </div>
        </>
      )}

      {step === 'choice' && (
        <>
          <h1 className={styles.heading}>Code verified</h1>
          <p className={styles.subheading}>
            Change your password while you're here? You're signed in either way.
          </p>

          <div className={styles.form}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => { setError(null); setInfo(null); setStep('reset'); }}
              disabled={loading}>
              {loading && <span className={styles.spinner} />}
              <span>Yes, change password</span>
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={skipAndLogin}
              disabled={loading}>
              {loading ? <span className={styles.spinner} /> : 'No, take me to the app'}
            </button>

            {errorBox}
          </div>
        </>
      )}

      {step === 'reset' && (
        <>
          <h1 className={styles.heading}>Set a new password</h1>
          <p className={styles.subheading}>
            Pick something you haven't used on this account before.
          </p>

          <form className={styles.form} onSubmit={submitReset} autoComplete="off">
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fp-pw">New password</label>
              <div className={styles.inputWrap}>
                <input
                  id="fp-pw"
                  className={`${styles.input} ${styles.inputPw}`}
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(null); }}
                  autoFocus
                />
                <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  <IcEye off={showPw} />
                </button>
              </div>

              {password.length > 0 && (
                <div className={styles.strength}>
                  <div className={styles.strengthTrack}>
                    <div className={styles.strengthFill}
                      style={{
                        width: `${(pwInfo.satisfied / pwInfo.total) * 100}%`,
                        background: pwInfo.color,
                      }}/>
                  </div>
                  <span className={`${styles.strengthHint} ${pwInfo.allOk ? styles.strengthHintOk : ''}`}
                    style={pwInfo.allOk ? {} : { color: pwInfo.color }}>
                    {pwInfo.label}
                  </span>
                </div>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="fp-confirm">Confirm new password</label>
              <div className={styles.inputWrap}>
                <input
                  id="fp-confirm"
                  className={`${styles.input} ${styles.inputMatch}`}
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(null); }}
                />
                {confirm.length > 0 && (
                  <span className={`${styles.matchHint} ${matchOk ? styles.matchOk : styles.matchBad}`}>
                    {matchOk ? '✓ matches' : '✗ no match'}
                  </span>
                )}
              </div>
            </div>

            {errorBox}

            <button type="submit" className={styles.primaryBtn} disabled={loading}>
              {loading && <span className={styles.spinner} />}
              <span>Reset password</span>
            </button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
