import { useState } from 'react';
import { createPortal } from 'react-dom';
import useModalA11y from '../hooks/useModalA11y.js';
import { apiUrl, authFetch, publicOrigin } from '../utils/api';
import styles from './ShareSheet.module.css';

/**
 * Send this report to somebody.
 *
 * Four ways, in the order a person reaches for them: a Teams message and an
 * email, both sent by the server from the RackTrack mailbox with the PDF
 * attached; a link, for anyone who is not in the tenant; and the phone's own
 * share sheet where it has one.
 *
 * The two Microsoft ones need an address because that is who the message goes
 * to — the server will not guess a recipient, and a report is not a thing to
 * send to the wrong person.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ShareSheet({ rackId, onClose }) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(null);      // 'teams' | 'outlook' | 'link'
  const [note, setNote] = useState(null);      // { tone, text }
  const panelRef = useModalA11y(onClose, { active: true });

  const send = async (channel) => {
    const email = to.trim();
    if (!EMAIL_RE.test(email)) {
      setNote({ tone: 'bad', text: 'Enter the address to send it to.' });
      return;
    }
    setBusy(channel); setNote(null);
    try {
      const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/${channel}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body.error || `The server could not send it (HTTP ${r.status}).`);
      setNote({ tone: 'good', text: channel === 'teams' ? `Sent to ${email} on Teams.` : `Emailed to ${email}.` });
    } catch (e) {
      setNote({ tone: 'bad', text: e.message || 'It could not be sent.' });
    } finally {
      setBusy(null);
    }
  };

  const link = async () => {
    setBusy('link'); setNote(null);
    try {
      const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/report-token`));
      if (!r.ok) throw new Error('The server would not authorise a link.');
      const { token } = await r.json();
      const url = `${publicOrigin()}/api/scan/${encodeURIComponent(rackId)}`
        + `/report?format=html&t=${encodeURIComponent(token)}`;
      if (typeof navigator.share === 'function') {
        try { await navigator.share({ title: `RackTrack — ${rackId}`, url }); setNote(null); return; }
        catch (e) { if (e && e.name === 'AbortError') { setNote(null); return; } }
      }
      await navigator.clipboard.writeText(url);
      setNote({ tone: 'good', text: 'Link copied. It opens without an account for the next five minutes.' });
    } catch (e) {
      setNote({ tone: 'bad', text: e.message || 'The link could not be made.' });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className={styles.scrim} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Send this report">
        <div className={styles.head}>
          <h3>Send this report</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className={styles.field}>
          <span>Send it to</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@company.com"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>

        <div className={styles.ways}>
          <button type="button" className={styles.way} disabled={busy !== null} onClick={() => send('teams')}>
            <span className={styles.wayIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </span>
            <span className={styles.wayText}>
              <b>{busy === 'teams' ? 'Sending…' : 'Teams'}</b>
              <small>A chat from the RackTrack account, with the PDF</small>
            </span>
          </button>

          <button type="button" className={styles.way} disabled={busy !== null} onClick={() => send('outlook')}>
            <span className={styles.wayIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" /><polyline points="22,6 12,13 2,6" />
              </svg>
            </span>
            <span className={styles.wayText}>
              <b>{busy === 'outlook' ? 'Sending…' : 'Email'}</b>
              <small>From racktrackteam@sprintpark.com, PDF attached</small>
            </span>
          </button>

          <button type="button" className={styles.way} disabled={busy !== null} onClick={link}>
            <span className={styles.wayIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />
              </svg>
            </span>
            <span className={styles.wayText}>
              <b>{busy === 'link' ? 'Making a link…' : 'Link'}</b>
              <small>Opens without an account, for five minutes</small>
            </span>
          </button>
        </div>

        {note && <p className={note.tone === 'bad' ? styles.bad : styles.good}>{note.text}</p>}
      </div>
    </div>,
    document.body,
  );
}
