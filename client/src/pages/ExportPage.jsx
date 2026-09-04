import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';
import { useSmartBack } from '../hooks/useSmartBack';
import styles from './ExportPage.module.css';

/**
 * Export — the NetBox end of the chain.
 *
 * Scan → Physical → Network → Compare → Review → **Export** → Report.
 *
 * Preview always comes first and it writes nothing: the engineer sees exactly
 * what would change in the system of record before anything does. Push is
 * safe to run twice — every object carries a stable id, so a second run
 * updates rather than duplicates — and it never deletes. The CSV and JSON
 * files need no NetBox at all.
 *
 * Ported from RackTrack for NetBox. The route carries V1's rack id; the NetBox
 * side keeps its own numeric scan id, obtained (or created) once per visit with
 * POST /api/nb/scans/adopt/:rackId. The NetBox login itself belongs to the
 * organisation and lives under Data Sources — nobody standing at a rack is
 * asked for a token here. Connectors (ServiceNow, REST) are paused by the
 * owner and are deliberately not offered on this screen.
 */

const RULES = [
  { k: 'Idempotent', t: 'Safe to run twice. A second push updates what is there; it never makes duplicates.' },
  { k: 'Dry-run first', t: 'Preview reads NetBox and writes nothing. Push is only offered after a preview.' },
  { k: 'Never deletes', t: 'Nothing in NetBox is ever removed. A device missing from this scan is listed, not deleted.' },
  { k: 'Confidence becomes status', t: 'A cable we saw clearly arrives as connected; one we inferred arrives as planned. A conflict is held back for Review, never written.' },
];

const FILTERS = [
  ['all', 'All'],
  ['create', 'New'],
  ['update', 'Updated'],
  ['noop', 'Same'],
  ['skip', 'Held back'],
  ['fail', 'Failed'],
];

const ACTION_WORD = { create: 'new', update: 'update', noop: 'same', skip: 'held', fail: 'failed' };

/** One row per kind of object, counted by what is about to happen to it.
    The order is the order NetBox needs them written in, which is the order
    the operations already arrive in, so the overview reads as the plan. */
function byType(changes) {
  const rows = new Map();
  for (const ch of changes || []) {
    if (!rows.has(ch.type)) rows.set(ch.type, { type: ch.type, create: 0, update: 0, noop: 0, skip: 0, fail: 0 });
    const row = rows.get(ch.type);
    if (row[ch.action] !== undefined) row[ch.action] += 1;
  }
  return [...rows.values()];
}

/**
 * One round trip to the NetBox side of the server, through V1's authFetch.
 *
 * Never throws, and a failed request keeps the server's body: the 409s, 428s
 * and 502s carry the reason a step could not run, and that reason is the
 * thing the engineer needs to read.
 */
async function nb(path, opts = {}) {
  let res;
  try {
    res = await authFetch(apiUrl(path), opts);
  } catch (e) {
    // An AbortError here is our own deadline (see the adopt step), not the
    // network: say so, or a slow server reads as "no connection".
    const timedOut = e && e.name === 'AbortError';
    return {
      ok: false, status: 0,
      body: {
        error: timedOut
          ? 'The server took too long to answer. Check your connection and try again.'
          : 'Could not reach the server. Check your connection and try again.',
      },
    };
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body };
}

/** NetBox's own error detail is often an object, not a sentence. */
function errText(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e, null, 2); } catch { return String(e); }
}

/** The server's reason, plus what to do about it where the status tells us. */
function explain(r, fallback) {
  const raw = errText(r.body && r.body.error).trim() || fallback || '';
  const msg = raw ? raw[0].toUpperCase() + raw.slice(1) : fallback;
  if (r.status === 403) return 'Only the account owner can use the NetBox tools for now. Ask them to sign in and export this rack.';
  if (r.status === 409) return `${msg.replace(/\.$/, '')}. Analyse the rack photo first, then come back here.`;
  // Every :rackId and :id on the NetBox routes goes through the ownership
  // guard, which answers 404 for a rack the caller cannot see — so 404 here
  // is "not yours", not a missing route, and reopening the page won't help.
  if (r.status === 404) return 'This rack is not available to your account. Go back and choose a rack you can see.';
  return msg;
}

/** What the health check means, in the words on the card. */
function healthView(h) {
  if (!h) return null;
  if (h.configured === false) {
    return {
      tone: 'none', title: 'No NetBox connection yet',
      text: 'This organisation has not got a NetBox set up in Data Sources. An admin adds one there — its address and an API token — once, for everyone.',
      link: true,
    };
  }
  if (!h.reachable) {
    return { tone: 'bad', title: 'NetBox did not answer', text: h.error || `Nothing answered at ${h.url}.`, hint: h.hint, link: true };
  }
  if (!h.authenticated) {
    return { tone: 'warn', title: 'NetBox refused the login', text: h.error || 'The token was not accepted.', hint: h.hint, link: true };
  }
  return {
    tone: 'good', title: 'Connected to NetBox',
    text: `${h.url}${h.netboxVersion ? ` · version ${h.netboxVersion}` : ''}`,
  };
}

const when = (iso) => {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
};

/** The export stage is recorded on failure too (status 'failed'), so a
    ranAt alone does not mean anything ever reached NetBox. */
function pushLine(stage) {
  if (!stage || !stage.ranAt) return 'never pushed';
  if (stage.status === 'ok') return `last pushed ${when(stage.ranAt)}`;
  return `last push failed ${when(stage.ranAt)}`;
}

/** The one warning the writer phrases for developers, said for an engineer. */
const FIELD_ABSENT = 'NetBox does not have RackTrack’s id field yet, so nothing can be matched and everything below reads as new. The first push creates that field; previews after it will be accurate.';

/** How long adopt may take before the page stops waiting on it. */
const ADOPT_TIMEOUT_MS = 20_000;

export default function ExportPage() {
  const { rackId } = useParams();
  const goBack = useSmartBack(`/results/${encodeURIComponent(rackId)}`);

  const [scanId, setScanId] = useState(null);      // the NetBox-side scan for this rack
  const [scan, setScan] = useState(null);          // its record: summary + stages
  const [pageErr, setPageErr] = useState(null);    // adopt failed: nothing else can run

  const [health, setHealth] = useState(null);
  const [healthErr, setHealthErr] = useState(null);
  const [checking, setChecking] = useState(true);

  const [busy, setBusy] = useState(null);          // 'preview' | 'push'
  const [report, setReport] = useState(null);
  const [previewed, setPreviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runErr, setRunErr] = useState(null);      // { title, text, hint }

  const [detail, setDetail] = useState(false);
  const [filter, setFilter] = useState('all');

  const [fileBusy, setFileBusy] = useState(null);  // 'csv' | 'json'
  const [fileNote, setFileNote] = useState(null);  // { tone, text }

  // Is NetBox there, and does our login work? Independent of the scan, so it
  // starts at once rather than waiting on adopt.
  const checkHealth = useCallback(async () => {
    setChecking(true); setHealthErr(null);
    // A preview vouches only for the NetBox it was run against. Checking again
    // means that NetBox may have changed (a new target, a new token), so Push
    // waits for a fresh preview — and an open confirm dialog is closed rather
    // than left offering a push nobody has previewed.
    setPreviewed(false); setConfirming(false);
    const r = await nb('/api/nb/netbox/health');
    setChecking(false);
    if (!r.ok) { setHealth(null); setHealthErr(explain(r, 'Could not check the NetBox connection.')); return; }
    setHealth(r.body);
    // Preview can be tapped while this check is in flight (it is not disabled
    // by `checking`). If the answer is "not set up" or "login refused", that
    // preview spoke for a NetBox we cannot write to: it does not count.
    if (r.body.configured === false || !r.body.authenticated) setPreviewed(false);
  }, []);
  useEffect(() => { checkHealth(); }, [checkHealth]);

  // Step one: V1's rack id -> the NetBox side's scan id. Idempotent on the
  // server, so revisiting the page never makes a second scan.
  //
  // Every button on the page is locked until this answers, so it must answer:
  // a server that accepts the connection and then hangs would otherwise leave
  // grey buttons forever. Twenty seconds, then the request is abandoned and
  // the page says so. Leaving the page abandons it too.
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), ADOPT_TIMEOUT_MS);
    setScanId(null); setScan(null); setReport(null); setPreviewed(false);
    setConfirming(false); setRunErr(null); setPageErr(null); setFileNote(null);
    (async () => {
      const r = await nb(`/api/nb/scans/adopt/${encodeURIComponent(rackId)}`, { method: 'POST', signal: ctrl.signal });
      clearTimeout(deadline);
      if (!live) return;
      if (!r.ok || !r.body || r.body.id === undefined || r.body.id === null) {
        setPageErr(explain(r, 'Could not open this rack on the NetBox side. Go back and try again.'));
        return;
      }
      setScanId(r.body.id);
    })();
    return () => { live = false; clearTimeout(deadline); ctrl.abort(); };
  }, [rackId]);

  // The scan record: what is about to go out, and when it last went.
  const loadScan = useCallback(async (id) => {
    const s = await nb(`/api/nb/scans/${id}`);
    if (s.ok) setScan(s.body);
  }, []);
  useEffect(() => {
    if (scanId === null) return undefined;
    let live = true;
    (async () => {
      const s = await nb(`/api/nb/scans/${scanId}`);
      if (live && s.ok) setScan(s.body);
    })();
    return () => { live = false; };
  }, [scanId]);

  const hv = healthView(health);
  const configured = Boolean(health && health.configured !== false);
  const authed = Boolean(health && health.reachable && health.authenticated);
  const canTalk = configured && Boolean(health && health.reachable);
  const locked = Boolean(pageErr) || scanId === null;
  const adopting = scanId === null && !pageErr;   // adopt in flight: say so, don't just grey out

  async function run(kind) {
    setBusy(kind); setRunErr(null); setConfirming(false);
    const path = kind === 'preview' ? 'preview' : 'export';
    const r = await nb(`/api/nb/netbox/${scanId}/${path}`, { method: 'POST' });
    setBusy(null);
    if (!r.ok) {
      setReport(null);
      if (r.status === 428) {
        // The org's NetBox was removed between the health check and the tap.
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
    setDetail(false); setFilter('all');
    if (kind === 'preview') setPreviewed(true);
    loadScan(scanId);
  }

  // ── Files ────────────────────────────────────────────────────────────────
  // The web build saves through a blob URL like every other download in the
  // app. The packaged app's WebView ignores blob: URLs and <a download>, and we
  // will not put the login in a URL just to hand it to the system browser — so
  // on the phone the file goes to the share sheet (Files, AirDrop, mail) when
  // the WebView offers one, and the JSON falls back to the clipboard.
  async function download(kind) {
    setFileBusy(kind); setFileNote(null);
    const ext = kind === 'csv' ? 'csv' : 'json';
    const fallbackName = kind === 'csv'
      ? `${String(rackId).replace(/[^A-Za-z0-9_-]/g, '_')}-netbox-csv.zip`
      : `${String(rackId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
    try {
      let res;
      try {
        res = await authFetch(apiUrl(`/api/nb/netbox/${scanId}/export.${ext}`));
      } catch {
        throw new Error('Could not reach the server. Check your connection and try again.');
      }
      if (!res.ok) {
        const text = await res.text();
        let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
        throw new Error(explain({ ok: false, status: res.status, body }, 'The file could not be made.'));
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const name = m ? m[1] : fallbackName;
      setFileNote(await saveBlob(blob, name, kind));
    } catch (e) {
      setFileNote({ tone: 'bad', text: e.message || 'The download failed.' });
    } finally {
      setFileBusy(null);
    }
  }

  const c = (report && report.counts) || {};
  const changes = (report && report.changes) || [];
  const shownFilters = FILTERS.filter(([k]) => k !== 'fail' || c.fail);
  const pushCount = (c.create || 0) + (c.update || 0);
  const lastPush = scan && scan.stages && scan.stages.export;
  const summary = scan && scan.summary;

  return (
    <div className={`page page-full ${styles.page}`}>
      <header className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={goBack} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className={styles.title}>Export</h1>
        <ThemeToggle />
      </header>

      <div className={styles.scroll}>
        <div className={styles.intro}>
          <p>
            Send this rack to <strong>NetBox</strong>. Preview first — it reads NetBox and
            changes nothing — then push. Or download the files and import them yourself.
          </p>
          <p className={styles.introNote}>
            Rack <b>{scan?.rackName || rackId}</b>
            {scan?.siteName ? ` · ${scan.siteName}` : ''}
            {` · ${pushLine(lastPush)}`}
          </p>
          {adopting && (
            <p className={`${styles.introNote} ${styles.working}`}>
              <span className={styles.spinner} />
              Opening this rack…
            </p>
          )}
        </div>

        {/* ── The four rules, always in view ── */}
        <div className={styles.rules} aria-label="How export behaves">
          {RULES.map((r) => (
            <div key={r.k} className={styles.rule}>
              <b>{r.k}</b>
              <span>{r.t}</span>
            </div>
          ))}
        </div>

        {/* ── Adopt failed: the whole page is about this scan, so say so once ── */}
        {pageErr && (
          <div className={`${styles.note} ${styles.noteBad}`}>
            <h3>Could not open this rack</h3>
            <p>{pageErr}</p>
          </div>
        )}

        {/* ── What is going out ── */}
        {summary && (
          <div className={styles.summary}>
            <div><b>{summary.devices}</b><span>devices</span></div>
            <div><b>{summary.identified}</b><span>identified</span></div>
            <div><b>{summary.ports}</b><span>ports</span></div>
            <div><b>{summary.cables}</b><span>cables</span></div>
            {summary.conflicts > 0 && (
              <div className={styles.sumHold}><b>{summary.conflicts}</b><span>held back</span></div>
            )}
          </div>
        )}

        {/* ── NetBox ── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.who}>
              <h2>NetBox</h2>
              <p>The system of record this rack is written to.</p>
              <span className={`${styles.pill} ${
                checking ? styles.pillBusy
                  : healthErr || (hv && hv.tone === 'bad') ? styles.pillBad
                    : hv && hv.tone === 'good' ? styles.pillGood
                      : hv && hv.tone === 'warn' ? styles.pillWarn : ''}`}>
                {checking ? 'Checking…'
                  : healthErr ? 'Not available'
                    : hv ? (hv.tone === 'good' ? 'Connected' : hv.tone === 'none' ? 'Not set up' : hv.tone === 'warn' ? 'Login refused' : 'No answer')
                      : 'Unknown'}
              </span>
            </div>
            <div className={styles.cardTools}>
              <button type="button" className={styles.del} disabled={checking} onClick={checkHealth}>
                Check again
              </button>
            </div>
          </div>

          {healthErr && healthErr !== pageErr && (
            <div className={`${styles.note} ${styles.noteBad}`}>
              <h3>Could not check NetBox</h3>
              <p>{healthErr}</p>
            </div>
          )}

          {!checking && hv && hv.tone !== 'good' && (
            <div className={`${styles.note} ${hv.tone === 'none' ? styles.noteInfo : hv.tone === 'warn' ? styles.noteWarn : styles.noteBad}`}>
              <h3>{hv.title}</h3>
              <p>{hv.text}</p>
              {hv.hint && <p className={styles.hint}>{hv.hint}</p>}
              {hv.link && (
                <Link to="/connections" className={styles.linkBtn}>Open Data Sources</Link>
              )}
              <p className={styles.hint}>The file downloads below still work — they need no connection and no token.</p>
            </div>
          )}

          {!checking && hv && hv.tone === 'good' && (
            <p className={styles.connected}>
              <span className={styles.dotGood} />
              {hv.text}
            </p>
          )}

          {confirming ? (
            <div className={styles.confirm}>
              <p>
                {report?.dryRun
                  ? <>Write <b>{pushCount}</b> change{pushCount === 1 ? '' : 's'} to NetBox at <b>{health?.url}</b>?</>
                  : <>Push this rack to NetBox at <b>{health?.url}</b> again?</>}
                {' '}Anything already correct is left alone. Nothing will be deleted.
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>Cancel</button>
                <button type="button" className={styles.primary} onClick={() => run('push')}>Yes, push</button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={locked || busy !== null || !canTalk}
                onClick={() => run('preview')}
              >
                {busy === 'preview' ? 'Reading NetBox…' : 'Preview changes'}
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={locked || busy !== null || !authed || !previewed}
                onClick={() => setConfirming(true)}
              >
                {busy === 'push' ? 'Writing…' : 'Push to NetBox'}
              </button>
            </div>
          )}

          {!previewed && authed && !locked && !confirming && (
            <p className={styles.fieldNote}>Push opens after a preview, so you always see the change list first.</p>
          )}

          {busy && (
            <p className={styles.working}>
              <span className={styles.spinner} />
              {busy === 'preview' ? 'Comparing this scan with NetBox' : 'Writing to NetBox'}…
            </p>
          )}

          {runErr && (
            <div className={`${styles.note} ${styles.noteBad}`}>
              <h3>{runErr.title}</h3>
              {runErr.text && (/^[[{]/.test(String(runErr.text).trim())
                ? <pre className={styles.pre}>{runErr.text}</pre>
                : <p>{runErr.text}</p>)}
              {runErr.hint && <p className={styles.hint}>{runErr.hint}</p>}
            </div>
          )}
        </section>

        {/* ── The report: preview or written ── */}
        {report && (
          <section className={styles.card}>
            <div className={`${styles.note} ${report.dryRun ? styles.noteInfo : styles.noteGood}`}>
              <h3>{report.dryRun ? 'Preview only. Nothing was written.' : 'Written to NetBox'}</h3>
              <p>
                {report.dryRun
                  ? 'This is exactly what Push would do.'
                  : 'Run Preview again and every line should read “same”.'}
              </p>
            </div>

            <div className={styles.tiles}>
              <div className={`${styles.tile} ${c.create ? styles.tileNew : ''}`}><b>{c.create || 0}</b><span>{report.dryRun ? 'to create' : 'created'}</span></div>
              <div className={`${styles.tile} ${c.update ? styles.tileUpd : ''}`}><b>{c.update || 0}</b><span>{report.dryRun ? 'to update' : 'updated'}</span></div>
              <div className={styles.tile}><b>{c.noop || 0}</b><span>no change</span></div>
              <div className={`${styles.tile} ${c.skip ? styles.tileHold : ''}`}><b>{c.skip || 0}</b><span>held back</span></div>
              {Boolean(c.fail) && (
                <div className={`${styles.tile} ${styles.tileFail}`}><b>{c.fail}</b><span>failed</span></div>
              )}
            </div>

            {Boolean(c.fail) && (
              <div className={`${styles.note} ${styles.noteBad}`}>
                <h3>{c.fail} object{c.fail === 1 ? '' : 's'} failed</h3>
                <p>Nothing was deleted and the rest went through. Fix the cause and run it again; repeating the push is safe.</p>
              </div>
            )}

            {report.customField === 'ABSENT' && (
              <div className={`${styles.note} ${styles.noteWarn}`}>
                <p>{FIELD_ABSENT}</p>
              </div>
            )}
            {(report.warnings || [])
              .filter((w) => !(report.customField === 'ABSENT' && /custom field does not exist/i.test(w)))
              .map((w) => (
                <div key={w} className={`${styles.note} ${styles.noteWarn}`}><p>{w}</p></div>
              ))}

            {/* Overview first: which KINDS of thing change and by how much.
                The line-by-line is for when one of those numbers looks wrong. */}
            <div className={styles.subHead}>
              <h3>What changes</h3>
              <button type="button" className={styles.copy} onClick={() => setDetail((v) => !v)}>
                {detail ? 'By object' : `Every operation (${changes.length})`}
              </button>
            </div>

            {!detail && (
              <div className={styles.scrollx}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Object</th>
                      <th className={styles.num}>New</th>
                      <th className={styles.num}>Upd.</th>
                      <th className={styles.num}>Same</th>
                      <th className={styles.num}>Held</th>
                      {Boolean(c.fail) && <th className={styles.num}>Fail</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {byType(changes).map((r) => (
                      <tr key={r.type}>
                        <td>{r.type}</td>
                        <td className={styles.num}>{r.create ? <b className={styles.tNew}>{r.create}</b> : <span className={styles.zero}>0</span>}</td>
                        <td className={styles.num}>{r.update ? <b className={styles.tUpd}>{r.update}</b> : <span className={styles.zero}>0</span>}</td>
                        <td className={styles.num}>{r.noop || <span className={styles.zero}>0</span>}</td>
                        <td className={styles.num}>{r.skip ? <b className={styles.tHold}>{r.skip}</b> : <span className={styles.zero}>0</span>}</td>
                        {Boolean(c.fail) && (
                          <td className={styles.num}>{r.fail ? <b className={styles.tFail}>{r.fail}</b> : <span className={styles.zero}>0</span>}</td>
                        )}
                      </tr>
                    ))}
                    {changes.length === 0 && (
                      <tr><td colSpan={c.fail ? 6 : 5} className={styles.zero}>Nothing to write for this scan.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!detail && report.orphans?.length > 0 && (
              <div className={styles.orphans}>
                <h4>In NetBox, absent from this scan <span className={styles.count}>{report.orphans.length}</span></h4>
                <p className={styles.hint}>Not deleted. Set a device offline only after someone has checked the rack.</p>
                <ul>
                  {report.orphans.map((o) => (
                    <li key={o.uid || o.name}><b>{o.name}</b>{o.status ? <em> · {o.status} in NetBox</em> : null}</li>
                  ))}
                </ul>
              </div>
            )}

            {detail && (
              <>
                <div className={styles.seg} role="radiogroup" aria-label="Show which operations">
                  {shownFilters.map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={filter === k}
                      className={`${styles.segBtn} ${filter === k ? styles.segOn : ''}`}
                      onClick={() => setFilter(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className={styles.diffList}>
                  {changes
                    .filter((ch) => filter === 'all' || ch.action === filter)
                    .map((ch) => {
                      const fields = ch.diff && Object.keys(ch.diff);
                      return (
                        <div key={`${ch.type}-${ch.uid}`} className={styles.diffRow}>
                          <span className={`${styles.diffAction} ${styles[`act_${ch.action}`] || ''}`}>
                            {ACTION_WORD[ch.action] || ch.action}
                          </span>
                          <span className={styles.diffMain}>
                            <span className={styles.diffName}>{ch.name}</span>
                            <span className={styles.diffType}>{ch.type}</span>
                          </span>
                          {(ch.reason || (fields && fields.length > 0)) && (
                            <span className={styles.diffWhy}>
                              {ch.reason || fields.join(', ')}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  {changes.filter((ch) => filter === 'all' || ch.action === filter).length === 0 && (
                    <p className={styles.zero}>No operations of that kind.</p>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Files: the path that needs no token ── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.who}>
              <h2>Files</h2>
              <p>No NetBox connection needed. Import them yourself, or keep them as the record.</p>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={locked || fileBusy !== null}
              onClick={() => download('csv')}
            >
              <DownloadIcon />
              {fileBusy === 'csv' ? 'Preparing…' : 'NetBox CSV (zip)'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={locked || fileBusy !== null}
              onClick={() => download('json')}
            >
              <DownloadIcon />
              {fileBusy === 'json' ? 'Preparing…' : 'JSON'}
            </button>
          </div>
          <p className={styles.fieldNote}>
            The zip holds one CSV per object type in the order NetBox needs them, with a README.
            Import each under its own type in NetBox (Import → CSV).
          </p>
          {fileNote && (
            <div className={`${styles.note} ${fileNote.tone === 'good' ? styles.noteGood : styles.noteBad}`}>
              <p>{fileNote.text}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/**
 * Put a file the server just sent into the engineer's hands.
 *
 * Returns the note to show, or null when the person dismissed the share sheet
 * themselves (that is not an error and should not read as one).
 */
async function saveBlob(blob, name, kind) {
  const native = Capacitor.isNativePlatform();

  if (!native) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { tone: 'good', text: `Saved ${name}.` };
  }

  // Packaged app: hand the file to the share sheet when the WebView has one.
  try {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (typeof navigator.share === 'function' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return { tone: 'good', text: `${name} is on the share sheet — save it to Files or send it on.` };
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
      }
    }
  } catch { /* File or share unavailable — fall through */ }

  if (kind === 'json') {
    try {
      await navigator.clipboard.writeText(await blob.text());
      return { tone: 'good', text: 'This phone cannot save files from inside the app, so the JSON was copied to your clipboard instead. Paste it wherever you keep the record.' };
    } catch { /* clipboard refused too */ }
  }
  return {
    tone: 'bad',
    text: 'This phone cannot save files from inside the app. Open RackTrack in a browser on a computer and download it from there — the same button is there.',
  };
}
