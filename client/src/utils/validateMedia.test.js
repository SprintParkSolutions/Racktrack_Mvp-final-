// Upload gate policy.
//
// This is the check that decides whether a technician's photo or video ever
// reaches the analyzer. Both directions cost real money: letting a blurry or
// low-resolution frame through burns a scan and returns a wrong rack, while
// rejecting something the server could actually have handled sends a
// technician back up the aisle to re-shoot for no reason. The rules below
// (HEIC, undecodable video, Infinity duration) are all cases where the server
// is known to do better than the browser, so they must stay permissive.
//
// The DOM is faked rather than driven: jsdom has no image decoder and no 2D
// canvas, so an <img>/<canvas>/<video> triple is stubbed with exactly the
// values each rule keys off.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateMedia } from './validateMedia';

const realCreateElement = document.createElement.bind(document);

// What the next `new Image()` resolves to. null makes it fail to decode.
let nextImage = null;
// What the next <video> reports once loaded. null makes it fail to decode.
let nextVideo = null;
// Pixel generator for the stub canvas, as (x, y) -> 0..255 luminance.
let nextPixels = () => 0;

function file(name, type) {
  return { name, type };
}

/** Flat grey: the Laplacian is zero everywhere, i.e. a maximally blurry frame. */
const FLAT = () => 128;
/** 1-px checkerboard: maximum high-frequency energy, i.e. a tack-sharp frame. */
const CHECKER = (x, y) => ((x + y) % 2 ? 255 : 0);

beforeEach(() => {
  nextImage = null;
  nextVideo = null;
  nextPixels = FLAT;

  window.URL.createObjectURL = vi.fn(() => 'blob:stub');
  window.URL.revokeObjectURL = vi.fn();

  class StubImage {
    set src(_v) {
      queueMicrotask(() => {
        if (!nextImage) return this.onerror?.(new Error('decode failed'));
        this.width = nextImage.width;
        this.height = nextImage.height;
        this.onload?.();
      });
    }
    get src() {
      return 'blob:stub';
    }
  }
  vi.stubGlobal('Image', StubImage);

  document.createElement = (tag, ...rest) => {
    if (tag === 'canvas') return stubCanvas();
    if (tag === 'video') return stubVideo();
    return realCreateElement(tag, ...rest);
  };
});

afterEach(() => {
  document.createElement = realCreateElement;
  vi.unstubAllGlobals();
});

function stubCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = () => ({
    drawImage: () => {},
    getImageData: (_x, _y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i += 4) {
          const v = nextPixels(x, y);
          data[i] = data[i + 1] = data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
      return { data };
    },
  });
  return canvas;
}

function stubVideo() {
  const listeners = new Map();
  const video = {
    videoWidth: 0,
    videoHeight: 0,
    duration: NaN,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    load: () => {},
    // Stand-in for the Chrome webm fix-up: seeking past the end is what makes
    // the real element replace an Infinity duration with the true one.
    settleDuration(value) {
      video.duration = value;
      listeners.get('durationchange')?.();
    },
  };
  let currentTime = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => currentTime,
    set(t) {
      currentTime = t;
      // Seeking past the end is the trigger; `settlesTo` says whether this
      // container ever reveals a real duration.
      if (t >= 1e9 && nextVideo?.settlesTo !== undefined) video.settleDuration(nextVideo.settlesTo);
    },
  });

  let src = '';
  Object.defineProperty(video, 'src', {
    get: () => src,
    set(v) {
      src = v;
      if (!v) return; // cleanupVideo() blanks src; that must not re-fire load
      queueMicrotask(() => {
        if (!nextVideo) return video.onerror?.(new Error('decode failed'));
        Object.assign(video, nextVideo);
        video.onloadeddata?.();
      });
    },
  });
  return video;
}

describe('dispatch', () => {
  test('no file is rejected', async () => {
    expect(await validateMedia(null)).toMatchObject({ ok: false });
  });

  test('anything that is neither image nor video is rejected', async () => {
    const r = await validateMedia(file('rack.pdf', 'application/pdf'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rack photo/i);
  });

  test('an audio file is rejected in those words', async () => {
    // Android's generic file chooser used to sit behind these upload buttons
    // and offered a sound recorder next to the camera. The accept lists no
    // longer let it appear, but a recording can still be picked out of the
    // file manager — and "unsupported file type" does not tell that user what
    // they actually did.
    for (const f of [file('memo.m4a', 'audio/mp4'), file('rack.mp3', 'audio/mpeg')]) {
      const r = await validateMedia(f);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/audio file/i);
    }
  });

  test('a file with no MIME type at all is deferred to the server', async () => {
    // An Android content:// pick frequently arrives with an empty `type` and a
    // name carrying no extension. That is a photograph the gallery just handed
    // us, not a bad file — the server reads the bytes and answers 400 if it
    // really isn't an image.
    const r = await validateMedia(file('image', ''));
    expect(r.ok).toBe(true);
  });

  test('HEIC/HEIF is passed straight to the server, by name or by MIME type', async () => {
    // iPhones shoot HEIC by default and no browser will decode it in JS, so
    // client-side checking it would reject the single most common upload on
    // the platform. The server normalizes and re-checks it instead.
    for (const f of [
      file('IMG_0042.HEIC', ''),
      file('IMG_0042.heif', ''),
      file('upload', 'image/heic'),
      file('upload', 'image/heif'),
    ]) {
      expect(await validateMedia(f)).toMatchObject({ ok: true });
    }
  });
});

describe('images', () => {
  test('a sharp, large-enough image passes and reports its metrics', async () => {
    nextImage = { width: 1920, height: 1080 };
    nextPixels = CHECKER;

    const r = await validateMedia(file('rack.jpg', 'image/jpeg'));
    expect(r.ok).toBe(true);
    expect(r.metrics).toMatchObject({ width: 1920, height: 1080 });
    expect(r.metrics.sharpness).toBeGreaterThan(100);
  });

  test('a short-edge under 480px is rejected as low resolution', async () => {
    // Short edge, not area: a tall 300x2000 crop of a rack is unusable even
    // though it has plenty of pixels.
    nextImage = { width: 2000, height: 300 };
    nextPixels = CHECKER;

    const r = await validateMedia(file('rack.jpg', 'image/jpeg'));
    expect(r).toMatchObject({ ok: false, kind: 'resolution', retryable: true });
    expect(r.error).toContain('2000×300');
  });

  test('exactly 480px on the short edge is accepted', async () => {
    // Pins the boundary as inclusive; an off-by-one here quietly rejects a
    // whole class of legitimate uploads.
    nextImage = { width: 480, height: 480 };
    nextPixels = CHECKER;
    expect(await validateMedia(file('rack.jpg', 'image/jpeg'))).toMatchObject({ ok: true });
  });

  test('a flat, detail-free frame is rejected as blurry', async () => {
    nextImage = { width: 1920, height: 1080 };
    nextPixels = FLAT;

    const r = await validateMedia(file('rack.jpg', 'image/jpeg'));
    expect(r).toMatchObject({ ok: false, kind: 'sharpness', retryable: true });
  });

  test('resolution is checked before sharpness', async () => {
    // Both faults at once: telling a technician "it is blurry" when the real
    // problem is that they shot from too far away sends them back to do the
    // wrong thing.
    nextImage = { width: 100, height: 100 };
    nextPixels = FLAT;
    expect(await validateMedia(file('rack.jpg', 'image/jpeg'))).toMatchObject({
      kind: 'resolution',
    });
  });

  test('an undecodable image is deferred to the server, not rejected', async () => {
    // Deliberately fail-open. A full-resolution phone photo can fail to decode
    // in the WebView under Android memory pressure, and failing closed rejected
    // perfectly good rack photos with a "take a clearer photo" error that no
    // retry could clear. The server normalizes and re-validates every upload
    // (detect-gate + quality checks), so deferring loses no coverage — the HEIC
    // and video paths already defer here for the same reason.
    nextImage = null;
    const r = await validateMedia(file('rack.jpg', 'image/jpeg'));
    expect(r.ok).toBe(true);
    expect(r.metrics.skipped).toBe('browser-decode-failed-deferred-to-server');
  });
});

describe('videos', () => {
  test('a well-formed pan passes and reports rounded duration', async () => {
    nextVideo = { videoWidth: 1920, videoHeight: 1080, duration: 12.34 };
    const r = await validateMedia(file('pan.mp4', 'video/mp4'));
    expect(r.ok).toBe(true);
    expect(r.metrics).toMatchObject({ width: 1920, height: 1080, duration: 12.3 });
  });

  test('too short and too long pans are both rejected', async () => {
    nextVideo = { videoWidth: 1920, videoHeight: 1080, duration: 0.4 };
    expect(await validateMedia(file('pan.mp4', 'video/mp4'))).toMatchObject({
      ok: false,
      kind: 'duration',
    });

    nextVideo = { videoWidth: 1920, videoHeight: 1080, duration: 300 };
    expect(await validateMedia(file('pan.mp4', 'video/mp4'))).toMatchObject({
      ok: false,
      kind: 'duration',
    });
  });

  test('a low-resolution video is rejected', async () => {
    nextVideo = { videoWidth: 320, videoHeight: 240, duration: 10 };
    expect(await validateMedia(file('pan.mp4', 'video/mp4'))).toMatchObject({
      ok: false,
      kind: 'resolution',
    });
  });

  test('an Infinity duration that never settles is deferred to the server, not rejected', async () => {
    // Chrome reports Infinity for MediaRecorder webm even after the
    // seek-to-1e9 workaround. Treating that as "too long" would reject every
    // in-app recording on Chrome. Fake timers so the 1.5s give-up wait does
    // not become 1.5s of test suite.
    vi.useFakeTimers();
    try {
      nextVideo = { videoWidth: 1920, videoHeight: 1080, duration: Infinity };
      const pending = validateMedia(file('pan.webm', 'video/webm'));
      await vi.advanceTimersByTimeAsync(2000);
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(r.metrics.duration).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a duration that only appears after the seek workaround is still enforced', async () => {
    // The workaround exists to recover the real duration; once it does, the
    // normal length rules have to apply to it.
    nextVideo = { videoWidth: 1920, videoHeight: 1080, duration: Infinity, settlesTo: 300 };
    expect(await validateMedia(file('pan.webm', 'video/webm'))).toMatchObject({
      ok: false,
      kind: 'duration',
    });
  });

  test('a video the browser cannot decode is still uploaded', async () => {
    // OpenCV on the server handles containers Chrome refuses, so a browser
    // decode failure is not evidence the file is bad.
    nextVideo = null;
    const r = await validateMedia(file('pan.mov', 'video/quicktime'));
    expect(r.ok).toBe(true);
    expect(r.metrics.skipped).toMatch(/server/);
  });

  test('a video with unknown dimensions is not rejected for resolution', async () => {
    // Some containers report 0x0 until a frame is painted; 0 is "unknown",
    // not "tiny".
    nextVideo = { videoWidth: 0, videoHeight: 0, duration: 10 };
    expect(await validateMedia(file('pan.mp4', 'video/mp4'))).toMatchObject({ ok: true });
  });
});
