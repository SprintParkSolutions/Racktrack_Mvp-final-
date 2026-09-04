import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import styles from './ScanPage.module.css';
import { validateMedia } from '../utils/validateMedia';
import { IMAGE_ACCEPT, VIDEO_ACCEPT } from '../utils/mediaAccept';
import { apiUrl, authFetch } from '../utils/api';
import { prefetchScan } from '../utils/scanPrefetch';
import { newJobId, setPendingScan, clearPendingScan } from '../utils/pendingScan';
import { useShutter } from '../ShutterContext.jsx';
import { useTheme } from '../ThemeContext.jsx';
import { useTour } from '../TourContext.jsx';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { useSmartBack } from '../hooks/useSmartBack';
import Icon from '../components/Icon';
import { getItem, setItem } from '../utils/safeStorage';

// three.js is no longer reachable from this page at all. MiniRack3D was the
// decoration on the analysing overlay and is gone; TopologyScene3D was declared
// here but never rendered — the VR view lives on the topology page. Both lazy
// imports have been removed rather than left as unused chunk boundaries.

// ── First-scan guidance ──────────────────────────────────────
//
// The same five lines that used to sit permanently under the Analyze button.
// Printed on every visit they were wallpaper — a block of advice the user had
// already read and could no longer see, taking a screenful on the one page
// where the content should be the photograph. Shown once, on the first scan
// this device ever starts, they are instructions; after that the user knows.
//
// The flag is per-device rather than per-account: it is about whether this
// person has done it before, and someone handed a second phone genuinely has
// not. "Show again" in the sheet clears it, which is the only route back.
const FIRST_SCAN_KEY = 'racktrack.scan.tipsSeen';

const SCAN_TIPS = [
  'Full rack in frame - keep the top and bottom visible',
  'Phone straight and level - stand directly in front',
  'Labels clearly visible - port and device labels readable',
  'Good lighting, no glare - turn the flash off',
  'Step back if needed - fit the whole rack on screen',
];

function FirstScanSheet({ onClose }) {
  return createPortal(
    <div className={styles.tipsBackdrop} onClick={onClose}>
      <div
        className={styles.tipsSheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-scan-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="first-scan-title" className={styles.tipsSheetTitle}>Before your first scan</h2>
        <p className={styles.tipsSheetLede}>Five things that decide whether the read is accurate.</p>
        <ul className={styles.tipsSheetList}>
          {SCAN_TIPS.map((t) => <li key={t}>{t}</li>)}
        </ul>
        <button type="button" className={styles.tipsSheetBtn} onClick={onClose}>Got it</button>
      </div>
    </div>,
    document.body,
  );
}

// ── Preview Card ─────────────────────────────────────────────
function PreviewCard({ file, onClear }) {
  // Blob URL lifecycle must live inside useEffect so it survives StrictMode's
  // intentional double-mount — creating in useMemo + revoking in cleanup revokes
  // the URL before the <img> gets a chance to use it on the second mount.
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const isVideo = file?.type?.startsWith('video/');

  return (
    <div className={styles.previewCard}>
      {url && (isVideo
        ? <video src={url} className={styles.previewImg} muted playsInline controls />
        : <img src={url} alt="Preview" className={styles.previewImg} />)}
      <button className={styles.previewCloseBtn} onClick={onClear} aria-label="Remove the selected file">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div className={styles.previewGrid} />
      <div className={styles.previewBar} />
    </div>
  );
}

// ── Upload / Drop Zone ───────────────────────────────────────
function UploadZone({ onFile, mode = 'image', inputRef: externalRef = null }) {
  // The parent needs to be able to open the picker too: the "Upload" tab is
  // labelled and iconed like an action, so tapping it must do something. It
  // only ever called setTab, and Upload is the default tab — so on the screen
  // testers actually saw, tapping Upload did nothing at all.
  const localRef = useRef(null);
  const inputRef = externalRef || localRef;
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback((file) => {
    if (file) onFile(file);
  }, [onFile]);

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  };

  const isVideo = mode === 'video';
  // Images only on the image tab. It used to append `video/*` here as well, which
  // did two unhelpful things: it duplicated the VIDEO mode sitting right beside it,
  // and it made the accept list mixed enough that Android's picker fell back to its
  // generic chooser — the one that offers a sound recorder. See mediaAccept.js.
  const accept = isVideo ? VIDEO_ACCEPT : IMAGE_ACCEPT;
  const title = isVideo ? 'Drop rack video here' : 'Drop rack image here';
  const sub = isVideo ? 'tap to browse · MP4, MOV, WEBM' : 'tap to browse · JPG, JPEG, PNG, HEIC';
  // Format pills shown only in the desktop reference layout (hidden on mobile
  // via CSS — see .fmtPills). Mobile keeps the inline `sub` string above.
  const formats = isVideo ? ['MP4', 'MOV', 'WEBM'] : ['JPG', 'JPEG', 'PNG', 'HEIC'];

  return (
    <>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dragOver : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        {/* Corner brackets */}
        <span className={`${styles.zc} ${styles.zcTL}`}/>
        <span className={`${styles.zc} ${styles.zcTR}`}/>
        <span className={`${styles.zc} ${styles.zcBL}`}/>
        <span className={`${styles.zc} ${styles.zcBR}`}/>

        {/* Centered viewfinder icon — no box, just a faded mark */}
        <div className={styles.iconRing}>
          <div className={styles.iconWrap}>
            <Icon name={isVideo ? 'videocam' : 'filter_center_focus'} style={{ fontSize: 32, color: 'inherit' }} />
          </div>
        </div>

        <div className={styles.dropText}>
          <p className={styles.dropTitle}>{title}</p>
          <p className={styles.dropSub}>{sub}</p>
        </div>

        {/* Desktop reference extras — rendered always but hidden on mobile via
            CSS (base rules set display:none; .scanContentDesktop reveals them).
            The mobile layout above is untouched. */}
        <p className={styles.dropSubAlt}>or <span className={styles.browseLink}>tap to browse</span></p>
        <div className={styles.fmtPills} aria-hidden="true">
          {formats.map(f => <span key={f} className={styles.fmtPill}>{f}</span>)}
        </div>
        <span className={styles.readyCaption} aria-hidden="true">READY · NO FILE SELECTED</span>
      </div>
      {/* Visually hidden (NOT display:none) — Safari blocks .click() on a
          display:none file input, so the Upload button wouldn't open the picker. */}
      <input ref={inputRef} type="file"
        accept={accept}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }}
        onChange={(e) => handleFile(e.target.files[0])} />
    </>
  );
}

// ── Multi-Image Upload Zone (Tall Rack stitch) ───────────────
// For tall racks that can't fit in a single shot: user picks 2-8 photos
// top-to-bottom, server stitches them, then runs the standard analyze
// pipeline on the panorama. Each row shows a thumbnail + reorder/remove
// controls so the user can correct the order if their files came in
// alphabetically rather than chronologically.
function MultiUploadZone({ files, onChange }) {
  const inputRef = useRef(null);
  const [urls, setUrls] = useState([]);

  // Blob URLs for thumbnails — lifecycle scoped to the file list so we
  // don't leak object URLs when the user reorders / removes images.
  useEffect(() => {
    const next = files.map(f => URL.createObjectURL(f));
    setUrls(next);
    return () => { next.forEach(URL.revokeObjectURL); };
  }, [files]);

  const addFiles = useCallback((picked) => {
    const arr = Array.from(picked || []);
    if (!arr.length) return;
    const merged = [...files, ...arr].slice(0, 8); // hard cap matches server
    onChange(merged);
  }, [files, onChange]);

  const moveUp = (i) => {
    if (i === 0) return;
    const next = [...files];
    [next[i-1], next[i]] = [next[i], next[i-1]];
    onChange(next);
  };
  const moveDown = (i) => {
    if (i >= files.length - 1) return;
    const next = [...files];
    [next[i+1], next[i]] = [next[i], next[i+1]];
    onChange(next);
  };
  const remove = (i) => {
    const next = files.filter((_, idx) => idx !== i);
    onChange(next);
  };

  // Position label is just the slot number — the server auto-arranges
  // top→bottom by detecting overlaps, so the upload order doesn't matter.
  // We still surface up/down/remove so the user can manually override if
  // they want, but the default flow is "drop them in, hit Analyze".
  const posLabel = (i) => `Photo ${i + 1}`;

  return (
    <div className={styles.multiZone}>
      {files.length === 0 ? (
        <div className={styles.multiEmpty}>
          <div className={styles.multiEmptyIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3"  y="3"  width="18" height="5" rx="1"/>
              <rect x="3"  y="10" width="18" height="5" rx="1"/>
              <rect x="3"  y="17" width="18" height="5" rx="1"/>
            </svg>
          </div>
          <div className={styles.multiEmptyTitle}>Tall rack - multi shot</div>
          <div className={styles.multiEmptySub}>
            Take 2-8 overlapping photos of the rack.<br/>
            Any order - we'll arrange them automatically.
          </div>
          <button type="button" className={styles.multiAddBtn}
            onClick={() => inputRef.current?.click()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Select photos
          </button>
        </div>
      ) : (
        <>
          <div className={styles.multiHead}>
            <span className={styles.multiTitle}>
              {files.length} photo{files.length === 1 ? '' : 's'} · auto-arranged
            </span>
            <span className={styles.multiHint}>{files.length}/8</span>
          </div>
          <div className={styles.multiList}>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}-${f.lastModified}`} className={styles.multiRow}>
                <img className={styles.multiThumb} src={urls[i] || ''} alt="" />
                <div className={styles.multiInfo}>
                  <div className={styles.multiName}>{f.name}</div>
                  <div className={styles.multiPos}>{posLabel(i)} · {Math.round(f.size/1024)} KB</div>
                </div>
                <div className={styles.multiActions}>
                  <button type="button" className={styles.multiBtn}
                    onClick={() => moveUp(i)} disabled={i === 0} aria-label="Move up">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="18 15 12 9 6 15"/>
                    </svg>
                  </button>
                  <button type="button" className={styles.multiBtn}
                    onClick={() => moveDown(i)} disabled={i === files.length - 1} aria-label="Move down">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                  <button type="button" className={`${styles.multiBtn} ${styles.multiBtnDanger}`}
                    onClick={() => remove(i)} aria-label="Remove">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
          {files.length < 8 && (
            <button type="button" className={styles.multiAddBtn}
              onClick={() => inputRef.current?.click()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add more
            </button>
          )}
        </>
      )}
      <input ref={inputRef} type="file" multiple
        accept={IMAGE_ACCEPT}
        style={{display:'none'}}
        onChange={(e) => addFiles(e.target.files)} />
    </div>
  );
}

// ── Camera Capture ───────────────────────────────────────────
function pickRecorderMime() {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function CameraCapture({ onCapture, onCancel }) {
  const navigate = useNavigate();
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const sampleRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recordChunksRef = useRef([]);
  const { registerShutter, clearShutter } = useShutter();
  const [ready,    setReady]    = useState(false);
  const [error,    setError]    = useState(null);
  const [flash,    setFlash]    = useState(false);
  const [mode,     setMode]     = useState('photo');   // 'photo' | 'video'
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [quality,  setQuality]  = useState({ sharp: false, framed: false, lit: false });

  // ── Live detection overlay ──────────────────────────────────
  // While the camera is streaming, sample frames at ~1Hz, send them to
  // /api/analyze, and overlay 2D HTML labels on top of the <video>. We
  // match each frame's detections against prior tracks by IoU so a device
  // that briefly drops below the model's confidence threshold doesn't get
  // a new label when it comes back, and run NMS so we never display two
  // overlapping labels on the same physical device.
  const [liveDevices, setLiveDevices] = useState([]); // already in display-pixel space
  const detectionInflightRef = useRef(false);
  const tracksRef        = useRef(new Map());
  const nextTrackIdRef   = useRef(1);
  const TRACK_IOU_MIN     = 0.2;
  const TRACK_TTL_FRAMES  = 1;   // single missed cycle (~400ms) drops the box — kills ghost-pan lingering
  const NMS_IOU           = 0.25; // tighter NMS so panning duplicates collapse onto the just-observed track
  const BBOX_EMA_ALPHA    = 0.6;  // when re-observing a track: 60% new + 40% old → reduces per-frame jitter
  const MIN_CONF          = 0.45; // drop low-confidence detections before they enter the tracker
  const MIN_HITS_TO_SHOW  = 2;    // single-frame false positives never render (need 2 consecutive matches)
  const DETECT_INTERVAL_MS = 400;

  const allGood = quality.sharp && quality.framed && quality.lit;
  const canShoot = mode === 'video' ? ready : ready && allGood;

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // If the user navigated away while the permission dialog was open the
      // <video> element is gone — stop the tracks immediately or the camera
      // hardware stays live until tab close.
      if (!videoRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        const v = videoRef.current;
        if (!v) return;
        v.play().catch(() => {});
        setReady(true);
      };
    } catch { setError('Camera access denied. Allow camera permission or use Upload.'); }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null; setReady(false);
  }, []);

  // Photo and Video both use the web getUserMedia stream.
  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [mode, startCamera, stopCamera]);

  // ── Live quality sampling loop (photo mode only) ────────
  useEffect(() => {
    if (!ready || mode !== 'photo') return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      const canvas = sampleRef.current;
      if (!video || !canvas || !video.videoWidth) return;

      const sw = 192;
      const sh = Math.max(1, Math.round(sw * video.videoHeight / video.videoWidth));
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);

      const gray = new Float32Array(sw * sh);
      let lumaSum = 0;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        gray[j] = y; lumaSum += y;
      }
      const meanLuma = lumaSum / (sw * sh);

      // Measure sharpness + edge density inside the guide region
      const gx0 = Math.floor(sw * 0.15), gx1 = Math.floor(sw * 0.85);
      const gy0 = Math.floor(sh * 0.08), gy1 = Math.floor(sh * 0.92);
      let lapSum = 0, lapSumSq = 0, n = 0, edgeCount = 0;
      for (let y = gy0 + 1; y < gy1 - 1; y++) {
        for (let x = gx0 + 1; x < gx1 - 1; x++) {
          const i = y * sw + x;
          const v = -4 * gray[i] + gray[i-1] + gray[i+1] + gray[i-sw] + gray[i+sw];
          lapSum += v; lapSumSq += v * v; n++;
          if (Math.abs(v) > 40) edgeCount++;
        }
      }
      if (n === 0) return;
      const lapMean = lapSum / n;
      const sharpness = lapSumSq / n - lapMean * lapMean;
      const edgeDensity = edgeCount / n;

      setQuality({
        sharp:  sharpness > 60,
        framed: edgeDensity > 0.035,
        lit:    meanLuma > 35 && meanLuma < 235,
      });
    }, 350);
    return () => clearInterval(interval);
  }, [ready, mode]);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    const vW = video.videoWidth, vH = video.videoHeight;
    // The preview uses object-fit:cover, which crops the camera frame to the
    // element's shape. Capture ONLY that visible region so the saved photo is
    // exactly what the user framed — otherwise the still includes the edges
    // that were cropped out on screen ("it shows more than I saw").
    const rect = video.getBoundingClientRect();
    const dW = rect.width || vW, dH = rect.height || vH;
    const scale = Math.max(dW / vW, dH / vH);
    const srcW = Math.min(vW, Math.round(dW / scale));
    const srcH = Math.min(vH, Math.round(dH / scale));
    const srcX = Math.round((vW - srcW) / 2);
    const srcY = Math.round((vH - srcH) / 2);
    canvas.width = srcW; canvas.height = srcH;
    canvas.getContext('2d').drawImage(video, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
      onCapture(file);
    }, 'image/jpeg', 0.92);
  }, [onCapture]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser. Use Upload instead.');
      return;
    }
    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      setError('Could not start video recording on this device.');
      return;
    }
    recordChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(recordChunksRef.current, { type });
      recordChunksRef.current = [];
      if (!blob.size) return;
      const file = new File([blob], `capture_${Date.now()}.${ext}`, { type });
      onCapture(file);
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
    setRecordSecs(0);
  }, [onCapture]);

  const stopRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') {
      try { r.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const handleShutter = useCallback(() => {
    if (mode === 'video') {
      if (recording) stopRecording();
      else startRecording();
      return;
    }
    capturePhoto();
  }, [mode, recording, startRecording, stopRecording, capturePhoto]);

  // Recording timer
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecordSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // If the user toggles modes while recording, stop cleanly.
  useEffect(() => {
    if (mode !== 'video' && recording) stopRecording();
  }, [mode, recording, stopRecording]);

  // Stop any in-flight recording when the camera unmounts.
  useEffect(() => () => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') {
      try { r.stop(); } catch { /* ignore */ }
    }
  }, []);

  // ── Live detection loop ─────────────────────────────────
  // Runs while the camera is ready (Photo + Video modes both). Samples
  // a frame from <video> each tick → /api/analyze → IoU-match against
  // existing tracks → NMS → display labels on top of the viewfinder.
  // Single-flighted so a slow analyze doesn't queue requests.
  useEffect(() => {
    if (!ready) { setLiveDevices([]); return; }

    // Reset tracks on each camera (re)start so stale labels from a
    // previous viewfinder don't bleed into a fresh scene.
    tracksRef.current.clear();
    nextTrackIdRef.current = 1;
    setLiveDevices([]);

    let cancelled = false;
    const tick = async () => {
      if (cancelled || detectionInflightRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;

      detectionInflightRef.current = true;
      try {
        const sw = video.videoWidth;
        const sh = video.videoHeight;
        // /api/detect runs YOLO at imgsz=320 for live throughput, so the
        // client only needs to send 320px wide. Smaller upload + decode +
        // inference together cuts round-trip ~3× vs 640.
        const targetW = Math.min(sw, 320);
        const targetH = Math.round(sh * targetW / sw);
        const canvas = document.createElement('canvas');
        canvas.width = targetW; canvas.height = targetH;
        canvas.getContext('2d').drawImage(video, 0, 0, targetW, targetH);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.78));
        if (!blob || cancelled) return;

        const fd = new FormData();
        fd.append('image', blob, 'live-frame.jpg');
        const r = await authFetch(apiUrl('/api/detect'), { method: 'POST', body: fd });
        if (cancelled) return;
        const data = await r.json().catch(() => ({}));
        const rawDevices = data?.devices || [];

        // /api/detect returns bboxes in the JPEG's space (targetW × targetH).
        // Scale back to source resolution so display-coord math uses one
        // consistent space (sourceW × sourceH).
        const back = sw / targetW;

        const observations = rawDevices
          .map(d => {
            const bb = normalizeBbox(d);
            if (!bb) return null;
            const conf = Number(d.confidence ?? d.score ?? 1);
            if (conf < MIN_CONF) return null;
            return {
              bbox:  bb.map(v => v * back),
              cls:   String(d.class_name || d.class || 'Device'),
              color: colorForClass(d.class_name || d.class || ''),
              conf,
            };
          })
          .filter(Boolean)
          .slice(0, 32);

        const tracks = tracksRef.current;
        const claimed = new Set();
        for (const obs of observations) {
          let bestId = null;
          let bestIoU = TRACK_IOU_MIN;
          for (const [id, t] of tracks) {
            if (claimed.has(id) || t.cls !== obs.cls) continue;
            const iou = boxIoU(t.bbox, obs.bbox);
            if (iou > bestIoU) { bestIoU = iou; bestId = id; }
          }
          if (bestId !== null) {
            const t = tracks.get(bestId);
            const a = BBOX_EMA_ALPHA;
            t.bbox = [
              a * obs.bbox[0] + (1 - a) * t.bbox[0],
              a * obs.bbox[1] + (1 - a) * t.bbox[1],
              a * obs.bbox[2] + (1 - a) * t.bbox[2],
              a * obs.bbox[3] + (1 - a) * t.bbox[3],
            ];
            t.misses = 0;
            t.hits   = (t.hits || 0) + 1;
            claimed.add(bestId);
          } else {
            const id = `t${nextTrackIdRef.current++}`;
            tracks.set(id, {
              id,
              label:  obs.cls,         // "Switch", "Patch Panel", "Server", …
              cls:    obs.cls,
              color:  obs.color,
              bbox:   obs.bbox,
              misses: 0,
              hits:   1,
            });
            claimed.add(id);
          }
        }
        for (const [id, t] of tracks) {
          if (claimed.has(id)) continue;
          t.misses += 1;
          if (t.misses > TRACK_TTL_FRAMES) tracks.delete(id);
        }

        // NMS: two tracks should never claim the same image region —
        // happens after a strong camera move when an old (still-alive)
        // track's last bbox sits where a new track just spawned. Prefer
        // the just-observed one (misses == 0) and drop the stale.
        const alive = Array.from(tracks.values())
          .sort((a, b) => a.misses - b.misses);
        const kept = [];
        for (const t of alive) {
          if (kept.some(k => boxIoU(k.bbox, t.bbox) > NMS_IOU)) {
            tracks.delete(t.id);
          } else {
            kept.push(t);
          }
        }

        // Map source coords → display pixels (object-fit:cover math).
        const rect = video.getBoundingClientRect();
        const dispW = rect.width;
        const dispH = rect.height;
        if (!dispW || !dispH) { if (!cancelled) setLiveDevices([]); return; }
        const scale = Math.max(dispW / sw, dispH / sh);
        const offX = (sw * scale - dispW) / 2;
        const offY = (sh * scale - dispH) / 2;
        const positioned = kept
          .filter(t => t.hits >= MIN_HITS_TO_SHOW)
          .map(t => ({
            id:     t.id,
            label:  t.label,
            color:  t.color,
            left:   Math.round(t.bbox[0] * scale - offX),
            top:    Math.round(t.bbox[1] * scale - offY),
            width:  Math.round(t.bbox[2] * scale),
            height: Math.round(t.bbox[3] * scale),
          }));
        if (!cancelled) setLiveDevices(positioned);
      } catch (e) {
        // Keep the loop alive — single-frame failures (network blips,
        // 429s) are normal during a long viewfinder session.
        console.warn('live detect failed:', e?.message || e);
      } finally {
        detectionInflightRef.current = false;
      }
    };

    // Kick once immediately, then every DETECT_INTERVAL_MS.
    tick();
    const interval = setInterval(tick, DETECT_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ready]);

  // The shutter now lives in the camera view itself (a real, visible button)
  // rather than hijacking the bottom nav's Scan tab, which left users with no
  // obvious way to capture. Make sure nothing stays bound to the nav button.
  useEffect(() => {
    clearShutter();
    return () => clearShutter();
  }, [clearShutter]);

  if (error) return (
    <div className={styles.camError}>
      <div className={styles.camErrorIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34"/>
        </svg>
      </div>
      <p className={styles.camErrorText}>{error}</p>
    </div>
  );

  const photoHint = !ready
    ? 'Starting camera…'
    : allGood
      ? 'Looks great - tap the shutter below'
      : !quality.framed ? 'Move closer so the rack fills the frame'
      : !quality.lit    ? 'Move to better lighting'
      : !quality.sharp  ? 'Hold steady - keep still for focus'
      : 'Align full rack within the frame';

  const videoHint = !ready
    ? 'Starting camera…'
    : recording
      ? 'Recording - tap shutter to stop'
      : 'Tap shutter to start recording the rack';

  const hintText = mode === 'video' ? videoHint : photoHint;

  const fmtTimer = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const r = (s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  };

  // Portal to <body> so camWrapFull (position:fixed) is truly fullscreen — a
  // transformed ancestor in the scan page otherwise traps the fixed layer and
  // the camera renders as a small letterboxed box.
  return createPortal(
    <div className={`${styles.camWrap} ${styles.camWrapFull}`}>
      <div className={`${styles.flashLayer} ${flash ? styles.flashOn : ''}`} />
      <video ref={videoRef} className={styles.camVideo} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{display:'none'}} />
      <canvas ref={sampleRef} style={{display:'none'}} />

      {/* Live detection labels — positioned absolutely on top of the
          video. Hidden during the photo flash so they don't leak into
          the captured still (they wouldn't anyway since canvas pulls
          from the <video> element directly, but it looks cleaner). */}
      <div className={styles.liveOverlay} aria-hidden="true">
        {liveDevices.map(d => (
          <div key={d.id} className={styles.liveBox}
            style={{
              left:        d.left,
              top:         d.top,
              width:       d.width,
              height:      d.height,
              borderColor: d.color,
            }}>
            <div className={styles.liveChip}
              style={{ background: d.color }}>
              {d.label}
            </div>
          </div>
        ))}
      </div>

      {onCancel && (
        <button className={styles.camCloseBtn} onClick={onCancel} aria-label="Close camera">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}

      <div className={styles.hud}>
        {/* Four corner brackets — the conventional scan-viewfinder guide. This
            was a full dashed rack-shaped rectangle, which testers read as an
            unexplained black box sitting over the picture rather than as a
            framing aid. The brackets carry the same state the box did: they go
            green when every check passes and red while recording, so the
            readiness signal survives the simpler shape. */}
        <div className={`${styles.corners} ${
          mode === 'photo' && canShoot ? styles.cornersOn : ''
        } ${recording ? styles.cornersRec : ''}`} aria-hidden="true">
          <span className={`${styles.hc} ${styles.hcTL}`} />
          <span className={`${styles.hc} ${styles.hcTR}`} />
          <span className={`${styles.hc} ${styles.hcBL}`} />
          <span className={`${styles.hc} ${styles.hcBR}`} />
        </div>

        {/* Top badge only while recording. The idle "RACK SCAN" pill sat
            directly under the Dynamic Island and read as a second black
            notch cutting into the viewfinder, so it's gone — the mode is
            already obvious from the Photo/Video toggle below. */}
        {recording && (
          <div className={styles.hudTop}>
            <span className={styles.hudBadge}>
              <span className={styles.recDot}/> REC {fmtTimer(recordSecs)}
            </span>
          </div>
        )}

        {/* ── Bottom control bar: hint → Photo|Video → shutter ── */}
        <div className={styles.camControls}>
          <p className={styles.hudHint}>{hintText}</p>

          <div className={styles.modeToggle}>
            <button type="button"
              className={`${styles.modeBtn} ${mode === 'photo' ? styles.modeBtnOn : ''}`}
              onClick={() => setMode('photo')}
              disabled={recording}>
              Photo
            </button>
            <button type="button"
              className={`${styles.modeBtn} ${mode === 'video' ? styles.modeBtnOn : ''}`}
              onClick={() => setMode('video')}>
              Video
            </button>
          </div>

          {/* The shutter. Previously this was hidden inside the bottom nav's
              Scan tab, so there was no obvious way to capture. */}
          <button
            type="button"
            className={`${styles.shutter} ${recording ? styles.shutterRec : ''}`}
            onClick={handleShutter}
            disabled={!canShoot && !recording}
            aria-label={
              mode === 'video'
                ? (recording ? 'Stop recording' : 'Start recording')
                : 'Take photo'
            }
          >
            <span className={`${styles.shutterInner} ${
              mode === 'video'
                ? (recording ? styles.shutterSquare : styles.shutterRed)
                : ''
            }`} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function normalizeBbox(d) {
  if (d.bbox && typeof d.bbox === 'object' && !Array.isArray(d.bbox) &&
      'x' in d.bbox && 'y' in d.bbox && 'w' in d.bbox && 'h' in d.bbox) {
    const a = [d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h].map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d.bbox) && d.bbox.length === 4) {
    const a = d.bbox.map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d.box) && d.box.length === 4) {
    const [x1, y1, x2, y2] = d.box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return [x1, y1, x2 - x1, y2 - y1];
  }
  return null;
}

function colorForClass(cls) {
  const c = String(cls || '').toLowerCase();
  if (c.includes('switch'))  return '#000000';
  if (c.includes('patch'))   return '#474747';
  if (c.includes('server'))  return '#1c1c1c';
  if (c.includes('router'))  return '#1c1c1c';
  return '#c6c6c6';
}

function isSwitchOrPatchPanel(cls) {
  const c = String(cls || '').toLowerCase();
  return c.includes('switch') || c.includes('patch');
}

function boxIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// ── Analysing overlay ────────────────────────────────────────
//
// Was a spinning 3D rack under a glow, over a rotating list of pipeline stages
// ("Detecting rack boundaries…", "Mapping ports and cables…"). Two problems
// with that, both reported: the 3D object with its shadow and bloom was the
// least app-like thing on any screen, and the stage list was theatre — the
// timings came from a fixed 400ms ticker, not from the server, so it narrated
// progress it did not actually know about.
//
// What is left is what is true: a title, one line of status, and a bar. The
// percentage is the same estimate it always was, but it no longer claims to be
// reporting on five named stages.
function AnalyzingOverlay({ progress, step }) {
  return (
    <div className={styles.overlay}>
      <div className={styles.overlayInner}>
        <p className={styles.ovTitle}>Analyzing rack…</p>
        <p className={styles.ovStep}>{step}</p>
        <div className={styles.ovTrack}>
          <div className={styles.ovFill} style={{width:`${progress}%`}}/>
        </div>
        <span className={styles.ovPct}>{progress}%</span>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────
export default function ScanPage() {
  const navigate = useNavigate();
  const goBackFromScan = useSmartBack('/');
  // useTour() is null outside TourProvider (e.g. a page rendered in isolation
  // by a test), so read through optional chaining rather than destructuring.
  const tour = useTour();
  const tourActive = !!tour?.active;
  const stopTour = tour?.stopTour;
  const setTourSuspended = tour?.setSuspended;
  const uploadInputRef = useRef(null);
  // Which mode the camera was opened FROM. A photo taken while Tall rack
  // (multi) is selected has to join that set — it used to be treated as a
  // single-image scan, so the first shot was analysed on its own and there was
  // no way to capture the remaining racks.
  const [cameraReturnTab, setCameraReturnTab] = useState('upload');
  const { theme } = useTheme();
  const isLight = theme === 'light';
  // Surface tokens for the incident picker — opaque white panel in light
  // theme, dark navy in dark theme. Hover/divider use black-on-light vs
  // white-on-dark so they're visible against either page background.
  const pickerPanelBg   = isLight ? '#ffffff' : '#161616';
  const pickerTriggerBg = isLight ? '#ffffff' : 'rgba(255,255,255,0.04)';
  const pickerShadow    = isLight ? '0 8px 24px rgba(0,0,0,0.10)' : '0 12px 32px rgba(0,0,0,0.6)';
  const pickerDivider   = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)';
  const pickerHoverBg   = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)';
  const isDesktop = useIsDesktop();
  const [tab,      setTab]      = useState('upload');
  const [file,     setFile]     = useState(null);
  const [multiFiles, setMultiFiles] = useState([]);  // tall-rack mode (vertical stitch)
  const [loading,  setLoading]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [step,     setStep]     = useState('');
  const [error,    setError]    = useState(null);
  const [qualityChoice, setQualityChoice] = useState(null);  // {error, kind} — shows Retake/Proceed
  // First visit to this screen on this device: show the capture guidance once.
  // Read lazily so the storage hit happens on mount rather than every render.
  const [showFirstScan, setShowFirstScan] = useState(() => !getItem(FIRST_SCAN_KEY));
  const dismissFirstScan = useCallback(() => {
    setShowFirstScan(false);
    setItem(FIRST_SCAN_KEY, '1');
  }, []);


  // Starting a new scan clears the previous rack context, so the sidebar's
  // rack tabs (Overview / Ports / Topology / Network / Switches / Drift) stop
  // pointing at — and showing — the last scan. They reappear pointing at THIS
  // scan once it finishes and produces a rackId.
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent('rt:rack-id-changed', { detail: null })); } catch (_) {}
  }, []);

  const [tickets, setTickets] = useState([]);        // all active ServiceNow incidents
  const [ticket,  setTicket]  = useState(null);      // the one the user has selected to work on
  const [incidentMenuOpen, setIncidentMenuOpen] = useState(false);
  const incidentTriggerRef = useRef(null);
  const [incidentMenuRect, setIncidentMenuRect] = useState(null);

  // ── Rack-identity verification (ticket-mode only) ──
  // When a ticket is selected, fetch the canonical rack metadata (site/row/
  // position + expected labels) so we can tell the tech *which* physical rack
  // to photograph. On upload, the server compares the uploaded image's OCR
  // labels against this expected set; if they don't match we surface a
  // rejection modal instead of proceeding to analyze.
  const [expectedRack, setExpectedRack] = useState(null);     // payload from GET expected-rack
  const [verifying,    setVerifying]    = useState(false);
  // Step aside for the analysing overlay.
  //
  // The tour's spotlight and card sat on top of it, covering the progress bar
  // the user had just started and pointing at a result that does not exist yet.
  // Suspending rather than stopping means the walkthrough picks up on the same
  // step the moment the scan finishes — which is when its next instruction
  // actually makes sense.
  useEffect(() => {
    if (!setTourSuspended) return undefined;
    const busy = loading || verifying;
    setTourSuspended(busy);
    // Clear it on unmount too: navigating to the results page mid-scan would
    // otherwise leave the tour suspended for the rest of the session.
    return () => setTourSuspended(false);
  }, [loading, verifying, setTourSuspended]);
  const [verifyReject, setVerifyReject] = useState(null);     // 409 payload — detected / expected diff

  const STEPS = ['Preprocessing image…','Detecting rack boundaries…','Identifying components…','Mapping ports and cables…','Locating incident target…'];

  // On mount, pull the list of active tickets from servicenow_inbox via
  // our Node API. Also re-fetch whenever the user switches their active
  // ServiceNow connection — ConnectionsContext dispatches the event AFTER
  // the inbox poll completes, so by the time we hear it the cache is fresh.
  // We also surface the source instance + polled-at timestamp so the user
  // can confirm which account's data they're looking at.
  const [ticketsSource, setTicketsSource] = useState({ instance: null, polled_at: null });
  useEffect(() => {
    let cancelled = false;
    const fetchTickets = async () => {
      try {
        const res = await authFetch(apiUrl('/api/incidents/active'));
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (cancelled || !data) return;
        setTickets(data.tickets || []);
        setTicketsSource({
          instance: data.source_instance || null,
          polled_at: data.polled_at || null,
        });
      } catch { /* no ticket backend available — fall back to manual flow */ }
    };
    fetchTickets();
    const onActivated = () => fetchTickets();
    window.addEventListener('rt:connection-activated', onActivated);
    return () => {
      cancelled = true;
      window.removeEventListener('rt:connection-activated', onActivated);
    };
  }, []);

  // When a ticket is selected, fetch the rack-identity record so we can show
  // the tech the site/row/position + expected labels *before* they pick an
  // image. Server's CMDB rack file (cmdb_racks/<rack>.json) backs this.
  useEffect(() => {
    setExpectedRack(null);
    setVerifyReject(null);
    if (!ticket?.incident_number) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(apiUrl(`/api/incidents/${encodeURIComponent(ticket.incident_number)}/expected-rack`));
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.ok) setExpectedRack(data);
      } catch { /* no CMDB rack record — skip identity check, fall through */ }
    })();
    return () => { cancelled = true; };
  }, [ticket?.incident_number]);

  const analyze = async ({ override = false, verifiedSkip = false } = {}) => {
    if (!file) return;
    setError(null);
    setQualityChoice(null);
    setVerifyReject(null);

    if (!override) {
      const check = await validateMedia(file);
      if (!check.ok) {
        if (check.retryable) {
          setQualityChoice({ error: check.error, kind: check.kind || 'quality' });
        } else {
          setError(check.error);
        }
        return;
      }
    }

    // Rack-identity verification (ticket mode + CMDB rack record present).
    // Skip when the caller already passed verification once (verifiedSkip)
    // or when there's no CMDB rack record to compare against.
    const ticketActive = !!ticket && ticket.target && ticket.target.device && ticket.target.port != null;
    const shouldVerify = ticketActive && expectedRack?.rack?.rack_name && !verifiedSkip
      && !((file?.type || '').startsWith('video/'));
    let verifiedPassed = verifiedSkip;
    if (shouldVerify) {
      setVerifying(true);
      try {
        const vb = new FormData();
        vb.append('image', file);
        const vRes = await authFetch(
          apiUrl(`/api/incidents/${encodeURIComponent(ticket.incident_number)}/verify-rack`),
          { method: 'POST', body: vb },
        );
        const vData = await vRes.json().catch(() => ({}));
        setVerifying(false);
        if (vRes.status === 409 || vData.ok === false) {
          setVerifyReject(vData);
          return;
        }
        // ok:true covers both the label-match case and the soft-mode
        // no-labels-detected fallback (server falls back to our
        // synthesized pattern downstream). Either way, proceed silently.
        verifiedPassed = true;
      } catch (err) {
        setVerifying(false);
        setError(`Identity check failed: ${err.message}`);
        return;
      }
    }

    setLoading(true); setProgress(0); setStep(STEPS[0]);
    // Kick the network-switch SSH probe in parallel with the CV pipeline so
    // the Logical tab on the Available Ports page is ready by the time the
    // user gets there. Fire-and-forget — it can't fail the scan.
    let si = 0;
    const ticker = setInterval(() => {
      setProgress(p => Math.min(p + 9, 88));
      si = Math.min(si + 1, STEPS.length - 1);
      setStep(STEPS[si]);
    }, 300);
    try {
      // Detect video uploads — if the user shot/picked a video clip, route
      // to the multi-rack pipeline. The server splits the video into one
      // best-frame per detected rack, runs the existing analyze on each,
      // and returns a group with N member rackIds.
      const isVideoUpload = (file?.type || '').startsWith('video/');
      const ticketActive = !!ticket && ticket.target && ticket.target.device && ticket.target.port != null;
      // A rack video now goes through /api/analyze, whose normalizeImage
      // extracts the single best frame and analyzes it like a photo. The old
      // multi-rack path (/api/analyze-video) required a tenant — so owner
      // accounts got a 401 and video "didn't work" — and was overkill for the
      // common one-rack video. (Multi-rack pan can return as an explicit mode.)
      const useMultiRack = false;

      const body = new FormData();
      body.append(useMultiRack ? 'video' : 'image', file);
      if (override) body.append('skipQualityCheck', '1');

      // Ticket-mode: one-shot endpoint that runs analyze + auto-targets the
      // ticket's device/port + runs LLDP. Returns a bundled payload.
      const useTicketMode = ticketActive;
      if (useTicketMode) {
        body.append('incident_number', ticket.incident_number);
        // Waive the server-side identity gate when we've already verified
        // (or the user manually confirmed). The server still re-runs the
        // check otherwise and rejects with 409 on mismatch.
        if (verifiedPassed) body.append('verified', '1');
      }
      const endpoint = useMultiRack
        ? '/api/analyze-video'
        : (useTicketMode ? '/api/analyze-for-ticket' : '/api/analyze');

      // Remember this scan so it can be reclaimed if iOS suspends the app
      // mid-analysis (the request below dies, but the scan finishes on the
      // server). PendingScanResumer polls for it on resume.
      const clientJobId = newJobId();
      body.append('clientJobId', clientJobId);
      setPendingScan(clientJobId, useMultiRack ? 'video' : 'image');

      // One retry on a network-level failure. iOS surfaces a dropped upload as
      // "Load Failed", which is what testers were seeing intermittently — a
      // rack photo is several megabytes over a phone connection and a single
      // blip kills the request. Retrying is safe here: rack ids are content
      // hashes, so if the first attempt actually reached the server the retry
      // hits the cache and returns the same scan rather than making a second.
      // Give up eventually.
      //
      // This request had no timeout, so when the server stopped answering —
      // its pipeline worker times out internally at 120s, and a restarted
      // container abandons in-flight work outright — the app sat on
      // "Analyzing rack…" indefinitely. Testers reported watching it spin for
      // five minutes and longer, with no way to tell whether anything was
      // still happening. Anything past the server's own ceiling is not slow,
      // it is not coming.
      const ANALYZE_TIMEOUT_MS = 180000;   // server gives up on its worker at 120s
      const attempt = () => authFetch(apiUrl(endpoint), {
        method: 'POST', body, signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      });

      let res;
      try {
        res = await attempt();
      } catch (netErr) {
        // A timeout is not a dropped connection: the photo did reach the
        // server and retrying would just wait out the same ceiling again.
        if (netErr?.name === 'TimeoutError' || netErr?.name === 'AbortError') {
          throw new Error(
            'The scan took too long and was stopped. The photo reached the '
            + 'server, so try again in a moment - if it keeps happening, the '
            + 'rack photo may be too large or the server may be busy.');
        }
        setStep('Connection dropped - retrying…');
        await new Promise((r) => setTimeout(r, 1200));
        try {
          res = await attempt();
        } catch (retryErr) {
          if (retryErr?.name === 'TimeoutError' || retryErr?.name === 'AbortError') {
            throw new Error('The scan took too long and was stopped. Please try again.');
          }
          throw new Error(
            'Upload failed - the connection dropped while sending the photo. '
            + 'Check your signal and try again.');
        }
      }
      const data = await res.json().catch(() => ({}));
      // We got a response, so the resume path is no longer needed. (If the app
      // was backgrounded the await throws instead, landing in catch, and we
      // intentionally KEEP the marker so resume can recover the result.)
      clearPendingScan();
      if (!res.ok) {
        if (data.retryable) {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setQualityChoice({ error: data.error || 'Image quality issue.', kind: data.kind || 'quality' });
          return;
        }
        if (res.status === 409 && data.error === 'rack_mismatch') {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setVerifyReject(data);
          return;
        }
        throw new Error(data.error || 'Analysis failed. Try again.');
      }
      clearInterval(ticker);
      setProgress(100); setStep(useTicketMode ? 'Port located!' : 'Target located!');

      // Multi-rack response — { groupId, racks:[...] }. Land the user on
      // the SAME /results overview a single-rack scan would show, just
      // for the FIRST rack. RackTabs at the top lets them switch between
      // members; per-rack sub-pages (Ports / Topology / Switches / etc.)
      // work unchanged because each member rack still has its own RK-id.
      if (useMultiRack && data.groupId) {
        const racks = data.racks || [];
        try {
          racks.forEach(r => r.rackId && prefetchScan(r.rackId));
        } catch (_) {}
        const first = racks.find(r => r.rackId);
        if (!first) {
          setError('Multi-rack scan succeeded but no rack ids returned.');
          return;
        }
        // Fetch the first rack's full scan payload so /results renders
        // identically to a fresh single-rack scan (devices, units, port
        // counts, hero image — everything the overview/Ports tab needs).
        let firstResult = null;
        try {
          const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(first.rackId)}`));
          if (r.ok) firstResult = await r.json();
        } catch (_) { /* fall through to deep-link path */ }
        setTimeout(() => {
          if (firstResult) {
            navigate(`/results/${encodeURIComponent(first.rackId)}`,
              { state: { result: firstResult } });
          } else {
            // Fetch failed — let ResultsPage cold-fetch via useParams.
            navigate(`/results/${encodeURIComponent(first.rackId)}`);
          }
        }, 600);
        return;
      }

      // Kick off every per-rack prefetch the moment analyze succeeds —
      // OCR, topology, CMDB, specs, firmware, SFP. By the time the user
      // clicks through to the Switches / Topology / Ports tabs, the data
      // is already in memory and the cards render instantly instead of
      // showing a per-tab loading spinner.
      if (data.rackId) {
        try { prefetchScan(data.rackId); } catch (_) {}
      }

      setTimeout(() => navigate(data.rackId ? `/results/${data.rackId}` : '/results', {
        state: { result: data, ticketMode: useTicketMode, ticket: useTicketMode ? ticket : null }
      }), 600);
    } catch (err) {
      clearInterval(ticker); setLoading(false); setProgress(0); setError(err.message);
    }
  };

  // ── Tall-Rack (multi-image stitch) flow ──
  // Posts N images to /api/stitch, which stitches them server-side and
  // then runs the same analyze pipeline that /api/analyze does. Response
  // shape matches /api/analyze, so downstream navigation/prefetch is
  // identical — we just route through the stitch endpoint and surface
  // any "uncertain seam" warnings to the user.
  const analyzeMulti = async ({ override = false } = {}) => {
    if (!multiFiles || multiFiles.length < 2) return;
    setError(null);
    setQualityChoice(null);

    // The same check the single-image path runs, over every photo in the set.
    //
    // Multi used to skip this entirely and post straight to /api/stitch, so a
    // low-resolution photo that single-image mode accepts with a "Proceed
    // anyway" came back from the server as a stitch failure instead — the same
    // picture, accepted one way and refused the other, with no way through.
    // Checking here restores the choice AND saves uploading a set that was
    // never going to stitch.
    if (!override) {
      for (let i = 0; i < multiFiles.length; i++) {
        const check = await validateMedia(multiFiles[i]);
        if (check.ok) continue;
        // Name the photo. "Image resolution is low" over a set of eight is not
        // something a user can act on without being told which one.
        const which = `Photo ${i + 1} of ${multiFiles.length}: `;
        if (check.retryable) {
          setQualityChoice({ error: which + check.error, kind: check.kind || 'quality' });
        } else {
          setError(which + check.error);
        }
        return;
      }
    }

    setLoading(true); setProgress(0);
    const MULTI_STEPS = [
      'Preparing photos…',
      'Detecting overlaps…',
      'Stitching panorama…',
      'Identifying components…',
      'Mapping ports and cables…',
    ];
    setStep(MULTI_STEPS[0]);
    let si = 0;
    const ticker = setInterval(() => {
      setProgress(p => Math.min(p + 7, 88));
      si = Math.min(si + 1, MULTI_STEPS.length - 1);
      setStep(MULTI_STEPS[si]);
    }, 400);

    try {
      const body = new FormData();
      multiFiles.forEach((f) => body.append('images', f));
      if (override) body.append('skipQualityCheck', '1');

      const clientJobId = newJobId();
      body.append('clientJobId', clientJobId);
      setPendingScan(clientJobId, 'stitch');

      const res  = await authFetch(apiUrl('/api/stitch'), { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      clearPendingScan();
      if (!res.ok) {
        if (data.retryable) {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setQualityChoice({ error: data.error || 'Stitch quality issue.', kind: data.kind || 'stitch' });
          return;
        }
        throw new Error(data.error || 'Stitch failed. Try again.');
      }

      clearInterval(ticker);
      setProgress(100); setStep('Rack analyzed!');

      // Warn (non-blocking) if any seam was uncertain — server still
      // produced a usable panorama by butting the images flush.
      const uncertain = Array.isArray(data?.stitch?.uncertain) ? data.stitch.uncertain : [];
      if (uncertain.length > 0) {
        console.warn(`[stitch] ${uncertain.length} uncertain seam(s):`, data.stitch.seams);
      }

      if (data.rackId) {
        try { prefetchScan(data.rackId); } catch (_) {}
      }
      setTimeout(() => navigate(data.rackId ? `/results/${data.rackId}` : '/results', { state: { result: data } }), 600);
    } catch (err) {
      clearInterval(ticker); setLoading(false); setProgress(0); setError(err.message);
    }
  };

  const handleRetake = () => {
    // Single: drop the photo, since there is exactly one and it is the problem.
    // Multi: keep the set. The warning names which photo is at fault, and the
    // user needs the list in front of them to swap that one out — clearing all
    // eight would make them start the whole set again to fix one picture.
    if (tab !== 'multi') setFile(null);
    setQualityChoice(null);
    setError(null);
  };

  return (
    <div className={`page ${styles.scan}`}>
      <div className={styles.amb} aria-hidden="true">
        <svg className={styles.art} viewBox="0 0 390 780" preserveAspectRatio="xMidYMid slice">
          <defs>
            <radialGradient id="bigG" cx="0.4" cy="0.3" r="0.85">
              <stop offset="0%" stopColor="#c6c6c6"/>
              <stop offset="24%" stopColor="#474747"/>
              <stop offset="56%" stopColor="#1c1c1c"/>
              <stop offset="100%" stopColor="#000000"/>
            </radialGradient>
            <radialGradient id="pinkG" cx="0.5" cy="0.5" r="0.6">
              <stop offset="0%" stopColor="#ffffff"/>
              <stop offset="50%" stopColor="#c6c6c6"/>
              <stop offset="100%" stopColor="#c6c6c6"/>
            </radialGradient>
            <radialGradient id="pearlG" cx="0.35" cy="0.3" r="0.75">
              <stop offset="0%" stopColor="#ffffff"/>
              <stop offset="42%" stopColor="#ffffff"/>
              <stop offset="100%" stopColor="#c6c6c6"/>
            </radialGradient>
            <clipPath id="bigClip"><circle cx="300" cy="235" r="205"/></clipPath>
          </defs>
          <circle cx="18" cy="470" r="156" fill="url(#pinkG)" opacity="0.92"/>
          <circle cx="300" cy="235" r="205" fill="url(#bigG)"/>
          <ellipse cx="280" cy="78" rx="158" ry="44" fill="rgba(255,255,255,0.26)" clipPath="url(#bigClip)"/>
          <path d="M206 360 C 252 420, 252 472, 250 508" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5"/>
          <circle cx="250" cy="540" r="30" fill="url(#pearlG)"/>
          <line x1="34" y1="70" x2="34" y2="540" stroke="rgba(0,0,0,0.34)" strokeWidth="1"/>
          <circle cx="34" cy="150" r="9" fill="#000000"/>
          <circle cx="34" cy="540" r="3" fill="rgba(0,0,0,0.5)"/>
        </svg>
      </div>

      {/* Header — soft back chip + centered white pill title. Mobile only:
          on desktop/iPad the DesktopShell already draws the page header
          (the "New scan" crumb), so rendering this too gave two stacked
          headers. Hide it inside the shell. */}
      {!isDesktop && (
        <header className={styles.header}>
          {/* Was a hardcoded navigate('/'), which threw you out to the landing
              page even when you had arrived from a results view. Go back to
              wherever you came from, falling back to Home on a cold start. */}
          {/* data-tour-bypass punches a click-through hole in the tour's dim
              layer over this button, so Back stays reachable mid-walkthrough
              instead of trapping the user until they finish it. */}
          <button className="btn btn-ghost btn-icon"
            data-tour-bypass={tourActive ? 'true' : undefined}
            onClick={() => { if (tourActive) stopTour?.(); goBackFromScan(); }}
            aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className={styles.headerTitle}>Scan your Rack</span>
          <div style={{width:44}} aria-hidden="true"/>
        </header>
      )}

      <div className={`pc ${styles.scanContent} ${isDesktop ? styles.scanContentDesktop : ''}`}>
        <div className={styles.scanIntro}>
        </div>

        {/* Desktop-only eyebrow label (mobile: not rendered — isDesktop is
            false below 1024px, so the mobile layout is unchanged). */}
        {isDesktop && <div className={`${styles.eyebrow} ${styles.eyebrowCapture}`}>Capture method</div>}
        {/* Primary tabs */}
        <div className={styles.tabs}>
          {[
            { id:'upload', label:'Upload', icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> },
            { id:'camera', label:'Camera', icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> },
          ].map(t => (
            <button
              key={t.id}
              className={`${styles.tab} ${(t.id === 'upload' ? tab !== 'camera' : tab === 'camera') ? styles.tabOn : ''}`}
              onClick={() => {
                // Already on an upload mode? Then this is the Upload ACTION —
                // open the picker rather than silently resetting the form.
                if (t.id === 'upload' && tab !== 'camera') {
                  uploadInputRef.current?.click();
                  return;
                }
                // Opening the camera: remember where to put the photo.
                if (t.id === 'camera' && tab !== 'camera') setCameraReturnTab(tab);
                setTab(t.id);
                setFile(null);
                setMultiFiles([]);
                setError(null);
                setQualityChoice(null);
              }}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {tab !== 'camera' && (
          <>
            {isDesktop && <div className={`${styles.eyebrow} ${styles.eyebrowMode}`}>Mode</div>}
            <div className={styles.uploadModes}>
            {[
              { id:'upload', label:'SINGLE', icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="3" width="12" height="18" rx="1.5"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="17" x2="15" y2="17"/></svg> },
              { id:'multi', label:'MULTI', icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="17" width="18" height="5" rx="1"/></svg> },
              { id:'video', label:'VIDEO', icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4z"/></svg> },
            ].map(t => (
              <button
                key={t.id}
                type="button"
                className={`${styles.uploadModeBtn} ${tab === t.id ? styles.uploadModeOn : ''}`}
                onClick={() => {
                  setTab(t.id);
                  setFile(null);
                  setMultiFiles([]);
                  setError(null);
                  setQualityChoice(null);
                }}>
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
            </div>
          </>
        )}


        {/* Media box — also the guided tour's "add a photo" anchor. It wraps
            whichever picker is showing (upload / video / tall-rack / camera),
            so the spotlight lands on the right thing in every mode instead of
            following one particular tab's markup. */}
        <div className={styles.mediaBox} data-tour="media-drop-zone">
          {tab === 'multi'
            ? <MultiUploadZone files={multiFiles} onChange={(fs) => { setMultiFiles(fs); setError(null); setQualityChoice(null); }}/>
            : file
              ? <PreviewCard file={file} onClear={() => { setFile(null); setError(null); setQualityChoice(null); }}/>
              : tab === 'upload'
                ? <UploadZone inputRef={uploadInputRef} onFile={(f) => { setFile(f); setError(null); setQualityChoice(null); }}/>
                : tab === 'video'
                  ? <UploadZone inputRef={uploadInputRef} onFile={(f) => { setFile(f); setError(null); setQualityChoice(null); }} mode="video"/>
                  : <CameraCapture
                      onCapture={(f) => {
                        setError(null); setQualityChoice(null);
                        if (cameraReturnTab === 'multi') {
                          // Add to the set and go back to it, so the shot just
                          // taken is visible and more can be captured. Nothing
                          // is analysed until the user says so.
                          setMultiFiles((prev) => [...prev, f].slice(0, 8));
                          setTab('multi');
                          return;
                        }
                        setFile(f); setTab('upload');
                      }}
                      onCancel={() => setTab('upload')}
                    />}
        </div>

        {/* The two-rack flow lives in the sidebar / bottom nav ("Two racks").
            It used to also appear here as a card, which put the same entry in
            two places on the scan screen; removed to keep a single home for it. */}

        {/* Selected-incident description — compact single line so the user
            sees what they picked without pushing the page off-screen. */}
        {ticket && (() => {
          const raw = ticket.short_description || '';
          const headline = raw.split(/\s+[-–-]\s+/)[0].trim() || raw;
          return (
            <h2 className={styles.ticketHeadline} style={{
              margin:'0',
              fontSize:14,
              fontWeight:600,
              letterSpacing:'-0.005em',
              color:'#000000',
              lineHeight:1.3,
              textAlign:'center',
              whiteSpace:'nowrap',
              overflow:'hidden',
              textOverflow:'ellipsis',
              padding:'0 4px',
            }}>
              {headline}
            </h2>
          );
        })()}

        {/* Incident picker — custom dropdown (native <select> options ignore
            app styling, so we roll our own). Selecting an incident makes
            Analyze jump straight to that device+port. */}
        {tickets.length > 0 && (
          <div className={styles.incidentBlock} style={{margin:'8px 0 4px', position:'relative'}}>
            {/* A <span>, not a <label>: this labels a custom dropdown *button*,
                and a <label> can only be associated with a real form control.
                The button points back at it via aria-labelledby. */}
            <span id="incident-link-label" className={styles.incidentLabel} style={{
              display:'block',
              fontSize:11,
              fontWeight:600,
              letterSpacing:'0.08em',
              color:'var(--md-on-surface-variant)',
              textTransform:'uppercase',
              marginBottom:8,
              textAlign:'left',
            }}>
              Incident link (Optional)
            </span>


            {/* Trigger button — shows the selected ticket as a chip */}
            <button
              ref={incidentTriggerRef}
              type="button"
              aria-labelledby="incident-link-label"
              data-tour="incident-dropdown"
              className={styles.incidentTrigger}
              onClick={() => {
                setIncidentMenuOpen(o => {
                  const next = !o;
                  if (next && incidentTriggerRef.current) {
                    setIncidentMenuRect(incidentTriggerRef.current.getBoundingClientRect());
                  }
                  return next;
                });
              }}
              style={{
                width:'100%',
                height:44,
                padding:'0 16px',
                borderRadius:8,
                background:'var(--md-surface-container-lowest)',
                color:'var(--md-on-surface)',
                border:`1px solid ${incidentMenuOpen ? 'var(--md-primary)' : 'var(--md-outline-variant)'}`,
                fontSize:14,
                cursor:'pointer',
                display:'flex',
                alignItems:'center',
                justifyContent:'space-between',
                gap:10,
                textAlign:'left',
                transition:'border-color 0.18s',
              }}>
              <span style={{display:'flex',flexDirection:'column',gap:2,minWidth:0,flex:1}}>
                {ticket ? (
                  <>
                    <span style={{fontSize:13,fontWeight:600}}>
                      {ticket.incident_number} · {ticket.target?.device}:{ticket.cmdb?.interface_alias || `port${ticket.target?.port}`}
                    </span>
                    <span style={{fontSize:11,color:'var(--muted, #474747)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                      {ticket.priority} · {ticket.short_description}
                    </span>
                  </>
                ) : (
                  <span style={{color:'var(--muted, #474747)'}}>Manual scan (tap to link an incident)</span>
                )}
              </span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{transform: incidentMenuOpen ? 'rotate(180deg)' : 'none', transition:'transform 0.15s ease', color:'var(--muted, #474747)', flexShrink:0}}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {/* Custom dropdown menu — fully styled, no OS interference */}
            {incidentMenuOpen && (
              <>
                <div
                  onClick={() => setIncidentMenuOpen(false)}
                  style={{position:'fixed', inset:0, zIndex:240}}
                />
                <div style={{
                  position:'fixed',
                  top: incidentMenuRect ? incidentMenuRect.bottom + 4 : 0,
                  left: incidentMenuRect ? incidentMenuRect.left : 0,
                  width: incidentMenuRect ? incidentMenuRect.width : 'auto',
                  maxHeight: incidentMenuRect
                    // dvh, not vh: on mobile the URL bar collapses and 100vh
                    // overstates the visible height, pushing the last option
                    // under the bottom bar where it cannot be tapped.
                    ? `calc(100dvh - ${incidentMenuRect.bottom + 4}px - 96px - env(safe-area-inset-bottom))`
                    : '50vh',
                  zIndex:250,
                  background: pickerPanelBg,
                  border:'1px solid rgba(0,0,0,0.35)',
                  borderRadius:10,
                  boxShadow: pickerShadow,
                  overflowY:'auto',
                  WebkitOverflowScrolling:'touch',
                  overscrollBehavior:'contain',
                  padding:4,
                }}>
                  {/* Manual scan option — explicit opt-out of ticket mode */}
                  <button
                    type="button"
                    onClick={() => { setTicket(null); setIncidentMenuOpen(false); }}
                    style={{
                      display:'flex',
                      flexDirection:'column',
                      gap:3,
                      width:'100%',
                      textAlign:'left',
                      padding:'10px 12px',
                      borderRadius:8,
                      border:'none',
                      borderBottom:`1px solid ${pickerDivider}`,
                      background: !ticket ? 'rgba(0,0,0,0.12)' : 'transparent',
                      color:'var(--text, #c6c6c6)',
                      cursor:'pointer',
                      marginBottom:2,
                    }}
                    onMouseEnter={e => { if (ticket) e.currentTarget.style.background = pickerHoverBg; }}
                    onMouseLeave={e => { if (ticket) e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{display:'flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600}}>
                      {!ticket && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                      <span>Manual scan</span>
                      <span style={{color:'var(--muted, #474747)',fontWeight:400,fontSize:11}}>· no ticket</span>
                    </span>
                    <span style={{fontSize:11,color:'var(--muted, #474747)',lineHeight:1.3}}>
                      Pick device and port yourself after the rack is analyzed
                    </span>
                  </button>
                  {tickets.map(t => {
                    const sel = ticket?.incident_number === t.incident_number;
                    return (
                      <button
                        key={t.incident_number}
                        type="button"
                        onClick={() => { setTicket(t); setIncidentMenuOpen(false); }}
                        style={{
                          display:'flex',
                          flexDirection:'column',
                          gap:3,
                          width:'100%',
                          textAlign:'left',
                          padding:'10px 12px',
                          borderRadius:8,
                          border:'none',
                          background: sel ? 'rgba(0,0,0,0.15)' : 'transparent',
                          color:'var(--text, #c6c6c6)',
                          cursor:'pointer',
                        }}
                        onMouseEnter={e => { if (!sel) e.currentTarget.style.background = pickerHoverBg; }}
                        onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
                        {/* Wraps rather than running off the edge. On a phone
                            the incident id, device:port and priority do not fit
                            on one line, and without flexWrap the id itself was
                            being clipped — testers could not tell the incidents
                            apart well enough to pick one. */}
                        <span style={{display:'flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600,flexWrap:'wrap',minWidth:0}}>
                          {sel && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1c1c1c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><polyline points="20 6 9 17 4 12"/></svg>}
                          <span>{t.incident_number}</span>
                          <span style={{color:'var(--muted, #474747)',fontWeight:400}}>·</span>
                          <span style={{overflowWrap:'anywhere'}}>{t.target?.device}:{t.cmdb?.interface_alias || `port${t.target?.port}`}</span>
                          <span style={{color:'var(--muted, #474747)',fontWeight:400,fontSize:11}}>· {t.priority}</span>
                        </span>
                        <span style={{fontSize:11,color:'var(--muted, #474747)',lineHeight:1.35,whiteSpace:'normal',overflowWrap:'anywhere'}}>
                          {t.short_description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

          </div>
        )}

        {error && (
          <div className={styles.errBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}

        {qualityChoice && (
          <div className={styles.qualityChoice}>
            <div className={styles.qualityChoiceHead}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>{qualityChoice.error}</span>
            </div>
            <div className={styles.qualityChoiceActions}>
              <button className="btn btn-ghost" onClick={handleRetake}>
                {tab === 'multi' ? 'Edit photos' : 'Retake'}
              </button>
              <button className="btn btn-primary"
                onClick={() => tab === 'multi'
                  ? analyzeMulti({ override: true })
                  : analyze({ override: true })
                }>
                Proceed anyway
              </button>
            </div>
          </div>
        )}

        {/* CTA — dispatches to single-image analyze() or tall-rack analyzeMulti() */}
        {!qualityChoice && (() => {
          const isMulti  = tab === 'multi';
          const canSubmit = isMulti
            ? multiFiles.length >= 2
            : !!file;
          const ctaLabel = isMulti
            ? (multiFiles.length < 2 ? `Add ${2 - multiFiles.length} more photo` : `Stitch & Analyze (${multiFiles.length})`)
            : 'Analyze Rack';
          return (
            <>
            <button className={`btn btn-primary btn-lg btn-full ${styles.cta}`}
              data-tour="analyze-rack-btn"
              disabled={!canSubmit}
              style={{
                opacity: canSubmit ? 1 : 0.4,
                marginBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
              }}
              onClick={() => isMulti ? analyzeMulti() : analyze()}>
              {ctaLabel}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
            </button>
            {/* Desktop-only helper shown while Analyze is disabled. */}
            {isDesktop && !canSubmit && (
              <div className={styles.analyzeHelper}>
                <span className={styles.analyzeHelperDot} aria-hidden="true" />
                Add an image to enable analysis
              </div>
            )}
            </>
          );
        })()}
        {/* The tips that used to live here are now the one-time sheet at the
            top of this file — see FirstScanSheet. */}

        {/* Spacer so the last button isn't flush against the fixed bottom nav */}
        <div className={styles.scanSpacer} style={{height:'calc(env(safe-area-inset-bottom, 0px) + 72px)'}} aria-hidden="true" />
      </div>

      {/* Not while the guided tour is running: the tour drives this same screen
          and a modal over its spotlight would fight it for the user's
          attention. Someone taking the tour is being shown all of this anyway. */}
      {showFirstScan && !tourActive && !loading && <FirstScanSheet onClose={dismissFirstScan} />}

      {loading && <AnalyzingOverlay progress={progress} step={step}/>}
      {verifying && <AnalyzingOverlay progress={50} step="Verifying rack identity…"/>}

      {/* Rejection modal — fired when the uploaded image's OCR labels don't
          match the ticket's expected rack. Shows detected vs expected and
          asks the tech to upload the correct rack. The "no labels detected"
          path falls through silently (server's soft mode accepts and the
          synthesized U-prefix pattern is used downstream). */}
      {verifyReject && (
        <VerifyRejectModal
          payload={verifyReject}
          onRetake={() => { setVerifyReject(null); setFile(null); }}
          onClose={()  => setVerifyReject(null)}
        />
      )}
    </div>
  );
}

// ── Verification modals ─────────────────────────────────────────
// Both modals share the same dark/overlay style — kept inline so they're
// trivially co-located with the verification logic in this page.

function VerifyRejectModal({ payload, onRetake, onClose }) {
  const detected = Array.isArray(payload?.detected) ? payload.detected : [];
  const expected = Array.isArray(payload?.expected) ? payload.expected : [];
  const expectedUnique = [...new Set(expected)];
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalDialog} onClick={(e) => e.stopPropagation()}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:'#1c1c1c',boxShadow:'0 0 8px rgba(0,0,0,0.8)'}} />
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.10em',color:'#1c1c1c',textTransform:'uppercase'}}>
            Wrong rack
          </div>
        </div>
        <h2 style={{margin:'0 0 8px',fontSize:18,fontWeight:600,color:'var(--text, #c6c6c6)'}}>
          This isn't <b>{payload?.expected_rack_name || 'the expected rack'}</b>
        </h2>
        <p style={{margin:'0 0 16px',fontSize:13,color:'var(--muted, #474747)',lineHeight:1.5}}>
          {payload?.message || `The labels read from this image don't match the rack on the incident. Upload the correct rack photo to continue.`}
        </p>

        <div style={{display:'flex',gap:12,marginBottom:16}}>
          <div style={diffCol}>
            <div style={diffHeading}>Detected on your image</div>
            {detected.length === 0
              ? <div style={diffEmpty}>No labels read</div>
              : <div style={chipWrap}>
                  {detected.map(l => <code key={l} style={{...chip, background:'rgba(0,0,0,0.10)', color:'#474747'}}>{l}</code>)}
                </div>}
          </div>
          <div style={diffCol}>
            <div style={diffHeading}>Expected on the rack</div>
            {expectedUnique.length === 0
              ? <div style={diffEmpty}>-</div>
              : <div style={chipWrap}>
                  {expectedUnique.map(l => <code key={l} style={{...chip, background:'rgba(0,0,0,0.10)', color:'#474747'}}>{l}</code>)}
                </div>}
          </div>
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button type="button" onClick={onClose} style={btnGhost}>Dismiss</button>
          <button type="button" onClick={onRetake} style={btnPrimary}>Upload correct rack</button>
        </div>
      </div>
    </div>
  );
}

const modalBackdrop = {
  position:'fixed', inset:0, zIndex:100,
  background:'rgba(0,0,0,0.7)', backdropFilter:'blur(4px)',
  display:'flex', alignItems:'center', justifyContent:'center', padding:16,
};
const modalDialog = {
  width:'100%', maxWidth:520,
  background:'#141414', border:'1px solid rgba(255,255,255,0.08)',
  borderRadius:14, padding:'20px 22px',
  boxShadow:'0 24px 48px rgba(0,0,0,0.6)',
};
const diffCol = {
  flex:1, padding:10, borderRadius:8,
  background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)',
};
const diffHeading = {
  fontSize:10, fontWeight:700, letterSpacing:'0.08em',
  color:'var(--muted, #474747)', textTransform:'uppercase', marginBottom:6,
};
const diffEmpty = { fontSize:11, color:'var(--muted, #474747)', fontStyle:'italic' };
const chipWrap  = { display:'flex', flexWrap:'wrap', gap:4 };
const chip = {
  padding:'2px 6px', borderRadius:4, fontSize:10, fontFamily:'var(--mono, monospace)',
};
const btnPrimary = {
  padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer',
  background:'#000000', color:'#ffffff', fontSize:13, fontWeight:600,
};
const btnGhost = {
  padding:'9px 16px', borderRadius:8, cursor:'pointer',
  background:'transparent', color:'var(--text, #c6c6c6)',
  border:'1px solid rgba(255,255,255,0.15)', fontSize:13, fontWeight:600,
};
