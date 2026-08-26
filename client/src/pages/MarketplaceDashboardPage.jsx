import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './MarketplaceDashboardPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';
import CategoryIcon from '../components/marketplace/CategoryIcon.jsx';

/* ──────────────────────────────────────────────────────────────────────
   MarketplaceDashboardPage — the seller's numbers.

   This page used to be four unrelated visual languages stacked on top of
   each other: plain white stat cards, a mint-green revenue pair, a grey
   pill for purchases and a row of four coloured buttons that duplicated
   navigation the shell nav now owns. Nothing lined up, and the green
   revenue block implied a status the number does not carry.

   It is now one object repeated — a stat tile — grouped under three
   headings that answer three questions in order: what have I listed,
   what have I sold, what have I bought. Every figure is tabular so the
   columns align down the grid, and the only emphasis available is size
   and weight. Deliberately no charts: this API returns six scalars and
   a short list, which a chart would dress up rather than clarify.
   ────────────────────────────────────────────────────────────────────── */

const STATUS_PILL = {
  active: 'mkt-pill--active',
  sold:   'mkt-pill--neutral',
  closed: 'mkt-pill--neutral',
};

function formatCurrency(cents, currency = 'USD') {
  if (cents == null) return '-';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* One tile, one number. `lead` gives a figure the full width of a two-up
   row and a larger value — used for revenue and spend, where the amount
   is the answer and the count beside it is only context. */
function Stat({ label, value, meta, lead }) {
  return (
    <div className={`${styles.tile} ${lead ? styles.tileLead : ''}`}>
      <span className="mkt-label">{label}</span>
      <span className={styles.tileVal}>{value}</span>
      {meta && <span className={styles.tileMeta}>{meta}</span>}
    </div>
  );
}

function StatGroup({ title, children }) {
  return (
    <section className={styles.group}>
      <div className="mkt-sectionHead">
        <h2 className="mkt-sectionTitle">{title}</h2>
      </div>
      <div className={styles.tiles}>{children}</div>
    </section>
  );
}

export default function MarketplaceDashboardPage() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!isAuthed) navigate('/login', { state: { from: '/marketplace/dashboard' }, replace: true });
  }, [isAuthed, navigate]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res  = await authFetch(apiUrl('/api/marketplace/dashboard'));
        const d    = await res.json();
        if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
        setData(d.dashboard);
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const d = data;
  const recent = d?.recentListings || [];

  return (
    <MarketplaceShell
      title="Seller dashboard"
      subtitle="Listings, sales and purchases"
      backTo="/marketplace"
    >
      {error && (
        <div className="mkt-banner mkt-banner--error" role="alert">
          <span>{error}</span>
          <button className="mkt-linkBtn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {loading && (
        <div className={styles.loading}><span className="mkt-spinner" /></div>
      )}

      {d && (
        <>
          <StatGroup title="Listings">
            <Stat label="Total"    value={d.listings.total} />
            <Stat label="Active"   value={d.listings.active} />
            <Stat label="Sold"     value={d.listings.sold} />
            <Stat label="Closed"   value={d.listings.closed} meta="Expired or withdrawn" />
          </StatGroup>

          <StatGroup title="Sales">
            <Stat
              lead
              label="Revenue"
              value={formatCurrency(d.sales.revenueCents)}
              meta={`From ${plural(d.sales.completedOrders, 'completed order')}`}
            />
            <Stat label="Orders"    value={d.sales.totalOrders} />
            <Stat label="Completed" value={d.sales.completedOrders} />
            <Stat
              label="Pending"
              value={d.sales.pendingOrders}
              meta={d.sales.pendingOrders > 0 ? 'Awaiting shipment' : undefined}
            />
          </StatGroup>

          <StatGroup title="Purchases">
            <Stat
              lead
              label="Spent"
              value={formatCurrency(d.purchases.spentCents)}
              meta={`Across ${plural(d.purchases.total, 'order')}`}
            />
            <Stat label="Orders" value={d.purchases.total} />
          </StatGroup>

          <section className={styles.group}>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">Recent listings</h2>
              {recent.length > 0 && (
                <button className="mkt-linkBtn" onClick={() => navigate('/marketplace?tab=mine')}>
                  View all
                </button>
              )}
            </div>

            {recent.length === 0 ? (
              <div className="mkt-empty">
                <CategoryIcon category="other" size={40} className="mkt-empty__icon" />
                <p className="mkt-empty__title">Nothing listed yet</p>
                <p className="mkt-empty__text">
                  Your most recent listings appear here once you post one - the numbers
                  above fill in from the same place.
                </p>
                <button className="mkt-btn mkt-btn--primary" onClick={() => navigate('/marketplace/new')}>
                  List an item
                </button>
              </div>
            ) : (
              <ul className={styles.recent}>
                {recent.map(l => (
                  <li key={l.id} className={styles.recentRow}>
                    <CategoryIcon category={l.category} size={20} className={styles.recentIcon} />
                    <div className={styles.recentInfo}>
                      <span className={styles.recentTitle}>{l.title}</span>
                      <span className={`mkt-pill ${STATUS_PILL[l.status] || 'mkt-pill--neutral'}`}>
                        <span className="mkt-pill__dot" />{l.status}
                      </span>
                    </div>
                    <span className={styles.recentPrice}>
                      {l.priceCents != null ? formatCurrency(l.priceCents, l.currency) : 'Offer'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </MarketplaceShell>
  );
}
