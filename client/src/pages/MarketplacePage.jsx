import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import styles from './MarketplacePage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';
import CategoryIcon from '../components/marketplace/CategoryIcon.jsx';
import useModalA11y from '../hooks/useModalA11y.js';

/* ──────────────────────────────────────────────────────────────────────
   MarketplacePage — browse + my-listings.

   Layout note: this page used to stack five full-width bands before a
   user saw a single listing — header, intro paragraph, a large partner
   search card, a tab row, then a filter row. The partner search sat at
   the very top, which put "leave RackTrack" above "shop RackTrack".

   It is now one toolbar (search + category + kind + result count) and
   then the grid. The partner search still exists, demoted to a quiet
   strip beneath the results where it reads as a fallback — which is
   what it is. Browse / My listings moved up into the shell nav so this
   page owns one level of controls instead of two.
   ────────────────────────────────────────────────────────────────────── */

const CATEGORY_LABEL = {
  cable:       'Cables',
  switch:      'Switches',
  router:      'Routers',
  rack:        'Racks',
  optic:       'Optics / SFPs',
  server:      'Servers',
  pdu:         'PDUs',
  firewall:    'Firewalls',
  patch_panel: 'Patch panels',
  other:       'Other',
};

const CONDITION_LABEL = {
  'new':       'New',
  'refurb':    'Refurbished',
  'used':      'Used',
  'for-parts': 'For parts',
};

const STATUS_PILL = {
  active: 'mkt-pill--active',
  sold:   'mkt-pill--neutral',
  closed: 'mkt-pill--neutral',
};

/* Was 2 — the grid could never look like a marketplace, and because
   "has more" was inferred from a full page, Next stayed live on the
   last page and landed the user on an empty one. We now ask for one
   extra row and render all but that, so the control reflects reality. */
const PAGE_SIZE = 24;

const PARTNER_SITES = [
  { name: 'eBay',      url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${q}` },
  { name: 'Amazon',    url: (q) => `https://www.amazon.com/s?k=${q}` },
  { name: 'FS.com',    url: (q) => `https://www.fs.com/search.html?keyword=${q}` },
  { name: 'Curvature', url: (q) => `https://www.curvature.com/search?keyword=${q}` },
];

function formatPrice(listing) {
  if (listing.priceCents == null) return 'Make an offer';
  const n = listing.priceCents / 100;
  const cur = listing.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: cur, maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${cur} ${n.toFixed(0)}`;
  }
}

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
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function StatusPill({ status }) {
  return (
    <span className={`mkt-pill ${STATUS_PILL[status] || 'mkt-pill--neutral'}`}>
      <span className="mkt-pill__dot" />{status}
    </span>
  );
}

/* ── Listing card (browse) ─────────────────────────────────────────────
   An <article> with a stretched overlay button rather than a <button>
   wrapping everything: the old markup nested the Buy control inside the
   card button, which is invalid HTML and unreachable by keyboard. Here
   the overlay opens the detail and Buy sits above it on its own. */
function ListingCard({ listing, onOpen, onBuy }) {
  const canBuy = listing.status === 'active'
    && listing.kind === 'sell'
    && listing.priceCents != null;

  return (
    <article className={styles.card}>
      <button
        type="button"
        className={styles.cardOpen}
        onClick={() => onOpen(listing)}
      >
        <span className={styles.srOnly}>View {listing.title}</span>
      </button>

      <div className={styles.cardThumb}>
        {listing.imageUrl
          ? <img src={listing.imageUrl} alt="" loading="lazy" />
          : <CategoryIcon category={listing.category} size={34} className={styles.cardThumbIcon} />}
        {listing.status !== 'active' && (
          <span className={`mkt-pill mkt-pill--solid ${styles.cardBadge}`}>{listing.status}</span>
        )}
      </div>

      <div className={styles.cardBody}>
        <p className={`mkt-label ${styles.cardEyebrow}`}>
          {CATEGORY_LABEL[listing.category] || listing.category}
          <span className={styles.cardEyebrowSep}>·</span>
          {CONDITION_LABEL[listing.condition] || listing.condition}
        </p>

        <h3 className={styles.cardTitle}>{listing.title}</h3>

        {(listing.vendor || listing.model) && (
          <p className={styles.cardVendor}>
            {[listing.vendor, listing.model].filter(Boolean).join(' · ')}
          </p>
        )}

        <div className={styles.cardFoot}>
          <span className={styles.cardPrice}>{formatPrice(listing)}</span>
          <span className={styles.cardAge}>{formatRelative(listing.createdAt)}</span>
        </div>

        {(listing.seller?.username || listing.location) && (
          <p className={styles.cardSeller}>
            {[listing.seller?.username && `@${listing.seller.username}`, listing.location]
              .filter(Boolean).join(' · ')}
          </p>
        )}

        {canBuy && (
          <button
            type="button"
            className={`mkt-btn mkt-btn--primary mkt-btn--sm mkt-btn--block ${styles.cardBuy}`}
            onClick={(e) => { e.stopPropagation(); onBuy(listing.id); }}
          >
            Buy now
          </button>
        )}
      </div>
    </article>
  );
}

/* ── My-listings row ────────────────────────────────────────────────── */
function MyListingRow({ listing, onOpen, onPatch, onDelete, onEdit }) {
  // Two-step inline delete instead of window.confirm — the confirmation
  // stays inside the page and inside the design.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div className={styles.row}>
      <button type="button" className={styles.rowOpen} onClick={() => onOpen(listing)}>
        <span className={styles.srOnly}>View {listing.title}</span>
      </button>

      <div className={styles.rowThumb}>
        {listing.imageUrl
          ? <img src={listing.imageUrl} alt="" loading="lazy" />
          : <CategoryIcon category={listing.category} size={20} className={styles.rowThumbIcon} />}
      </div>

      <div className={styles.rowInfo}>
        <div className={styles.rowTitleLine}>
          <h3 className={styles.rowTitle}>{listing.title}</h3>
          <StatusPill status={listing.status} />
        </div>
        <p className={styles.rowMeta}>
          {[
            CATEGORY_LABEL[listing.category] || listing.category,
            CONDITION_LABEL[listing.condition] || listing.condition,
            listing.location,
            formatRelative(listing.createdAt),
          ].filter(Boolean).join(' · ')}
        </p>
      </div>

      <span className={styles.rowPrice}>{formatPrice(listing)}</span>

      <div className={styles.rowActions}>
        {confirmDelete ? (
          <>
            <span className={styles.rowConfirmText}>Delete?</span>
            <button
              className="mkt-btn mkt-btn--sm mkt-btn--danger"
              onClick={stop(() => onDelete(listing.id))}
            >
              Yes, delete
            </button>
            <button
              className="mkt-btn mkt-btn--sm"
              onClick={stop(() => setConfirmDelete(false))}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="mkt-btn mkt-btn--sm" onClick={stop(() => onEdit(listing))}>
              Edit
            </button>
            {listing.status === 'active' ? (
              <button
                className="mkt-btn mkt-btn--sm"
                onClick={stop(() => onPatch(listing.id, { status: 'sold' }))}
              >
                Mark sold
              </button>
            ) : (
              <button
                className="mkt-btn mkt-btn--sm"
                onClick={stop(() => onPatch(listing.id, { status: 'active' }))}
              >
                Relist
              </button>
            )}
            <button
              className="mkt-btn mkt-btn--sm mkt-btn--danger"
              onClick={stop(() => setConfirmDelete(true))}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Detail modal ───────────────────────────────────────────────────── */
function ListingDetailModal({ listing, partners, onClose, onPatch, onDelete, isMine, onBuy, onFlag }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting]         = useState(false);
  const [reason, setReason]               = useState('');
  const [reported, setReported]           = useState(false);
  // The modal sits above the page's error banner, so a failed report has
  // to say so inside the modal or it looks like nothing happened.
  const [reportErr, setReportErr]         = useState(null);

  // Reset per-listing UI whenever a different listing is opened.
  const id = listing?.id;
  useEffect(() => {
    setConfirmDelete(false); setReporting(false);
    setReason(''); setReported(false); setReportErr(null);
  }, [id]);

  // Escape, focus trap, focus restore and background scroll lock all come
  // from the shared hook; `active` gates it so the closed modal does nothing.
  const dialogRef = useModalA11y(onClose, { active: !!listing });

  if (!listing) return null;

  const canBuy = listing.status === 'active'
    && listing.kind === 'sell'
    && listing.priceCents != null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={listing.title}
      >
        <button className={styles.modalClose} onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div className={`${styles.modalThumb} ${listing.imageUrl ? '' : styles.modalThumbEmpty}`}>
          {listing.imageUrl
            ? <img src={listing.imageUrl} alt="" />
            : <CategoryIcon category={listing.category} size={40} className={styles.modalThumbIcon} />}
        </div>

        <div className={styles.modalBody}>
          <div className={styles.modalHead}>
            <p className={`mkt-label ${styles.cardEyebrow}`}>
              {CATEGORY_LABEL[listing.category] || listing.category}
              <span className={styles.cardEyebrowSep}>·</span>
              {CONDITION_LABEL[listing.condition] || listing.condition}
            </p>
            {listing.status !== 'active' && <StatusPill status={listing.status} />}
          </div>

          <h2 className={styles.modalTitle}>{listing.title}</h2>
          {(listing.vendor || listing.model) && (
            <p className={styles.modalVendor}>
              {[listing.vendor, listing.model].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className={styles.modalPrice}>{formatPrice(listing)}</p>

          <div className="mkt-facts mkt-facts--2">
            <div className="mkt-fact">
              <span className="mkt-fact__key">Seller</span>
              <span className="mkt-fact__val">@{listing.seller?.username || 'unknown'}</span>
            </div>
            <div className="mkt-fact">
              <span className="mkt-fact__key">Listed</span>
              <span className="mkt-fact__val">{formatRelative(listing.createdAt)}</span>
            </div>
            {listing.quantity > 1 && (
              <div className="mkt-fact">
                <span className="mkt-fact__key">Quantity</span>
                <span className="mkt-fact__val">{listing.quantity} available</span>
              </div>
            )}
            {listing.location && (
              <div className="mkt-fact">
                <span className="mkt-fact__key">Location</span>
                <span className="mkt-fact__val">{listing.location}</span>
              </div>
            )}
            {listing.sourceRackId && (
              <div className="mkt-fact">
                <span className="mkt-fact__key">From scan</span>
                <span className="mkt-fact__val mkt-mono">{listing.sourceRackId}</span>
              </div>
            )}
          </div>

          {listing.description && (
            <p className={styles.modalDesc}>{listing.description}</p>
          )}

          {isMine ? (
            <div className={styles.modalActions}>
              {confirmDelete ? (
                <div className={styles.confirmBar}>
                  <span className={styles.confirmText}>
                    Delete this listing? This cannot be undone.
                  </span>
                  <div className={styles.confirmBtns}>
                    <button className="mkt-btn mkt-btn--sm" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                    <button className="mkt-btn mkt-btn--sm mkt-btn--danger" onClick={onDelete}>
                      Yes, delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.modalBtnRow}>
                  {listing.status === 'active' ? (
                    <button className="mkt-btn" onClick={() => onPatch({ status: 'sold' })}>
                      Mark sold
                    </button>
                  ) : (
                    <button className="mkt-btn" onClick={() => onPatch({ status: 'active' })}>
                      Relist
                    </button>
                  )}
                  <button className="mkt-btn mkt-btn--danger" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.modalActions}>
              {canBuy && (
                <button
                  className="mkt-btn mkt-btn--primary mkt-btn--tall mkt-btn--block"
                  onClick={() => onBuy(listing.id)}
                >
                  Buy now - {formatPrice(listing)}
                </button>
              )}
              {listing.priceCents == null && (
                <p className={`mkt-banner ${styles.offerNote}`}>
                  No set price on this listing - contact @{listing.seller?.username} to
                  make an offer.
                </p>
              )}

              {/* Report — an inline form, replacing window.prompt(). */}
              {reported ? (
                <p className="mkt-banner mkt-banner--success">
                  Reported. An admin will review this listing.
                </p>
              ) : reporting ? (
                <div className={styles.reportBox}>
                  <label className="mkt-label" htmlFor="mkt-report-reason">
                    Why are you reporting this?
                  </label>
                  <textarea
                    id="mkt-report-reason"
                    className="mkt-field"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Tell us what's wrong with this listing…"
                  />
                  {reportErr && (
                    <p className="mkt-banner mkt-banner--error">{reportErr}</p>
                  )}
                  <div className={styles.confirmBtns}>
                    <button className="mkt-btn mkt-btn--sm" onClick={() => setReporting(false)}>
                      Cancel
                    </button>
                    <button
                      className="mkt-btn mkt-btn--sm mkt-btn--primary"
                      disabled={!reason.trim()}
                      onClick={async () => {
                        setReportErr(null);
                        const err = await onFlag(listing.id, reason.trim());
                        if (err) setReportErr(err);
                        else { setReporting(false); setReported(true); }
                      }}
                    >
                      Submit report
                    </button>
                  </div>
                </div>
              ) : (
                <button className={`mkt-linkBtn ${styles.reportLink}`} onClick={() => setReporting(true)}>
                  Report listing
                </button>
              )}
            </div>
          )}

          {partners && partners.length > 0 && (
            <div className={styles.modalPartners}>
              <p className="mkt-label">Compare elsewhere</p>
              <div className={styles.partnerLinks}>
                {partners.map(p => (
                  <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"
                     className="mkt-btn mkt-btn--sm">
                    {p.name}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17 17 7M9 7h8v8" />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Pagination ─────────────────────────────────────────────────────── */
function Pagination({ page, hasMore, onPrev, onNext }) {
  if (page <= 1 && !hasMore) return null;
  return (
    <div className={styles.pagination}>
      <button className="mkt-btn mkt-btn--sm" disabled={page <= 1} onClick={onPrev}>
        Previous
      </button>
      <span className={styles.pageLabel}>Page {page}</span>
      <button className="mkt-btn mkt-btn--sm" disabled={!hasMore} onClick={onNext}>
        Next
      </button>
    </div>
  );
}

/* ── Partner strip ──────────────────────────────────────────────────── */
function PartnerStrip() {
  const [query, setQuery] = useState('');
  const term = query.trim();
  const enc  = encodeURIComponent(term);

  return (
    <section className={styles.partnerStrip}>
      <div className={styles.partnerCopy}>
        <p className="mkt-label">Can’t find it here?</p>
        <p className={styles.partnerText}>
          Run the same part number across the partner marketplaces.
        </p>
      </div>
      <div className={styles.partnerControls}>
        <input
          className={`mkt-field ${styles.partnerInput}`}
          placeholder="e.g. Cisco WS-C3850-48T"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search partner marketplaces"
        />
        <div className={styles.partnerLinks}>
          {PARTNER_SITES.map(site => (
            <a
              key={site.name}
              className={`mkt-btn mkt-btn--sm ${!term ? styles.partnerDisabled : ''}`}
              href={term ? site.url(enc) : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!term}
              tabIndex={term ? 0 : -1}
              onClick={(e) => { if (!term) e.preventDefault(); }}
            >
              {site.name}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════ */
export default function MarketplacePage() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const [params, setParams] = useSearchParams();

  // The shell nav owns Browse / My listings, so the tab is read from the
  // URL rather than held here — otherwise the two would drift apart.
  const tab = params.get('tab') === 'mine' ? 'mine' : 'browse';

  const [kind, setKind]         = useState(params.get('kind') === 'want' ? 'want' : 'sell');
  const [q, setQ]               = useState(params.get('q') || '');
  const [category, setCategory] = useState(params.get('category') || '');
  const [page, setPage]         = useState(parseInt(params.get('page'), 10) || 1);
  const [listings, setListings] = useState([]);
  const [hasMore, setHasMore]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [detail, setDetail]     = useState(null);

  // Typing used to fire one request per keystroke; hold the query for a
  // beat so a part number is one search, not fourteen.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url;
      if (tab === 'mine') {
        url = apiUrl('/api/marketplace/listings/mine');
      } else {
        const usp = new URLSearchParams();
        usp.set('kind', kind);
        // Ask for one more than we show: if it comes back, there really
        // is a next page. Inferring it from a full page left Next live
        // on the last page.
        usp.set('limit', String(PAGE_SIZE + 1));
        usp.set('page', String(page));
        if (category)   usp.set('category', category);
        if (debouncedQ) usp.set('q', debouncedQ);
        url = apiUrl('/api/marketplace/listings?' + usp.toString());
      }
      const res  = await authFetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const all = data.listings || [];
      if (tab === 'mine') {
        setListings(all);
        setHasMore(false);
      } else {
        setListings(all.slice(0, PAGE_SIZE));
        setHasMore(all.length > PAGE_SIZE);
      }
    } catch (err) {
      setError(err.message);
      setListings([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [tab, kind, debouncedQ, category, page]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  // Reset to page 1 when the filters change — but not on first render,
  // or a bookmarked ?page=3 would be thrown away before it loaded.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setPage(1);
  }, [tab, kind, debouncedQ, category]);

  // Reflect filter state into the URL so bookmarks and Back work.
  useEffect(() => {
    const usp = new URLSearchParams();
    if (tab === 'mine')  usp.set('tab', 'mine');
    if (kind === 'want') usp.set('kind', 'want');
    if (q)         usp.set('q', q);
    if (category)  usp.set('category', category);
    if (page > 1)  usp.set('page', String(page));
    setParams(usp, { replace: true });
  }, [tab, kind, q, category, page, setParams]);

  const requireAuthThen = (to) => {
    if (!isAuthed) { navigate('/login', { state: { from: to } }); return; }
    navigate(to);
  };

  const openDetail = async (listing) => {
    try {
      const res  = await authFetch(apiUrl(`/api/marketplace/listings/${listing.id}`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail({ listing: data.listing, partners: data.partners });
    } catch (err) {
      setError(err.message);
    }
  };

  const patchDetail = async (patch) => {
    if (!detail) return;
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/listings/${detail.listing.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail({ listing: data.listing, partners: detail.partners });
      fetchListings();
    } catch (err) { setError(err.message); }
  };

  const deleteDetail = async () => {
    if (!detail) return;
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/listings/${detail.listing.id}`), {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail(null);
      fetchListings();
    } catch (err) { setError(err.message); }
  };

  const patchListingInline = async (id, patch) => {
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/listings/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      fetchListings();
    } catch (err) { setError(err.message); }
  };

  const deleteListingInline = async (id) => {
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/listings/${id}`), { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      fetchListings();
    } catch (err) { setError(err.message); }
  };

  // Resolves to null on success, or the message to show inside the modal.
  const flagListing = async (id, reason) => {
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/listings/${id}/flag`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to report listing');
      return null;
    } catch (err) { return err.message || 'Failed to report listing'; }
  };

  const hasFilters = Boolean(q || category);
  const clearFilters = () => { setQ(''); setCategory(''); };

  const countLabel = useMemo(() => {
    if (loading) return 'Loading…';
    const n = listings.length;
    if (tab === 'mine') return `${n} listing${n === 1 ? '' : 's'}`;
    const noun = kind === 'want' ? 'request' : 'listing';
    const more = hasMore ? '+' : '';
    return `${n}${more} ${noun}${n === 1 && !more ? '' : 's'}`;
  }, [loading, listings.length, tab, kind, hasMore]);

  return (
    <MarketplaceShell
      title="Marketplace"
      subtitle="Buy, sell and swap surplus network and data-center gear"
    >
      {error && (
        <div className="mkt-banner mkt-banner--error" role="alert">
          <span>{error}</span>
          <button className="mkt-linkBtn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* ── One toolbar: search, category, kind, count ───────────────── */}
      {tab === 'browse' && (
        <section className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <svg className={styles.searchIcon} width="15" height="15" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className={`mkt-field ${styles.searchInput}`}
              placeholder="Search by title, vendor or model…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search listings"
            />
            {q && (
              <button className={styles.searchClear} onClick={() => setQ('')} aria-label="Clear search">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <select
            className={`mkt-field ${styles.categorySelect}`}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          <div className="mkt-segmented" role="group" aria-label="Listing kind">
            <button
              className="mkt-segment"
              aria-pressed={kind === 'sell'}
              onClick={() => setKind('sell')}
            >
              For sale
            </button>
            <button
              className="mkt-segment"
              aria-pressed={kind === 'want'}
              onClick={() => setKind('want')}
            >
              Wanted
            </button>
          </div>
        </section>
      )}

      {/* ── Results ──────────────────────────────────────────────────── */}
      <section className={styles.results}>
        <div className="mkt-sectionHead">
          <h2 className="mkt-sectionTitle">
            {tab === 'mine' ? 'My listings' : kind === 'want' ? 'Wanted' : 'For sale'}
            <span className={styles.count}>{countLabel}</span>
          </h2>
          {tab === 'browse' && hasFilters && (
            <button className="mkt-linkBtn" onClick={clearFilters}>Clear filters</button>
          )}
        </div>

        {loading && (
          <div className={styles.loading}><span className="mkt-spinner" /></div>
        )}

        {!loading && listings.length === 0 && (
          <div className="mkt-empty">
            <CategoryIcon category="other" size={40} className="mkt-empty__icon" />
            <p className="mkt-empty__title">
              {tab === 'mine'
                ? 'You haven’t listed anything yet'
                : hasFilters
                  ? 'Nothing matches those filters'
                  : kind === 'want'
                    ? 'No open requests'
                    : 'No listings yet'}
            </p>
            <p className="mkt-empty__text">
              {tab === 'mine'
                ? 'List surplus gear from a scan or add it manually - it takes about a minute.'
                : hasFilters
                  ? 'Try a broader search, or clear the filters to see everything on offer.'
                  : kind === 'want'
                    ? 'Post what you’re looking for and sellers can respond directly.'
                    : 'Be the first to list surplus gear for your organization.'}
            </p>
            {hasFilters
              ? <button className="mkt-btn" onClick={clearFilters}>Clear filters</button>
              : <button className="mkt-btn mkt-btn--primary"
                        onClick={() => requireAuthThen('/marketplace/new')}>
                  {kind === 'want' && tab === 'browse' ? 'Post a request' : 'List an item'}
                </button>}
          </div>
        )}

        {!loading && listings.length > 0 && tab === 'browse' && (
          <>
            <div className={styles.grid}>
              {listings.map(l => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  onOpen={openDetail}
                  onBuy={(id) => requireAuthThen(`/marketplace/checkout/${id}`)}
                />
              ))}
            </div>
            <Pagination
              page={page}
              hasMore={hasMore}
              onPrev={() => setPage(p => Math.max(1, p - 1))}
              onNext={() => setPage(p => p + 1)}
            />
          </>
        )}

        {!loading && listings.length > 0 && tab === 'mine' && (
          <div className={styles.rows}>
            {listings.map(l => (
              <MyListingRow
                key={l.id}
                listing={l}
                onOpen={openDetail}
                onPatch={patchListingInline}
                onDelete={deleteListingInline}
                onEdit={(listing) => navigate(`/marketplace/new?editId=${listing.id}`)}
              />
            ))}
          </div>
        )}
      </section>

      {tab === 'browse' && <PartnerStrip />}

      <ListingDetailModal
        listing={detail?.listing}
        partners={detail?.partners}
        isMine={detail?.listing?.isMine}
        onClose={() => setDetail(null)}
        onPatch={patchDetail}
        onDelete={deleteDetail}
        onBuy={(id) => requireAuthThen(`/marketplace/checkout/${id}`)}
        onFlag={flagListing}
      />
    </MarketplaceShell>
  );
}
