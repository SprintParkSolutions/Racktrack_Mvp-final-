import { useState, useEffect, useCallback, useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { apiUrl, authFetch, publicOrigin } from '../utils/api';
import styles from './OrgConsole.module.css';
import OrgConnectionsPanel from '../components/OrgConnectionsPanel.jsx';
import BackButton from '../components/BackButton.jsx';
import { useHeaderBack } from '../components/ShellHeader.jsx';
import useModalA11y from '../hooks/useModalA11y.js';
import Icon from '../components/Icon';

// Organization console. Role-aware:
//   owner     → list/create organizations, drill into any org's Sites + Members
//   org_admin → manage their own org's Sites + Members
async function getJSON(path) {
  const r = await authFetch(apiUrl(path));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
async function postJSON(path, body) {
  const r = await authFetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
async function patchJSON(path, body) {
  const r = await authFetch(apiUrl(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
async function delJSON(path) {
  const r = await authFetch(apiUrl(path), { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export default function OrgConsolePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';
  const isOrgAdmin = user?.role === 'org_admin';

  const [orgs, setOrgs] = useState([]);
  const [activeOrg, setActiveOrg] = useState(null);   // {id, name, slug}
  const [sites, setSites] = useState([]);
  const [members, setMembers] = useState([]);
  const [dash, setDash] = useState(null);             // owner: {totals, recentScans}
  const [odash, setOdash] = useState(null);           // org:   {totals, recentScans}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);           // 'org' | 'site' | 'member' | 'invite'
  const [banner, setBanner] = useState(null);
  const [pending, setPending] = useState([]);         // owner: orgs awaiting approval
  const [myOrgPending, setMyOrgPending] = useState(false); // admin: my org not yet approved
  const [scanFilter, setScanFilter] = useState(null);      // {type:'user',id,name} | {type:'site',name}
  const [menuFor, setMenuFor] = useState(null);            // member id whose ⋮ menu is open
  const [orgMenuFor, setOrgMenuFor] = useState(null);      // org id whose ⋮ menu is open

  const loadOrgs = useCallback(async () => {
    const d = await getJSON('/api/dashboard/owner');
    setDash({ totals: d.totals, recentScans: d.recentScans || [] });
    setOrgs(d.organizations || []);
    setError(null); // clear any stale error (e.g. a mount-race 401) now that data loaded
    try { const p = await getJSON('/api/orgs/pending'); setPending(p.pending || []); } catch (_) { /* ignore */ }
  }, []);

  const openOrg = useCallback(async (org) => {
    setActiveOrg(org);
    setError(null);
    // Clear the previous org's data before loading the new one. Without this,
    // one org's members/sites — and their Edit / Remove options — lingered
    // under the new org's header while the fetch was in flight, so controls for
    // a different organization appeared to "come back". Also close any open ⋮.
    setMembers([]); setSites([]); setOdash(null);
    setMenuFor(null); setOrgMenuFor(null);
    try {
      const [d, m] = await Promise.all([
        getJSON(`/api/orgs/${org.id}/dashboard`),
        getJSON(`/api/orgs/${org.id}/members`),
      ]);
      setOdash({ totals: d.totals, recentScans: d.recentScans || [] });
      setSites(d.sites || []);
      setMembers(m.members || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (!isOwner && !isOrgAdmin) { navigate('/', { replace: true }); return; }
    (async () => {
      try {
        if (isOwner) {
          await loadOrgs();
        } else {
          const my = await getJSON('/api/my-org');
          if (my.organization) {
            if (my.organization.status && my.organization.status !== 'active') {
              setActiveOrg(my.organization);
              setMyOrgPending(true);
            } else {
              await openOrg(my.organization);
            }
          }
        }
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg) => { setBanner(msg); setTimeout(() => setBanner(null), 4000); };

  const toggleActive = async (m) => {
    try {
      await patchJSON(`/api/orgs/${activeOrg.id}/members/${m.id}`, { active: m.active === 0 ? 1 : 0 });
      flash(m.active === 0 ? `${m.username} reactivated` : `${m.username} deactivated`);
      await openOrg(activeOrg);
    } catch (e) { setError(e.message); }
  };

  const removeMember = async (m) => {
    setMenuFor(null);
    if (!window.confirm(`Remove ${m.username}? The account is deleted; their past scans stay (shown as “-”).`)) return;
    try {
      await delJSON(`/api/orgs/${activeOrg.id}/members/${m.id}`);
      flash(`${m.username} removed`);
      await openOrg(activeOrg);
    } catch (e) { setError(e.message); }
  };

  // Close the ⋮ menus (member + org) on any outside click / Escape.
  useEffect(() => {
    if (menuFor == null && orgMenuFor == null) return;
    const close = () => { setMenuFor(null); setOrgMenuFor(null); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [menuFor, orgMenuFor]);

  const approveOrg = async (o) => {
    try { await postJSON(`/api/orgs/${o.id}/approve`, {}); flash(`${o.name} approved`); await loadOrgs(); }
    catch (e) { setError(e.message); }
  };
  const rejectOrg = async (o) => {
    try { await postJSON(`/api/orgs/${o.id}/reject`, {}); flash(`Rejected ${o.name}`); await loadOrgs(); }
    catch (e) { setError(e.message); }
  };
  // These do the actual API call — invoked from the in-app modals below.
  // (We use modals instead of window.confirm/prompt because browsers can block
  // native dialogs, which silently made "Remove"/"Edit" appear to do nothing.)
  const doRenameOrg = async (o, name) => {
    try { await patchJSON(`/api/orgs/${o.id}`, { name }); flash('Organization renamed'); await loadOrgs(); }
    catch (e) { setError(e.message); }
  };

  const doSetOrgStatus = async (o, status) => {
    try {
      await patchJSON(`/api/orgs/${o.id}`, { status });
      flash(status === 'active' ? `${o.name} reactivated` : `${o.name} deactivated`);
      await loadOrgs();
    } catch (e) { setError(e.message); }
  };

  const doRemoveOrg = async (o) => {
    try {
      await delJSON(`/api/orgs/${o.id}`);
      flash(`Removed ${o.name}`);
      if (activeOrg?.id === o.id) { setActiveOrg(null); setSites([]); setMembers([]); setOdash(null); }
      await loadOrgs();
    } catch (e) { setError(e.message); }
  };

  // Reactivate is non-destructive → do it immediately; the rest open a modal.
  const onOrgMenu = (action, o) => {
    if (action === 'edit')       setModal({ kind: 'renameOrg', org: o });
    else if (action === 'remove') setModal({ kind: 'removeOrg', org: o });
    else if (action === 'toggle') {
      if (o.status === 'active') setModal({ kind: 'deactivateOrg', org: o });
      else doSetOrgStatus(o, 'active');
    }
  };

  // The shared shell Back button clears the active org (returns to the org
  // list) when an owner is inside one — mirroring the page's own in-page back.
  // At the list it falls back to the default history back.
  useHeaderBack(
    activeOrg && isOwner
      ? () => { setActiveOrg(null); setSites([]); setMembers([]); setOdash(null); setOrgMenuFor(null); }
      : null,
  );

  // Longest scan bar in the org list is normalised against the busiest org.
  const maxScans = Math.max(1, ...orgs.map(o => o.scans || 0));

  if (loading) return <div className={styles.scroll}><div className={styles.page}><div className={styles.loading}>Loading…</div></div></div>;

  return (
    <div className={styles.scroll}>
    <div className={styles.page}>
      {isOwner && !activeOrg ? (
        <header className={`${styles.bleed} ${styles.hero}`}>
          <div className={styles.heroTop}>
            <div className={styles.heroTopLeft}>
              <BackButton fallback="/" always className={styles.heroBack} />
              <h1 className={styles.heroTitle}>Organizations</h1>
            </div>
            <span className={styles.ownerPill}>{roleLabel(user?.role)}</span>
          </div>
          {dash && (
            <div className={styles.heroStats}>
              <div className={styles.heroStat}>
                <div className={styles.heroStatNum}>{dash.totals.organizations ?? 0}</div>
                <div className={styles.heroStatLbl}>Organizations</div>
              </div>
              <div className={styles.heroStat}>
                <div className={styles.heroStatNum}>{dash.totals.sites ?? 0}</div>
                <div className={styles.heroStatLbl}>Sites</div>
              </div>
              <div className={styles.heroStat}>
                <div className={styles.heroStatNum}>{dash.totals.users ?? 0}</div>
                <div className={styles.heroStatLbl}>Users</div>
              </div>
              <div className={styles.heroStat}>
                <div className={styles.heroStatNum}>{dash.totals.scans ?? 0}</div>
                <div className={styles.heroStatLbl}>Total scans</div>
              </div>
            </div>
          )}
        </header>
      ) : (
        <header className={styles.head}>
        {activeOrg && isOwner
          // Inside an organization, "back" returns to the organization LIST,
          // not to wherever the owner came from (the dashboard/profile). Only
          // at the list does back leave the console.
          ? (
            <button type="button" className={styles.headBackBtn} aria-label="Back to organizations"
              onClick={() => { setActiveOrg(null); setSites([]); setMembers([]); setOdash(null); setOrgMenuFor(null); }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            </button>
          )
          : <BackButton fallback="/" />}
        <div>
          <p className={styles.eyebrow}>{activeOrg ? 'Organization' : 'Organization Console'}</p>
          <h1 className={styles.title}>
            {activeOrg && isOwner ? activeOrg.name : (activeOrg?.name || 'Organizations')}
          </h1>
        </div>
        <div className={styles.headActions}>
          <span className={styles.roleBadge}>{roleLabel(user?.role)}</span>
          {isOwner && (
            <button className={styles.ghostBtn} onClick={() => navigate('/dashboard')}>Console</button>
          )}
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>App</button>
          <button className={styles.ghostBtn} onClick={logout}>Sign out</button>
        </div>
      </header>
      )}

      {banner && <div className={styles.banner}>{banner}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {/* ── Owner: platform dashboard + organizations ── */}
      {isOwner && !activeOrg && (
        <section>
          {pending.length > 0 && (
            <section className={styles.block}>
              <div className={styles.sectionHead}><SecTitle icon="pending_actions">Pending approvals</SecTitle></div>
              <div className={styles.list}>
                {pending.map(o => (
                  <div key={o.id} className={styles.row}>
                    <div>
                      <div className={styles.rowName}>{o.name} <span className={styles.tagOff}>Pending</span></div>
                      <div className={styles.rowSub}>
                        Requested by {o.admin_username}{o.admin_email ? ` · ${o.admin_email}` : ''}
                      </div>
                    </div>
                    <div className={styles.rowActions}>
                      <button className={styles.dangerBtn} onClick={() => setModal({ kind: 'removeOrg', org: o })}>Remove</button>
                      <button className={styles.smallBtn} onClick={() => rejectOrg(o)}>Reject</button>
                      <button className={styles.primaryBtn} onClick={() => approveOrg(o)}>Approve</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className={`${styles.bleed} ${styles.listSection}`}>
            <div className={styles.listHead}>
              <span className={styles.listEyebrow}>All organizations</span>
              <button className={styles.primaryBtn} onClick={() => setModal('org')}>+ New organization</button>
            </div>
            {orgs.length === 0 ? (
              <div className={styles.empty}>No organizations yet. Create the first one.</div>
            ) : (
              <div className={styles.orgList}>
                {orgs.map(o => {
                  const pct = Math.round(((o.scans || 0) / maxScans) * 100);
                  return (
                    <div key={o.id} className={styles.orgRow}
                      role="button" tabIndex={0}
                      onClick={() => openOrg(o)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrg(o); } }}
                      style={{ position: 'relative', zIndex: orgMenuFor === o.id ? 5 : undefined }}>
                      <span className={styles.orgBadge} aria-hidden="true">{orgInitials(o.name)}</span>
                      <div className={styles.orgInfo}>
                        <div className={styles.orgRowName}>
                          {o.name}
                          {o.status && o.status !== 'active' && (
                            <span className={styles.tagOff}>
                              {o.status === 'pending' ? 'Pending' : 'Inactive'}
                            </span>
                          )}
                        </div>
                        <div className={styles.orgRowMeta}>
                          {o.sites} site{o.sites === 1 ? '' : 's'} · {o.users} user{o.users === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className={styles.scanBar}>
                        <div className={styles.scanTrack}>
                          <div className={styles.scanFill} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={styles.scanVal}>{o.scans || 0}</span>
                      </div>
                      <div className={styles.kebabWrap} onClick={(e) => e.stopPropagation()}>
                        <button className={styles.kebabBtn} title="Options" aria-label="Options"
                          onClick={(e) => { e.stopPropagation(); setOrgMenuFor(orgMenuFor === o.id ? null : o.id); }}>⋮</button>
                        {orgMenuFor === o.id && (
                          <div className={styles.menu} onClick={(e) => e.stopPropagation()}>
                            <button className={styles.menuItem}
                              onClick={() => { setOrgMenuFor(null); onOrgMenu('edit', o); }}>Edit</button>
                            <button className={styles.menuItem}
                              onClick={() => { setOrgMenuFor(null); onOrgMenu('toggle', o); }}>
                              {o.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
                            <button className={`${styles.menuItem} ${styles.menuDanger}`}
                              onClick={() => { setOrgMenuFor(null); onOrgMenu('remove', o); }}>Remove</button>
                          </div>
                        )}
                      </div>
                      <span className={styles.orgArrow} aria-hidden="true">→</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Admin: organization awaiting owner approval ── */}
      {myOrgPending && activeOrg && (
        <div className={styles.empty} style={{ marginTop: 24, textAlign: 'left', padding: '28px 24px' }}>
          <div className={styles.rowName} style={{ fontSize: '1.05rem', marginBottom: 8 }}>
            {activeOrg.name} is awaiting approval
          </div>
          <p style={{ color: '#717171', fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            Your organization request has been submitted and is waiting for the platform owner to review it.
            Once approved, you'll be able to add sites, invite members, and start scanning.
          </p>
        </div>
      )}

      {/* ── Org detail: Sites + Members ── */}
      {activeOrg && !myOrgPending && (
        <>
          {isOwner && (
            <button className={styles.backLink} onClick={() => { setActiveOrg(null); setSites([]); setMembers([]); setOdash(null); }}>
              <Icon name="arrow_back" style={{ fontSize: 16 }} />
              All organizations
            </button>
          )}

          {odash && (
            <StatRow items={[
              { label: 'People', value: odash.totals.users, icon: 'group' },
              { label: 'Active', value: odash.totals.activeUsers, icon: 'person_check' },
              { label: 'Scans', value: odash.totals.scans, icon: 'qr_code_scanner' },
              { label: 'Sites', value: odash.totals.sites, icon: 'location_on' },
            ]} />
          )}

          {/* People — scan counts, click to see that person's scans */}
          <section className={styles.block}>
            <div className={styles.sectionHead}><SecTitle icon="group">People</SecTitle></div>
            {members.length === 0 ? (
              <div className={styles.empty}>No members yet.</div>
            ) : (
              <div className={styles.peopleGrid}>
                {members.map(m => {
                  const on = scanFilter?.type === 'user' && scanFilter.id === m.id;
                  const canManage = m.role !== 'owner' && !(m.role === 'org_admin' && !isOwner);
                  return (
                    <div key={m.id} className={`${styles.personCard} ${on ? styles.personOn : ''} ${m.active === 0 ? styles.personOff : ''}`}
                      style={menuFor === m.id ? { position: 'relative', zIndex: 5 } : undefined}>
                      <button className={styles.personMain}
                        onClick={() => setScanFilter(on ? null : { type: 'user', id: m.id, name: m.username })}
                        title="Show this person's scans">
                        <span className={styles.avatar}>
                          {(m.username || '?').slice(0, 1).toUpperCase()}
                          <span className={`${styles.statusDot} ${m.active === 0 ? styles.statusIdle : styles.statusOn}`} aria-hidden="true" />
                        </span>
                        <span className={styles.personText}>
                          <span className={styles.personName}>{m.username}</span>
                          <span className={styles.personSub}>
                            {roleLabel(m.role)}{m.active === 0 ? ' · off' : ''}
                            {m.last_scan ? ` · ${fmtDate(m.last_scan)}` : ''}
                          </span>
                        </span>
                        <span className={styles.tally}>
                          <span className={styles.tallyNum}>{m.scans || 0}</span>
                          <span className={styles.tallyLbl}>scan{m.scans === 1 ? '' : 's'}</span>
                        </span>
                      </button>
                      {canManage && (
                        <div className={styles.kebabWrap}>
                          <button className={styles.kebabBtn} title="Options" aria-label="Options"
                            onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m.id ? null : m.id); }}>⋮</button>
                          {menuFor === m.id && (
                            <div className={styles.menu} onClick={(e) => e.stopPropagation()}>
                              <button className={styles.menuItem}
                                onClick={() => { setMenuFor(null); setModal({ kind: 'editMember', member: m }); }}>Edit</button>
                              <button className={styles.menuItem}
                                onClick={() => { setMenuFor(null); toggleActive(m); }}>{m.active === 0 ? 'Reactivate' : 'Deactivate'}</button>
                              <button className={`${styles.menuItem} ${styles.menuDanger}`}
                                onClick={() => removeMember(m)}>Remove</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Sites — click to see that site's scans */}
          <section className={styles.block}>
            <div className={styles.sectionHead}>
              <SecTitle icon="location_on">Sites</SecTitle>
              <button className={styles.primaryBtn} onClick={() => setModal('site')}>+ Add site</button>
            </div>
            {sites.length === 0 ? (
              <div className={styles.empty}>No sites yet.</div>
            ) : (
              <div className={styles.list}>
                {sites.map(s => {
                  const on = scanFilter?.type === 'site' && scanFilter.name === s.name;
                  return (
                    <div key={s.id} className={`${styles.row} ${on ? styles.rowActive : ''}`}>
                      <button className={styles.rowMain}
                        onClick={() => setScanFilter(on ? null : { type: 'site', name: s.name })}
                        title="Show this site's scans">
                        <div className={styles.rowName}>{s.name}</div>
                        <div className={styles.rowSub}>
                          {s.users} user{s.users === 1 ? '' : 's'} · {s.scans} scan{s.scans === 1 ? '' : 's'}
                          {s.last_scan ? ` · last ${fmtDate(s.last_scan)}` : ''}
                        </div>
                      </button>
                      <div className={styles.rowActions}>
                        <button className={styles.smallBtn}
                          onClick={() => setModal({ kind: 'invite', siteId: s.id, siteName: s.name })}>Invite</button>
                        <button className={styles.smallBtn}
                          onClick={() => setModal({ kind: 'member', siteId: s.id, siteName: s.name })}>+ Add member</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Scans — thumbnails, filtered by the selected person / site */}
          {odash && (
            <ScanGrid
              scans={(odash.recentScans || []).filter(s => !scanFilter
                || (scanFilter.type === 'user' && s.by_user_id === scanFilter.id)
                || (scanFilter.type === 'site' && s.site === scanFilter.name))}
              filterLabel={scanFilter ? (scanFilter.type === 'user' ? `by ${scanFilter.name}` : scanFilter.name) : null}
              onClear={() => setScanFilter(null)}
            />
          )}

          {/* Org-wide external access — admin sets encrypted credentials the
              whole org's pipeline uses. Owner has no org context, so admin-only. */}
          {!isOwner && <OrgConnectionsPanel />}
        </>
      )}

      {/* ── Modals ── */}
      {modal === 'org' && (
        <CreateOrgModal
          onClose={() => setModal(null)}
          onDone={async (org) => { setModal(null); flash(`Organization “${org.name}” created`); await loadOrgs(); }}
        />
      )}
      {modal === 'site' && activeOrg && (
        <CreateSiteModal orgId={activeOrg.id}
          onClose={() => setModal(null)}
          onDone={async (site) => { setModal(null); flash(`Site “${site.name}” added`); await openOrg(activeOrg); }}
        />
      )}
      {modal?.kind === 'member' && activeOrg && (
        <AddMemberModal siteId={modal.siteId} siteName={modal.siteName}
          onClose={() => setModal(null)}
          onDone={async (mem) => { setModal(null); flash(`${mem.username} added to ${modal.siteName}`); await openOrg(activeOrg); }}
        />
      )}
      {modal?.kind === 'editMember' && activeOrg && (
        <EditMemberModal orgId={activeOrg.id} member={modal.member} sites={sites}
          onClose={() => setModal(null)}
          onDone={async (mem) => { setModal(null); flash(`${mem.username} updated`); await openOrg(activeOrg); }}
        />
      )}
      {modal?.kind === 'invite' && activeOrg && (
        <InviteModal siteId={modal.siteId} siteName={modal.siteName}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'renameOrg' && (
        <RenameOrgModal org={modal.org}
          onClose={() => setModal(null)}
          onSave={async (name) => { setModal(null); await doRenameOrg(modal.org, name); }}
        />
      )}
      {modal?.kind === 'deactivateOrg' && (
        <ConfirmModal
          title={`Deactivate ${modal.org.name}?`}
          message="Its members won't be able to scan until you reactivate it. You can turn it back on anytime."
          confirmLabel="Deactivate"
          onClose={() => setModal(null)}
          onConfirm={async () => { setModal(null); await doSetOrgStatus(modal.org, 'inactive'); }}
        />
      )}
      {modal?.kind === 'removeOrg' && (
        <ConfirmModal danger
          title={`Remove ${modal.org.name}?`}
          message="This permanently deletes the organization and all its members, sites and invites. This cannot be undone."
          confirmLabel="Remove permanently"
          onClose={() => setModal(null)}
          onConfirm={async () => { setModal(null); await doRemoveOrg(modal.org); }}
        />
      )}
    </div>
    </div>
  );
}

function RenameOrgModal({ org, onClose, onSave }) {
  const [name, setName] = useState(org.name || '');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const v = name.trim();
    if (!v || v === org.name) { onClose(); return; }
    setBusy(true);
    await onSave(v);
  };
  return (
    <Modal title="Rename organization" onClose={onClose}>
      <form onSubmit={submit}>
        <input className={styles.input} value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="Organization name" />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className={styles.smallBtn} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.primaryBtn} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger = false, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ margin: '0 0 18px', color: '#545454', lineHeight: 1.6 }}>{message}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button type="button" className={styles.smallBtn} onClick={onClose}>Cancel</button>
        <button type="button"
          className={danger ? styles.dangerBtn : styles.primaryBtn}
          disabled={busy}
          onClick={async () => { setBusy(true); await onConfirm(); }}>
          {busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

function roleLabel(r) {
  return { owner: 'Owner', org_admin: 'Org Admin', site_manager: 'Site Manager', member: 'Member' }[r] || r || 'Member';
}

// 1–2 letter initials for an org's badge (e.g. "Acme Corp" → "AC").
function orgInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function fmtDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    if (isNaN(d)) return s;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return s; }
}

function StatRow({ items }) {
  return (
    <div className={styles.stats}>
      {items.map(it => (
        <div key={it.label} className={styles.stat}>
          {it.icon && (
            <span className={styles.statIcon}>
              <Icon name={it.icon} />
            </span>
          )}
          <div className={styles.statText}>
            <div className={styles.statValue}>{it.value ?? 0}</div>
            <div className={styles.statLabel}>{it.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Section title with a leading inline-SVG icon. Replaces the old
// ::before dot marker with an actual glyph so each section reads at a glance.
function SecTitle({ icon, children }) {
  return (
    <h2 className={styles.sectionTitle}>
      {icon && <Icon name={icon} className={`${styles.secIcon}`} />}
      {children}
    </h2>
  );
}

function RecentScans({ scans, showOrg = false }) {
  const navigate = useNavigate();
  if (!scans || scans.length === 0) return null;
  const open = (rackId) => navigate(`/results/${rackId}`);
  return (
    <section className={styles.block}>
      <div className={styles.sectionHead}><SecTitle icon="history">Recent scans</SecTitle></div>
      <div className={styles.list}>
        {scans.map((s, i) => (
          <div
            key={s.rack_id + '_' + i}
            className={`${styles.row} ${styles.rowClickable}`}
            role="button"
            tabIndex={0}
            onClick={() => open(s.rack_id)}
            onKeyDown={e => { if (e.key === 'Enter') open(s.rack_id); }}
          >
            <div>
              <div className={`${styles.rowName} ${styles.mono}`}>{s.rack_id}</div>
              <div className={styles.rowSub}>
                {showOrg && s.org ? `${s.org} · ` : ''}{s.site || '-'}
                {s.by_user ? ` · by ${s.by_user}` : ''}
              </div>
            </div>
            <div className={styles.rowRight}>
              <span className={styles.rowDate}>{fmtDate(s.created_at)}</span>
              <span className={styles.rowOpen} aria-hidden="true">→</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Scan grid with original-image thumbnails + who/where/when. Filter-aware.
function ScanGrid({ scans, filterLabel, onClear }) {
  const navigate = useNavigate();
  const open = (rackId) => navigate(`/results/${rackId}`);
  return (
    <section className={styles.block}>
      <div className={styles.sectionHead}>
        <SecTitle icon="qr_code_scanner">
          {filterLabel ? `Scans · ${filterLabel}` : 'Recent scans'}
          <span className={styles.count}>{scans.length}</span>
        </SecTitle>
        {filterLabel && <button className={styles.smallBtn} onClick={onClear}>Show all</button>}
      </div>
      {scans.length === 0 ? (
        <div className={styles.empty}>{filterLabel ? 'No scans for this selection yet.' : 'No scans yet.'}</div>
      ) : (
        <div className={styles.scanGrid}>
          {scans.map((s, i) => (
            <button key={s.rack_id + '_' + i} className={styles.scanCard} onClick={() => open(s.rack_id)}>
              <span className={styles.scanThumb}>
                {s.image
                  ? <img src={apiUrl(s.image)} alt="" loading="lazy" />
                  : <span className={styles.scanThumbEmpty}>no image</span>}
                {s.devices > 0 && <span className={styles.scanBadge}>{s.devices} dev</span>}
              </span>
              <span className={styles.scanInfo}>
                <span className={`${styles.scanId} ${styles.mono}`}>{s.rack_id}</span>
                <span className={styles.scanSub}>{s.by_user ? `by ${s.by_user}` : '-'}{s.site ? ` · ${s.site}` : ''}</span>
                <span className={styles.scanDate}>{fmtDate(s.created_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Modal shell ──
// Every modal on this page goes through here, so the focus trap / Escape /
// focus-restore behaviour is applied once for all of them.
function Modal({ title, children, onClose }) {
  const titleId = useId();
  const ref = useModalA11y(onClose);
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div ref={ref} className={styles.modal} onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.modalHead}>
          <h3 id={titleId}>{title}</h3>
          <button className={styles.x} onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input className={styles.input} {...props} />
    </label>
  );
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await fn(); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return { run, busy, err };
}

function CreateOrgModal({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', adminUsername: '', adminEmail: '', adminPassword: '' });
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const { run, busy, err } = useSubmit(async () => {
    const d = await postJSON('/api/orgs', f);
    onDone(d.organization);
  });
  return (
    <Modal title="New organization" onClose={onClose}>
      <form onSubmit={run} className={styles.form}>
        <Field label="Organization name" value={f.name} onChange={set('name')} placeholder="Acme Corp" autoFocus />
        <p className={styles.formNote}>This organization gets one admin who manages its sites and members.</p>
        <Field label="Admin username" value={f.adminUsername} onChange={set('adminUsername')} placeholder="acme-admin" />
        <Field label="Admin email" type="email" value={f.adminEmail} onChange={set('adminEmail')} placeholder="admin@acme.com" />
        <Field label="Admin password" type="password" value={f.adminPassword} onChange={set('adminPassword')} placeholder="Min 8 chars, upper/lower/digit/symbol" />
        {err && <div className={styles.formErr}>{err}</div>}
        <button className={styles.primaryBtn} disabled={busy} type="submit">{busy ? 'Creating…' : 'Create organization'}</button>
      </form>
    </Modal>
  );
}

function CreateSiteModal({ orgId, onClose, onDone }) {
  const [name, setName] = useState('');
  const { run, busy, err } = useSubmit(async () => {
    const d = await postJSON(`/api/orgs/${orgId}/sites`, { name });
    onDone(d.site);
  });
  return (
    <Modal title="Add site" onClose={onClose}>
      <form onSubmit={run} className={styles.form}>
        <Field label="Site name" value={name} onChange={e => setName(e.target.value)} placeholder="HQ Datacenter" autoFocus />
        {err && <div className={styles.formErr}>{err}</div>}
        <button className={styles.primaryBtn} disabled={busy} type="submit">{busy ? 'Adding…' : 'Add site'}</button>
      </form>
    </Modal>
  );
}

function AddMemberModal({ siteId, siteName, onClose, onDone }) {
  const [f, setF] = useState({ username: '', email: '', password: '', role: 'member' });
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const { run, busy, err } = useSubmit(async () => {
    const d = await postJSON(`/api/sites/${siteId}/members`, f);
    onDone(d.member);
  });
  return (
    <Modal title={`Add member to ${siteName}`} onClose={onClose}>
      <form onSubmit={run} className={styles.form}>
        <Field label="Username" value={f.username} onChange={set('username')} placeholder="jane.doe" autoFocus />
        <Field label="Email" type="email" value={f.email} onChange={set('email')} placeholder="jane@acme.com" />
        <Field label="Password" type="password" value={f.password} onChange={set('password')} placeholder="Min 8 chars, upper/lower/digit/symbol" />
        <label className={styles.field}>
          <span>Role</span>
          <select className={styles.input} value={f.role} onChange={set('role')}>
            <option value="member">Member</option>
            <option value="site_manager">Site Manager</option>
          </select>
        </label>
        {err && <div className={styles.formErr}>{err}</div>}
        <button className={styles.primaryBtn} disabled={busy} type="submit">{busy ? 'Adding…' : 'Add member'}</button>
      </form>
    </Modal>
  );
}

function EditMemberModal({ orgId, member, sites, onClose, onDone }) {
  const isAdminTarget = member.role === 'org_admin';
  const [f, setF] = useState({
    username: member.username || '',
    email: member.email || '',
    role: isAdminTarget ? member.role : (member.role || 'member'),
    siteId: member.tenant_id ? String(member.tenant_id) : '',
    password: '',
  });
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const { run, busy, err } = useSubmit(async () => {
    const body = { username: f.username, email: f.email, siteId: f.siteId || null };
    if (!isAdminTarget) body.role = f.role;
    if (f.password) body.password = f.password;
    const d = await patchJSON(`/api/orgs/${orgId}/members/${member.id}`, body);
    onDone(d.member);
  });
  return (
    <Modal title={`Edit ${member.username}`} onClose={onClose}>
      <form onSubmit={run} className={styles.form}>
        <Field label="Username" value={f.username} onChange={set('username')} autoFocus />
        <Field label="Email" type="email" value={f.email} onChange={set('email')} />
        {!isAdminTarget && (
          <label className={styles.field}>
            <span>Role</span>
            <select className={styles.input} value={f.role} onChange={set('role')}>
              <option value="member">Member</option>
              <option value="site_manager">Site Manager</option>
            </select>
          </label>
        )}
        {sites && sites.length > 0 && (
          <label className={styles.field}>
            <span>Site</span>
            <select className={styles.input} value={f.siteId} onChange={set('siteId')}>
              <option value="">- No site -</option>
              {sites.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </label>
        )}
        <Field label="New password (leave blank to keep)" type="password" value={f.password} onChange={set('password')} placeholder="••••••••" />
        {err && <div className={styles.formErr}>{err}</div>}
        <button className={styles.primaryBtn} disabled={busy} type="submit">{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </Modal>
  );
}

function InviteModal({ siteId, siteName, onClose }) {
  const [f, setF] = useState({ email: '', role: 'member' });
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const { run, busy, err } = useSubmit(async () => {
    const d = await postJSON(`/api/sites/${siteId}/invites`, f);
    // publicOrigin(), not window.location.origin: in the native app the latter
    // is capacitor://localhost / http://localhost, so a shared invite link was
    // dead. This resolves to the real backend host that serves the web app.
    setLink(publicOrigin() + d.invite.path);
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) {}
  };
  return (
    <Modal title={`Invite to ${siteName}`} onClose={onClose}>
      {link ? (
        <div className={styles.form}>
          <p className={styles.formNote}>
            Send this link to {f.email}. It works once and expires in 7 days.
          </p>
          <div className={styles.inviteLinkRow}>
            <input className={styles.input} value={link} readOnly onFocus={e => e.target.select()} />
            <button type="button" className={styles.smallBtn} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <button className={styles.primaryBtn} type="button" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form onSubmit={run} className={styles.form}>
          <Field label="Email" type="email" value={f.email} onChange={set('email')} placeholder="teammate@company.com" autoFocus />
          <label className={styles.field}>
            <span>Role</span>
            <select className={styles.input} value={f.role} onChange={set('role')}>
              <option value="member">Member</option>
              <option value="site_manager">Site Manager</option>
            </select>
          </label>
          <p className={styles.formNote}>They open the link and set their own username &amp; password.</p>
          {err && <div className={styles.formErr}>{err}</div>}
          <button className={styles.primaryBtn} disabled={busy} type="submit">{busy ? 'Creating…' : 'Create invite link'}</button>
        </form>
      )}
    </Modal>
  );
}
