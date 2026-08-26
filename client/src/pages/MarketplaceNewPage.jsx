import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import styles from './MarketplaceNewPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import { IMAGE_ACCEPT } from '../utils/mediaAccept';
import { useAuth } from '../AuthContext.jsx';
import MarketplaceShell from '../components/marketplace/MarketplaceShell.jsx';

/* ──────────────────────────────────────────────────────────────────────
   MarketplaceNewPage — create a marketplace listing.

   Prefill via query params so a "Sell this" button on the
   SwitchInformationPage / ResultsPage can deep-link in:
     /marketplace/new?vendor=Cisco&model=WS-C3850-48T&category=switch&rackId=RK-XXXX

   The form was previously one undifferentiated stack of eleven fields
   with no grouping, so "Currency" and "Description" carried the same
   visual weight. It is now four named sections — Item, Condition &
   pricing, Photo, Details — and the submit pair lives in a bar pinned to
   the bottom of the viewport, because on a form this tall the primary
   action was otherwise below the fold from the moment the page opened.
   ────────────────────────────────────────────────────────────────────── */

const CATEGORIES = [
  ['cable',       'Cables'],
  ['switch',      'Switches'],
  ['router',      'Routers'],
  ['rack',        'Racks'],
  ['optic',       'Optics / SFPs'],
  ['server',      'Servers'],
  ['pdu',         'PDUs'],
  ['firewall',    'Firewalls'],
  ['patch_panel', 'Patch panels'],
  ['other',       'Other'],
];
const CONDITIONS = [
  ['new',       'New (sealed)'],
  ['refurb',    'Refurbished'],
  ['used',      'Used - working'],
  ['for-parts', 'For parts / not working'],
];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR'];

/* A titled band of fields. Nothing more than mkt-sectionHead plus a
   grid, but naming it keeps the page body readable at a glance. */
function FormSection({ title, hint, children }) {
  return (
    <section className={styles.section}>
      <div className="mkt-sectionHead">
        <h2 className="mkt-sectionTitle">{title}</h2>
        {hint && <span className="mkt-meta">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export default function MarketplaceNewPage() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const [params] = useSearchParams();

  // Bounce unauthenticated visitors to login first, then back here.
  useEffect(() => {
    if (!isAuthed) {
      navigate('/login', { state: { from: '/marketplace/new' }, replace: true });
    }
  }, [isAuthed, navigate]);

  const initialKind = params.get('kind') === 'want' ? 'want' : 'sell';
  const [kind, setKind]             = useState(initialKind);
  const [category, setCategory]     = useState(params.get('category') || 'switch');
  const [title, setTitle]           = useState('');
  const [vendor, setVendor]         = useState(params.get('vendor') || '');
  const [model, setModel]           = useState(params.get('model')  || '');
  const [condition, setCondition]   = useState('used');
  const [quantity, setQuantity]     = useState(1);
  const [price, setPrice]           = useState('');
  const [currency, setCurrency]     = useState('USD');
  const [location, setLocation]     = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl]     = useState('');
  const [imagePreview, setImagePreview] = useState(''); // blob: URL for instant preview
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState(null);
  const fileInputRef                = useRef(null);
  const [sourceRackId]              = useState(params.get('rackId') || '');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);
  const [partners, setPartners]     = useState([]);

  // Suggest a title once vendor/model is typed in (the user can edit it).
  useEffect(() => {
    if (title) return;
    const t = [vendor, model].filter(Boolean).join(' ').trim();
    if (t) setTitle(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, model]);

  // Live partner-link preview keyed off vendor + model so the user can see
  // the redirect-only option without leaving the page.
  useEffect(() => {
    const v = vendor.trim();
    const m = model.trim();
    if (!v && !m) { setPartners([]); return; }
    let cancelled = false;
    const usp = new URLSearchParams();
    if (v) usp.set('vendor', v);
    if (m) usp.set('model', m);
    usp.set('category', category);
    fetch(apiUrl('/api/marketplace/partner-search?' + usp.toString()))
      .then(r => r.json())
      .then(data => { if (!cancelled && data?.ok) setPartners(data.partners || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [vendor, model, category]);

  const titleHint = useMemo(() => {
    if (!title.trim()) return '';
    if (title.length < 6) return 'A few more words helps buyers find it.';
    return '';
  }, [title]);

  // Free the blob URL when the component unmounts or the preview changes,
  // otherwise the browser holds the picked file in memory forever.
  useEffect(() => {
    return () => { if (imagePreview && imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview); };
  }, [imagePreview]);

  const handleFilePick = async (file) => {
    if (!file) return;
    setImageError(null);
    if (!/^image\//i.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) {
      setImageError('Only image files are accepted (JPG/JPEG, PNG, WebP, HEIC).');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setImageError('Image must be 8 MB or smaller.');
      return;
    }
    // Instant local preview while the upload runs.
    if (imagePreview && imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
    setImageUploading(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await authFetch(apiUrl('/api/marketplace/uploads'), {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setImageUrl(data.url);  // server-side URL, persisted on the listing
    } catch (err) {
      setImageError(err.message);
      setImageUrl('');
    } finally {
      setImageUploading(false);
    }
  };

  const clearImage = () => {
    if (imagePreview && imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setImagePreview('');
    setImageUrl('');
    setImageError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const openFilePicker = () => { if (fileInputRef.current) fileInputRef.current.click(); };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (imageUploading) { setError('Please wait for the image to finish uploading.'); return; }
    setError(null);
    const t = title.trim();
    if (!t) { setError('Title is required.'); return; }
    setSubmitting(true);
    try {
      const body = {
        kind, category, condition, quantity, currency,
        title: t,
        vendor: vendor.trim() || undefined,
        model:  model.trim()  || undefined,
        location:    location.trim()    || undefined,
        description: description.trim() || undefined,
        imageUrl:    imageUrl.trim()    || undefined,
        sourceRackId: sourceRackId || undefined,
      };
      if (price !== '' && price !== null) body.price = Number(price);
      const res  = await authFetch(apiUrl('/api/marketplace/listings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      navigate('/marketplace?tab=mine', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const wanted = kind === 'want';

  const photoStatus = imageUploading ? 'Uploading…'
    : imageError    ? 'Upload failed'
    :                 'Photo ready';

  return (
    <MarketplaceShell
      title={wanted ? 'Post a request' : 'New listing'}
      subtitle={wanted
        ? 'Tell sellers what you’re looking for'
        : 'List surplus equipment for other RackTrack orgs'}
      action={null}
      backTo="/marketplace"
    >
      <form className={styles.form} onSubmit={onSubmit}>
        {/* ── Listing type ─────────────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.kindRow}>
            <div className="mkt-segmented" role="group" aria-label="Listing type">
              <button type="button" className="mkt-segment"
                      aria-pressed={!wanted} onClick={() => setKind('sell')}>
                For sale
              </button>
              <button type="button" className="mkt-segment"
                      aria-pressed={wanted} onClick={() => setKind('want')}>
                Wanted
              </button>
            </div>
            <p className="mkt-meta">
              {wanted
                ? 'Requests appear under the Wanted tab so sellers can respond.'
                : 'Listings appear under For sale, or redirect buyers to a partner site.'}
            </p>
          </div>

          {sourceRackId && (
            <p className={`mkt-banner ${styles.scanHint}`}>
              <span>
                Prefilled from scan <span className="mkt-mono">{sourceRackId}</span>. Buyers
                see this, so they know the listing is backed by a RackTrack scan.
              </span>
            </p>
          )}
        </section>

        {/* ── Item ─────────────────────────────────────────────────── */}
        <FormSection title="Item">
          <div className={styles.fields}>
            <div className={`mkt-fieldGroup ${styles.span2}`}>
              <label className="mkt-label" htmlFor="mkt-new-title">Title *</label>
              <input
                id="mkt-new-title"
                className="mkt-field"
                placeholder="e.g. Cisco WS-C3850-48T-S 48-port switch"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required maxLength={140}
              />
              {titleHint && <span className="mkt-hint">{titleHint}</span>}
            </div>

            <div className="mkt-fieldGroup">
              <label className="mkt-label" htmlFor="mkt-new-vendor">Vendor</label>
              <input
                id="mkt-new-vendor"
                className="mkt-field"
                placeholder="Cisco, Juniper, Arista…"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                maxLength={60}
              />
            </div>

            <div className="mkt-fieldGroup">
              <label className="mkt-label" htmlFor="mkt-new-model">Model</label>
              <input
                id="mkt-new-model"
                className="mkt-field"
                placeholder="WS-C3850-48T-S"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={80}
              />
            </div>

            <div className={`mkt-fieldGroup ${styles.span2}`}>
              <label className="mkt-label" htmlFor="mkt-new-category">Category *</label>
              <select
                id="mkt-new-category"
                className="mkt-field"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
        </FormSection>

        {/* ── Condition & pricing ──────────────────────────────────── */}
        <FormSection title="Condition & pricing" hint="Leave the price blank to invite offers">
          <div className={styles.fields}>
            <div className={`mkt-fieldGroup ${styles.span2}`}>
              <label className="mkt-label" htmlFor="mkt-new-condition">Condition *</label>
              <select
                id="mkt-new-condition"
                className="mkt-field"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
              >
                {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>

            <div className={`mkt-fieldGroup ${styles.third}`}>
              <label className="mkt-label" htmlFor="mkt-new-price">Price</label>
              <input
                id="mkt-new-price"
                type="number"
                className={`mkt-field ${styles.num}`}
                placeholder="Make an offer"
                value={price}
                min={0}
                step="0.01"
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>

            <div className={`mkt-fieldGroup ${styles.third}`}>
              <label className="mkt-label" htmlFor="mkt-new-currency">Currency</label>
              <select
                id="mkt-new-currency"
                className="mkt-field"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className={`mkt-fieldGroup ${styles.third}`}>
              <label className="mkt-label" htmlFor="mkt-new-quantity">Quantity</label>
              <input
                id="mkt-new-quantity"
                type="number"
                className={`mkt-field ${styles.num}`}
                value={quantity}
                min={1}
                onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </div>
          </div>
        </FormSection>

        {/* ── Photo ────────────────────────────────────────────────── */}
        <FormSection title="Photo" hint="Optional, but listings with one sell faster">
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className={styles.fileInput}
            onChange={(e) => handleFilePick(e.target.files && e.target.files[0])}
          />

          {imagePreview ? (
            <div className={`mkt-card ${styles.photoCard}`}>
              <img src={imagePreview} alt="Listing preview" className={styles.photoPreview} />
              <div className={styles.photoMeta}>
                <span className={styles.photoStatus}>
                  {imageUploading && <span className={`mkt-spinner ${styles.photoSpinner}`} />}
                  {photoStatus}
                </span>
                <div className={styles.photoActions}>
                  <button type="button" className="mkt-btn mkt-btn--sm" onClick={openFilePicker}>
                    Replace
                  </button>
                  <button type="button" className="mkt-btn mkt-btn--sm mkt-btn--danger"
                          onClick={clearImage}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button type="button" className={styles.photoDrop} onClick={openFilePicker}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                   className={styles.photoIcon} aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8.5" cy="10" r="1.5" />
                <path d="m3 16 4.5-4.5L12 16l3-3 6 5" />
              </svg>
              <span className={styles.photoMain}>Upload a photo</span>
              <span className="mkt-hint">JPG · PNG · WebP · HEIC · up to 8 MB</span>
            </button>
          )}

          {imageError && (
            <div className="mkt-banner mkt-banner--error" role="alert">{imageError}</div>
          )}
        </FormSection>

        {/* ── Location & details ───────────────────────────────────── */}
        <FormSection title="Location & details">
          <div className={styles.fields}>
            <div className={`mkt-fieldGroup ${styles.span2}`}>
              <label className="mkt-label" htmlFor="mkt-new-location">Location</label>
              <input
                id="mkt-new-location"
                className="mkt-field"
                placeholder="City, country - helps with shipping estimates"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={100}
              />
            </div>

            <div className={`mkt-fieldGroup ${styles.span2}`}>
              <label className="mkt-label" htmlFor="mkt-new-description">Description</label>
              <textarea
                id="mkt-new-description"
                className="mkt-field"
                placeholder={wanted
                  ? 'What exactly are you looking for? Quantity, condition, deadline…'
                  : 'Hours of use, last firmware, included accessories, reason for selling…'}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={2000}
              />
              <span className="mkt-hint">{description.length} / 2000</span>
            </div>
          </div>
        </FormSection>

        {/* ── Partner redirect ─────────────────────────────────────────
            Only appears once vendor/model resolves to a partner match, so
            it reads as an alternative to publishing, not a competing CTA. */}
        {partners.length > 0 && (
          <section className={`mkt-card mkt-card--pad ${styles.partnerBox}`}>
            <div className="mkt-sectionHead">
              <h2 className="mkt-sectionTitle">Or send buyers to a partner</h2>
            </div>
            <div className={styles.partnerRow}>
              {partners.map(p => (
                <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"
                   className="mkt-btn mkt-btn--sm" title={p.blurb}>
                  {p.name}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 17 17 7M9 7h8v8" />
                  </svg>
                </a>
              ))}
            </div>
            <p className="mkt-meta">
              We don’t take a cut - partner links are a convenience and open in a new tab.
            </p>
          </section>
        )}

        {error && (
          <div className="mkt-banner mkt-banner--error" role="alert">{error}</div>
        )}

        {/* ── Action bar ───────────────────────────────────────────── */}
        <div className={styles.actionBar}>
          <button type="button" className="mkt-btn" onClick={() => navigate('/marketplace')}>
            Cancel
          </button>
          <button type="submit" className="mkt-btn mkt-btn--primary" disabled={submitting}>
            {submitting ? 'Publishing…' : wanted ? 'Post request' : 'Publish listing'}
          </button>
        </div>
      </form>
    </MarketplaceShell>
  );
}
