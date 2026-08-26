// SFP Procurement Advisor.
//
// Recommends compatible SFP transceivers for a switch identified from the
// rack photo (OCR-derived make/model). Lives alongside the switch info on
// SwitchInformationPage — NOT under "Available Ports", because available
// ports come from live SSH against a single switch, while this advisor is
// scoped to whatever switch the OCR pinned down.
//
// Props:
//   rackId    — required, used to pull OCR-devices fallback when vendor/model unknown
//   position  — optional rack unit ('U14'), so the OCR fallback reads THIS switch
//   vendor    — string, OCR-derived switch vendor ('Unknown' or null when unidentified)
//   model     — string, OCR-derived switch model  ('Unknown' or null when unidentified)
//   sfpPorts  — optional [{iface, ...}], passed when caller knows the SFP slot list
//   sfpCounts — optional { avail, total }, passed when caller knows free-slot count

import { useEffect, useState } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import { fetchSfpAnalysis, generateOfflineFallback, SFP_SLOT_TYPES } from '../utils/sfpDatabase';
import SfpModuleImage from './SfpModuleImage.jsx';
// CSS is shared with PortsPage where the component originally lived; the
// styles are advisor-specific and not used by anything else in that file,
// so re-pointing them to a new module would just churn imports without
// changing behavior.
import styles from '../pages/PortsPage.module.css';

export default function SfpAdvisor({ rackId, position, vendor: vendorProp, model: modelProp, sfpPorts = [], sfpCounts }) {
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(true);
  // "More compatible modules" section is collapsed by default — the user
  // only sees the count and a + button. Toggling expands the full list of
  // alternatives so they're hidden behind one click instead of forcing
  // every visit to scroll past them.
  const [showAlternatives, setShowAlternatives] = useState(false);

  const vendor = vendorProp || 'Unknown';
  const model  = modelProp  || 'Unknown';
  const ifaces = sfpPorts?.map(p => p.iface) || [];

  useEffect(() => {
    if (!rackId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      let v = vendor, m = model;
      // OCR fallback — if the caller's vendor/model came in as 'Unknown',
      // ask the server's per-device crop OCR for any Switch entry that
      // pinned vendor/model down (different OCR pass with different bias).
      try {
        const ocrR = await authFetch(apiUrl(`/api/scan/${rackId}/ocr-devices`));
        if (ocrR.ok) {
          const ocrData = await ocrR.json();
          const devices = Array.isArray(ocrData) ? ocrData : (ocrData.devices || []);
          // Match on rack unit first. Without it this took the first switch in
          // the rack that OCR had read, so opening switch #3 in a three-switch
          // rack could recommend modules for switch #1's slots — a wrong answer
          // presented with the same confidence as a right one. Only fall back to
          // "any switch we could read" when the caller didn't say which unit it
          // is asking about.
          const readable = devices.filter(d => d.class_name === 'Switch' && (d.make || d.model));
          const ocrSwitch = (position && readable.find(d => d.position === position))
            || (!position && readable[0])
            || null;
          if (ocrSwitch) {
            if (v === 'Unknown' && ocrSwitch.make)  v = ocrSwitch.make;
            if (m === 'Unknown' && ocrSwitch.model) m = ocrSwitch.model;
          }
        }
      } catch (_) {}
      if (cancelled) return;

      // Nothing identified the switch — not the rack scan, not the per-device
      // OCR pass above. Say that, and stop.
      //
      // This used to fall through to `generateOfflineFallback`, whose result has
      // no `status`, so the render below treated it as real advice: the advisor
      // drew its full card for "Unknown Unknown", the empty module list tripped
      // the curated-catalog injection, and the user was shown a TOP PICK with a
      // price and a buy link for a switch nobody had identified. It also blamed
      // the server ("Server unavailable") for what was only a missing make and
      // model. A recommendation nobody can act on is worse than no card at all.
      const known = (x) => !!x && x !== 'Unknown';
      if (!known(v) || !known(m)) {
        const missing = !known(v) && !known(m) ? 'vendor and model'
                      : !known(v)              ? 'vendor'
                      :                          'model';
        setAdvice({
          status: 'need_make_model',
          message: `The switch ${missing} could not be read from the photo. Add ${!known(v) && !known(m) ? 'them' : 'it'} above - SFP advice needs both to be certain the module fits.`,
        });
        setLoading(false);
        return;
      }

      const result = await fetchSfpAnalysis(v, m, ifaces);
      if (cancelled) return;
      setAdvice(result || generateOfflineFallback({ vendor: v, model: m, sfpPorts, sfpCounts }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [rackId, position, vendorProp, modelProp]);

  if (loading) {
    return (
      <section className={styles.advisorSection}>
        <div className={styles.advisorHead}>
          <div className={styles.advisorTitleRow}>
            <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
            <span className={styles.advisorBadge}>AI</span>
          </div>
        </div>
        <div className={styles.advisorLoading}>
          <div className={styles.advisorSpinner} />
          <div className={styles.advisorLoadingText}>
            Analyzing<span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span>
          </div>
        </div>
      </section>
    );
  }

  if (!advice) return null;

  // ── Make + model missing → prompt, don't guess ──
  if (advice.status === 'need_make_model') {
    return (
      <section className={styles.advisorSection}>
        <div className={styles.advisorHead}>
          <div className={styles.advisorTitleRow}>
            <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
          </div>
        </div>
        <div className={styles.emptyHint}>
          {advice.message || 'Add the switch make and model to get SFP advice.'}
        </div>
      </section>
    );
  }

  // ── Copper-only switch → no SFP required ──
  if (advice.status === 'no_sfp') {
    return (
      <section className={styles.advisorSection}>
        <div className={styles.advisorHead}>
          <div className={styles.advisorTitleRow}>
            <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
          </div>
        </div>
        <div className={styles.noSfpMsg}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>
          </svg>
          <span><b>No SFP required.</b>{' '}
            {advice.message || 'This switch has no SFP/fiber slots - only copper (RJ45) ports.'}
          </span>
        </div>
      </section>
    );
  }

  const slotInfo = advice.slotInfo || SFP_SLOT_TYPES[advice.slotType] || SFP_SLOT_TYPES['SFP'];
  const sfpsToProcure = sfpCounts?.avail || 0;

  // Blocked vendors whose scraped product pages have been unreliable for
  // our users (they kept landing on the wrong product). Modules sourced
  // from these domains are dropped entirely.
  const BLOCKED_DOMAINS = new Set(['satej.co.in']);
  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch (_) { return ''; }
  };
  const isBlocked = (m) =>
    !!m?.sourceUrl && BLOCKED_DOMAINS.has(hostOf(m.sourceUrl));

  // Apply the block-list filter first.
  let allModules = (advice.modules || []).filter(m => !isBlocked(m));
  let recommended  = isBlocked(advice.recommended) ? null : advice.recommended;
  let budgetOption = isBlocked(advice.budget)      ? null : advice.budget;

  // CURATED CATALOG — every entry below was verified live against the
  // manufacturer's own product page on 2026-05-28. URL, image, and price
  // are real. If Mikrotik renames a slug or rotates an image, an entry
  // here may need refreshing — but everything links to the manufacturer
  // (no third-party reseller), so the destination is always the actual
  // product. No SVG fallback, no random search-result interstitial.
  const slotKey = (advice.slotType || 'SFP').toUpperCase();
  const CURATED_CATALOG = {
    // SFP+ TRANSCEIVERS only — these are the modules that go INTO an
    // SFP+ port. DAC / AOC cables (which terminate in SFP+ ends and
    // replace the module+fiber pair) are listed separately so the user
    // sees them as cabling, not as port-fillers.
    'SFP+': [
      { brand: 'Mikrotik', partNumber: 'S+85DLC03D',  type: 'SR',  speed: '10G',       maxDistance: '300m',  wavelength: '850nm',
        price: '$59', sourceUrl: 'https://mikrotik.com/product/Splus85DLC03D',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/813_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'S+31DLC10D',  type: 'LR',  speed: '10G',       maxDistance: '10km',  wavelength: '1310nm',
        price: '$69', sourceUrl: 'https://mikrotik.com/product/s_31dlc10d',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2514_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'S+RJ10',      type: 'T',   speed: '10G',       maxDistance: '30m',
        price: '$65', sourceUrl: 'https://mikrotik.com/product/s_rj10',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/1351_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'XS+85LC01D',  type: 'SR',  speed: '10G/25G',   maxDistance: '100m',  wavelength: '850nm',
        price: '$59', sourceUrl: 'https://mikrotik.com/product/xs_85lc01d',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2345_lg.webp' },
    ],
    'QSFP+': [
      { brand: 'Mikrotik', partNumber: 'XQ+DA0001',   type: 'DAC', speed: '40/100G', maxDistance: '1m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0001' },
      { brand: 'Mikrotik', partNumber: 'XQ+85MP01D',  type: 'SR4', speed: '40/100G', maxDistance: '100m', wavelength: '850nm',
        sourceUrl: 'https://mikrotik.com/product/xq_85mp01d' },
    ],
    'QSFP28': [
      { brand: 'Mikrotik', partNumber: 'XQ+DA0001',   type: 'DAC', speed: '100G', maxDistance: '1m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0001' },
      { brand: 'Mikrotik', partNumber: 'XQ+DA0003',   type: 'DAC', speed: '100G', maxDistance: '3m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0003' },
      { brand: 'Mikrotik', partNumber: 'XQ+85MP01D',  type: 'SR4', speed: '100G', maxDistance: '100m', wavelength: '850nm',
        sourceUrl: 'https://mikrotik.com/product/xq_85mp01d' },
      { brand: 'Mikrotik', partNumber: 'XQ+31LC02D',  type: 'LR',  speed: '100G', maxDistance: '2km',  wavelength: '1310nm',
        sourceUrl: 'https://mikrotik.com/product/xq_31lc02d' },
      { brand: 'Mikrotik', partNumber: 'XQ+31LC10D',  type: 'LR',  speed: '100G', maxDistance: '10km', wavelength: '1310nm',
        sourceUrl: 'https://mikrotik.com/product/xq_31lc10d' },
    ],
    'SFP': [
      { brand: 'Mikrotik', partNumber: 'XS+DA0001',   type: 'DAC', speed: '1G/10G/25G', maxDistance: '1m',
        price: '$29', sourceUrl: 'https://mikrotik.com/product/xs_da0001',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2003_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'XS+85LC01D',  type: 'SR',  speed: '1G/10G/25G', maxDistance: '100m', wavelength: '850nm',
        sourceUrl: 'https://mikrotik.com/product/xs_85lc01d' },
      { brand: 'Mikrotik', partNumber: 'XS+31LC10D',  type: 'LR',  speed: '1G/10G/25G', maxDistance: '10km', wavelength: '1310nm',
        sourceUrl: 'https://mikrotik.com/product/xs_31lc10d' },
    ],
  };
  const curatedFallback = CURATED_CATALOG[slotKey] || [];

  // Pre-terminated cables (DAC/AOC) — these REPLACE the module+fiber
  // combo by plugging into the SFP+ port directly on both ends. We list
  // them separately from the transceiver modules so the user sees a
  // clear distinction: "what goes in the port" vs "the cable to run".
  const CURATED_CABLES = {
    'SFP+': [
      { brand: 'Mikrotik', partNumber: 'XS+DA0001', type: 'DAC', speed: '10G', maxDistance: '1m',
        price: '$29', sourceUrl: 'https://mikrotik.com/product/xs_da0001',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2003_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'XS+DA0003', type: 'DAC', speed: '10G', maxDistance: '3m',
        price: '$39', sourceUrl: 'https://mikrotik.com/product/xs_da0003',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2002_lg.webp' },
      { brand: 'Mikrotik', partNumber: 'S+AO0005',  type: 'AOC', speed: '10G', maxDistance: '5m',
        price: '$49', sourceUrl: 'https://mikrotik.com/product/s_ao0005',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/1729_lg.webp' },
    ],
    'QSFP+':  [
      { brand: 'Mikrotik', partNumber: 'XQ+DA0001', type: 'DAC', speed: '40G', maxDistance: '1m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0001' },
    ],
    'QSFP28': [
      { brand: 'Mikrotik', partNumber: 'XQ+DA0001', type: 'DAC', speed: '100G', maxDistance: '1m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0001' },
      { brand: 'Mikrotik', partNumber: 'XQ+DA0003', type: 'DAC', speed: '100G', maxDistance: '3m',
        sourceUrl: 'https://mikrotik.com/product/xq_da0003' },
    ],
    'SFP': [
      { brand: 'Mikrotik', partNumber: 'XS+DA0001', type: 'DAC', speed: '1G/10G/25G', maxDistance: '1m',
        price: '$29', sourceUrl: 'https://mikrotik.com/product/xs_da0001',
        imageUrl: 'https://cdn.mikrotik.com/web-assets/rb_images/2003_lg.webp' },
    ],
  };
  const curatedCables = CURATED_CABLES[slotKey] || [];

  // If after filtering we have no recommendations, inject the curated
  // catalog so the user gets real products (image, price, buy link) for
  // the TOP PICK card. Keep this simple: ONE top pick, no separate budget
  // tile (those just duplicated information).
  if ((!recommended || allModules.length === 0) && curatedFallback.length > 0) {
    if (!recommended) recommended = curatedFallback[0];
    allModules = curatedFallback;
  }
  // Intentionally collapse "BEST PRICE" into the main alternatives list —
  // having a duplicate pick was confusing for the user.
  budgetOption = null;

  const cables = advice.cables || [];

  // Total cost in cards is computed against all available SFP ports.
  const currentQty = sfpsToProcure;

  const recPN = recommended?.partNumber;
  // Up to 3 more compatible modules — a tight, curated list rather than
  // a long expandable scroll. These appear flat (no collapse toggle).
  const alternativeModules = allModules
    .filter(m => m.partNumber !== recPN)
    .slice(0, 3);

  const parsePrice = (p) => {
    if (!p) return null;
    const n = parseFloat(String(p).replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  };
  const fmtTotal = (unit, qty) =>
    unit != null ? `$${(unit * qty).toFixed(2)}` : null;
  const sourceDomain = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (_) { return null; }
  };

  // Detect when the scraped sourceUrl is actually a *switch* product page
  // (which merely lists this SFP as a compatible accessory) rather than the
  // SFP's own product page. Only the switch *model* number is a reliable
  // signal — the vendor name appears legitimately in many accessory URLs
  // on the vendor's own store (e.g. mikrotik.com/product/s_da0001).
  const modelToken = model && model !== 'Unknown'
    ? String(model).toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
  const looksLikeSwitchPage = (url) => {
    if (!url) return false;
    const norm = url.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (modelToken && modelToken.length >= 4 && norm.includes(modelToken)) return true;
    return false;
  };
  const buyUrl = (mod) => {
    if (!mod?.sourceUrl) return null;
    if (looksLikeSwitchPage(mod.sourceUrl)) {
      try {
        const u = new URL(mod.sourceUrl);
        return `${u.protocol}//${u.hostname}`;
      } catch { /* fall through */ }
    }
    return mod.sourceUrl;
  };
  const specsLine = (m) =>
    [m.speed, m.type, m.maxDistance, m.wavelength].filter(Boolean).join(' · ');

  return (
    <section className={styles.advisorSection}>
      <div className={styles.advisorHead}>
        <div className={styles.advisorTitleRow}>
          <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
          <span className={styles.advisorBadge}>AI</span>
          <span className={styles.headSpacer} />
          <span className={styles.headSlotInfo}>
            <span className={styles.metaSlot}>{slotInfo.formFactor || advice.slotType}</span>
            <span className={styles.metaDot} aria-hidden>·</span>
            <span className={styles.metaSpeed}>{slotInfo.maxSpeed || slotInfo.speed}</span>
          </span>
        </div>
      </div>

      {(advice.status === 'nearest_match' || advice.fallbackModel) && (
        <div className={styles.nearestNote}>
          No exact listings for <b>{advice.model}</b> - showing nearest-match {slotKey} modules
          compatible with this switch's slot type.
        </div>
      )}

      <div className={styles.advisorContent}>
        {/* EMPTY STATE — couldn't find live listings. Cause is usually one of:
            (a) the chassis OCR couldn't read vendor/model from the rack photo,
            (b) the vendor/model was identified but no live listings matched.
            Tell the user which case they're in, and build a useful search
            query that omits the "Unknown" placeholder when present. */}
        {!recommended && allModules.length === 0 && (() => {
          // Only reached if even the curated catalog is empty for this
          // slot type (e.g. exotic form factor we don't have data for).
          // Tell the user honestly and offer a search button.
          const q = encodeURIComponent(`${slotKey} transceiver`);
          return (
            <div className={styles.emptyHint}>
              <strong>No curated picks</strong> for {slotKey} yet.
              <div style={{ marginTop: 8 }}>
                <a
                  href={`https://www.fs.com/search.html?keyword=${q}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.emptyLink}>
                  Search FS.com →
                </a>
              </div>
            </div>
          );
        })()}

        {/* HERO TOP PICK — visually dominant card for the recommended module */}
        {recommended && (() => {
          const unit = parsePrice(recommended.price);
          const total = fmtTotal(unit, currentQty);
          const domain = recommended.sourceUrl ? sourceDomain(recommended.sourceUrl) : null;
          return (
            <div className={styles.heroPick}>
              <div className={styles.heroPickRibbon}>
                <span className={styles.heroPickBadge}>★ TOP PICK</span>
                <span className={styles.heroPickBrand}>{recommended.brand || 'Unknown'}</span>
              </div>
              <div className={styles.heroPickBody}>
                <div className={styles.heroPickInfo}>
                  <div className={styles.heroPickSku}>{recommended.partNumber}</div>
                  <div className={styles.heroPickSpecs}>
                    {recommended.speed && <span className={styles.heroSpecChip}>{recommended.speed}</span>}
                    {recommended.type && <span className={styles.heroSpecChip}>{recommended.type}</span>}
                    {recommended.maxDistance && <span className={styles.heroSpecChip}>{recommended.maxDistance}</span>}
                    {recommended.wavelength && <span className={styles.heroSpecChip}>{recommended.wavelength}</span>}
                  </div>
                  <div className={styles.heroPickPrice}>
                    {unit != null && unit > 0 ? (
                      <>
                        <span className={styles.heroPickUnit}>{recommended.price}<span className={styles.heroPickEa}>each</span></span>
                        {currentQty > 1 && total && (
                          <>
                            <span className={styles.heroPickPriceDot}>·</span>
                            <span className={styles.heroPickTotal}>{total} for {currentQty}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <span className={styles.heroPickNoPrice}>Price not available</span>
                    )}
                  </div>
                </div>
                <div className={styles.heroPickImage}>
                  <SfpModuleImage module={recommended} size="hero" />
                </div>
              </div>
              {recommended.sourceUrl && (
                <a
                  href={buyUrl(recommended)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.heroPickCta}
                >
                  {domain ? `Buy on ${domain}` : 'Buy product'} →
                </a>
              )}
            </div>
          );
        })()}

        {/* COMPACT BUDGET — single-row layout, less visual weight than the hero */}
        {budgetOption && budgetOption.partNumber !== recPN && (() => {
          const unit = parsePrice(budgetOption.price);
          const total = fmtTotal(unit, currentQty);
          return (
            <a
              href={buyUrl(budgetOption) || '#'}
              target={budgetOption.sourceUrl ? '_blank' : undefined}
              rel={budgetOption.sourceUrl ? 'noopener noreferrer' : undefined}
              className={styles.compactPick}
              onClick={!budgetOption.sourceUrl ? (e) => e.preventDefault() : undefined}
            >
              <div className={styles.compactPickTag}>$ BEST PRICE</div>
              <div className={styles.compactPickThumb}>
                <SfpModuleImage module={budgetOption} size="compact" />
              </div>
              <div className={styles.compactPickInfo}>
                <div className={styles.compactPickHead}>
                  <span className={styles.compactPickBrand}>{budgetOption.brand || 'Unknown'}</span>
                  <span className={styles.compactPickSku}>{budgetOption.partNumber}</span>
                </div>
                <div className={styles.compactPickMeta}>{specsLine(budgetOption)}</div>
              </div>
              <div className={styles.compactPickRight}>
                <div className={styles.compactPickPrices}>
                  {unit != null && unit > 0 ? (
                    <>
                      <span className={styles.compactPickUnit}>{budgetOption.price}</span>
                      {currentQty > 1 && total && (
                        <span className={styles.compactPickTotal}>{total}</span>
                      )}
                    </>
                  ) : (
                    <span className={styles.compactPickNoPrice}>Price not available</span>
                  )}
                </div>
                {budgetOption.sourceUrl && (
                  <span className={styles.compactPickArrow}>→</span>
                )}
              </div>
            </a>
          );
        })()}

        {/* MORE COMPATIBLE — collapsed by default behind a + button.
            User sees the count next to a toggle; clicking expands the
            full list of alternative transceivers. */}
        {alternativeModules.length > 0 && (
          <div className={styles.altsBlock}>
            <button
              type="button"
              className={styles.altsHeader}
              onClick={() => setShowAlternatives(v => !v)}
              aria-expanded={showAlternatives}
            >
              <span className={styles.altsHeaderLabel}>
                <span className={styles.altsCount}>{alternativeModules.length}</span>
                more compatible {alternativeModules.length === 1 ? 'module' : 'modules'}
              </span>
              <span className={styles.altsHeaderToggle}>{showAlternatives ? '−' : '+'}</span>
            </button>
            {showAlternatives && (
              <div className={styles.altsList} style={{ paddingTop: 6 }}>
                {alternativeModules.map(m => {
                  const unit = parsePrice(m.price);
                  const total = fmtTotal(unit, currentQty);
                  const Tag = m.sourceUrl ? 'a' : 'div';
                  const linkProps = m.sourceUrl
                    ? { href: buyUrl(m), target: '_blank', rel: 'noopener noreferrer' }
                    : {};
                  return (
                    <Tag key={m.partNumber} {...linkProps} className={styles.altsRow}>
                      <div className={styles.altsRowThumb}>
                        <SfpModuleImage module={m} size="compact" />
                      </div>
                      <div className={styles.altsRowMain}>
                        <span className={styles.altsRowBrand}>{m.brand || 'Unknown'}</span>
                        <span className={styles.altsRowSku}>{m.partNumber}</span>
                      </div>
                      <div className={styles.altsRowMeta}>{specsLine(m) || '-'}</div>
                      <div className={styles.altsRowSide}>
                        {m.price && (
                          <span className={styles.altsRowPrice}>
                            {m.price}
                            {currentQty > 1 && total && (
                              <span className={styles.altsRowPriceTotal}>{total}</span>
                            )}
                          </span>
                        )}
                        {m.sourceUrl && <span className={styles.altsRowArrow}>→</span>}
                      </div>
                    </Tag>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* PLUG-AND-PLAY CABLES — pre-terminated DAC/AOC that replace the
            module-plus-fiber combo. Rendered as a 3-up horizontal grid of
            mini product cards so they sit together compactly. */}
        {curatedCables.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{
                fontSize: '.78rem', fontWeight: 800, letterSpacing: '.02em',
                color: 'var(--t1, #c6c6c6)',
              }}>
                Plug-and-play cables
              </span>
              <span style={{
                fontSize: '.58rem', fontWeight: 700,
                letterSpacing: '.10em', textTransform: 'uppercase',
                color: 'rgba(0,0,0,0.55)',
              }}>
                No transceiver needed
              </span>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 8,
            }}>
              {curatedCables.slice(0, 3).map(c => {
                const Tag = c.sourceUrl ? 'a' : 'div';
                const linkProps = c.sourceUrl
                  ? { href: c.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }
                  : {};
                return (
                  <Tag
                    key={c.partNumber}
                    {...linkProps}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 4,
                      padding: 8,
                      borderRadius: 10,
                      background: 'linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.04))',
                      border: '1px solid rgba(0,0,0,0.25)',
                      color: 'inherit',
                      textDecoration: 'none',
                      transition: 'transform .15s ease, border-color .15s ease',
                    }}>
                    <div style={{
                      width: '100%', aspectRatio: '4 / 3',
                      borderRadius: 6,
                      background: '#ffffff',
                      overflow: 'hidden',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <SfpModuleImage module={c} size="compact" />
                    </div>
                    <span style={{
                      fontSize: '.68rem', fontWeight: 700,
                      color: '#474747',
                      letterSpacing: '.04em',
                    }}>
                      {c.type} · {c.maxDistance}
                    </span>
                    <span style={{
                      fontFamily: 'var(--mono, ui-monospace, monospace)',
                      fontSize: '.7rem', fontWeight: 700,
                      color: 'var(--t1, #c6c6c6)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {c.partNumber}
                    </span>
                    <div style={{
                      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                      marginTop: 'auto',
                      paddingTop: 2,
                    }}>
                      {c.price && (
                        <span style={{
                          fontSize: '.86rem', fontWeight: 800,
                          color: '#474747',
                        }}>
                          {c.price}
                        </span>
                      )}
                      {c.sourceUrl && (
                        <span style={{
                          fontSize: '.66rem', fontWeight: 700,
                          color: 'rgba(0,0,0,0.65)',
                        }}>
                          Buy →
                        </span>
                      )}
                    </div>
                  </Tag>
                );
              })}
            </div>
          </div>
        )}

        {/* FOOTER — datasheet link + sources count, single line */}
        {(advice.searchResults?.length > 0 || advice.productUrl) && (
          <div className={styles.advisorFooter}>
            {advice.productUrl && (
              <a
                href={advice.productUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.advisorFooterLink}
              >
                📄 Switch datasheet
              </a>
            )}
            {advice.searchResults?.length > 0 && (
              <span className={styles.advisorFooterNote}>
                {allModules.length} {allModules.length === 1 ? 'module' : 'modules'} · {advice.searchResults.length} sources
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
