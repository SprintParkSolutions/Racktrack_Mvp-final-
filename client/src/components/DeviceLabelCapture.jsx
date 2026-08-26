import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import { IMAGE_ACCEPT } from '../utils/mediaAccept';

// Close-up capture for one device's model label.
//
// The rack scan reads every device from a single photo, which means each one
// gets only its slice of the frame — and a model string that was perfectly
// legible in person arrives at the OCR engine 20px tall. That is why
// "Vendor not detected" is usually a resolution problem, not a legibility
// one, and why the fix is another photo rather than a better parser.
//
// So: point the camera at the one device, fill the frame with its label, and
// the same engine reads real pixels instead of interpolated ones. Whatever
// comes back is a suggestion the user confirms — this screen never commits a
// value on its own.

const GUIDE = { x: 0.06, y: 0.30, w: 0.88, h: 0.34 };  // fractions of the frame

export default function DeviceLabelCapture({ deviceLabel, onIdentified, onManualEntry, onCancel }) {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const sampleRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef   = useRef(null);

  const [phase, setPhase]   = useState('camera');  // 'camera' | 'reading' | 'error'
  const [ready, setReady]   = useState(false);
  const [error, setError]   = useState(null);
  const [flash, setFlash]   = useState(false);
  const [steady, setSteady] = useState(true);
  const [torch, setTorch]   = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  // ── Camera ────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      setError(null);
      // Ask for more pixels than the rack scan does. Everything about this
      // screen exists to put real detail on a small piece of text, so the
      // resolution request is the feature — it degrades to whatever the
      // camera actually supports.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      // The user may have navigated away while the permission sheet was up;
      // without this the camera hardware stays live until the tab closes.
      if (!videoRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(() => {});
        setReady(true);
      };
      // Rack aisles are dark and the phone is inches from the chassis, so the
      // torch matters more here than on a whole-rack shot. Android exposes it;
      // iOS Safari does not, hence the capability check rather than a
      // permanent button.
      try {
        const track = stream.getVideoTracks()[0];
        setHasTorch(!!track?.getCapabilities?.().torch);
      } catch { /* capability probing is best-effort */ }
    } catch {
      setError('Camera unavailable. Allow camera access, or choose a photo instead.');
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setReady(false);
    setTorch(false);
  }, []);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorch(next);
    } catch { setHasTorch(false); }
  };

  // ── Blur advisory ─────────────────────────────────────────────
  // Motion blur is what kills a hand-held close-up, and unlike framing the
  // user gets no feedback on it from the viewfinder. Measure Laplacian
  // variance inside the guide box and say so. Advisory only — a blurry photo
  // that still reads is better than a shutter the user can't press.
  useEffect(() => {
    if (!ready || phase !== 'camera') return;
    const id = setInterval(() => {
      const video = videoRef.current, canvas = sampleRef.current;
      if (!video || !canvas || !video.videoWidth) return;
      const sw = 192;
      const sh = Math.max(1, Math.round(sw * video.videoHeight / video.videoWidth));
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);

      const gray = new Float32Array(sw * sh);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const x0 = Math.floor(sw * GUIDE.x), x1 = Math.floor(sw * (GUIDE.x + GUIDE.w));
      const y0 = Math.floor(sh * GUIDE.y), y1 = Math.floor(sh * (GUIDE.y + GUIDE.h));
      let sum = 0, sumSq = 0, n = 0;
      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          const i = y * sw + x;
          const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - sw] + gray[i + sw];
          sum += v; sumSq += v * v; n++;
        }
      }
      if (!n) return;
      const mean = sum / n;
      setSteady(sumSq / n - mean * mean > 90);
    }, 500);
    return () => clearInterval(id);
  }, [ready, phase]);

  // ── Read ──────────────────────────────────────────────────────
  const identify = useCallback(async (file) => {
    setPhase('reading');
    setError(null);
    try {
      const body = new FormData();
      body.append('image', file);
      const res = await authFetch(apiUrl('/api/ocr/device-label'), { method: 'POST', body });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Could not read that photo.');
      }
      // A read that found no vendor and no model stays on this screen rather
      // than handing an empty editor back: the usual cause is framing, and
      // re-shooting from here is one tap where re-opening the camera is four.
      if (!data.make && !data.model) {
        setPhase('error');
        setError(data.detections
          ? "That's readable, but no make or model in it. Move closer to the printed model number."
          : 'No text came through. Get closer, steady the phone, and try again.');
        return;
      }
      stopCamera();
      onIdentified(data);
    } catch (e) {
      setPhase('error');
      setError(e.message || 'Could not read that photo.');
    }
  }, [onIdentified, stopCamera]);

  const shoot = useCallback(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 140);
    // Full sensor frame, not the guide crop: the guide is a framing aid, and
    // cropping to it would throw away a vendor logo sitting just outside it.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) { setPhase('error'); setError('Could not capture the photo.'); return; }
      identify(new File([blob], 'device_label.jpg', { type: 'image/jpeg' }));
      // 0.95, not the usual 0.8: JPEG ringing lands on exactly the thin
      // high-contrast strokes the recognizer needs.
    }, 'image/jpeg', 0.95);
  }, [identify]);

  const onPickFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) identify(file);
  };

  const retry = () => {
    setPhase('camera');
    setError(null);
    if (!streamRef.current) startCamera();
  };

  // ── Render ────────────────────────────────────────────────────
  const guideStyle = {
    position: 'absolute',
    left:  `${GUIDE.x * 100}%`,
    top:   `${GUIDE.y * 100}%`,
    width: `${GUIDE.w * 100}%`,
    height:`${GUIDE.h * 100}%`,
    border: '2px solid rgba(255,255,255,0.9)',
    borderRadius: 10,
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
    pointerEvents: 'none',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3000,
      background: '#000000',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: 'max(12px, env(safe-area-inset-top)) 14px 12px',
        background: '#000000', color: '#ffffff',
      }}>
        <button type="button" onClick={() => { stopCamera(); onCancel?.(); }}
          style={{
            background: 'transparent', border: 0, color: '#ffffff',
            fontSize: '.86rem', fontWeight: 600, cursor: 'pointer', padding: 0,
          }}>Cancel</button>
        <div style={{ marginLeft: 'auto', textAlign: 'right', lineHeight: 1.25 }}>
          <div style={{ fontSize: '.8rem', fontWeight: 700 }}>Scan the device label</div>
          {deviceLabel && (
            <div style={{ fontSize: '.68rem', opacity: 0.7 }}>{deviceLabel}</div>
          )}
        </div>
      </div>

      {/* Viewfinder */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000000' }}>
        <video ref={videoRef} playsInline muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: phase === 'camera' ? 'block' : 'none' }} />
        {phase === 'camera' && ready && <div style={guideStyle} />}
        {flash && <div style={{ position: 'absolute', inset: 0, background: '#ffffff', opacity: 0.75 }} />}

        {phase === 'camera' && !error && (
          <div style={{
            position: 'absolute', left: 0, right: 0,
            top: `calc(${(GUIDE.y + GUIDE.h) * 100}% + 14px)`,
            textAlign: 'center', padding: '0 24px', color: '#ffffff',
          }}>
            <p style={{ margin: 0, fontSize: '.82rem', fontWeight: 600 }}>
              Fill the box with the model label
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '.72rem', opacity: 0.75 }}>
              The printed model number on the faceplate - not the whole device.
            </p>
            {ready && !steady && (
              <p style={{
                display: 'inline-block', margin: '10px 0 0',
                padding: '3px 10px', borderRadius: 20,
                background: 'rgba(255,255,255,0.16)',
                fontSize: '.7rem', fontWeight: 700,
              }}>Hold steady</p>
            )}
          </div>
        )}

        {phase === 'reading' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 10, color: '#ffffff', padding: 24, textAlign: 'center',
          }}>
            <Spinner />
            <p style={{ margin: 0, fontSize: '.86rem', fontWeight: 600 }}>Reading the label…</p>
            <p style={{ margin: 0, fontSize: '.74rem', opacity: 0.7 }}>
              This takes a few seconds.
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 14, color: '#ffffff', padding: 24, textAlign: 'center',
          }}>
            <p style={{ margin: 0, fontSize: '.86rem', fontWeight: 600 }}>{error}</p>
            {/* The floor under this whole flow: a photo that can't be read
                hands off to the keyboard, it doesn't dead-end. */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button type="button" onClick={retry} style={darkBtn(true)}>Try again</button>
              <button type="button" onClick={() => fileRef.current?.click()} style={darkBtn(false)}>
                Upload a photo
              </button>
              <button type="button" onClick={() => { stopCamera(); onManualEntry?.(); }} style={darkBtn(false)}>
                Enter it manually
              </button>
            </div>
          </div>
        )}

        {phase === 'camera' && error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 14, color: '#ffffff', padding: 24, textAlign: 'center',
          }}>
            <p style={{ margin: 0, fontSize: '.86rem', fontWeight: 600 }}>{error}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button type="button" onClick={() => fileRef.current?.click()} style={darkBtn(true)}>
                Choose a photo
              </button>
              <button type="button" onClick={() => { stopCamera(); onManualEntry?.(); }} style={darkBtn(false)}>
                Enter it manually
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 26, padding: '16px 20px max(16px, env(safe-area-inset-bottom))',
        background: '#000000',
      }}>
        {/* Upload sits beside the shutter as a peer, not a fallback. Plenty of
            label photos are already on the phone from an earlier walk of the
            aisle, and on a desktop browser this is the only way in. */}
        <button type="button" onClick={() => fileRef.current?.click()}
          disabled={phase === 'reading'}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            background: 'transparent', border: 0, color: '#ffffff',
            fontSize: '.7rem', fontWeight: 600, cursor: 'pointer',
            opacity: phase === 'reading' ? 0.4 : 0.9, padding: 0, width: 64,
          }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload
        </button>

        <button type="button" onClick={shoot}
          disabled={phase !== 'camera' || !ready}
          aria-label="Capture the device label"
          style={{
            width: 68, height: 68, borderRadius: '50%',
            background: '#ffffff',
            border: '4px solid rgba(255,255,255,0.35)',
            backgroundClip: 'padding-box',
            cursor: phase === 'camera' && ready ? 'pointer' : 'not-allowed',
            opacity: phase === 'camera' && ready ? 1 : 0.4,
          }} />

        <button type="button" onClick={toggleTorch}
          disabled={!hasTorch || phase !== 'camera'}
          aria-hidden={!hasTorch}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            background: 'transparent', border: 0, color: '#ffffff',
            fontSize: '.7rem', fontWeight: 600, cursor: hasTorch ? 'pointer' : 'default',
            opacity: hasTorch ? (torch ? 1 : 0.9) : 0, padding: 0, width: 64,
          }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill={torch ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 2h10l-1 6 3 3-7 11-7-11 3-3z" />
          </svg>
          {torch ? 'Light on' : 'Light'}
        </button>
      </div>

      {/* No `capture` attribute on purpose. With it, mobile browsers jump
          straight back to the camera and the photo library is unreachable —
          which would make this button a duplicate of the shutter instead of
          the upload path. The HEIC hints matter on iOS, where a library photo
          arrives in that format; the server re-encodes it before OCR. */}
      <input ref={fileRef} type="file"
        accept={IMAGE_ACCEPT}
        onChange={onPickFile} style={{ display: 'none' }} />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <canvas ref={sampleRef} style={{ display: 'none' }} />
    </div>
  );
}

function darkBtn(primary) {
  return primary
    ? { background: '#ffffff', color: '#1c1c1c', border: 0,
        padding: '8px 16px', borderRadius: 8, fontSize: '.8rem',
        fontWeight: 700, cursor: 'pointer' }
    : { background: 'transparent', color: '#ffffff',
        border: '1px solid rgba(255,255,255,0.4)',
        padding: '8px 14px', borderRadius: 8, fontSize: '.8rem',
        fontWeight: 600, cursor: 'pointer' };
}

function Spinner() {
  return (
    <>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '3px solid rgba(255,255,255,0.25)',
        borderTopColor: '#ffffff',
        animation: 'rtLabelSpin 0.9s linear infinite',
      }} />
      <style>{'@keyframes rtLabelSpin { to { transform: rotate(360deg); } }'}</style>
    </>
  );
}
