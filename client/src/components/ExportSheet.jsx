import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import useModalA11y from '../hooks/useModalA11y.js';
import { nb, explain, errText, healthView } from '../utils/exportApi';
import { getCached, setCached } from '../utils/scanPrefetch';
import styles from './ExportSheet.module.css';

/**
 * Push this rack into NetBox, from the report.
 *
 * Preview always comes first and it writes nothing: the engineer sees exactly
 * what would change in the system of record before anything does. Push is
 * safe to run twice — every object carries a stable id, so a second run
 * updates rather than duplicates — and it never deletes.
 *
 * This was a page of its own. It is a sheet now, because everything it needs
 * is on the report and walking to a second screen to press two buttons is not
 * a step, it is a detour.
 */


const ORDER = [['create', 'new'], ['update', 'updated'], ['noop', 'same'], ['skip', 'held back'], ['fail', 'failed']];

/** One row per kind of object, counted by what is about to happen to it. */
function byType(changes) {
  const rows = new Map();
  for (const ch of changes || []) {
    if (!rows.has(ch.type)) rows.set(ch.type, { type: ch.type, create: 0, update: 0, noop: 0, skip: 0, fail: 0 });
    const row = rows.get(ch.type);
    if (row[ch.action] !== undefined) row[ch.action] += 1;
  }
  return [...rows.values()];
}

export default function ExportSheet({ scanId, rackId, onClose }) {
  const [health, setHealth] = useState(null);
  const [healthErr, setHealthErr] = useState(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(null);          // 'preview' | 'push'
  const [report, setReport] = useState(null);
  const [previewed, setPreviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runErr, setRunErr] = useState(null);
  const [comparedAt, setComparedAt] = useState(null);   // when the shown preview was taken
  const [written, setWritten] = useState(false);

  const panelRef = useModalA11y(onClose, { active: true });

  // The report compared with NetBox in the background when it opened; if
  // that answer is here, show it at once. Otherwise compare now, unasked —
  // the preview writes nothing and is the first thing anyone would press.
  useEffect(() => {
    const pre = scanId ? getCached(`nb-preview:${scanId}`) : null;
    if (pre && pre.body) { setReport(pre.body); setPreviewed(true); setComparedAt(pre.at); return; }
    if (scanId) run('preview');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId]);

  // Is NetBox there, and does our login work?
  const checkHealth = useCallback(async () => {
    setChecking(true); setHealthErr(null);
    // A preview vouches only for the NetBox it was run against.
    setPreviewed(false); setConfirming(false);
    const r = await nb('/api/nb/netbox/health');
    setChecking(false);
    if (!r.ok) { setHealth(null); setHealthErr(explain(r, 'Could not check the NetBox connection.')); return; }
    setHealth(r.body);
  }, []);
  useEffect(() => { checkHealth(); }, [checkHealth]);

  const run = async (kind) => {
    setBusy(kind); setRunErr(null); setConfirming(false);
    const r = await nb(`/api/nb/netbox/${scanId}/${kind === 'preview' ? 'preview' : 'export'}`, { method: 'POST' });
    setBusy(null);
    if (!r.ok) {
      setReport(null);
      if (r.status === 428) {
        setRunErr({ title: 'No NetBox connection', text: r.body.error, hint: r.body.hint });
        checkHealth();
      } else if (r.status === 502) {
        setRunErr({
          title: kind === 'preview' ? 'NetBox could not be read' : 'NetBox refused the write',
          text: errText(r.body.error),
          hint: 'Nothing was deleted. Fix the cause and run it again; repeating is safe.',
        });
      } else {
        setRunErr({ title: kind === 'preview' ? 'Preview did not run' : 'Push did not run', text: explain(r, 'Something went wrong.') });
      }
      return;
    }
    setReport(r.body);
    if (kind === 'preview') {
      setPreviewed(true); setComparedAt(Date.now());
      setCached(`nb-preview:${scanId}`, { body: r.body, at: Date.now() });
    } else {
      setWritten(true);
      setCached(`nb-preview:${scanId}`, null);
    }
  };

  const openUrl = health && health.publicUrl
    ? `${health.publicUrl}/dcim/racks/?q=${encodeURIComponent(rackId || '')}`
    : null;
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

  const hv = healthView(health);
  const authed = Boolean(health && health.reachable && health.authenticated);
  const c = (report && report.counts) || {};
  const pushCount = (c.create || 0) + (c.update || 0);

  return createPortal(
    <div className={styles.scrim} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label="Export to NetBox">
        <div className={styles.head}>
          <h3>Export to NetBox</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.body}>
          {checking && <p className={styles.note}>Checking the NetBox connection…</p>}
          {healthErr && <p className={`${styles.note} ${styles.bad}`}>{healthErr}</p>}
          {hv && (
            <div className={`${styles.health} ${styles[hv.tone]}`}>
              <b>{hv.title}</b>
              <span>{hv.text}</span>
              {hv.hint && <span className={styles.hint}>{hv.hint}</span>}
            </div>
          )}

          {runErr && (
            <div className={`${styles.health} ${styles.bad}`}>
              <b>{runErr.title}</b>
              <span>{runErr.text}</span>
              {runErr.hint && <span className={styles.hint}>{runErr.hint}</span>}
            </div>
          )}

          {report && (
            <>
              <p className={styles.note}>
                {written ? 'Written to NetBox.' : `Compared with NetBox ${comparedAt ? ago(comparedAt) : ''}.`}
                {openUrl && (
                  <> <a href={openUrl} target="_blank" rel="noreferrer noopener" className={styles.openLink}>Open NetBox ↗</a></>
                )}
              </p>
              <div className={styles.tally}>
                {ORDER.filter(([k]) => c[k]).map(([k, word]) => (
                  <div key={k}><b>{c[k]}</b><span>{word}</span></div>
                ))}
                {!ORDER.some(([k]) => c[k]) && <div><b>0</b><span>changes</span></div>}
              </div>
              <ul className={styles.types}>
                {byType(report.changes).map((row) => (
                  <li key={row.type}>
                    <span className={styles.typeName}>{row.type}</span>
                    <span className={styles.typeCounts}>
                      {ORDER.filter(([k]) => row[k]).map(([k, word]) => `${row[k]} ${word}`).join(' · ') || 'nothing'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

        </div>

        {confirming ? (
          <div className={styles.confirm}>
            <p>Write {pushCount} object{pushCount === 1 ? '' : 's'} to NetBox?</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>Not yet</button>
              <button type="button" className={styles.primary} onClick={() => run('push')}>Write them</button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button" className={styles.secondary}
              disabled={busy !== null || !authed}
              onClick={() => run('preview')}
            >
              {busy === 'preview' ? 'Comparing…' : previewed ? 'Preview again' : 'Preview'}
            </button>
            <button
              type="button" className={styles.primary}
              disabled={busy !== null || !previewed || pushCount === 0}
              onClick={() => setConfirming(true)}
            >
              {busy === 'push' ? 'Writing…' : `Push${pushCount ? ` ${pushCount}` : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
