'use strict';

/**
 * Image intake: decide what an upload IS from its bytes, and hand the route a
 * file the pipeline can read.
 *
 * multer's fileFilter only sees what the client SAYS the file is. A camera
 * capture says image/jpeg, an iOS gallery pick says image/heic, and an Android
 * content:// pick frequently says nothing at all. None of that is the file.
 * So the filter lets anything picture-shaped through, and this module makes
 * the real decision once the bytes are on disk:
 *
 *   sniffImage(path)             what the first bytes say the file is
 *   normalizeForPipeline(path)   the path the pipeline should read
 *
 * JPEG, PNG and video pass through on their original path, untouched. Every
 * other picture format (HEIC/HEIF, AVIF, WebP, TIFF, BMP, GIF) is converted
 * to an upright RGB JPEG by pipeline/normalize_image.py, which decodes with
 * Pillow + pillow-heif and is the same interpreter the pipeline runs on. A
 * file that is not a picture at all is refused with a 400-tagged Error.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HEAD_BYTES = 64;
const NORMALIZE_TIMEOUT_MS = 90_000;
const UNREADABLE_MSG = 'That file is not an image we can read.';

// Formats handed to the pipeline as they are. Everything else is converted.
const PASS_THROUGH = new Set(['jpeg', 'png', 'video']);

// ISO BMFF brands. HEIF and AVIF share the container with MP4/MOV, so the
// brand list is what tells a photo from a video. 'mif1'/'msf1' are the generic
// HEIF brands and also appear in AVIF compatibility lists, so AVIF is tested
// first.
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const VIDEO_BRAND_RE = /^(isom|iso[2-9]|mp4[12]|mp71|qt {2}|M4V[ PH]|3gp[4-9]|3g2a|avc1|dash|mmp4|MSNV|XAVC|f4v )$/;
// A QuickTime file does not have to start with ftyp; these are the other
// top-level atoms that can come first.
const QT_FIRST_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function _ascii(buf, start, end) {
  return buf.toString('latin1', start, end);
}

/**
 * Classify a buffer holding the first bytes of a file.
 *
 * @param {Buffer} buf  at least the first 12 bytes; 64 lets the ftyp
 *                      compatibility list be read too.
 * @returns {'jpeg'|'png'|'gif'|'webp'|'bmp'|'tiff'|'heif'|'avif'|'video'|'unknown'}
 */
function sniffBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'unknown';

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && _ascii(buf, 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a
      && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (_ascii(buf, 0, 4) === 'GIF8') return 'gif';
  if (_ascii(buf, 0, 4) === 'RIFF') {
    const form = _ascii(buf, 8, 12);
    if (form === 'WEBP') return 'webp';
    if (form === 'AVI ') return 'video';
    return 'unknown';
  }
  const tiff = _ascii(buf, 0, 4);
  if (tiff === 'II*\0' || tiff === 'MM\0*') return 'tiff';
  // BMP's signature is only two letters, so also require the two reserved
  // 16-bit fields (bytes 6..9) to be zero, which every real writer leaves.
  if (_ascii(buf, 0, 2) === 'BM' && buf[6] === 0 && buf[7] === 0 && buf[8] === 0 && buf[9] === 0) return 'bmp';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video'; // WebM / Matroska

  const atom = _ascii(buf, 4, 8);
  if (atom === 'ftyp') {
    const boxLen = Math.min(buf.readUInt32BE(0) || buf.length, buf.length);
    const brands = [_ascii(buf, 8, 12)];
    for (let off = 16; off + 4 <= boxLen; off += 4) brands.push(_ascii(buf, off, off + 4));
    if (brands.some(b => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some(b => HEIF_BRANDS.has(b))) return 'heif';
    if (brands.some(b => VIDEO_BRAND_RE.test(b))) return 'video';
    return 'unknown';
  }
  if (QT_FIRST_ATOMS.has(atom)) return 'video';

  return 'unknown';
}

/**
 * Read the first bytes of a file and classify it. Synchronous: it reads 64
 * bytes, which is cheaper than the promise machinery around it.
 *
 * @param {string} filePath
 * @returns {{kind: string}}  kind is 'unknown' for an unreadable or absent file.
 */
function sniffImage(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return { kind: sniffBuffer(buf.subarray(0, n)) };
  } catch {
    return { kind: 'unknown' };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function _unreadable(kind, detail) {
  const err = new Error(UNREADABLE_MSG);
  err.status = 400;
  err.intake = true;
  err.kind = kind;
  err.detail = detail || null;
  return err;
}

/**
 * True for the Error normalizeForPipeline throws when the upload is not a
 * picture we can read. Routes use it to answer 400 with the plain message
 * instead of 500 with a generic one.
 */
function isUnreadable(err) {
  return !!(err && err.intake === true && err.status === 400);
}

function _defaultPython() {
  return process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
}

/** `<dir>/tmp_<uuid>.heic` -> `<dir>/tmp_<uuid>.norm.jpg` (an extension-less name just gains `.norm.jpg`). */
function normalizedPath(tmpPath) {
  const dir = path.dirname(tmpPath);
  const base = path.basename(tmpPath);
  const stem = base.replace(/\.[^.]+$/, '');
  return path.join(dir, `${stem}.norm.jpg`);
}

/**
 * Run pipeline/normalize_image.py and return its JSON result.
 * Resolves (never rejects) with {ok:false, error} on any failure, so the
 * caller has one shape to look at.
 */
function runNormalizer(src, dst, { pythonCmd, projectRoot, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonCmd, ['-u', '-m', 'pipeline.normalize_image', src, dst], {
        cwd: projectRoot,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: `normalizer failed to start: ${e.message}` });
    }

    let stdout = '', stderr = '', settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, error: `normalizer timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', e => finish({ ok: false, error: `normalizer failed to start: ${e.message}` }));
    child.on('close', (code) => {
      // The module prints exactly one JSON line; take the last non-empty line
      // in case a library wrote a warning to stdout first.
      const lines = stdout.split(/\r?\n/).filter(l => l.trim());
      const last = lines[lines.length - 1];
      if (last) {
        try {
          const parsed = JSON.parse(last);
          if (parsed && typeof parsed === 'object') return finish(parsed);
        } catch { /* fall through to the exit-code answer */ }
      }
      finish({ ok: false, error: `normalizer exited ${code}: ${stderr.trim().slice(-400) || 'no output'}` });
    });
  });
}

/**
 * Give the route a path the pipeline can read.
 *
 * @param {string} tmpPath  the file multer wrote
 * @param {object} [opts]
 * @param {string} [opts.pythonCmd]    interpreter the pipeline runs on
 * @param {string} [opts.projectRoot]  repo root, so `-m pipeline.normalize_image` resolves
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{path: string, kind: string, converted: boolean, width: number|null, height: number|null}>}
 *   `path` is `tmpPath` itself for jpeg/png/video (converted false, no size
 *   read), or a sibling `<stem>.norm.jpg` for every other picture format
 *   (converted true, size of the written JPEG). The original file is left
 *   in place either way; the caller removes what it no longer needs.
 * @throws {Error} with `.status = 400`, `.intake = true`, `.kind` and `.detail`
 *   when the bytes are not a picture we can read or the conversion failed.
 */
async function normalizeForPipeline(tmpPath, opts = {}) {
  const pythonCmd = opts.pythonCmd || _defaultPython();
  const projectRoot = opts.projectRoot || path.resolve(__dirname, '..', '..');
  const timeoutMs = opts.timeoutMs || NORMALIZE_TIMEOUT_MS;

  const { kind } = sniffImage(tmpPath);
  if (kind === 'unknown') throw _unreadable(kind, 'no known image or video signature');
  if (PASS_THROUGH.has(kind)) {
    return { path: tmpPath, kind, converted: false, width: null, height: null };
  }

  const dst = normalizedPath(tmpPath);
  const result = await runNormalizer(tmpPath, dst, { pythonCmd, projectRoot, timeoutMs });
  if (!result.ok) {
    try { fs.unlinkSync(dst); } catch { /* nothing was written */ }
    throw _unreadable(kind, result.error || 'conversion failed');
  }
  return {
    path: dst,
    kind,
    converted: true,
    width: Number.isFinite(result.width) ? result.width : null,
    height: Number.isFinite(result.height) ? result.height : null,
  };
}

module.exports = {
  sniffBuffer,
  sniffImage,
  normalizeForPipeline,
  normalizedPath,
  isUnreadable,
  UNREADABLE_MSG,
};
