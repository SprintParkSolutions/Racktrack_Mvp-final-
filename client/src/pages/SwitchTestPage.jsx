import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { getJSON, setJSON } from '../utils/safeStorage';
import { testLogin, readSwitch } from '../utils/snmpClient';
import styles from './SwitchTestPage.module.css';

// Switch test — the phone talking to a switch directly, over SNMP.
//
// This screen exists to answer one question: can the handset reach a managed
// switch on the network it is standing on? Every previous attempt went
// phone → our server → switch, and the server sits in a data centre with no
// route to a private address inside somebody's building. Here the phone sends
// the packets itself.
//
// Two dialects, both without cryptography: v2c with a community string (the
// D-Link), and v3 with a user name at noAuthNoPriv (the TP-Links, which is how
// they are configured and how every stored reading of them was taken). Nothing
// on this screen can fail for a reason we would have to separate from the
// reachability question we are actually asking. v3 with a password is written
// and proven on the server; it comes to the phone once these switches need it.
//
// The switches a tester adds are kept ON THE PHONE, in local storage, and are
// never sent anywhere. This is a throwaway test screen and the addresses are
// somebody's real infrastructure; storing them on the server would mean asking
// permission we have not asked for.

// Switches are filed against a rack when the page is opened as a rack's
// Network step (/results/:rackId/network); the rack-less menu entry keeps the
// original list. A rack that has none yet inherits the rack-less list once, so
// the switches someone already typed in show up where the chain needs them.
const LEGACY_STORE = 'rt_snmp_test_switches';
const storeKey = (rackId) => (rackId ? `rt_snmp_switches_${rackId}` : LEGACY_STORE);
const NETWORK_STATE = (rackId) => `rt_network_state_${rackId}`;

/** What the chain shows for this rack's Network step: how much has been read. */
function saveNetworkState(rackId, resultsMap) {
  if (!rackId) return;
  const full = Object.values(resultsMap).filter((r) => r && r.kind === 'full');
  setJSON(NETWORK_STATE(rackId), {
    read: full.length,
    ports: full.reduce((n, r) => n + (r.counts?.ports || 0), 0),
    up: full.reduce((n, r) => n + (r.counts?.up || 0), 0),
    at: new Date().toISOString(),
  });
}

const BLANK = {
  label: '', host: '', port: 161,
  version: 'v2c', community: 'public',
  username: '', securityLevel: 'noAuthNoPriv',
};

/** The one-line summary under a switch's name: how we talk to it. */
const dialect = (sw) => (sw.version === 'v3' ? `v3 · ${sw.username || 'no user'} · no password` : 'v2c');

/** Seconds of uptime, as something a person would say. */
function uptimeText(ticks) {
  if (!ticks && ticks !== 0) return null;
  const secs = Math.floor(Number(ticks) / 100);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `up ${d} day${d === 1 ? '' : 's'}`;
  if (h > 0) return `up ${h} hour${h === 1 ? '' : 's'}`;
  return `up ${Math.max(1, Math.floor(secs / 60))} min`;
}

export default function SwitchTestPage() {
  const navigate = useNavigate();
  const { rackId } = useParams();
  const STORE = storeKey(rackId);

  const [switches, setSwitches] = useState([]);
  const [form, setForm] = useState(null);        // null, or the switch being added
  const [busy, setBusy] = useState(null);        // switch id currently talking
  const [step, setStep] = useState('');          // what it is doing right now
  const [results, setResults] = useState({});    // id -> what came back
  const [errors, setErrors] = useState({});      // id -> what went wrong

  useEffect(() => {
    let list = getJSON(STORE, []) || [];
    if (rackId && list.length === 0) {
      const inherited = getJSON(LEGACY_STORE, []) || [];
      if (inherited.length) { list = inherited; setJSON(STORE, list); }
    }
    setSwitches(list);
    setResults({});
    setErrors({});
  }, [STORE, rackId]);

  const persist = useCallback((next) => {
    setSwitches(next);
    setJSON(STORE, next);
  }, [STORE]);

  // Add and edit share one form. Editing exists because a DHCP lease moves:
  // the TP-Links went from .101/.102 to .11/.12 between one week and the next,
  // and "remove it and type everything again" is the wrong answer to that.
  const openEdit = (sw) => setForm({ ...BLANK, ...sw });

  const save = () => {
    const host = String(form.host || '').trim();
    if (!host) return;
    const version = form.version === 'v3' ? 'v3' : 'v2c';
    if (version === 'v3' && !String(form.username || '').trim()) return;
    const entry = {
      id: form.id || `sw_${Date.now()}`,
      label: String(form.label || '').trim() || host,
      host,
      port: Number(form.port) || 161,
      version,
      community: version === 'v2c' ? (form.community ?? 'public') : undefined,
      username: version === 'v3' ? String(form.username).trim() : undefined,
      securityLevel: version === 'v3' ? 'noAuthNoPriv' : undefined,
    };
    if (form.id) {
      persist(switches.map((x) => (x.id === form.id ? entry : x)));
      clearFor(form.id);                // what it said before is about the old address
    } else {
      persist([...switches, entry]);
    }
    setForm(null);
  };

  const remove = (sw) => {
    persist(switches.filter((x) => x.id !== sw.id));
    setResults((m) => { const n = { ...m }; delete n[sw.id]; return n; });
    setErrors((m) => { const n = { ...m }; delete n[sw.id]; return n; });
  };

  const clearFor = (id) => {
    setErrors((m) => ({ ...m, [id]: null }));
    setResults((m) => ({ ...m, [id]: null }));
  };

  // Test login — one question, answered in one round trip. If this works, the
  // phone can reach the switch and the community string is right; everything
  // else is detail.
  const doTest = async (sw) => {
    setBusy(sw.id); setStep('Saying hello'); clearFor(sw.id);
    try {
      const info = await testLogin(sw);
      setResults((m) => ({ ...m, [sw.id]: { kind: 'hello', ...info } }));
    } catch (e) {
      setErrors((m) => ({ ...m, [sw.id]: { message: e.message, hint: e.hint } }));
    } finally {
      setBusy(null); setStep('');
    }
  };

  const doRead = async (sw) => {
    setBusy(sw.id); setStep('Starting'); clearFor(sw.id);
    try {
      const data = await readSwitch(sw, setStep);
      setResults((m) => {
        const next = { ...m, [sw.id]: { kind: 'full', ...data } };
        saveNetworkState(rackId, next);   // lights the Network step in the chain
        return next;
      });
    } catch (e) {
      setErrors((m) => ({ ...m, [sw.id]: { message: e.message, hint: e.hint } }));
    } finally {
      setBusy(null); setStep('');
    }
  };

  // Testers need to be able to send this back without retyping it.
  const copyResult = async (sw) => {
    const r = results[sw.id];
    const err = errors[sw.id];
    const text = JSON.stringify(
      { switch: { label: sw.label, host: sw.host, port: sw.port }, result: r, error: err },
      null, 2,
    );
    try { await navigator.clipboard.writeText(text); } catch { /* nothing to do */ }
  };

  return (
    <div className={`page page-full ${styles.page}`}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className={styles.title}>Network</h1>
        <ThemeToggle />
      </header>

      <div className={styles.scroll}>
      {/* One line that says how the rack's network stands, before any detail.
          No introduction above it: the numbers are the introduction. */}
      {switches.length > 0 && (() => {
        const read = switches.filter((s) => results[s.id]?.kind === 'full');
        const ports = read.reduce((n, s) => n + (results[s.id].counts?.ports || 0), 0);
        const up = read.reduce((n, s) => n + (results[s.id].counts?.up || 0), 0);
        const failed = switches.filter((s) => errors[s.id]).length;
        return (
          <div className={styles.summary}>
            <div><b>{switches.length}</b><span>switch{switches.length === 1 ? '' : 'es'}</span></div>
            <div><b>{read.length}</b><span>read</span></div>
            <div><b>{ports}</b><span>ports</span></div>
            <div className={up ? styles.sumUp : ''}><b>{up}</b><span>up</span></div>
            {failed > 0 && <div className={styles.sumBad}><b>{failed}</b><span>no answer</span></div>}
          </div>
        );
      })()}

      {switches.length === 0 && !form && (
        <div className={styles.empty}>
          <p>No switches on this rack yet. Add one and read it — every value comes from the switch itself.</p>
          <button type="button" className={styles.primary} onClick={() => setForm(BLANK)}>
            Add a switch
          </button>
        </div>
      )}

      {/* ── The switches ── */}
      <div className={styles.list}>
        {switches.map((sw) => {
          const r = results[sw.id];
          const err = errors[sw.id];
          const working = busy === sw.id;

          return (
            <section key={sw.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div className={styles.who}>
                  <h2>{sw.label}</h2>
                  <p>{sw.host}:{sw.port} · {dialect(sw)}</p>
                  <span className={`${styles.pill} ${
                    working ? styles.pillBusy
                      : err ? styles.pillBad
                        : r?.kind === 'full' ? styles.pillGood
                          : r ? styles.pillOk : ''}`}>
                    {working ? 'Reading…'
                      : err ? 'Did not answer'
                        : r?.kind === 'full' ? `Read · ${r.counts.ports} ports, ${r.counts.up} up`
                          : r ? 'Answered' : 'Not read yet'}
                  </span>
                </div>
                <div className={styles.cardTools}>
                  <button
                    type="button"
                    className={styles.del}
                    disabled={working}
                    onClick={() => openEdit(sw)}
                    aria-label={`Edit ${sw.label}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.del}
                    disabled={working}
                    onClick={() => remove(sw)}
                    aria-label={`Remove ${sw.label}`}
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={working}
                  onClick={() => doTest(sw)}
                >
                  Test login
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={working}
                  onClick={() => doRead(sw)}
                >
                  Read switch
                </button>
              </div>

              {working && (
                <p className={styles.working}>
                  <span className={styles.spinner} />
                  {step || 'Working'}…
                </p>
              )}

              {err && (
                <div className={styles.bad}>
                  <h3>It did not answer</h3>
                  <p>{err.message}</p>
                  {err.hint && <p className={styles.hint}>{err.hint}</p>}
                  {/* A switch added before v3 existed is stored as v2c and will
                      never answer a community string. Name the likely cause
                      rather than leaving "did not answer" to be puzzled over. */}
                  {sw.version !== 'v3' && /did not answer/i.test(err.message || '') && (
                    <p className={styles.hint}>
                      This switch is saved as <b>v2c</b>. If it is set up for SNMPv3
                      (the TP-Links are), remove it and add it again choosing v3.
                    </p>
                  )}
                  <button type="button" className={styles.copy} onClick={() => copyResult(sw)}>
                    Copy result
                  </button>
                </div>
              )}

              {r && (
                <div className={styles.good}>
                  {/* What it is, said by the switch itself — the two facts a
                      camera cannot read reliably, first and large. */}
                  <div className={styles.hero}>
                    <span className={styles.heroMake}>{r.vendor || 'Make not stated'}</span>
                    <span className={styles.heroModel}>{r.model || (r.sysName || 'Model not stated')}</span>
                    <span className={styles.heroSub}>
                      {r.sysName && r.model ? `${r.sysName} · ` : ''}
                      {r.uptime != null ? uptimeText(r.uptime) : 'answered'}
                      {r.kind === 'full' ? (r.serial ? ` · serial ${r.serial}` : ' · no serial offered') : ''}
                    </span>
                  </div>

                  {/* The description is only worth the space when it is the
                      only identity the switch gave. */}
                  {!r.model && r.sysDescr && <p className={styles.descr}>{r.sysDescr}</p>}

                  {r.kind === 'full' && (
                    <>
                      <div className={styles.tiles}>
                        <div className={styles.tile}><b>{r.counts.ports}</b><span>ports</span></div>
                        <div className={`${styles.tile} ${r.counts.up ? styles.tileUp : ''}`}><b>{r.counts.up}</b><span>up</span></div>
                        <div className={styles.tile}><b>{r.counts.ports - r.counts.up}</b><span>down</span></div>
                        <div className={styles.tile}><b>{r.counts.neighbours}</b><span>neighbours</span></div>
                      </div>

                      {r.interfaces.length > 0 && (
                        <div className={styles.ports}>
                          {r.interfaces.map((i) => (
                            <span
                              key={i.index}
                              className={`${styles.port} ${i.up ? styles.portUp : ''}`}
                              title={`${i.name}${i.descr ? ` — ${i.descr}` : ''}${
                                i.speedMbps ? ` · ${i.speedMbps} Mbps` : ''}`}
                            >
                              {i.name}
                            </span>
                          ))}
                        </div>
                      )}

                      {r.neighbours.length > 0 && (
                        <ul className={styles.neighbours}>
                          {r.neighbours.map((n, k) => (
                            <li key={k}>
                              <b>{n.sysName}</b>
                              {n.port ? ` on ${n.port}` : ''}
                              {n.localPort ? ` ← our port ${n.localPort}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}

                      {r.gaps.length > 0 && (
                        <div className={styles.gaps}>
                          <h4>Not stated by the switch</h4>
                          <ul>{r.gaps.map((g, k) => <li key={k}>{g}</li>)}</ul>
                        </div>
                      )}
                    </>
                  )}

                  <button type="button" className={styles.copy} onClick={() => copyResult(sw)}>
                    Copy result
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* ── Add ── */}
      {form ? (
        <section className={styles.form}>
          <h2>{form.id ? `Edit ${form.label || 'switch'}` : 'Add a switch'}</h2>

          <label className={styles.field}>
            <span>Name it</span>
            <input
              value={form.label}
              placeholder="Core switch"
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>

          <label className={styles.field}>
            <span>Address</span>
            <input
              value={form.host}
              placeholder="10.10.1.33"
              inputMode="decimal"
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>

          {/* Which dialect. Offered by what the switch's own settings page calls
              them, because that is what the person adding it will be reading. */}
          <div className={styles.field}>
            <span>How it is set up</span>
            <div className={styles.seg} role="radiogroup" aria-label="SNMP version">
              <button
                type="button"
                role="radio"
                aria-checked={form.version !== 'v3'}
                className={`${styles.segBtn} ${form.version !== 'v3' ? styles.segOn : ''}`}
                onClick={() => setForm({ ...form, version: 'v2c' })}
              >
                <b>v2c</b><small>community string</small>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.version === 'v3'}
                className={`${styles.segBtn} ${form.version === 'v3' ? styles.segOn : ''}`}
                onClick={() => setForm({ ...form, version: 'v3' })}
              >
                <b>v3</b><small>user name</small>
              </button>
            </div>
          </div>

          <div className={styles.pair}>
            <label className={styles.field}>
              <span>Port</span>
              <input
                value={form.port}
                inputMode="numeric"
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </label>
            {form.version === 'v3' ? (
              <label className={styles.field}>
                <span>User name</span>
                <input
                  value={form.username}
                  placeholder="racktrack"
                  autoCapitalize="none"
                  autoCorrect="off"
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </label>
            ) : (
              <label className={styles.field}>
                <span>Community</span>
                <input
                  value={form.community}
                  autoCapitalize="none"
                  autoCorrect="off"
                  onChange={(e) => setForm({ ...form, community: e.target.value })}
                />
              </label>
            )}
          </div>

          {form.version === 'v3' ? (
            <p className={styles.fieldNote}>
              The SNMPv3 user your network team created on the switch, at the
              <b> noAuthNoPriv</b> level — no password, no encryption. That is how
              the TP-Links are set up today. A user with a password comes in the
              next build. The name stays on this phone.
            </p>
          ) : (
            <p className={styles.fieldNote}>
              The community is the read-only password your network team set on the
              switch. It is often <code>public</code>. It stays on this phone.
            </p>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setForm(null)}>
              Cancel
            </button>
            <button type="button" className={styles.primary} onClick={save}>
              Save
            </button>
          </div>
        </section>
      ) : switches.length > 0 && (
        <button type="button" className={styles.addMore} onClick={() => setForm(BLANK)}>
          Add another switch
        </button>
      )}
      </div>
    </div>
  );
}
