import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import styles from './MarketplaceOrdersPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';
import CategoryIcon from '../components/marketplace/CategoryIcon.jsx';

/* ──────────────────────────────────────────────────────────────────────
   MarketplaceOrdersPage — order list, order detail and the buyer/seller
   message thread.

   The old page carried five differently-coloured status chips (amber,
   blue, green, grey, red), a mint-green tracking callout and three
   button colours, so a single order card could show four hues before
   the user had read a word of it. Status now reads through one pill
   shape with a coloured dot, and every control is the same hairline
   button.

   Three window-modal calls also lived here — alert() on every failed
   request and confirm() on complete/cancel. Errors now surface as an
   in-page banner and the two destructive-ish transitions use a
   two-step inline confirm, matching MarketplacePage.
   ────────────────────────────────────────────────────────────────────── */

const STATUS_LABEL = {
  pending: 'Pending', paid: 'Paid', shipped: 'Shipped',
  completed: 'Completed', cancelled: 'Cancelled',
};

/* Colour survives only as the dot inside the pill: amber while the
   order is waiting on someone, green while it is in flight, grey once
   it is done, red when it died. */
const STATUS_PILL = {
  pending:   'mkt-pill--pending',
  paid:      'mkt-pill--active',
  shipped:   'mkt-pill--active',
  completed: 'mkt-pill--neutral',
  cancelled: 'mkt-pill--negative',
};

function formatCurrency(cents, currency = 'USD') {
  if (cents == null) return '-';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
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
  return `${Math.floor(days / 7)}w ago`;
}

function StatusPill({ status }) {
  return (
    <span className={`mkt-pill ${STATUS_PILL[status] || 'mkt-pill--neutral'}`}>
      <span className="mkt-pill__dot" />
      {STATUS_LABEL[status] || status}
    </span>
  );
}

/* ── Order row ──────────────────────────────────────────────────────── */
function OrderRow({ order, role, onOpen }) {
  const counterparty = role === 'buying'
    ? `@${order.sellerUsername || 'unknown'}`
    : `@${order.buyerUsername || 'unknown'}`;

  return (
    <button type="button" className={styles.row} onClick={() => onOpen(order.id)}>
      <span className={styles.rowThumb}>
        {order.listingImageUrl
          ? <img src={order.listingImageUrl} alt="" loading="lazy" />
          : <CategoryIcon category={order.listingCategory} size={22} className={styles.thumbIcon} />}
      </span>

      <span className={styles.rowInfo}>
        <span className={styles.rowTitleLine}>
          <span className={styles.rowTitle}>{order.listingTitle || 'Listing'}</span>
          <StatusPill status={order.status} />
        </span>
        <span className={styles.rowMeta}>
          {[
            role === 'buying' ? `Seller ${counterparty}` : `Buyer ${counterparty}`,
            order.quantity > 1 ? `Qty ${order.quantity}` : null,
            formatRelative(order.createdAt),
          ].filter(Boolean).join(' · ')}
        </span>
      </span>

      <span className={styles.rowTotal}>{formatCurrency(order.totalCents, order.currency)}</span>
    </button>
  );
}

/* ── Message thread ──────────────────────────────────────────────────
   Own and other messages are told apart by alignment plus a fill /
   hairline distinction, never by hue — the old thread used the same
   black bubble but there was no reason to give the section a second
   colour system when this one already reads at a glance. */
function MessageThread({ messages = [], meId, endRef }) {
  if (messages.length === 0) {
    return (
      <div className={styles.thread}>
        <p className={styles.threadEmpty}>No messages yet - start the conversation below.</p>
        <div ref={endRef} />
      </div>
    );
  }

  return (
    <div className={styles.thread}>
      {messages.map(m => {
        const mine = m.senderId === meId;
        return (
          <div key={m.id} className={`${styles.bubbleWrap} ${mine ? styles.bubbleWrapMe : ''}`}>
            <div className={`${styles.bubble} ${mine ? styles.bubbleMe : ''}`}>
              {!mine && <span className={styles.bubbleSender}>@{m.senderUsername}</span>}
              <p className={styles.bubbleBody}>{m.body}</p>
            </div>
            <span className={styles.bubbleTime}>{formatRelative(m.createdAt)}</span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════ */
export default function MarketplaceOrdersPage() {
  const navigate = useNavigate();
  const { isAuthed, user } = useAuth();
  const { orderId } = useParams();

  const [role, setRole]         = useState('buying');
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [detail, setDetail]     = useState(null); // {order, messages}
  const [msgBody, setMsgBody]   = useState('');
  const [sending, setSending]   = useState(false);
  const [trackCarrier, setTrackCarrier] = useState('');
  const [trackNumber, setTrackNumber]   = useState('');
  // Replaces confirm() — 'complete' | 'cancel' | null.
  const [confirming, setConfirming]     = useState(null);
  const msgsEndRef = useRef(null);

  useEffect(() => {
    if (!isAuthed) {
      navigate('/login', { state: { from: '/marketplace/orders' }, replace: true });
    }
  }, [isAuthed, navigate]);

  const fetchOrders = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res  = await authFetch(apiUrl(`/api/marketplace/orders?role=${role}`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOrders(data.orders || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [role]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // Auto-open order from URL param
  useEffect(() => {
    if (orderId && orders.length > 0) {
      const o = orders.find(x => x.id === Number(orderId));
      if (o) openOrder(o.id);
    }
   
  }, [orderId, orders]);

  const openOrder = async (id) => {
    try {
      const res  = await authFetch(apiUrl(`/api/marketplace/orders/${id}`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail(data);
      setTrackCarrier(data.order.carrier || '');
      setTrackNumber(data.order.trackingNumber || '');
      setTimeout(() => msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) { setError(err.message); }
  };

  const sendMessage = async () => {
    if (!msgBody.trim() || sending || !detail) return;
    setSending(true);
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/orders/${detail.order.id}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: msgBody.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail(prev => (prev ? { ...prev, messages: [...(prev.messages || []), data.message] } : prev));
      setMsgBody('');
      setTimeout(() => msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) { setError(err.message); }
    finally { setSending(false); }
  };

  const patchOrder = async (patch) => {
    if (!detail) return;
    try {
      const res = await authFetch(apiUrl(`/api/marketplace/orders/${detail.order.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetail(prev => (prev ? { ...prev, order: data.order } : prev));
      setConfirming(null);
      fetchOrders();
    } catch (err) { setError(err.message); }
  };

  // Auto-refresh messages every 30s when detail open
  useEffect(() => {
    if (!detail) return;
    const iv = setInterval(() => openOrder(detail.order.id), 30000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.order?.id]);

  // A pending confirm belongs to one order; opening another must not
  // inherit it.
  useEffect(() => { setConfirming(null); }, [detail?.order?.id]);

  const isSeller = detail && detail.order.sellerId === user?.id;
  const order    = detail?.order;

  const closeDetail = () => { setDetail(null); setConfirming(null); };

  return (
    <MarketplaceShell
      title={detail ? 'Order' : 'Orders'}
      subtitle={detail ? `#${order.id} · ${STATUS_LABEL[order.status] || order.status}` : 'Purchases and sales'}
      action={null}
      backTo={detail ? closeDetail : '/marketplace'}
    >
      {error && (
        <div className="mkt-banner mkt-banner--error" role="alert">
          <span>{error}</span>
          <button className="mkt-linkBtn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* ── List ─────────────────────────────────────────────────────── */}
      {!detail && (
        <section className={styles.list}>
          <div className="mkt-sectionHead">
            <div className="mkt-segmented" role="group" aria-label="Order role">
              <button
                className="mkt-segment"
                aria-pressed={role === 'buying'}
                onClick={() => setRole('buying')}
              >
                Buying
              </button>
              <button
                className="mkt-segment"
                aria-pressed={role === 'selling'}
                onClick={() => setRole('selling')}
              >
                Selling
              </button>
            </div>
            {!loading && orders.length > 0 && (
              <span className="mkt-meta">
                {orders.length} order{orders.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {loading && <div className={styles.loading}><span className="mkt-spinner" /></div>}

          {!loading && !error && orders.length === 0 && (
            <div className="mkt-empty">
              <svg className="mkt-empty__icon" width="40" height="40" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" strokeWidth="1.5"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5Z" />
                <path d="m3 7.5 9 4.5 9-4.5M12 12v9" />
              </svg>
              <p className="mkt-empty__title">
                {role === 'buying' ? 'You haven’t bought anything yet' : 'Nothing sold yet'}
              </p>
              <p className="mkt-empty__text">
                {role === 'buying'
                  ? 'Orders you place appear here with their status, tracking and a direct line to the seller.'
                  : 'When someone buys one of your listings the order shows up here, ready to ship.'}
              </p>
              <button className="mkt-btn mkt-btn--primary" onClick={() => navigate('/marketplace')}>
                {role === 'buying' ? 'Browse marketplace' : 'List an item'}
              </button>
            </div>
          )}

          {!loading && orders.length > 0 && (
            <div className={styles.rows}>
              {orders.map(o => (
                <OrderRow key={o.id} order={o} role={role} onOpen={openOrder} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Detail + thread ──────────────────────────────────────────── */}
      {detail && (
        <div className={styles.detail}>
          <button className={`mkt-linkBtn ${styles.backToList}`} onClick={closeDetail}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            All orders
          </button>

          <section className="mkt-card mkt-card--pad">
            <div className={styles.detailHead}>
              <span className={styles.detailThumb}>
                {order.listingImageUrl
                  ? <img src={order.listingImageUrl} alt="" />
                  : <CategoryIcon category={order.listingCategory} size={26} className={styles.thumbIcon} />}
              </span>
              <div className={styles.detailHeadText}>
                <h2 className={styles.detailTitle}>{order.listingTitle || 'Listing'}</h2>
                <p className="mkt-meta">
                  {isSeller
                    ? `Buyer @${order.buyerUsername || 'unknown'}`
                    : `Seller @${order.sellerUsername || 'unknown'}`}
                </p>
              </div>
              <StatusPill status={order.status} />
            </div>

            <div className={`mkt-facts mkt-facts--2 ${styles.detailFacts}`}>
              <div className="mkt-fact">
                <span className="mkt-fact__key">Order</span>
                <span className="mkt-fact__val mkt-mono">#{order.id}</span>
              </div>
              <div className="mkt-fact">
                <span className="mkt-fact__key">Placed</span>
                <span className="mkt-fact__val">{formatRelative(order.createdAt) || '-'}</span>
              </div>
              <div className="mkt-fact">
                <span className="mkt-fact__key">Quantity</span>
                <span className="mkt-fact__val">{order.quantity}</span>
              </div>
              {order.trackingNumber && (
                <div className="mkt-fact">
                  <span className="mkt-fact__key">{order.carrier || 'Tracking'}</span>
                  <span className="mkt-fact__val mkt-mono">{order.trackingNumber}</span>
                </div>
              )}
            </div>

            <div className={styles.totals}>
              <div className="mkt-row mkt-row--total">
                <span className="mkt-row__key">Total</span>
                <span className="mkt-row__val mkt-mono">
                  {formatCurrency(order.totalCents, order.currency)}
                </span>
              </div>
            </div>

            {/* Seller ships — carrier + number, then one transition. */}
            {isSeller && order.status === 'paid' && (
              <div className={styles.ship}>
                <p className="mkt-label">Ship this order</p>
                <div className={styles.shipFields}>
                  <div className="mkt-fieldGroup">
                    <label className="mkt-label" htmlFor="mkt-order-carrier">Carrier</label>
                    <input
                      id="mkt-order-carrier"
                      className="mkt-field"
                      placeholder="UPS, USPS, FedEx…"
                      value={trackCarrier}
                      onChange={(e) => setTrackCarrier(e.target.value)}
                    />
                  </div>
                  <div className="mkt-fieldGroup">
                    <label className="mkt-label" htmlFor="mkt-order-tracking">Tracking number</label>
                    <input
                      id="mkt-order-tracking"
                      className="mkt-field"
                      placeholder="1Z999AA10123456784"
                      value={trackNumber}
                      onChange={(e) => setTrackNumber(e.target.value)}
                    />
                  </div>
                </div>
                <button
                  className="mkt-btn mkt-btn--primary"
                  onClick={() => patchOrder({
                    status: 'shipped',
                    carrier: trackCarrier,
                    trackingNumber: trackNumber,
                  })}
                >
                  Mark shipped
                </button>
              </div>
            )}

            {/* Two-step confirms — these change money-bearing state, so
                they ask once inline rather than through window.confirm. */}
            {confirming ? (
              <div className={styles.confirm}>
                <span className={styles.confirmText}>
                  {confirming === 'complete'
                    ? 'Mark this order completed? This closes it for both sides.'
                    : 'Cancel this order? This cannot be undone.'}
                </span>
                <div className={styles.confirmBtns}>
                  <button className="mkt-btn mkt-btn--sm" onClick={() => setConfirming(null)}>
                    Keep as is
                  </button>
                  {confirming === 'complete' ? (
                    <button
                      className="mkt-btn mkt-btn--sm mkt-btn--primary"
                      onClick={() => patchOrder({ status: 'completed' })}
                    >
                      Yes, complete
                    </button>
                  ) : (
                    <button
                      className="mkt-btn mkt-btn--sm mkt-btn--danger"
                      onClick={() => patchOrder({ status: 'cancelled' })}
                    >
                      Yes, cancel
                    </button>
                  )}
                </div>
              </div>
            ) : (
              (order.status === 'shipped' || ['pending', 'paid'].includes(order.status)) && (
                <div className={styles.actions}>
                  {order.status === 'shipped' && (
                    <button className="mkt-btn" onClick={() => setConfirming('complete')}>
                      Mark completed
                    </button>
                  )}
                  {['pending', 'paid'].includes(order.status) && (
                    <button className="mkt-btn mkt-btn--danger" onClick={() => setConfirming('cancel')}>
                      Cancel order
                    </button>
                  )}
                </div>
              )
            )}
          </section>

          <section>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">Messages</h2>
              <span className="mkt-meta">
                {isSeller
                  ? `with @${order.buyerUsername || 'buyer'}`
                  : `with @${order.sellerUsername || 'seller'}`}
              </span>
            </div>

            <MessageThread messages={detail.messages} meId={user?.id} endRef={msgsEndRef} />

            <div className={styles.composer}>
              <input
                className="mkt-field"
                placeholder="Type a message…"
                value={msgBody}
                aria-label="Message"
                onChange={(e) => setMsgBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                }}
              />
              <button
                className={`mkt-btn mkt-btn--primary ${styles.sendBtn}`}
                disabled={sending || !msgBody.trim()}
                onClick={sendMessage}
                aria-label="Send message"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </section>
        </div>
      )}
    </MarketplaceShell>
  );
}
