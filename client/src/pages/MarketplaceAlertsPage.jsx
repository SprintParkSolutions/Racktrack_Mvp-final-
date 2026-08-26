import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './MarketplaceAlertsPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';

/* ──────────────────────────────────────────────────────────────────────
   MarketplaceAlertsPage — saved-search matches and the searches
   themselves.

   The old page announced an unread alert with an indigo badge, a
   periwinkle card, a blue eyebrow and a blue link — four shades to say
   one thing. Unread is now a single ink dot on a slightly raised row,
   which is legible without turning the list into a colour chart, and
   leaves the coloured pill vocabulary free for genuine status.

   The two sections are deliberately ordered matches-then-searches: the
   reason to open this page is almost always "what came in", not "what
   am I watching".
   ────────────────────────────────────────────────────────────────────── */

const CATEGORY_LABEL = {
  cable: 'Cables', switch: 'Switches', router: 'Routers', rack: 'Racks',
  optic: 'Optics', server: 'Servers', pdu: 'PDUs', firewall: 'Firewalls',
  patch_panel: 'Patch panels', other: 'Other',
};

function formatRelative(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d + 'Z').getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function formatCurrency(cents, currency = 'USD') {
  if (cents == null) return 'Make an offer';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch { return `${currency} ${(cents / 100).toFixed(0)}`; }
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/* ── Alert row ───────────────────────────────────────────────────────
   Unread carries a raised background plus one ink dot. No colour: the
   row already differs from its neighbours by tone, and a coloured
   highlight would outrank the status pills elsewhere in the section. */
function AlertRow({ alert, onView, onDismiss }) {
  const { listing } = alert;
  return (
    <div className={`${styles.alert} ${alert.read ? '' : styles.alertUnread}`}>
      <span className={styles.alertDot} aria-hidden={alert.read ? 'true' : undefined}>
        {!alert.read && <span className={styles.alertDotMark} />}
      </span>

      <div className={styles.alertMain}>
        <p className="mkt-label">
          New match · {alert.searchLabel}
          {!alert.read && <span className={styles.srOnly}> (unread)</span>}
        </p>
        <h3 className={styles.alertTitle}>{listing.title}</h3>
        <p className={styles.alertMeta}>
          {[
            CATEGORY_LABEL[listing.category] || listing.category,
            listing.condition,
            formatCurrency(listing.priceCents, listing.currency),
            listing.sellerUsername && `@${listing.sellerUsername}`,
            formatRelative(alert.createdAt),
          ].filter(Boolean).join(' · ')}
        </p>
      </div>

      <div className={styles.alertActions}>
        <button className="mkt-btn mkt-btn--sm" onClick={onView}>View</button>
        <button
          className={`mkt-btn mkt-btn--sm ${styles.iconBtn}`}
          onClick={onDismiss}
          aria-label={`Dismiss alert for ${listing.title}`}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/* ── Saved-search row ────────────────────────────────────────────────
   The filters are the content here, so they render as pills rather than
   as a run-on sentence — a user scanning six saved searches is looking
   for one facet, not reading prose. */
function SavedSearchRow({ search, confirming, onConfirm, onCancel, onDelete }) {
  return (
    <div className={styles.search}>
      <div className={styles.searchMain}>
        <h3 className={styles.searchTitle}>{search.label}</h3>
        <div className={styles.chips}>
          {search.query && (
            /* A keyword is a literal the user typed, so it keeps its own
               casing instead of being shouted in the pill's uppercase. */
            <span className={`mkt-pill mkt-pill--neutral ${styles.chipQuery}`}>“{search.query}”</span>
          )}
          <span className="mkt-pill mkt-pill--neutral">
            {search.category ? CATEGORY_LABEL[search.category] || search.category : 'Any category'}
          </span>
          <span className="mkt-pill mkt-pill--neutral">
            {search.kind === 'want' ? 'Wanted' : 'For sale'}
          </span>
          {search.maxPrice != null && (
            <span className="mkt-pill mkt-pill--neutral">Under ${search.maxPrice}</span>
          )}
        </div>
      </div>

      {confirming ? (
        <div className={styles.searchConfirm}>
          <span className={styles.confirmText}>Stop alerts and delete?</span>
          <button className="mkt-btn mkt-btn--sm" onClick={onCancel}>Cancel</button>
          <button className="mkt-btn mkt-btn--sm mkt-btn--danger" onClick={onDelete}>
            Yes, delete
          </button>
        </div>
      ) : (
        <button
          className={`mkt-btn mkt-btn--sm mkt-btn--danger ${styles.iconBtn}`}
          onClick={onConfirm}
          aria-label={`Delete saved search ${search.label}`}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════ */
export default function MarketplaceAlertsPage() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();

  const [alerts, setAlerts]       = useState([]);
  const [searches, setSearches]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showNew, setShowNew]     = useState(false);
  // Replaces confirm() on delete — holds the id awaiting confirmation.
  const [confirmId, setConfirmId] = useState(null);

  // New search form
  const [label, setLabel]         = useState('');
  const [query, setQuery]         = useState('');
  const [category, setCategory]   = useState('');
  const [kind, setKind]           = useState('sell');
  const [maxPrice, setMaxPrice]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    if (!isAuthed) navigate('/login', { state: { from: '/marketplace/alerts' }, replace: true });
  }, [isAuthed, navigate]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [aRes, sRes] = await Promise.all([
        authFetch(apiUrl('/api/marketplace/alerts')),
        authFetch(apiUrl('/api/marketplace/saved-searches')),
      ]);
      const aData = await aRes.json();
      const sData = await sRes.json();
      if (aData.ok) setAlerts(aData.alerts || []);
      if (sData.ok) setSearches(sData.searches || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const markAllRead = async () => {
    await authFetch(apiUrl('/api/marketplace/alerts/mark-read'), { method: 'POST' });
    setAlerts(prev => prev.map(a => ({ ...a, read: true })));
  };

  const dismissAlert = async (id) => {
    await authFetch(apiUrl(`/api/marketplace/alerts/${id}`), { method: 'DELETE' });
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const deleteSavedSearch = async (id) => {
    await authFetch(apiUrl(`/api/marketplace/saved-searches/${id}`), { method: 'DELETE' });
    setSearches(prev => prev.filter(s => s.id !== id));
    setAlerts(prev => prev.filter(a => a.searchLabel !== searches.find(s => s.id === id)?.label));
    setConfirmId(null);
  };

  const saveSearch = async (e) => {
    e.preventDefault();
    if (!label.trim()) { setError('Label is required'); return; }
    setSaving(true); setError(null);
    try {
      const res = await authFetch(apiUrl('/api/marketplace/saved-searches'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          query: query.trim() || undefined,
          category: category || undefined,
          kind,
          maxPrice: maxPrice ? Number(maxPrice) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSearches(prev => [data.search, ...prev]);
      setShowNew(false);
      setLabel(''); setQuery(''); setCategory(''); setKind('sell'); setMaxPrice('');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const unreadCount = alerts.filter(a => !a.read).length;

  return (
    <MarketplaceShell
      title="Alerts"
      subtitle="Saved searches and matches"
      action={null}
      backTo="/marketplace"
    >
      {loading && <div className={styles.loading}><span className="mkt-spinner" /></div>}

      {!loading && (
        <>
          {/* ── Matches ────────────────────────────────────────────── */}
          <section>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">
                Matches
                {unreadCount > 0 && (
                  <span className={styles.unreadCount}>{unreadCount} new</span>
                )}
              </h2>
              {unreadCount > 0 && (
                <button className="mkt-linkBtn" onClick={markAllRead}>Mark all read</button>
              )}
            </div>

            {alerts.length === 0 ? (
              <div className="mkt-empty">
                <svg className="mkt-empty__icon" width="40" height="40" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="1.5"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5" />
                  <path d="M13.7 20a2 2 0 0 1-3.4 0" />
                </svg>
                <p className="mkt-empty__title">No matches yet</p>
                <p className="mkt-empty__text">
                  Save a search below and every new listing that fits it lands here -
                  usually within a few minutes of being posted.
                </p>
              </div>
            ) : (
              <div className={styles.alerts}>
                {alerts.map(a => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    onView={() => navigate(`/marketplace?q=${encodeURIComponent(a.listing.title)}`)}
                    onDismiss={() => dismissAlert(a.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Saved searches ─────────────────────────────────────── */}
          <section>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">
                Saved searches
                {searches.length > 0 && (
                  <span className={styles.unreadCount}>{searches.length}</span>
                )}
              </h2>
              {!showNew && (
                <button className="mkt-btn mkt-btn--sm" onClick={() => setShowNew(true)}>
                  New search
                </button>
              )}
            </div>

            {searches.length === 0 && !showNew && (
              <div className="mkt-empty">
                <svg className="mkt-empty__icon" width="40" height="40" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="1.5"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <p className="mkt-empty__title">Nothing saved yet</p>
                <p className="mkt-empty__text">
                  A saved search is a standing order - describe the gear you want once
                  and we watch every new listing for you.
                </p>
                <button className="mkt-btn mkt-btn--primary" onClick={() => setShowNew(true)}>
                  Save a search
                </button>
              </div>
            )}

            {searches.length > 0 && (
              <div className={styles.searches}>
                {searches.map(s => (
                  <SavedSearchRow
                    key={s.id}
                    search={s}
                    confirming={confirmId === s.id}
                    onConfirm={() => setConfirmId(s.id)}
                    onCancel={() => setConfirmId(null)}
                    onDelete={() => deleteSavedSearch(s.id)}
                  />
                ))}
              </div>
            )}

            {showNew && (
              <form className={`mkt-card mkt-card--pad ${styles.form}`} onSubmit={saveSearch}>
                <div className="mkt-fieldGroup">
                  <label className="mkt-label" htmlFor="mkt-search-label">Label *</label>
                  <input
                    id="mkt-search-label"
                    className="mkt-field"
                    placeholder="e.g. Cisco switch under $2k"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                  />
                  <span className="mkt-hint">How this search is named in your alerts.</span>
                </div>

                <div className="mkt-fieldGroup">
                  <label className="mkt-label" htmlFor="mkt-search-query">Keyword</label>
                  <input
                    id="mkt-search-query"
                    className="mkt-field"
                    placeholder="Cisco, Dell, SFP…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                <div className={styles.formRow}>
                  <div className="mkt-fieldGroup">
                    <label className="mkt-label" htmlFor="mkt-search-category">Category</label>
                    <select
                      id="mkt-search-category"
                      className="mkt-field"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="">Any</option>
                      {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mkt-fieldGroup">
                    <label className="mkt-label" htmlFor="mkt-search-price">Max price</label>
                    <input
                      id="mkt-search-price"
                      type="number"
                      className="mkt-field"
                      placeholder="No limit"
                      value={maxPrice}
                      min={0}
                      onChange={(e) => setMaxPrice(e.target.value)}
                    />
                  </div>
                </div>

                <div className="mkt-fieldGroup">
                  <span className="mkt-label">Listing kind</span>
                  <div className="mkt-segmented" role="group" aria-label="Listing kind">
                    <button
                      type="button"
                      className="mkt-segment"
                      aria-pressed={kind === 'sell'}
                      onClick={() => setKind('sell')}
                    >
                      For sale
                    </button>
                    <button
                      type="button"
                      className="mkt-segment"
                      aria-pressed={kind === 'want'}
                      onClick={() => setKind('want')}
                    >
                      Wanted
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="mkt-banner mkt-banner--error" role="alert">{error}</div>
                )}

                <div className={styles.formActions}>
                  <button type="button" className="mkt-btn" onClick={() => setShowNew(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="mkt-btn mkt-btn--primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save search'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </>
      )}
    </MarketplaceShell>
  );
}
