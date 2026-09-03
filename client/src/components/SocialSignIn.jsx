import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { apiUrl } from '../utils/api';
import styles from '../pages/AuthPages.module.css';

/**
 * "Continue with Google / Apple / Facebook".
 *
 * Which buttons appear is decided by the SERVER (/api/auth/providers), not by a
 * build flag — so switching a provider on is an env change and a restart, with
 * no App Store resubmission. Renders nothing at all when none are configured,
 * which keeps this safe to drop into the auth pages before the credentials
 * exist.
 *
 * The sign-in itself is not a fetch. We hand the whole browser to the provider
 * and the server redirects back with a session; a native build cannot do this
 * inside its own WebView because Google rejects OAuth from an embedded user
 * agent (`disallowed_useragent`), so it opens a real in-app browser tab.
 */

/* Providers the server may well have configured but that we do not render.
 *
 * Google is here on the owner's instruction for this round ("remove the sign in
 * with google option for now"). Filtered client-side rather than by unsetting
 * GOOGLE_* on the box: the env change would also disturb the callback URLs that
 * are registered with Google, and it would come back the moment someone copied
 * a working .env forward. Accounts already created through Google are
 * untouched — the OAuth routes still exist, so an existing session and the
 * /auth/callback deep link both keep working; there is simply no button.
 *
 * Deleting the name from this set is the whole of putting it back. */
const HIDDEN_PROVIDERS = new Set(['google']);

const MARKS = {
  google: (
    <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
    </svg>
  ),
  apple: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 12.54c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.42-.14-2.76.83-3.48.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.89-3.75 2.27-1.6 2.77-.41 6.88 1.15 9.13.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.23-.02 2.02-1.12 2.78-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.65zM14.76 5.2c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.68-1.09 1.77-.95 2.81 1.02.08 2.05-.52 2.68-1.28z"/>
    </svg>
  ),
  facebook: (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/>
    </svg>
  ),
};

/**
 * @param {'login'|'invite'} mode
 * @param {string} [inviteCode]  required when mode === 'invite'
 * @param {(providers: Array) => void} [onLoaded]  told which providers exist,
 *        so the parent can tailor its copy (e.g. the failed-password hint)
 */
export default function SocialSignIn({ mode = 'login', inviteCode, onLoaded }) {
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/auth/providers'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.providers) return;
        const shown = d.providers.filter((p) => !HIDDEN_PROVIDERS.has(p.name));
        setProviders(shown);
        // The parent tailors its copy from this ("you may have signed up with
        // Google"), so it must be told what is actually on screen, not what the
        // server offers.
        onLoaded?.(shown);
      })
      // A server that doesn't know this route yet, or is simply unreachable,
      // just means no buttons. Never block the password form on it.
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native only: the user swiped the browser tab away without finishing. There
  // is no deep link in that case, so nothing else would ever clear the spinner.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let sub;
    (async () => {
      sub = await Browser.addListener('browserFinished', () => setBusy(null));
    })();
    return () => { sub?.remove?.(); };
  }, []);

  if (!providers.length) return null;

  const start = async (name) => {
    setBusy(name);
    const native = Capacitor.isNativePlatform();
    const q = new URLSearchParams({ platform: native ? 'native' : 'web', mode });
    if (mode === 'invite' && inviteCode) q.set('invite', inviteCode);
    const url = apiUrl(`/api/auth/oauth/${name}/start?${q}`);

    if (native) {
      // An in-app browser tab (SFSafariViewController / Chrome Custom Tabs).
      // It is dismissed by the appUrlOpen handler in App.jsx once the server
      // redirects to our custom scheme.
      try {
        await Browser.open({ url, presentationStyle: 'popover' });
      } catch {
        setBusy(null);
      }
      // Leave `busy` set: the tab is covering the app, and clearing it would
      // just flash the button back to life underneath. The handler that adopts
      // the session navigates away; a cancelled tab is caught below.
      return;
    }
    window.location.assign(url);
  };

  return (
    <div className={styles.socialBlock}>
      {/* Two providers sit side by side and one spans the row — the grid
          decides, so adding a third on the server needs nothing here. */}
      <div className={styles.socialGrid}>
        {providers.map((p) => (
          <button
            key={p.name}
            type="button"
            className={styles.socialBtn}
            onClick={() => start(p.name)}
            disabled={!!busy}
          >
            <span className={styles.socialIcon}>
              {busy === p.name ? <span className={styles.socialSpinner} /> : MARKS[p.name]}
            </span>
            <span>Sign in with {p.label}</span>
          </button>
        ))}
      </div>
      <div className={styles.socialDivider}><span>or</span></div>
    </div>
  );
}
