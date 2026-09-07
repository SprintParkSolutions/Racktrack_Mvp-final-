import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { BackIcon } from '../components/BackButton.jsx';
import { apiUrl, authFetch } from '../utils/api';
import ExportSheet from '../components/ExportSheet.jsx';
import ShareSheet from '../components/ShareSheet.jsx';
import { downloadExport } from '../utils/exportApi';
import { getJSON } from '../utils/safeStorage';
import { useSmartBack } from '../hooks/useSmartBack';
import styles from './ReportPage.module.css';

/**
 * Report — the rack and its network on one page.
 *
 * Scan → Physical → Network → **Report**. The report is the end of the chain:
 * downloading it, pushing it to NetBox and sending it to somebody all happen
 * here, because they are all things you do with the report you are reading.
 *
 * Two witnesses, joined and read-only. The camera gives the layout: which box
 * sits in which U, and what was read off its bezel. A switch reading gives the
 * live truth about that box: its own make, model and serial, every port's
 * state and VLAN, and who it hears on the other end of each cable. Where the
 * two were matched (in Review, on the NetBox side), a device shows both; where
 * they were not, it shows the camera's view and says so.
 *
 * Every value here has a named source. Nothing is filled in.
 *
 * Ported from RackTrack for NetBox. The route carries V1's rack id; the NetBox
 * side keeps its own numeric scan id, obtained (or created) once per visit with
 * POST /api/nb/scans/adopt/:rackId — the same call Export makes.
 */

/**
 * One round trip to the NetBox side of the server, through V1's authFetch.
 * Never throws; a failed request keeps the server's body, because the 409s
 * carry the reason a step could not run and that reason is what gets shown.
 */
async function nb(path, opts = {}) {
  let res;
  try {
    res = await authFetch(apiUrl(path), opts);
  } catch {
    return {
      ok: false, status: 0,
      body: { error: 'Could not reach the server. Check your connection and try again.' },
    };
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body };
}

/** The server's reason, said once, with what to do where the status tells us. */
function explain(r, fallback) {
  const raw = String((r.body && r.body.error) || '').trim();
  const msg = raw ? raw[0].toUpperCase() + raw.slice(1) : fallback;
  if (r.status === 403) return 'Only the account owner can open the NetBox tools for now. Ask them to sign in and open this report.';
  if (r.status === 404) return 'This rack could not be found on the NetBox side. Go back to the rack and open Report again.';
  return msg.endsWith('.') ? msg : `${msg}.`;
}

const IconDownload = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const IconSend = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);
const IconExport = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
    <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
  </svg>
);

/** Uptime in seconds, as something a person would say. */
function uptimeText(secs) {
  const n = Number(secs || 0);
  if (!n) return '';
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  if (d > 0) return `up ${d} day${d === 1 ? '' : 's'}`;
  if (h > 0) return `up ${h} hour${h === 1 ? '' : 's'}`;
  return `up ${Math.max(1, Math.floor(n / 60))} min`;
}

const when = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
};

// "Unknown" is the camera's word for a make it could not read; "enterprise
// 11863" is SNMP's for a vendor number we could not name. Both are absences.
const noMake = (s) => !s || /^unknown$/i.test(s) || /^enterprise\s*\d+$/i.test(s);
// "Unidentified Switch (24-port)" is the camera's placeholder, not a model.
const noModel = (s) => !s || /^unidentified\b/i.test(s);
const said = (make, model) => [noMake(make) ? '' : make, noModel(model) ? '' : model].filter(Boolean).join(' ');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

/**
 * The camera names a placed device by its class and U ("Switch U12"). Next to
 * a U badge that repeats itself, so the row shows the class alone; a name a
 * person gave is kept exactly.
 */
function titleOf(d) {
  if (d.role && d.u != null && d.name === `${d.role} U${d.u}`) return d.role;
  return d.name || d.role || 'Device';
}

const speedText = (mbps) => (!mbps ? '' : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

/** What the camera saw of a cable on a port, reconciled with what the switch shows. */
function cableText(p) {
  if (p.cableColor) return `${p.cableColor}${p.cableType ? ` ${p.cableType}` : ''} cable`;
  if (p.plugged) return 'cabled';
  const live = p.state === 'up' || (p.hosts && p.hosts.length > 0) || Boolean(p.neighbour);
  // The switch proves the port is in use; the camera caught no cable (thin
  // lead, glare, a bend out of frame). Trust the switch, and say who missed it.
  if (live) return p.plugged === false ? 'cabled · camera missed it' : '';
  if (p.plugged === false) return 'empty';
  return '';
}

const PROOF = {
  lldp_both: 'both ends agree',
  lldp_one: 'one end says so',
  manual: 'typed by a person',
};
const proofText = (ev) => PROOF[ev] || String(ev || '').replace(/_/g, ' ');

/**
 * Everything the page says that is not read straight off the report: which
 * words are the camera's and which the switch's, what was heard but not
 * proven, and the list of things nobody has stated.
 *
 * `doc` is the report (confirmed matches only). `view` is the Review picture
 * for the same scan, optional: it carries the camera's un-merged identity per
 * device and each filed switch's own headline facts. Its suggested matches
 * are never used — a proposal is not a fact.
 */
function derive(doc, view) {
  const devices = doc.devices || [];
  const camByName = new Map((view?.devices || []).map((d) => [d.name, d]));
  const uidToName = new Map((view?.devices || []).map((d) => [d.uid, d.name]));
  const confirmed = Boolean(view) && !view.suggested;

  const swByDevName = new Map();
  if (confirmed) {
    for (const sw of view.switches || []) {
      if (!sw.read || !sw.matchedTo) continue;
      const name = uidToName.get(sw.matchedTo);
      if (name) swByDevName.set(name, sw);
    }
  }

  const filed = view?.switches || [];
  const read = filed.filter((s) => s.read);
  const up = devices.reduce((n, d) => n + (d.portsUp || 0), 0);

  // Neighbours heard on a port that did not become a proven cable: the far
  // end is outside this rack, or not placed in it yet.
  const cabledEnds = new Set();
  for (const c of doc.cables || []) {
    if (c.a) cabledEnds.add(`${c.a.device}|${c.a.port}`);
    if (c.b) cabledEnds.add(`${c.b.device}|${c.b.port}`);
  }
  const heard = [];
  for (const d of devices) {
    for (const p of d.ports || []) {
      if (p.neighbour && !cabledEnds.has(`${d.name}|${p.name}`)) {
        heard.push({ from: d.name, port: p.name, to: p.neighbour.device, toPort: p.neighbour.port });
      }
    }
  }

  return { camByName, swByDevName, filed, read, up, heard };
}

export default function ReportPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const goBack = useSmartBack(`/results/${rackId}`);

  const [doc, setDoc] = useState(null);     // the report
  const [view, setView] = useState(null);   // the Review picture: camera vs switch, per device
  const [err, setErr] = useState(null);     // { text, hint }
  const [open, setOpen] = useState({});     // which device's ports are shown

  // What this phone read on the Network step. The Network page files each
  // reading on the server, but a filing can fail or not have happened yet, and
  // the report can only contain what the server holds. When the two differ
  // the page says so, with numbers, rather than leave it unexplained.
  const phoneNet = useMemo(() => getJSON(`rt_network_state_${rackId}`, null), [rackId]);

  // The NetBox side's id for this rack, and the three things a finished report
  // is for: keeping it, writing it to the system of record, and sending it to
  // somebody.
  const [scanId, setScanId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [fileBusy, setFileBusy] = useState(null);   // 'csv' | 'json' | 'share'
  const [note, setNote] = useState(null);           // { tone, text }

  const getFile = async (kind) => {
    setFileBusy(kind); setNote(null);
    try { setNote(await downloadExport(scanId, rackId, kind)); }
    catch (e) { setNote({ tone: 'bad', text: e.message || 'The download failed.' }); }
    finally { setFileBusy(null); }
  };

  useEffect(() => {
    let live = true;
    setDoc(null); setView(null); setErr(null); setOpen({});
    (async () => {
      // V1's rack id -> the NetBox side's scan id. Idempotent on the server.
      const a = await nb(`/api/nb/scans/adopt/${encodeURIComponent(rackId)}`, { method: 'POST' });
      if (!live) return;
      if (!a.ok || !a.body || a.body.id === undefined || a.body.id === null) {
        setErr({ text: explain(a, 'Could not open this rack on the NetBox side'), hint: a.body?.hint || null });
        return;
      }
      const id = a.body.id;
      setScanId(id);
      const [r, v] = await Promise.all([
        nb(`/api/nb/scans/${id}/report`),
        nb(`/api/nb/scans/${id}/reconcile`),
      ]);
      if (!live) return;
      if (!r.ok) {
        setErr({ text: explain(r, 'Could not build the report'), hint: r.body?.hint || null });
        return;
      }
      setDoc(r.body);
      if (v.ok) setView(v.body);   // optional: without it the report still stands
    })();
    return () => { live = false; };
  }, [rackId]);

  const facts = useMemo(() => (doc ? derive(doc, view) : null), [doc, view]);

  const s = (doc && doc.summary) || {};
  const devices = (doc && doc.devices) || [];
  const cables = (doc && doc.cables) || [];
  const vlans = (doc && doc.vlans) || [];
  const addresses = (doc && doc.addresses) || [];
  const switchesRead = facts ? Math.max(facts.read.length, s.switchesRead || 0) : 0;
  const noReadings = Boolean(facts) && switchesRead === 0;
  const hasNetwork = Boolean(facts) && (cables.length > 0 || facts.heard.length > 0 || vlans.length > 0 || addresses.length > 0);
  const addrSwitch = addresses.filter((a) => a.kind === 'switch').length;

  return (
    <div className={`page page-full ${styles.page}`}>
      <header className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={goBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1 className={styles.title}>Report</h1>
        <ThemeToggle />
      </header>

      {/* What this report is for, at the top of it. Four things: keep it, send
          it, put it in the system of record. They were at the foot of the page,
          past every device, which is not where anyone looks for the verb. */}
      <div className={styles.actions}>
        <button type="button" className={styles.action} disabled={!doc || scanId === null || fileBusy !== null}
          onClick={() => getFile('csv')}>
          <IconDownload />
          <span>{fileBusy === 'csv' ? '…' : 'CSV'}</span>
        </button>
        <button type="button" className={styles.action} disabled={!doc || scanId === null || fileBusy !== null}
          onClick={() => getFile('json')}>
          <IconDownload />
          <span>{fileBusy === 'json' ? '…' : 'JSON'}</span>
        </button>
        <button type="button" className={styles.action} disabled={!doc}
          onClick={() => setSharing(true)}>
          <IconSend />
          <span>Send</span>
        </button>
        <button type="button" className={`${styles.action} ${styles.actionStrong}`}
          disabled={!doc || scanId === null} onClick={() => setExporting(true)}>
          <IconExport />
          <span>NetBox</span>
        </button>
      </div>
      {note && <p className={note.tone === 'bad' ? styles.noteBad : styles.noteOk}>{note.text}</p>}

      <div className={styles.scroll}>
        {!doc && !err && (
          <p className={styles.working}>
            <span className={styles.spinner} />
            Building the report…
          </p>
        )}

        {err && (
          <div className={`${styles.note} ${styles.noteBad}`}>
            <h3>Could not build the report</h3>
            <p>{err.text}</p>
            {err.hint && <p className={styles.hint}>{err.hint}</p>}
            <Link to={`/results/${rackId}`} className={styles.linkBtn}>Open the rack</Link>
          </div>
        )}

        {doc && facts && (
          <>
            {/* Which rack, when. The two facts a person checks first. */}
            <div className={styles.hero}>
              <span className={styles.heroMake}>{doc.siteName || 'Rack'}</span>
              <span className={styles.heroModel}>{doc.rackName || rackId}</span>
              <span className={styles.heroSub}>
                {doc.scannedAt ? `Scanned ${when(doc.scannedAt)}` : 'Scan time not recorded'}
                {doc.changeNote ? ` · ${doc.changeNote}` : ''}
              </span>
            </div>

            {/* At a glance.
                A wrapping row of number-and-word pairs put "6 ADDRESSES" alone
                on a third line and left every column ragged — nine facts in a
                shape that has to be read rather than seen. A fixed grid for the
                counts, and the ports as what they actually are: a proportion,
                drawn. */}
            {(() => {
              const ports = s.ports || 0;
              const inUse = s.portsInUse ?? facts.up ?? 0;
              const free = Math.max(0, ports - inUse);
              const pct = ports ? Math.round((inUse / ports) * 100) : 0;
              const cells = [
                [s.devices || 0, 'devices'],
                [switchesRead, `switch${switchesRead === 1 ? '' : 'es'} read`],
                [s.seen || 0, 'plugged in'],
                [s.cables || 0, 'cables'],
                [s.vlans || 0, 'VLANs'],
                [s.addresses || 0, 'addresses'],
              ].filter(([n]) => n > 0);
              return (
                <div className={styles.glance}>
                  {ports > 0 && (
                    <div className={styles.ports}>
                      <div className={styles.portsHead}>
                        <span>Ports</span>
                        <b>{inUse} of {ports} in use</b>
                      </div>
                      <div className={styles.bar} role="img"
                        aria-label={`${pct} per cent of ports in use`}>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      <div className={styles.portsFoot}>
                        <span><b>{inUse}</b> in use</span>
                        <span><b>{free}</b> free</span>
                        <span>{pct}%</span>
                      </div>
                    </div>
                  )}
                  {cells.length > 0 && (
                    <div className={styles.grid}>
                      {cells.map(([n, what]) => (
                        <div key={what}><b>{n}</b><span>{what}</span></div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {noReadings && (
              <div className={`${styles.note} ${styles.noteInfo}`}>
                <h3>No switch reading has been filed for this rack yet</h3>
                <p>
                  The rack below is what the camera saw. Port state, VLANs and
                  neighbours come from the switches.
                </p>
                {phoneNet && phoneNet.read > 0 && (
                  <p className={styles.hint}>
                    This phone read {plural(phoneNet.read, 'switch', 'switches')} on the
                    Network step ({phoneNet.ports} ports, {phoneNet.up} up). Those readings
                    have not reached the server, so they are not in this report yet.
                  </p>
                )}
                <Link to={`/results/${rackId}/network`} className={styles.linkBtn}>Open Network</Link>
              </div>
            )}

            {/* ── The rack, top down ── */}
            <section className={styles.section}>
              <div className={styles.secHead}>
                <h2>Rack</h2>
                <span>{plural(devices.length, 'device')} · top down</span>
              </div>

              {devices.length === 0 && (
                <p className={styles.emptyLine}>The camera saw no devices in this rack.</p>
              )}

              <div className={styles.rows}>
                {devices.map((d) => {
                  const key = `${d.u ?? 'x'}-${d.name}`;
                  return (
                    <DeviceRow
                      key={key}
                      d={d}
                      cam={facts.camByName.get(d.name) || null}
                      sw={facts.swByDevName.get(d.name) || null}
                      open={Boolean(open[key])}
                      onToggle={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                    />
                  );
                })}
              </div>
            </section>

            {/* ── Network: what the switches said about each other ── */}
            {hasNetwork && (
              <section className={styles.section}>
                <div className={styles.secHead}>
                  <h2>Network</h2>
                  <span>from the switches</span>
                </div>

                {cables.length > 0 && (
                  <div className={styles.sub}>
                    <h3>Cables <span className={styles.count}>{cables.length}</span></h3>
                    <ul className={styles.links}>
                      {cables.map((c, i) => (
                        <li key={i}>
                          <span className={styles.end}><b>{c.a?.device || '—'}</b> {c.a?.port || ''}</span>
                          <span className={styles.arrow} aria-hidden="true">→</span>
                          <span className={styles.end}><b>{c.b?.device || '—'}</b> {c.b?.port || ''}</span>
                          <span className={`${styles.proof} ${c.evidence === 'lldp_both' ? styles.proofGood : ''}`}>
                            {proofText(c.evidence)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {facts.heard.length > 0 && (
                  <div className={styles.sub}>
                    <h3>Neighbours heard <span className={styles.count}>{facts.heard.length}</span></h3>
                    <ul className={styles.links}>
                      {facts.heard.map((h, i) => (
                        <li key={i}>
                          <span className={styles.end}><b>{h.from}</b> {h.port}</span>
                          <span className={styles.arrow} aria-hidden="true">→</span>
                          <span className={styles.end}><b>{h.to}</b> {h.toPort}</span>
                          <span className={styles.proof}>LLDP</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {vlans.length > 0 && (
                  <div className={styles.sub}>
                    <h3>VLANs <span className={styles.count}>{vlans.length}</span></h3>
                    <div className={styles.chips}>
                      {vlans.map((v) => (
                        <span key={v.id} className={styles.chip}>
                          <b>{v.id}</b>
                          {v.name && String(v.name) !== String(v.id) ? ` ${v.name}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {addresses.length > 0 && (
                  <div className={styles.sub}>
                    <h3>Addresses <span className={styles.count}>{addresses.length}</span></h3>
                    <p className={styles.subLine}>
                      {addrSwitch} on switches · {addresses.length - addrSwitch} on things plugged into them
                    </p>
                  </div>
                )}
              </section>
            )}

          </>
        )}

      </div>

      {exporting && scanId !== null && (
        <ExportSheet scanId={scanId} onClose={() => setExporting(false)} />
      )}
      {sharing && <ShareSheet rackId={rackId} onClose={() => setSharing(false)} />}
    </div>
  );
}

/**
 * One device: its U, what the camera saw, and — where a switch was matched to
 * it — what the switch said about itself. Ports fold out underneath.
 */
function DeviceRow({ d, cam, sw, open, onToggle }) {
  const matched = String(d.source || '').startsWith('switch');
  const ports = d.ports || [];
  const inUse = ports.filter((p) => p.inUse).length;
  const cabled = ports.filter((p) => p.plugged === true).length;

  // A report states what is there. "Make and model not read" is not a fact
  // about the rack, it is a fact about us, and printing it on every row a
  // camera could not read made the page look like a list of failures.
  const camMake = cam ? cam.make : (matched ? '' : d.vendor);
  const camModel = cam ? cam.model : (matched ? '' : d.model);
  const camPorts = cam ? cam.portCount : (matched ? null : d.portCount);
  const identity = matched ? said(sw ? sw.vendor : d.vendor, sw ? sw.model : d.model)
    : said(camMake, camModel);

  // How it is doing, as numbers with their names — a sentence of six facts
  // separated by dots wraps into a shape nobody can scan, and "1 of 28 ports
  // up" next to a button saying "16 ports in use" reads as a contradiction
  // when it is two different questions. Each count is labelled with what it
  // counts, and they sit next to each other so the comparison is the layout.
  const stats = [
    [d.portCount || camPorts || 0, 'ports'],
    [inUse, 'in use'],
    [d.portsUp, 'up'],
    [cabled, 'cabled'],
    [d.seen, 'devices'],
  ].filter(([n]) => n != null && n > 0);

  // Who it is, for anyone who has to find it again.
  const ids = [
    ['at', d.mgmtIp],
    ['serial', d.serial],
    ['hardware', d.hardware],
    ['firmware', d.firmware],
    ['up', d.uptimeSeconds ? uptimeText(d.uptimeSeconds).replace(/^up /, '') : null],
  ].filter(([, v]) => v);

  // The witness that knows most goes first. A matched device is the switch
  // stating what it is; an unmatched one is the camera guessing. Naming the
  // other witness inline reads better than a label column, which squeezed the
  // sentence into three words a line on a phone.
  return (
    <div className={styles.row}>
      <span className={`${styles.u} ${d.u == null ? styles.uNone : ''}`}>
        {d.u != null ? `U${d.u}` : '—'}
      </span>
      <div className={styles.rowMain}>
        <div className={styles.rowTop}>
          <b className={styles.rowTitle}>{titleOf(d)}</b>
          {matched && <span className={styles.tag}>from the switch</span>}
        </div>

        {identity && <p className={styles.said}>{identity}</p>}

        {stats.length > 0 && (
          <div className={styles.stats}>
            {stats.map(([n, what]) => (
              <div key={what}><b>{n}</b><span>{what}</span></div>
            ))}
          </div>
        )}

        {ids.length > 0 && (
          <dl className={styles.ids}>
            {ids.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}

        {inUse > 0 && (
          <button type="button" className={styles.more} aria-expanded={open} onClick={onToggle}>
            {open ? 'Hide ports' : `${plural(inUse, 'port')} in use`}
          </button>
        )}
        {open && inUse > 0 && <PortList ports={ports.filter((p) => p.inUse)} total={ports.length} />}
      </div>
    </div>
  );
}

/** The ports in use, one line each: the switch's view and the camera's, side by side. */
function PortList({ ports, total }) {
  return (
    <div className={styles.ports}>
      {ports.map((p, i) => {
        const cable = cableText(p);
        const hosts = p.hosts || [];
        return (
          <div key={`${p.name}-${i}`} className={styles.port}>
            <span className={styles.portName}>{p.name}</span>
            <span className={styles.portFacts}>
              {p.state && (
                <span className={p.state === 'up' ? styles.up : styles.down}>{p.state}</span>
              )}
              {p.state === 'up' && p.speedMbps ? <span>{speedText(p.speedMbps)}</span> : null}
              {p.vlan != null && <span>VLAN {p.vlan}</span>}
              {p.neighbour && (
                <span>→ {p.neighbour.device}{p.neighbour.port ? ` ${p.neighbour.port}` : ''}</span>
              )}
              {cable && <span>{cable}</span>}
              {hosts.length > 0 && (
                <span>{plural(hosts.length, 'host')}{hosts[0].ip ? ` · ${hosts[0].ip}` : ''}</span>
              )}
            </span>
          </div>
        );
      })}
      <p className={styles.portNote}>{ports.length} of {total} ports in use.</p>
    </div>
  );
}
