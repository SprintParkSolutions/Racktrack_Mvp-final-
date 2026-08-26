import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext.jsx';
import BackButton from '../components/BackButton.jsx';
import styles from './GroundTruthPage.module.css';

// Same vocabulary the Results page correction picker uses, so a truth given
// here and a correction given there produce identical feedback records.
const DEVICE_CLASS_OPTIONS = [
  'Switch', 'Patch Panel', 'Firewall', 'Router', 'Server', 'Load Balancer',
  'Modem', 'Controller', 'Recorder', 'Amplifier', 'Gateway', 'PDU', 'PSU', 'UPS',
];

// One place the truth is written. Reuses the existing, battle-tested device
// feedback endpoint (atomic map update + append-only log + active learning +
// accuracy scoreboard). Throws with the server's message on failure.
async function submitTruth({ scanId, device_index, is_correct, actual_device_class }) {
  const res = await authFetch(apiUrl('/api/feedback/device'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scanId,
      device_index,
      is_correct,
      actual_device_class: is_correct ? null : actual_device_class,
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json().catch(() => ({}));
}

function fmtDate(ts) {
  if (!ts) return 'Unknown date';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}

// Rack imagery and device crops are auth-gated, and an <img> tag can't send a
// Bearer token — so fetch the bytes with authFetch and hand the tag an object
// URL. Revokes on unmount / src change so we never leak blobs.
function AuthImg({ src, alt = '', className, fallback = null }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!src) { setUrl(null); setErr(false); return undefined; }
    let cancelled = false;
    let obj = null;
    setUrl(null); setErr(false);
    authFetch(src)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then((b) => { if (cancelled) return; obj = URL.createObjectURL(b); setUrl(obj); })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [src]);

  if (err || !src) return fallback;
  if (!url) return <div className={`${className || ''} ${styles.imgLoading}`} aria-hidden="true" />;
  return <img src={url} alt={alt} className={className} />;
}

function ConfidenceChip({ value }) {
  if (value == null) {
    return <span className={`${styles.conf} ${styles.confUnknown}`}>confidence n/a</span>;
  }
  const pct = Math.round(value * 100);
  const level = pct < 50 ? styles.confLow : pct < 75 ? styles.confMid : styles.confHigh;
  return (
    <span className={`${styles.conf} ${level}`}>
      <span className={styles.confDot} aria-hidden="true" />{pct}% confident
    </span>
  );
}

// Confirm / correct control. "type only" truth: confirm the model's class, or
// pick the actual class. onDone({ is_correct, actual }) fires after the write
// succeeds; the caller advances / updates its own state.
function TruthControl({ device, onDone }) {
  const [mode, setMode] = useState('choose'); // 'choose' | 'correct'
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (isCorrect, actual) => {
    setSaving(true); setErr(null);
    try {
      await submitTruth({
        scanId: device.scanId,
        device_index: device.device_index,
        is_correct: isCorrect,
        actual_device_class: actual,
      });
      onDone({ is_correct: isCorrect, actual: actual || null });
    } catch (e) {
      setErr(e.message || 'Could not save');
      setSaving(false);
    }
  };

  if (mode === 'correct') {
    return (
      <div className={styles.control}>
        <span className={styles.pickLabel}>What is it actually?</span>
        <div className={styles.pickRow}>
          <select
            className={styles.select}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={saving}
            aria-label="Actual device type"
          >
            <option value="">Select device type…</option>
            {DEVICE_CLASS_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {err && <div className={styles.controlErr}>{err}</div>}
        <div className={styles.pickActions}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => { setMode('choose'); setErr(null); }}
            disabled={saving}
          >
            Back
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => submit(false, choice)}
            disabled={!choice || saving}
          >
            {saving ? 'Saving…' : 'Save truth'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.control}>
      {err && <div className={styles.controlErr}>{err}</div>}
      <div className={styles.verdictRow}>
        <button
          type="button"
          className={styles.btnConfirm}
          onClick={() => submit(true, null)}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Correct'}
        </button>
        <button
          type="button"
          className={styles.btnReject}
          onClick={() => { setMode('correct'); setErr(null); }}
          disabled={saving}
        >
          Not this
        </button>
      </div>
    </div>
  );
}

function TruthBadge({ truth, onEdit }) {
  const corrected = truth && truth.is_correct === false;
  return (
    <div className={styles.badgeWrap}>
      {corrected ? (
        <span className={`${styles.truthBadge} ${styles.badgeCorrected}`}>
          Corrected{truth.actual_class ? ` → ${truth.actual_class}` : ''}
        </span>
      ) : (
        <span className={`${styles.truthBadge} ${styles.badgeConfirmed}`}>Confirmed</span>
      )}
      <button type="button" className={styles.editLink} onClick={onEdit}>Change</button>
    </div>
  );
}

function Stat({ k, v, sub }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statK}>{k}</div>
      <div className={styles.statV}>{v}{sub != null && <span className={styles.statSub}> · {sub}</span>}</div>
    </div>
  );
}

function StatsRow({ stats }) {
  if (!stats) return null;
  const acc = stats.accuracy != null ? `${Math.round(stats.accuracy * 100)}%` : '-';
  const graded = (stats.correct || 0) + (stats.wrong || 0);
  return (
    <div className={styles.stats}>
      <Stat k="Remaining" v={stats.remaining} />
      <Stat k="Truthed" v={stats.truthed} />
      <Stat k="Model accuracy" v={acc} sub={graded ? `${stats.correct}/${graded}` : 'no truth yet'} />
      <Stat k="Scans" v={stats.scans} />
    </div>
  );
}

function WorklistCard({ item, onDone, onSkip }) {
  const overlayFallback = item.rackImageUrl
    ? (
      <AuthImg
        src={apiUrl(item.rackImageUrl)}
        alt="Rack"
        className={styles.crop}
        fallback={<div className={styles.cropPlaceholder}>No image available</div>}
      />
    )
    : <div className={styles.cropPlaceholder}>No image available</div>;

  return (
    <div className={styles.card}>
      <div className={styles.cardMedia}>
        <AuthImg
          src={apiUrl(item.cropUrl)}
          alt="Detected device"
          className={styles.crop}
          fallback={overlayFallback}
        />
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={styles.pos}>{item.position || '-'}</span>
          <ConfidenceChip value={item.confidence} />
        </div>
        <div className={styles.guessLabel}>The model detected this as</div>
        <div className={styles.guessClass}>{item.predicted_class}</div>
        <div className={styles.scanRef}>{item.scanId}{item.scannedAt ? ` · ${fmtDate(item.scannedAt)}` : ''}</div>
        <TruthControl device={item} onDone={onDone} />
        <button type="button" className={styles.skipBtn} onClick={onSkip}>Skip for now</button>
      </div>
    </div>
  );
}

function EmptyDone({ truncated, remaining, onReload }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{truncated || remaining > 0 ? 'Batch complete' : 'All caught up'}</div>
      <p className={styles.emptyBody}>
        {truncated || remaining > 0
          ? `You've cleared this batch. ${remaining} device${remaining === 1 ? '' : 's'} still need truth.`
          : 'Every detected device across your scans has been reviewed. Nice work.'}
      </p>
      {(truncated || remaining > 0) && (
        <button type="button" className={styles.btnPrimary} onClick={onReload}>Load next batch</button>
      )}
    </div>
  );
}

function Worklist() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    authFetch(apiUrl('/api/ground-truth/queue?limit=150'))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        if (cancelled) return;
        setItems(d.items || []);
        setStats(d.stats || null);
        setTruncated(!!d.truncated);
        setCursor(0);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  const handleDone = (verdict) => {
    setStats((s) => (s ? {
      ...s,
      truthed: s.truthed + 1,
      remaining: Math.max(0, s.remaining - 1),
      correct: s.correct + (verdict.is_correct ? 1 : 0),
      wrong: s.wrong + (verdict.is_correct ? 0 : 1),
    } : s));
    setCursor((c) => c + 1);
  };

  if (loading) return <div className={styles.center}>Loading worklist…</div>;
  if (err) return <div className={styles.errBox}>Couldn’t load the worklist: {err}</div>;

  const current = items[cursor] || null;

  return (
    <>
      <StatsRow stats={stats} />
      {current ? (
        <>
          <div className={styles.progressText}>
            {cursor + 1} of {items.length} in this batch{truncated ? ' · more remain' : ''}
          </div>
          <WorklistCard
            key={`${current.scanId}:${current.device_index}`}
            item={current}
            onDone={handleDone}
            onSkip={() => setCursor((c) => c + 1)}
          />
        </>
      ) : (
        <EmptyDone truncated={truncated} remaining={stats?.remaining || 0} onReload={load} />
      )}
    </>
  );
}

function BrowseDetail({ rackId, onBack, backLabel = '‹ All scans' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    authFetch(apiUrl(`/api/ground-truth/scan/${rackId}`))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rackId]);

  const setRow = (idx, patch) => {
    setData((d) => (d ? {
      ...d,
      devices: d.devices.map((dv) => (dv.device_index === idx ? { ...dv, ...patch } : dv)),
    } : d));
  };

  return (
    <div>
      <button type="button" className={styles.backLink} onClick={onBack}>{backLabel}</button>
      {loading ? (
        <div className={styles.center}>Loading scan…</div>
      ) : err ? (
        <div className={styles.errBox}>{err}</div>
      ) : data ? (
        <>
          <div className={styles.detailHead}>
            <div className={styles.detailId}>{data.rackId}</div>
            <div className={styles.detailSub}>{fmtDate(data.timestamp)} · {data.devices.length} devices</div>
          </div>
          {data.rackImageUrl && (
            <div className={styles.detailImg}>
              <AuthImg
                src={apiUrl(data.rackImageUrl)}
                alt="Rack scan"
                className={styles.detailImgEl}
                fallback={<div className={styles.cropPlaceholder}>No image available</div>}
              />
            </div>
          )}
          {data.devices.length === 0 ? (
            <p className={styles.emptyBody}>No devices were detected in this scan.</p>
          ) : (
            <div className={styles.deviceList}>
              {data.devices.map((dv) => (
                <div key={dv.device_index} className={styles.deviceRow}>
                  <div className={styles.deviceInfo}>
                    <span className={styles.devicePos}>{dv.position || '-'}</span>
                    <span className={styles.deviceClass}>{dv.predicted_class}</span>
                    <ConfidenceChip value={dv.confidence} />
                  </div>
                  <div className={styles.deviceAction}>
                    {dv.truthed ? (
                      <TruthBadge
                        truth={dv.truth}
                        onEdit={() => setRow(dv.device_index, { truthed: false })}
                      />
                    ) : (
                      <TruthControl
                        device={{ scanId: data.rackId, device_index: dv.device_index }}
                        onDone={(v) => setRow(dv.device_index, {
                          truthed: true,
                          truth: { is_correct: v.is_correct, actual_class: v.actual || null },
                        })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function Browse() {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    authFetch(apiUrl('/api/ground-truth/scans'))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (!cancelled) setScans(d.scans || []); })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (selected) return <BrowseDetail rackId={selected} onBack={() => setSelected(null)} />;
  if (loading) return <div className={styles.center}>Loading scans…</div>;
  if (err) return <div className={styles.errBox}>Couldn’t load scans: {err}</div>;
  if (!scans.length) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No scans yet</div>
        <p className={styles.emptyBody}>Scans will appear here once racks have been scanned.</p>
      </div>
    );
  }

  return (
    <div className={styles.scanGrid}>
      {scans.map((s) => {
        const pct = s.deviceCount ? Math.round((100 * s.truthedCount) / s.deviceCount) : 0;
        return (
          <button key={s.rackId} type="button" className={styles.scanCard} onClick={() => setSelected(s.rackId)}>
            <div className={styles.scanThumb}>
              {s.image ? (
                <AuthImg src={apiUrl(s.image)} alt="" className={styles.scanThumbImg} fallback={<div className={styles.scanThumbEmpty} />} />
              ) : <div className={styles.scanThumbEmpty} />}
            </div>
            <div className={styles.scanMeta}>
              <div className={styles.scanId}>{s.rackId}</div>
              <div className={styles.scanSub}>{fmtDate(s.timestamp)} · {s.deviceCount} devices</div>
              <div className={styles.scanProgress}>
                <span className={styles.progBarWrap}><span className={styles.progBar} style={{ width: `${pct}%` }} /></span>
                <span className={styles.progText}>{s.truthedCount}/{s.deviceCount} truthed</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Ground Truth is now a PER-SCAN step, reached only after a scan is analysed
// (/ground-truth/:rackId, linked from the rack context). It verifies the model's
// detections for THAT one upload — not a global worklist across every scan. The
// server already exposes /api/ground-truth/scan/:rackId, which BrowseDetail uses.
export default function GroundTruthPage() {
  const { rackId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';

  if (!isOwner) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <BackButton fallback={rackId ? `/results/${rackId}` : '/'} />
          <div className={styles.headerText}>
            <h1 className={styles.title}>Ground Truth</h1>
          </div>
        </header>
        <main className={styles.main}>
          <p className={styles.refusal}>Ground Truth is restricted to platform owners.</p>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <BackButton fallback={rackId ? `/results/${rackId}` : '/'} />
        <div className={styles.headerText}>
          <h1 className={styles.title}>Ground Truth</h1>
          <p className={styles.subtitle}>Verify what the model detected in this scan</p>
        </div>
      </header>

      <main className={styles.main}>
        {rackId ? (
          <BrowseDetail
            rackId={rackId}
            backLabel="‹ Back to results"
            onBack={() => navigate(`/results/${rackId}`)}
          />
        ) : (
          <p className={styles.refusal}>Open a scan first, then verify its detections here.</p>
        )}
      </main>
    </div>
  );
}
