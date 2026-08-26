import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import AuthLayout, { AuthAside, IcAlert, IcEye, IcInfo } from '../components/AuthLayout.jsx';
import { useAuth } from '../AuthContext.jsx';
import { safeRedirect } from '../utils/safeRedirect.js';

export const PW_RULES = [
  { id: 'len',   label: '8 characters',   test: pw => pw.length >= 8 },
  { id: 'upper', label: 'an uppercase',   test: pw => /[A-Z]/.test(pw) },
  { id: 'lower', label: 'a lowercase',    test: pw => /[a-z]/.test(pw) },
  { id: 'digit', label: 'a digit',        test: pw => /[0-9]/.test(pw) },
  { id: 'spec',  label: 'a special char', test: pw => /[^A-Za-z0-9]/.test(pw) },
];
export const STRENGTH_COLORS = ['#b42318', '#b42318', '#b54708', '#b54708', '#067647', '#067647'];

export function CodeGrid({ value, onChange, disabled }) {
  const refs = useRef([]);
  const digits = value.padEnd(6, ' ').split('').slice(0, 6);

  const setDigit = (i, ch) => {
    const cleaned = String(ch).replace(/\D/g, '');
    // OS one-time-code autofill (or typing/pasting several digits) drops the
    // whole code into one cell — spread it across the grid instead of dropping it.
    if (cleaned.length > 1) {
      onChange(cleaned.slice(0, 6));
      refs.current[Math.min(cleaned.length, 6) - 1]?.focus();
      return;
    }
    const next = value.padEnd(6, ' ').split('');
    next[i] = cleaned || ' ';
    onChange(next.join('').replace(/\s/g, ''));
    if (cleaned && i < 5) refs.current[i + 1]?.focus();
  };

  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !digits[i].trim() && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus(); e.preventDefault();
    } else if (e.key === 'ArrowRight' && i < 5) {
      refs.current[i + 1]?.focus(); e.preventDefault();
    }
  };

  const handlePaste = (e) => {
    const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    refs.current[Math.min(pasted.length, 5)]?.focus();
  };

  return (
    <div className={styles.codeGrid} onPaste={handlePaste}>
      {[0,1,2,3,4,5].map(i => (
        <input
          key={i}
          ref={el => refs.current[i] = el}
          className={`${styles.codeCell} ${digits[i].trim() ? styles.codeCellFilled : ''}`}
          type="text" inputMode="numeric" maxLength="6"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          value={digits[i].trim()}
          disabled={disabled}
          onChange={e => setDigit(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onFocus={e => e.target.select()}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}

export default function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signup, verifyCode, resendCode, loading } = useAuth();
  const [step, setStep] = useState('details');

  const [email, setEmail]       = useState('');
  const [username, setUsername] = useState('');
  // REQUIRED — the verify step creates a brand-new tenant for this user.
  // They become the founding member of that tenant and other employees
  // can later be invited into it. Multi-tenancy means each customer
  // company gets its own private space; without a company name there's
  // no tenant to put the user into.
  const [company, setCompany]   = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);

  const [code, setCode]         = useState('');
  const [error, setError]       = useState(null);
  const [info, setInfo]         = useState(null);

  const from = safeRedirect(location.state?.from, '/scan');

  // Live password strength: count satisfied rules, pick a color, name what's missing.
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

  const submitDetails = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email.'); return; }
    // Account creation is limited to Gmail addresses (the server enforces this too).
    if (!/@gmail\.com$/i.test(email.trim()))                { setError('Please use a @gmail.com email address to create an account.'); return; }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))            { setError('Username 3-32 chars (letters, digits, . _ -).'); return; }
    if (!company.trim() || company.trim().length < 2)        { setError('Organization name is required.'); return; }
    if (!pwInfo.allOk)                                       { setError('Password is too weak.'); return; }
    if (!matchOk)                                            { setError('Passwords do not match.'); return; }
    try {
      await signup(email.trim(), username.trim(), password, company.trim());
      setStep('code');
      setInfo('We sent a 6-digit code to your email.');
    } catch (err) { setError(err.message); }
  };

  const submitCode = async (e) => {
    e?.preventDefault();
    setError(null);
    if (code.length !== 6) { setError('Enter the full 6-digit code.'); return; }
    try {
      await verifyCode(email.trim(), code);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  const onResend = async () => {
    setError(null); setInfo(null);
    try {
      await resendCode(email.trim());
      setInfo('A new code has been sent.');
    } catch (err) { setError(err.message); }
  };

  useEffect(() => {
    if (step === 'code') {
      const first = document.querySelector(`.${styles.codeCell}`);
      first?.focus();
    }
  }, [step]);

  return (
    <AuthLayout
      onBack={() => step === 'code' ? setStep('details') : navigate('/')}
      backLabel="Back"
      aside={
        step === 'details' ? (
          <AuthAside text="Already have an account?">
            <Link to="/login" state={{ from }} className={styles.asideLink}>Sign in</Link>
          </AuthAside>
        ) : (
          <div className={styles.stepDots}>
            <span className={`${styles.stepDot} ${styles.stepDotDone}`} />
            <span className={`${styles.stepDot} ${styles.stepDotActive}`} />
          </div>
        )
      }
    >
      {step === 'details' ? (
        <>
          <h1 className={styles.heading}>Create your organization</h1>
          <p className={styles.subheading}>
            You'll be its first member, and can invite the rest of your team afterwards.
          </p>

          <form className={styles.form} onSubmit={submitDetails} autoComplete="on">
            <div className={styles.field}>
              <label className={styles.label} htmlFor="su-email">Email</label>
              <div className={styles.inputWrap}>
                <input id="su-email" className={styles.input} type="email"
                  autoComplete="email" value={email}
                  onChange={e => { setEmail(e.target.value); setError(null); }} autoFocus />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="su-user">Username</label>
              <div className={styles.inputWrap}>
                <input id="su-user" className={styles.input} type="text"
                  autoComplete="username" value={username}
                  onChange={e => { setUsername(e.target.value); setError(null); }} />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="su-company">Organization</label>
              <div className={styles.inputWrap}>
                <input id="su-company" className={styles.input} type="text"
                  autoComplete="organization" value={company}
                  onChange={e => { setCompany(e.target.value); setError(null); }}
                  required />
              </div>
              <p className={styles.fieldNote}>Creates a new organization.</p>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="su-pw">Password</label>
              <div className={styles.inputWrap}>
                <input id="su-pw" className={`${styles.input} ${styles.inputPw}`} type={showPw ? 'text' : 'password'}
                  autoComplete="new-password" value={password}
                  onChange={e => { setPassword(e.target.value); setError(null); }} />
                <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  <IcEye off={showPw} />
                </button>
              </div>

              {/* Single strength bar + 1-line hint */}
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
              <label className={styles.label} htmlFor="su-confirm">Confirm password</label>
              <div className={styles.inputWrap}>
                <input id="su-confirm" className={`${styles.input} ${styles.inputMatch}`} type={showPw ? 'text' : 'password'}
                  autoComplete="new-password" value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(null); }} />
                {confirm.length > 0 && (
                  <span className={`${styles.matchHint} ${matchOk ? styles.matchOk : styles.matchBad}`}>
                    {matchOk ? '✓ matches' : '✗ no match'}
                  </span>
                )}
              </div>
            </div>

            {error && (
              <div className={styles.errBox}><IcAlert width="14" height="14" />{error}</div>
            )}

            <button type="submit" className={styles.primaryBtn}
              disabled={loading || !pwInfo.allOk || !matchOk || !email || !username}>
              {loading && <span className={styles.spinner} />}
              <span>Create organization</span>
            </button>
          </form>
          {/* No "Already have an account? Sign in" row here — the top bar
              already carries exactly that link, word for word. */}
        </>
      ) : (
        <>
          <h1 className={styles.heading}>Check your email</h1>
          <p className={styles.sentTo}>
            We sent a 6-digit code to <span className={styles.sentToEmail}>{email}</span>.
          </p>

          <form className={styles.form} onSubmit={submitCode}>
            <CodeGrid value={code} onChange={(v) => { setCode(v); setError(null); }} disabled={loading} />

            {info && !error && (
              <div className={styles.infoBox}><IcInfo width="14" height="14" />{info}</div>
            )}
            {error && (
              <div className={styles.errBox}><IcAlert width="14" height="14" />{error}</div>
            )}

            <button type="submit" className={styles.primaryBtn} disabled={loading || code.length !== 6}>
              {loading && <span className={styles.spinner} />}
              <span>Verify and continue</span>
            </button>
          </form>

          <div className={styles.altRow}>
            Didn't get it?
            <button type="button" className={styles.altLink} onClick={onResend}>Resend code</button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
