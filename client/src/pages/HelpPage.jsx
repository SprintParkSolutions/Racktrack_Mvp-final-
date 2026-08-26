// Help — the full-screen home for DOT, the RackTrack assistant.
//
// The floating panel (SupportBot) is for when you are mid-task and need one
// answer. This page is for when you came here to ask something.
//
// Two things drive the design:
//
//   1. When Assist is unsure it offers a numbered list and asks you to "reply
//      with the number". Making people type a number into a chat box is poor
//      on a phone, so the list renders as buttons. Tapping one sends that
//      question verbatim, which the server matches exactly and answers from
//      the verified text — no guessing in between.
//
//   2. Every reply is labelled with how it was produced: answered from
//      verified documentation, unsure, or declined. A support bot that looks
//      equally confident whether it knows or not is worse than no bot.
//
// The retrieval diagnostics (route, entry ids, latency) are hidden behind a
// toggle. They were on screen for everyone, so users saw lines like
// "suggestions MKT-012, ACCT-001 4ms" under their answer, which reads as an
// error and means nothing to them.

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { useTheme } from '../ThemeContext.jsx';
import { useTour } from '../TourContext.jsx';
import BackButton from '../components/BackButton.jsx';
import styles from './HelpPage.module.css';

const STARTERS = [
  "I can't sign in",
  'My scan came back empty',
  'Where did my earlier scans go?',
  'How do I export a report?',
  'Why is my device showing the wrong model?',
  'Do I need internet to scan?',
];

// Routes where Assist did not answer. Shown differently so a decline is never
// mistaken for advice.
const DECLINED = new Set(['refusal', 'out-of-scope', 'needs-access']);
const UNSURE = new Set(['suggestions', 'clarify']);

/** How a reply should be labelled, in the user's language rather than ours. */
function badgeFor(route) {
  if (DECLINED.has(route)) return { label: 'No verified answer', kind: 'declined' };
  if (UNSURE.has(route)) return { label: 'Not sure yet', kind: 'unsure' };
  if (route === 'credential-guard') return { label: 'Security notice', kind: 'declined' };
  if (route === 'grounded') return { label: 'Composed from documentation', kind: 'ok' };
  if (route === 'verbatim') return { label: 'Verified answer', kind: 'ok' };
  return null;
}

/**
 * Split a suggestions reply into its lead-in and the numbered options, so the
 * options can be rendered as real controls. Falls back to plain text whenever
 * the shape is not what we expect — never lose the message trying to prettify it.
 */
function parseOptions(text) {
  const lines = String(text || '').split('\n');
  const opts = [];
  const lead = [];
  let trailing = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,2})[.)]\s+(.*\S)\s*$/);
    if (m) { opts.push(m[2]); trailing = []; }
    else if (opts.length) { if (line.trim()) trailing.push(line.trim()); }
    else if (line.trim()) lead.push(line.trim());
  }
  if (opts.length < 2) return null;
  return { lead: lead.join(' '), options: opts, trailing: trailing.join(' ') };
}

export default function HelpPage() {
  const navigate = useNavigate();
  // Null outside TourProvider, so the replay entry simply doesn't render.
  const startTour = useTour()?.startTour;
  const [status, setStatus] = useState(null); // null = checking
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  // Retrieval diagnostics are ours, not the user's. Behind ?debug=1 rather than
  // a visible control, so a tester never meets them by accident.
  const showDiag = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('debug');
  // Each logo has its background baked in, so the wrong one shows as a black
  // square on a white bar (or the reverse) rather than just looking off.
  const { theme } = useTheme();
  const dotLogo = theme === 'dark' ? '/dark_DOT.png' : '/white_DOT.png';

  const logRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(apiUrl('/api/support/status'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setStatus(d || { ok: false }); })
      .catch(() => { if (!cancelled) setStatus({ ok: false }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, pending, expanded]);

  useEffect(() => { inputRef.current?.focus(); }, [status]);

  const send = useCallback(async (text) => {
    const question = String(text || '').trim();
    if (!question || pending) return;

    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setDraft('');
    setPending(true);

    const started = Date.now();
    try {
      // `sources` goes back too: when Assist offers a numbered list and the
      // user replies "2", the server resolves that number against the ids it
      // offered. Without them the number means nothing and the reply Assist
      // explicitly asked for produces a refusal.
      const history = messages.slice(-6).map((m) => ({
        role: m.role, content: m.content, sources: m.sources || undefined,
      }));
      const res = await authFetch(apiUrl('/api/support/ask'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
      });

      if (!res.ok) {
        // Read the body before deciding what to say: on a 429 the server sends
        // the real limit and how long to wait. This used to hardcode "give it
        // a few seconds", which was simply wrong — the wait can be minutes.
        let err = null;
        try { err = await res.json(); } catch { /* non-JSON error body */ }
        setMessages((prev) => [...prev, {
          role: 'assistant',
          route: 'refusal',
          content: res.status === 429
            ? (err?.message || 'That was a lot of questions at once. Try again shortly.')
            : 'DOT is unavailable right now.',
        }]);
        return;
      }

      const data = await res.json();
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: data.answer,
        detail: data.detail || null,
        route: data.route,
        sources: data.sources || [],
        ms: data.ms ?? Date.now() - started,
      }]);
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        route: 'refusal',
        content: 'Could not reach DOT. Check your connection and try again.',
      }]);
    } finally {
      setPending(false);
    }
  }, [messages, pending]);

  const toggleDetail = (i) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const parsed = useMemo(
    () => messages.map((m) => (m.role === 'assistant' && UNSURE.has(m.route) ? parseOptions(m.content) : null)),
    [messages],
  );

  if (status && !status.ok) {
    return (
      <div className={styles.page}>
        <div className={styles.unavailable}>
          <h2>Help is unavailable</h2>
          <p>DOT isn&apos;t running right now. Please contact your RackTrack administrator.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        {/* Every other destination reached from the menu has a back control;
            Help was the one that did not, so it was a dead end. */}
        <BackButton fallback="/scan" always />
        <span className={styles.mark} aria-hidden="true">
          <img src={dotLogo} alt="" />
        </span>
        <div className={styles.headText}>
          <h1 className={styles.title}>DOT</h1>
        </div>

        {/* A permanent way through to a human.
            Contact used to be reachable only from the phone's More menu, which
            testers reported as not knowing it was there — and the one link to
            it from this page appeared solely when DOT failed to answer, so a
            user who simply preferred a person had no route. The bottom bar is
            full at five slots, and Ask DOT now has a button on the home screen,
            so putting it here makes Contact two taps from home, always. */}
        <button
          type="button"
          className={styles.headContact}
          onClick={() => navigate('/contact')}
        >
          Contact support
        </button>

      </header>

      <div className={styles.log} ref={logRef}>
        <div className={styles.inner}>
          {messages.length === 0 && (
            <div className={styles.intro}>
              <div className={styles.introRule} aria-hidden="true" />
              <h2>Hello! I&apos;m the RackTrack support assistant.</h2>
              <p>
                Ask me anything about using RackTrack - scans, racks, switches,
                reports, your account - and I&apos;ll answer from our verified
                help content.
              </p>
              <div className={styles.startersLabel}>Common questions</div>
              <div className={styles.starters}>
                {STARTERS.map((s) => (
                  <button key={s} type="button" className={styles.starter} onClick={() => send(s)}>
                    {s}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </div>

              {/* Way back into the guided walkthrough. The first-run prompt is
                  shown once per device and then never again, so without this
                  there was no route back to it short of clearing site data. */}
              {startTour && (<>
                <div className={styles.startersLabel} style={{ marginTop: 22 }}>New here?</div>
                <button type="button" className={styles.starter} onClick={startTour}>
                  Take the guided tour
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </>)}
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === 'user') {
              return (
                <div key={i} className={`${styles.row} ${styles.me}`}>
                  <div className={styles.meBubble}>{m.content}</div>
                </div>
              );
            }

            const opts = parsed[i];

            return (
              <div key={i} className={`${styles.row} ${styles.bot}`}>
                <div className={styles.card}>
                  {opts ? (
                    <>
                      {opts.lead && <p className={styles.lead}>{opts.lead}</p>}
                      <div className={styles.options}>
                        {opts.options.map((o, n) => (
                          <button
                            key={n}
                            type="button"
                            className={styles.option}
                            onClick={() => send(o)}
                            disabled={pending}
                          >
                            <span className={styles.optionNum}>{n + 1}</span>
                            <span className={styles.optionText}>{o}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </button>
                        ))}
                      </div>
                      <p className={styles.hint}>Tap one, or rephrase your question below.</p>
                    </>
                  ) : (
                    <div className={styles.answer}>{m.content}</div>
                  )}

                  {DECLINED.has(m.route) && (
                    <div className={styles.escape}>
                      Still stuck?{' '}
                      {/* Can't answer → hand off to the Contact page, pre-filled
                          with the question DOT couldn't handle. */}
                      <button
                        type="button"
                        onClick={() => navigate('/contact', { state: { context: messages[i - 1]?.content || '' } })}
                      >
                        Contact support
                      </button>
                    </div>
                  )}

                  {showDiag && m.route && (
                    <div className={styles.debug}>
                      <b>{m.route}</b>
                      {m.sources?.length > 0 && <span>{m.sources.join(' · ')}</span>}
                      {m.ms != null && <span>{m.ms}ms</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {pending && (
            <div className={`${styles.row} ${styles.bot}`}>
              <div className={`${styles.card} ${styles.thinking}`}>
                <span className={styles.dots} aria-label="Searching the documentation">
                  <i /><i /><i />
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        <div className={styles.formInner}>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about scans, racks, ports, reports…"
            maxLength={1000}
            autoComplete="off"
            aria-label="Your question"
          />
          <button type="submit" className={styles.send} disabled={pending || !draft.trim()} aria-label="Ask">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
