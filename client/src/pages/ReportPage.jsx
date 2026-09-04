import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';
import { getJSON } from '../utils/safeStorage';
import { useSmartBack } from '../hooks/useSmartBack';
import styles from './ReportPage.module.css';

/**
 * Report — the rack and its network on one page.
 *
 * Scan → Physical → Network → **Report** → Export.
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

  // Not stated / needs a person. Each line names who did not say it.
  const gaps = [];
  for (const d of devices) {
    const who = d.u != null ? `U${d.u}` : d.name;
    const cam = camByName.get(d.name);
    const sw = swByDevName.get(d.name);
    const matched = String(d.source || '').startsWith('switch');
    if (d.u == null) gaps.push({ who: d.name, what: 'the camera did not place it in a U.' });
    if (!matched && noModel(cam ? cam.model : d.model)) {
      gaps.push({ who, what: `${titleOf(d).toLowerCase()} — make and model not read by the camera, and no switch reading is matched to it.` });
    }
    if (matched && sw && noModel(sw.model)) gaps.push({ who, what: 'the switch did not state its model.' });
    if (matched && !d.serial) gaps.push({ who, what: 'the switch did not state a serial.' });
  }
  for (const s of filed) {
    if (!s.read) gaps.push({ who: s.label, what: `${s.host} — filed for this rack, no reading yet.` });
    else if (!(confirmed && s.matchedTo)) {
      gaps.push({ who: s.label, what: `${s.host} — read, but not matched to a rack position, so its ports are not in the rack list.` });
    }
  }
  for (const u of view?.summary?.unresolved || []) {
    gaps.push({ who: u.from, what: `hears ${u.seen}: ${u.why}.` });
  }
  for (const c of doc.cables || []) {
    if (c.evidence === 'lldp_one' && c.a && c.b) {
      gaps.push({ who: `${c.a.device} ${c.a.port}`, what: `→ ${c.b.device} ${c.b.port}: only one end reports this cable.` });
    }
  }

  return { camByName, swByDevName, filed, read, up, heard, gaps };
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className={styles.title}>Report</h1>
        <ThemeToggle />
      </header>

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

            {/* One line that says how the rack stands, before any detail. */}
            <div className={styles.summary}>
              <div><b>{s.devices || 0}</b><span>devices</span></div>
              <div className={switchesRead ? styles.sumUp : ''}><b>{switchesRead}</b><span>switches read</span></div>
              <div><b>{s.ports || 0}</b><span>ports</span></div>
              <div className={facts.up ? styles.sumUp : ''}><b>{facts.up}</b><span>up</span></div>
            </div>

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
            <section className={styles.card}>
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
              <section className={styles.card}>
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
                  <p className={styles.line}>
                    <span className={styles.lineK}>Addresses</span>
                    {plural(addresses.length, 'address', 'addresses')} seen
                    {' · '}{addrSwitch} on switches · {addresses.length - addrSwitch} hosts
                  </p>
                )}
              </section>
            )}

            {/* ── Not stated. Every line names who did not say it. ── */}
            {facts.gaps.length > 0 && (
              <section className={styles.card}>
                <div className={styles.secHead}>
                  <h2>Not stated</h2>
                  <span>needs a person</span>
                </div>
                <ul className={styles.gaps}>
                  {facts.gaps.map((g, i) => (
                    <li key={i}><b>{g.who}</b> {g.what}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {/* The one thing to do next. */}
        <div className={styles.cta}>
          <button
            type="button"
            className={styles.primary}
            disabled={!doc}
            onClick={() => navigate(`/results/${rackId}/export`)}
          >
            Export to NetBox
          </button>
        </div>
      </div>
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

  // The camera's own words. With the Review picture they are the un-merged
  // identity read off the bezel; without it, only an unmatched device's record
  // is purely the camera's, so a matched one shows its class alone.
  const camMake = cam ? cam.make : (matched ? '' : d.vendor);
  const camModel = cam ? cam.model : (matched ? '' : d.model);
  const camPorts = cam ? cam.portCount : (matched ? null : d.portCount);
  const camId = said(camMake, camModel);
  const camBits = [
    camId || 'make and model not read',
    camPorts ? `${camPorts} ports` : '',
    cabled ? `${cabled} cabled` : '',
  ].filter(Boolean).join(' · ');

  let swBits = null;
  if (matched) {
    const id = said(sw ? sw.vendor : d.vendor, sw ? sw.model : d.model);
    swBits = [
      id || 'make and model not stated',
      sw?.sysName || '',
      d.serial ? `serial ${d.serial}` : 'no serial',
      d.mgmtIp || '',
      d.portsUp != null ? `${d.portsUp} of ${d.portCount} up` : '',
    ].filter(Boolean).join(' · ');
  }

  return (
    <div className={styles.row}>
      <span className={`${styles.u} ${d.u == null ? styles.uNone : ''}`}>
        {d.u != null ? `U${d.u}` : '—'}
      </span>
      <div className={styles.rowMain}>
        <div className={styles.rowTop}>
          <b className={styles.rowTitle}>{titleOf(d)}</b>
          <span className={`${styles.pill} ${matched ? styles.pillGood : ''}`}>
            {matched ? 'switch + camera' : 'camera only'}
          </span>
        </div>
        <p className={styles.line}><span className={styles.lineK}>Camera</span>{camBits}</p>
        {swBits && <p className={styles.line}><span className={styles.lineK}>Switch</span>{swBits}</p>}

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
