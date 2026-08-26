import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import styles from './MarketplaceCheckoutPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';
import CategoryIcon from '../components/marketplace/CategoryIcon.jsx';

/* ──────────────────────────────────────────────────────────────────────
   MarketplaceCheckoutPage — buy a listing.

   This is the only screen in the section where a user parts with money,
   so it is deliberately the calmest one: no colour, no emoji, one
   primary action, and every figure in the breakdown set in tabular
   numerals so the column of prices lines up against the total.

   The old version stacked item → quantity → address → totals → pay in a
   single narrow column, which put the amount being charged a full
   screen below the item it was for. Item, quantity and money now travel
   together in one summary block beside the address form on desktop, and
   the total sits directly above the button that commits to it.
   ────────────────────────────────────────────────────────────────────── */

const CONDITION_LABEL = {
  'new': 'New', 'refurb': 'Refurbished', 'used': 'Used', 'for-parts': 'For parts',
};

function formatCurrency(cents, currency = 'USD') {
  if (cents == null) return '-';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

const PLATFORM_FEE_RATE = 0.03;

export default function MarketplaceCheckoutPage() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const { listingId } = useParams();

  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [qty, setQty]         = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [stripeEnabled, setStripeEnabled] = useState(false);

  // Shipping fields
  const [name, setName]       = useState('');
  const [street, setStreet]   = useState('');
  const [city, setCity]       = useState('');
  const [state, setState]     = useState('');
  const [zip, setZip]         = useState('');
  const [country, setCountry] = useState('US');

  useEffect(() => {
    if (!isAuthed) {
      navigate('/login', { state: { from: `/marketplace/checkout/${listingId}` }, replace: true });
      return;
    }
  }, [isAuthed, navigate, listingId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [listingRes, stripeRes] = await Promise.all([
          authFetch(apiUrl(`/api/marketplace/listings/${listingId}`)),
          authFetch(apiUrl('/api/marketplace/stripe/status')),
        ]);
        const data = await listingRes.json();
        if (!listingRes.ok || !data.ok) throw new Error(data.error || `HTTP ${listingRes.status}`);
        setListing(data.listing);
        const stripeData = await stripeRes.json();
        if (stripeData.ok) setStripeEnabled(!!stripeData.configured);
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    })();
  }, [listingId]);

  const subtotal = listing ? (listing.priceCents || 0) * qty : 0;
  const fee      = Math.round(subtotal * PLATFORM_FEE_RATE);
  const total    = subtotal + fee;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!street.trim()) { setError('Street address is required.'); return; }
    if (!city.trim()) { setError('City is required.'); return; }
    setSubmitting(true);
    try {
      const res = await authFetch(apiUrl('/api/marketplace/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId: Number(listingId),
          quantity: qty,
          shippingName: name.trim(),
          shippingStreet: street.trim(),
          shippingCity: city.trim(),
          shippingState: state.trim(),
          shippingZip: zip.trim(),
          shippingCountry: country.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // If Stripe is configured, redirect to Stripe Checkout
      if (data.stripeSessionUrl) {
        window.location.href = data.stripeSessionUrl;
        return;
      }
      navigate(`/marketplace/orders/${data.order.id}`, { replace: true });
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const currency = listing?.currency;

  return (
    <MarketplaceShell title="Checkout" subtitle="Review the order and confirm shipping"
                      action={null} backTo="/marketplace">
      {loading && (
        <div className={styles.center}><span className="mkt-spinner" /></div>
      )}

      {!loading && error && !listing && (
        <div className="mkt-banner mkt-banner--error" role="alert">{error}</div>
      )}

      {listing && (
        <form className={styles.layout} onSubmit={onSubmit}>
          {/* ── What is being bought ───────────────────────────────── */}
          <section className={`mkt-card mkt-card--pad ${styles.item}`}>
            <div className={styles.itemHead}>
              <div className={styles.itemThumb}>
                {listing.imageUrl
                  ? <img src={listing.imageUrl} alt="" />
                  : <CategoryIcon category={listing.category} size={28}
                                  className={styles.itemThumbIcon} />}
              </div>
              <div className={styles.itemInfo}>
                <h2 className={styles.itemTitle}>{listing.title}</h2>
                <p className="mkt-meta">
                  {[
                    CONDITION_LABEL[listing.condition] || listing.condition,
                    listing.seller?.username && `@${listing.seller.username}`,
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>

            {listing.quantity > 1 && (
              <div className={`mkt-fieldGroup ${styles.qty}`}>
                <label className="mkt-label" htmlFor="mkt-checkout-qty">
                  Quantity - {listing.quantity} available
                </label>
                <input
                  id="mkt-checkout-qty"
                  type="number"
                  className={`mkt-field ${styles.qtyField}`}
                  value={qty}
                  min={1}
                  max={listing.quantity}
                  onChange={(e) => setQty(Math.max(1, Math.min(listing.quantity, parseInt(e.target.value, 10) || 1)))}
                />
              </div>
            )}
          </section>

          {/* ── Shipping ───────────────────────────────────────────── */}
          <section className={styles.shipping}>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">Shipping address</h2>
              <span className="mkt-meta">Where the seller sends the item</span>
            </div>

            <div className={styles.fields}>
              <div className={`mkt-fieldGroup ${styles.span2}`}>
                <label className="mkt-label" htmlFor="mkt-ship-name">Full name *</label>
                <input id="mkt-ship-name" className="mkt-field" autoComplete="name"
                       value={name} onChange={(e) => setName(e.target.value)} required />
              </div>

              <div className={`mkt-fieldGroup ${styles.span2}`}>
                <label className="mkt-label" htmlFor="mkt-ship-street">Street address *</label>
                <input id="mkt-ship-street" className="mkt-field" autoComplete="street-address"
                       value={street} onChange={(e) => setStreet(e.target.value)} required />
              </div>

              <div className="mkt-fieldGroup">
                <label className="mkt-label" htmlFor="mkt-ship-city">City *</label>
                <input id="mkt-ship-city" className="mkt-field" autoComplete="address-level2"
                       value={city} onChange={(e) => setCity(e.target.value)} required />
              </div>

              <div className="mkt-fieldGroup">
                <label className="mkt-label" htmlFor="mkt-ship-state">State / region</label>
                <input id="mkt-ship-state" className="mkt-field" autoComplete="address-level1"
                       value={state} onChange={(e) => setState(e.target.value)} />
              </div>

              <div className="mkt-fieldGroup">
                <label className="mkt-label" htmlFor="mkt-ship-zip">ZIP / postcode</label>
                <input id="mkt-ship-zip" className="mkt-field" autoComplete="postal-code"
                       value={zip} onChange={(e) => setZip(e.target.value)} />
              </div>

              <div className="mkt-fieldGroup">
                <label className="mkt-label" htmlFor="mkt-ship-country">Country</label>
                <input id="mkt-ship-country" className="mkt-field" autoComplete="country"
                       value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
            </div>
          </section>

          {/* ── Money ──────────────────────────────────────────────────
              The breakdown, the error and the commit button share one
              card: a user should never have to look away from the total
              to find the control that charges it. */}
          <aside className={`mkt-card mkt-card--pad ${styles.totals}`}>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">Order summary</h2>
            </div>

            <div className={styles.rows}>
              <div className="mkt-row">
                <span className="mkt-row__key">Unit price</span>
                <span className="mkt-row__val">{formatCurrency(listing.priceCents, currency)}</span>
              </div>
              <div className="mkt-row">
                <span className="mkt-row__key">Quantity</span>
                <span className="mkt-row__val">× {qty}</span>
              </div>
              <div className="mkt-row">
                <span className="mkt-row__key">Subtotal</span>
                <span className="mkt-row__val">{formatCurrency(subtotal, currency)}</span>
              </div>
              <div className="mkt-row">
                <span className="mkt-row__key">Platform fee (3%)</span>
                <span className="mkt-row__val">{formatCurrency(fee, currency)}</span>
              </div>
              <div className="mkt-row mkt-row--total">
                <span className="mkt-row__key">Total</span>
                <span className="mkt-row__val">{formatCurrency(total, currency)}</span>
              </div>
            </div>

            {error && (
              <div className="mkt-banner mkt-banner--error" role="alert">{error}</div>
            )}

            <button type="submit"
                    className="mkt-btn mkt-btn--primary mkt-btn--tall mkt-btn--block"
                    disabled={submitting}>
              {submitting
                ? 'Processing…'
                : stripeEnabled
                  ? `Pay with Stripe - ${formatCurrency(total, currency)}`
                  : `Complete purchase - ${formatCurrency(total, currency)}`}
            </button>

            <p className={`mkt-meta ${styles.assurance}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                   aria-hidden="true">
                <path d="M12 3 4.5 6v6c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>
                {stripeEnabled
                  ? 'You’ll be redirected to Stripe for secure payment. The seller is notified once payment is confirmed.'
                  : 'Payment is processed securely. The seller is notified and can ship once payment is confirmed.'}
              </span>
            </p>
          </aside>
        </form>
      )}
    </MarketplaceShell>
  );
}
