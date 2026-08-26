import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ProfilePage.module.css';
import { useAuth } from '../AuthContext.jsx';
import { useConnections } from '../ConnectionsContext.jsx';
import { TYPE_INFO } from '../utils/connectionsApi';
import { apiUrl, authFetch } from '../utils/api';
import Avatar from '../components/Avatar.jsx';
import { AVATARS, resolveAvatarIndex } from '../utils/avatars';
import BackButton from '../components/BackButton.jsx';
import Icon from '../components/Icon';
import AssetImg from '../components/AssetImg';

function formatJoined(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  } catch { return null; }
}
function formatJoinedLong(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  } catch { return '-'; }
}
function formatRelative(d) {
  if (!d) return '-';
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms) || ms < 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}
const titleCase = (s) => (s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-');

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, logout, refreshUser } = useAuth();
  const { active: activeConnection } = useConnections();
  const [scans, setScans] = useState([]);
  const [scansLoading, setScansLoading] = useState(true);
  const [scansError, setScansError] = useState(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const currentAvatar = resolveAvatarIndex(user);
  const chooseAvatar = async (idx) => {
    setSavingAvatar(true);
    try {
      const r = await authFetch(apiUrl('/api/auth/avatar'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: idx }),
      });
      if (r.ok) { await refreshUser?.(); setPickerOpen(false); }
    } catch (_) { /* keep the sheet open so they can retry */ }
    finally { setSavingAvatar(false); }
  };

  useEffect(() => {
    let cancelled = false;
    setScansLoading(true);
    authFetch(apiUrl('/api/scans'))
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setScans(data.scans || []); setScansError(null); } })
      .catch(err => { if (!cancelled) setScansError(err.message); })
      .finally(() => { if (!cancelled) setScansLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // The "copied" flag has to be cleared on a timer, and that timer has to be
  // cancelled on unmount — otherwise navigating away mid-countdown sets state
  // on a page that no longer exists.
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const joined = useMemo(() => formatJoined(user?.created_at), [user]);
  // Profile shows the 5 most recent only; the rest live on /history.
  const recent = useMemo(() => scans.slice(0, 5), [scans]);
  const orgName = user?.organization?.name || user?.tenant?.name || 'DEFAULT';
  const isAdmin = user?.role === 'owner' || user?.role === 'org_admin';

  const onSignOut = () => {
    logout();
    navigate('/', { replace: true });
  };

  // Sign out everywhere. The endpoint bumps token_version and revokes every
  // refresh row, which invalidates THIS session too — so the only correct
  // follow-up is to drop the local session and land on the sign-in page.
  // Treating a failure as success would leave someone believing a stolen
  // laptop had been locked out when it had not.
  const revokeEverywhere = async () => {
    setRevoking(true);
    try {
      const r = await authFetch(apiUrl('/api/auth/logout-all'), { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || `Could not sign out everywhere (HTTP ${r.status}).`);
      logout();
      navigate('/', { replace: true });
    } catch (err) {
      setScansError(err.message);
      setConfirmingRevoke(false);
    } finally {
      setRevoking(false);
    }
  };

  const copyEmail = async () => {
    if (!user?.email) return;
    try {
      await navigator.clipboard.writeText(user.email);
      setCopied(true);
    } catch { /* clipboard blocked — the address is on screen to select */ }
  };

  const openScan = async (rackId) => {
    try {
      const meta = scans.find(s => s.rackId === rackId);
      const res  = await authFetch(apiUrl(`/api/scan/${rackId}/report?format=json`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load scan');
      const result = {
        scanId: rackId, rackId, cached: true, timestamp: meta?.timestamp,
        devices: data.devices || [], units_detected: data.units_detected || [],
        originalExt: 'jpg',
      };
      // Navigate WITH the rackId in the URL (not bare /results) so the
      // Overview tab / sidebar link matches the route and highlights, and the
      // page is a proper deep link. state.result still preloads the data so it
      // doesn't refetch.
      navigate(`/results/${rackId}`, { state: { result } });
    } catch (err) { setScansError(err.message); }
  };

  return (
    <div className={`page page-full ${styles.profile}`}>
      <header className={styles.topbar}>
        {/* Grouped with the title so the header stays left-aligned whether or
            not the back button renders — it only appears when you arrived
            from somewhere, since tapping Profile in the nav has nowhere to
            go back to. */}
        <div className={styles.topbarLeft}>
          <BackButton fallback="/" />
          <h1 className={styles.topbarTitle}>Profile</h1>
        </div>
        {/* Kept even though the identity block below carries the account
            actions: on a phone the sidebar is a bottom bar with no sign-out,
            so removing this would leave that surface with no way out. */}
        <button
          type="button"
          className={styles.topbarIconBtn}
          onClick={() => setConfirmingSignOut(true)}
          aria-label="Sign out">
          <Icon name="logout" />
        </button>
      </header>

      <main className={styles.main}>
        {/* ── Identity ──
            An <img> banner rather than a CSS background: index.css strips
            background-image from a broad substring allow-list, so a background
            here would silently vanish. */}
        <section className={styles.identity}>
          <div className={styles.banner} aria-hidden="true">
            <img src="/datacenter.jpg" alt="" className={styles.bannerImg} loading="lazy" />
          </div>

          <div className={styles.idRow}>
            <button
              type="button"
              className={styles.avatarBtn}
              onClick={() => setPickerOpen(true)}
              aria-label="Change profile picture"
            >
              <Avatar user={user} size={104} ring />
              <span className={styles.avatarEdit}><Icon name="edit" /></span>
            </button>

            <div className={styles.idText}>
              <h2 className={styles.name}>{user?.username || 'Guest'}</h2>
              {user?.email && (
                <p className={styles.email}>
                  <span className={styles.emailText}>{user.email}</span>
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={copyEmail}
                    aria-label={copied ? 'Email copied' : 'Copy email address'}
                  >
                    <Icon name={copied ? 'check' : 'copy'} />
                  </button>
                  {copied && <span className={styles.copied}>Copied</span>}
                </p>
              )}
              <p className={styles.metaLine}>
                {orgName}{joined && <> · Since {joined}</>}
              </p>
            </div>
          </div>
        </section>

        {scansError && <div className={styles.errBanner} role="alert">{scansError}</div>}

        <div className={styles.cols}>
          {/* ── Left column ── */}
          <div className={styles.colMain}>
            {isAdmin && (
              <section className={styles.block}>
                <h3 className={styles.blockH}>Administration</h3>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => navigate('/organizations')}
                >
                  <span className={styles.rowIcon}><Icon name="space_dashboard" /></span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {user?.role === 'owner' ? 'Owner Dashboard' : 'Organization Dashboard'}
                    </span>
                    <span className={styles.rowMeta}>
                      {user?.role === 'owner'
                        ? 'All organizations, sites & scans'
                        : 'Sites, members & scan activity'}
                    </span>
                  </span>
                  <Icon name="chevron_right" className={styles.rowChevron} />
                </button>
              </section>
            )}

            <section className={styles.block}>
              <h3 className={styles.blockH}>Recent scans</h3>

              {scansLoading && (
                <div className={styles.note}>Loading scans…</div>
              )}

              {!scansLoading && recent.length === 0 && !scansError && (
                <div className={styles.empty}>
                  <p className={styles.emptyText}>No scans yet.</p>
                  <button className={styles.startBtn} onClick={() => navigate('/scan')}>
                    Start your first scan
                  </button>
                </div>
              )}

              {!scansLoading && recent.length > 0 && (
                <ul className={styles.rowList}>
                  {recent.map(s => (
                    <li key={s.rackId}>
                      <button
                        type="button"
                        className={styles.row}
                        onClick={() => openScan(s.rackId)}
                      >
                        <span className={styles.rowThumb}>
                          {s.image
                            ? <AssetImg path={s.image} alt="" loading="lazy" />
                            : <Icon name="terminal" />}
                        </span>
                        <span className={styles.rowMain}>
                          <span className={`${styles.rowTitle} ${styles.rowTitleMono}`}>{s.rackId}</span>
                          <span className={styles.rowMeta}>
                            {s.deviceCount} dev · {s.unitCount} units · {s.portCount} port{s.portCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className={styles.rowEnd}>
                          <span className={styles.rowTime}>{formatRelative(s.timestamp)}</span>
                          <Icon name="chevron_right" className={styles.rowChevron} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Beyond five, the archive is its own page — expanding the list in
                  place turned Profile into an endless scroll with no way to find a
                  particular rack. /history is searchable, filtered and paged. */}
              {!scansLoading && scans.length > 5 && (
                <button
                  type="button"
                  className={styles.showAllBtn}
                  onClick={() => navigate('/history')}
                >
                  View all {scans.length} scans
                  <Icon name="chevron_right" className={styles.showAllChevron} />
                </button>
              )}
            </section>
          </div>

          {/* ── Right column ── */}
          <div className={styles.colSide}>
            {isAdmin && (
              <section className={styles.block}>
                <h3 className={styles.blockH}>Data sources</h3>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => navigate('/connections')}
                >
                  <span className={styles.rowIcon}><Icon name="dns" /></span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {activeConnection ? activeConnection.name : 'Connect a database'}
                    </span>
                    <span className={styles.rowMeta}>
                      {activeConnection
                        ? <>{TYPE_INFO[activeConnection.type]?.label || activeConnection.type} · <span className={styles.ok}>Active</span></>
                        : 'Set up ServiceNow, NetBox, Orion…'}
                    </span>
                  </span>
                  <Icon name="chevron_right" className={styles.rowChevron} />
                </button>
              </section>
            )}

            <section className={styles.block}>
              <h3 className={styles.blockH}>Profile details</h3>
              <dl className={styles.details}>
                <div className={styles.detail}>
                  <dt className={styles.dt}>Role</dt>
                  <dd className={styles.dd}>{titleCase(user?.role)}</dd>
                </div>
                <div className={styles.detail}>
                  <dt className={styles.dt}>Email</dt>
                  <dd className={styles.dd}>{user?.email || '-'}</dd>
                </div>
                <div className={styles.detail}>
                  <dt className={styles.dt}>Member since</dt>
                  <dd className={styles.dd}>{formatJoinedLong(user?.created_at)}</dd>
                </div>
                <div className={styles.detail}>
                  <dt className={styles.dt}>Default organization</dt>
                  <dd className={styles.dd}>{orgName}</dd>
                </div>
              </dl>
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockH}>Account actions</h3>
              <div className={styles.actionWrap}>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => setConfirmingRevoke(true)}
                  disabled={revoking}
                >
                  <Icon name="logout" className={styles.dangerIcon} />
                  {revoking ? 'Signing out…' : 'Sign out from all devices'}
                </button>
                <p className={styles.actionNote}>
                  Ends every signed-in session for this account, including this one.
                </p>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* ── Sign-out confirm ── */}
      {confirmingSignOut && (
        <div className={styles.confirmBackdrop}>
          <div className={styles.confirmModal}>
            <div className={styles.confirmIcon}><Icon name="logout" /></div>
            <h3 className={styles.confirmTitle}>Sign out?</h3>
            <p className={styles.confirmMsg}>You&apos;ll need to sign in again to scan racks.</p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setConfirmingSignOut(false)}>Cancel</button>
              <button className={styles.confirmGo} onClick={onSignOut}>Sign out</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sign-out-everywhere confirm ──
          Separate from the ordinary sign-out prompt on purpose: this one also
          ends sessions on devices the person is not holding, and that is not
          something to discover after the fact. */}
      {confirmingRevoke && (
        <div className={styles.confirmBackdrop}>
          <div className={styles.confirmModal}>
            <div className={styles.confirmIcon}><Icon name="logout" /></div>
            <h3 className={styles.confirmTitle}>Sign out from all devices?</h3>
            <p className={styles.confirmMsg}>
              Every phone, tablet and browser signed in as <strong>{user?.username}</strong> will
              be signed out, including this one.
            </p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setConfirmingRevoke(false)} disabled={revoking}>
                Cancel
              </button>
              <button className={styles.confirmGo} onClick={revokeEverywhere} disabled={revoking}>
                {revoking ? 'Signing out…' : 'Sign out everywhere'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Avatar picker ── */}
      {pickerOpen && (
        <div
          onClick={() => !savingAvatar && setPickerOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            background: 'rgba(0, 0, 0,.55)', backdropFilter: 'blur(4px)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, background: 'var(--md-background, #fff)', color: 'var(--md-on-surface, #171717)',
              borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '20px 22px calc(24px + env(safe-area-inset-bottom))',
              boxShadow: '0 -10px 40px rgba(0,0,0,.28)' }}
          >
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'rgba(128,128,128,.35)', margin: '0 auto 16px' }} />
            <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 750, textAlign: 'center' }}>Choose your picture</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13.5, opacity: .6, textAlign: 'center' }}>Pick a look - tap to save.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, justifyItems: 'center' }}>
              {AVATARS.map((_, idx) => (
                <Avatar
                  key={idx}
                  index={idx}
                  initial={(user?.username || user?.email || '?').charAt(0).toUpperCase()}
                  size={64}
                  ring={idx === currentAvatar}
                  title={idx === currentAvatar ? 'Current' : 'Select'}
                  onClick={() => !savingAvatar && chooseAvatar(idx)}
                  style={savingAvatar ? { opacity: .5, pointerEvents: 'none' } : undefined}
                />
              ))}
            </div>
            <button
              onClick={() => !savingAvatar && setPickerOpen(false)}
              style={{ width: '100%', marginTop: 22, padding: '13px', borderRadius: 13, border: '1px solid rgba(128,128,128,.28)',
                background: 'transparent', color: 'inherit', fontSize: 15, fontWeight: 650, cursor: 'pointer' }}
            >
              {savingAvatar ? 'Saving…' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
