import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useModalA11y from '../hooks/useModalA11y.js';
import { apiUrl, authFetch, publicOrigin } from '../utils/api';
import styles from './ShareSheet.module.css';

/**
 * Send this report to somebody.
 *
 * Three ways: a Teams message and an email, both sent by the server from the
 * RackTrack mailbox with the PDF attached; and a link, for anyone who is not
 * in the tenant. The way is picked at the top; below it is the one thing
 * that way needs (an address) and a Send button right under it, so the
 * button is on screen while the keyboard is up.
 *
 * The two Microsoft ones need an address because that is who the message goes
 * to — the server will not guess a recipient, and a report is not a thing to
 * send to the wrong person.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const WAYS = [
  { id: 'teams',   label: 'Teams', hint: 'A chat from the RackTrack account, with the PDF attached.' },
  { id: 'outlook', label: 'Email', hint: 'From racktrackteam@sprintpark.com, with the PDF attached.' },
  { id: 'link',    label: 'Link',  hint: 'Opens without an account, for the next five minutes.' },
];

export default function ShareSheet({ rackId, onClose, initial = null }) {
  const [way, setWay] = useState(WAYS.some(w => w.id === initial) ? initial : 'teams');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);      // { tone, text }
  const panelRef = useModalA11y(onClose, { active: true });
  const inputRef = useRef(null);

  const needsAddress = way !== 'link';
  const addressOk = EMAIL_RE.test(to.trim());

  const send = async () => {
    const email = to.trim();
    if (!EMAIL_RE.test(email)) {
      setNote({ tone: 'bad', text: 'Enter the address to send it to.' });
      inputRef.current?.focus();
      return;
    }
    setBusy(true); setNote(null);
    try {
      const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/${way}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body.error || `The server could not send it (HTTP ${r.status}).`);
      setNote({ tone: 'good', text: way === 'teams' ? `Sent to ${email} on Teams.` : `Emailed to ${email}.` });
    } catch (e) {
      setNote({ tone: 'bad', text: e.message || 'It could not be sent.' });
    } finally {
      setBusy(false);
    }
  };

  const link = async () => {
    setBusy(true); setNote(null);
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
      setBusy(false);
    }
  };

  // Opened from "Share → Link": nothing to type, so do it straight away.
  useEffect(() => { if (initial === 'link') link(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (e) => { e.preventDefault(); if (busy) return; needsAddress ? send() : link(); };
  const current = WAYS.find(w => w.id === way);

  return createPortal(
    <div className={styles.scrim} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={panelRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Send this report" onSubmit={onSubmit}>
        <div className={styles.head}>
          <h3>Send this report</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.seg} role="tablist" aria-label="How to send it">
          {WAYS.map(w => (
            <button key={w.id} type="button" role="tab" aria-selected={way === w.id}
              className={`${styles.segBtn} ${way === w.id ? styles.segOn : ''}`}
              disabled={busy} onClick={() => { setWay(w.id); setNote(null); }}>
              {w.label}
            </button>
          ))}
        </div>

        <p className={styles.hint}>{current.hint}</p>

        {needsAddress && (
          <label className={styles.field}>
            <span>Send it to</span>
            <input
              ref={inputRef}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@company.com"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="send"
              autoFocus
            />
          </label>
        )}

        <button type="submit" className={styles.primary} disabled={busy || (needsAddress && !addressOk)}>
          {busy
            ? (needsAddress ? 'Sending…' : 'Making a link…')
            : (way === 'teams' ? 'Send on Teams' : way === 'outlook' ? 'Send the email' : 'Copy the link')}
        </button>

        {note && <p className={note.tone === 'bad' ? styles.bad : styles.good} role="status">{note.text}</p>}
      </form>
    </div>,
    document.body,
  );
}
