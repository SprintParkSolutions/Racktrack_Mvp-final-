'use strict';

// Image intake: the bytes decide, not the name and not the declared type.
// The byte-signature tests below need nothing but Node. The conversion tests
// write real files with the repo's Python (Pillow + pillow-heif) and are
// skipped when the venv is not present, so the suite stays runnable on a box
// without the CV stack.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const intake = require('../lib/image_intake');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VENV_PY = path.join(PROJECT_ROOT, '.venv',
  process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
const havePython = fs.existsSync(VENV_PY);
const PY_OPTS = { pythonCmd: VENV_PY, projectRoot: PROJECT_ROOT };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-image-intake-'));

// ── Byte signatures ─────────────────────────────────────────────────────

// An ISO BMFF file: [size][ftyp][major][minor][compat...] padded out.
function ftyp(major, compat = []) {
  const brands = [major, ...compat];
  const size = 16 + 4 * compat.length;
  const buf = Buffer.alloc(64, 0);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write(brands[0], 8, 'latin1');
  brands.slice(1).forEach((b, i) => buf.write(b, 16 + 4 * i, 'latin1'));
  return buf;
}
function bytes(...parts) {
  const out = Buffer.alloc(64, 0);
  let off = 0;
  for (const p of parts) {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1');
    b.copy(out, off); off += b.length;
  }
  return out;
}

test('sniffBuffer reads the container, whatever the file is called', () => {
  assert.equal(intake.sniffBuffer(bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'Exif')), 'jpeg');
  assert.equal(intake.sniffBuffer(bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))), 'png');
  assert.equal(intake.sniffBuffer(bytes('GIF89a')), 'gif');
  assert.equal(intake.sniffBuffer(bytes('GIF87a')), 'gif');
  assert.equal(intake.sniffBuffer(bytes('RIFF', Buffer.from([0, 0, 0, 0]), 'WEBPVP8 ')), 'webp');
  assert.equal(intake.sniffBuffer(bytes('RIFF', Buffer.from([0, 0, 0, 0]), 'AVI LIST')), 'video');
  assert.equal(intake.sniffBuffer(bytes('RIFF', Buffer.from([0, 0, 0, 0]), 'WAVEfmt ')), 'unknown');
  assert.equal(intake.sniffBuffer(bytes('BM', Buffer.from([0x36, 0x10, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]))), 'bmp');
  assert.equal(intake.sniffBuffer(bytes('II*\0')), 'tiff');
  assert.equal(intake.sniffBuffer(bytes('MM\0*')), 'tiff');
  assert.equal(intake.sniffBuffer(bytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))), 'video'); // WebM
});

test('sniffBuffer tells HEIF, AVIF and MP4 apart by brand', () => {
  assert.equal(intake.sniffBuffer(ftyp('heic', ['mif1', 'heic', 'miaf'])), 'heif');   // iPhone
  assert.equal(intake.sniffBuffer(ftyp('mif1', ['heic', 'miaf'])), 'heif');           // Samsung
  assert.equal(intake.sniffBuffer(ftyp('heix', ['mif1', 'heix'])), 'heif');
  assert.equal(intake.sniffBuffer(ftyp('hevc', ['mif1', 'msf1', 'hevc'])), 'heif');    // HEIF sequence
  assert.equal(intake.sniffBuffer(ftyp('msf1', ['hevc'])), 'heif');
  assert.equal(intake.sniffBuffer(ftyp('avif', ['avif', 'mif1', 'miaf'])), 'avif');
  assert.equal(intake.sniffBuffer(ftyp('mif1', ['avif', 'miaf'])), 'avif');           // generic major, avif compat
  assert.equal(intake.sniffBuffer(ftyp('avis', ['avif', 'msf1'])), 'avif');
  assert.equal(intake.sniffBuffer(ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41'])), 'video');
  assert.equal(intake.sniffBuffer(ftyp('mp42', ['isom', 'mp42'])), 'video');
  assert.equal(intake.sniffBuffer(ftyp('qt  ', ['qt  '])), 'video');                  // iPhone .mov
  assert.equal(intake.sniffBuffer(ftyp('M4V ', ['M4V ', 'mp42', 'isom'])), 'video');
  assert.equal(intake.sniffBuffer(ftyp('3gp5', ['3gp5', 'isom'])), 'video');
  assert.equal(intake.sniffBuffer(ftyp('zzzz', ['yyyy'])), 'unknown');
  // An old QuickTime file that opens with a moov or mdat atom, no ftyp.
  assert.equal(intake.sniffBuffer(bytes(Buffer.from([0, 0, 0, 8]), 'wide', Buffer.from([0, 1, 0, 0]), 'mdat')), 'video');
  assert.equal(intake.sniffBuffer(bytes(Buffer.from([0, 0, 1, 0]), 'moov')), 'video');
});

test('sniffBuffer answers unknown for text, empty and short input', () => {
  assert.equal(intake.sniffBuffer(bytes('hello, this is a text file\n')), 'unknown');
  assert.equal(intake.sniffBuffer(bytes('%PDF-1.7\n')), 'unknown');
  assert.equal(intake.sniffBuffer(bytes('PK\x03\x04')), 'unknown');                  // zip / docx
  assert.equal(intake.sniffBuffer(Buffer.alloc(0)), 'unknown');
  assert.equal(intake.sniffBuffer(Buffer.from([0xff, 0xd8])), 'unknown');           // too short to trust
  assert.equal(intake.sniffBuffer(null), 'unknown');
});

test('sniffImage on a missing file is unknown, not an exception', () => {
  assert.deepEqual(intake.sniffImage(path.join(tmp, 'does-not-exist.jpg')), { kind: 'unknown' });
});

test('normalizedPath swaps the extension for .norm.jpg and copes with none', () => {
  assert.equal(intake.normalizedPath('/u/tmp_abc.heic'), path.join('/u', 'tmp_abc.norm.jpg'));
  assert.equal(intake.normalizedPath('/u/tmp_abc.HEIC'), path.join('/u', 'tmp_abc.norm.jpg'));
  assert.equal(intake.normalizedPath('/u/tmp_abc'), path.join('/u', 'tmp_abc.norm.jpg'));
});

test('a text file is refused with a 400 before any Python runs', async () => {
  const p = path.join(tmp, 'notes.txt');
  fs.writeFileSync(p, 'this is not a picture\n');
  await assert.rejects(
    intake.normalizeForPipeline(p, { pythonCmd: '/definitely/not/python', projectRoot: PROJECT_ROOT }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.message, 'That file is not an image we can read.');
      assert.equal(intake.isUnreadable(err), true);
      assert.equal(err.kind, 'unknown');
      return true;
    });
  assert.ok(fs.existsSync(p), 'the caller owns the original; intake does not remove it');
});

test('isUnreadable is only true for the intake rejection', () => {
  assert.equal(intake.isUnreadable(new Error('boom')), false);
  const e = new Error('x'); e.status = 400;
  assert.equal(intake.isUnreadable(e), false);
  assert.equal(intake.isUnreadable(null), false);
});

// ── Real files from Pillow ──────────────────────────────────────────────

// Writes one 64x48 red/blue picture per format into `dir` and prints, as
// JSON, which files it managed to write (HEIF/AVIF depend on pillow-heif).
const GEN = `
import json, os, sys
from PIL import Image
try:
    import pillow_heif; pillow_heif.register_heif_opener(); heif = True
except ImportError:
    heif = False
d = sys.argv[1]
im = Image.new("RGB", (64, 48), (255, 0, 0))
for x in range(32, 64):
    for y in range(48):
        im.putpixel((x, y), (0, 0, 255))
out = {}
for name, fmt in [("a.jpg","JPEG"),("a.png","PNG"),("a.gif","GIF"),("a.webp","WEBP"),
                  ("a.bmp","BMP"),("a.tif","TIFF"),("noext","JPEG"),("renamed.jpg","HEIF"),
                  ("a.heic","HEIF"),("a.avif","AVIF")]:
    if fmt in ("HEIF","AVIF") and not heif: continue
    p = os.path.join(d, name); im.save(p, format=fmt); out[name] = fmt
print(json.dumps(out))
`;

let written = {};
if (havePython) {
  const r = spawnSync(VENV_PY, ['-c', GEN, tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr}`);
  written = JSON.parse(r.stdout.trim().split('\n').pop());
}
const has = (name) => havePython && Object.prototype.hasOwnProperty.call(written, name);
const skipPy = havePython ? false : `no venv python at ${VENV_PY}`;
const skipHeif = has('a.heic') ? false : 'pillow-heif not installed in the venv';

const EXPECT_KIND = {
  'a.jpg': 'jpeg', 'a.png': 'png', 'a.gif': 'gif', 'a.webp': 'webp', 'a.bmp': 'bmp',
  'a.tif': 'tiff', 'noext': 'jpeg', 'renamed.jpg': 'heif', 'a.heic': 'heif', 'a.avif': 'avif',
};

test('sniffImage names every format Pillow wrote', { skip: skipPy }, () => {
  for (const [name, kind] of Object.entries(EXPECT_KIND)) {
    if (!has(name)) continue;
    assert.equal(intake.sniffImage(path.join(tmp, name)).kind, kind, name);
  }
});

test('jpeg and png pass through on their own path, even with no extension', { skip: skipPy }, async () => {
  for (const name of ['a.jpg', 'a.png', 'noext']) {
    const p = path.join(tmp, name);
    const r = await intake.normalizeForPipeline(p, PY_OPTS);
    assert.equal(r.path, p, name);
    assert.equal(r.converted, false);
    assert.equal(r.kind, EXPECT_KIND[name]);
    assert.equal(r.width, null);
    assert.equal(r.height, null);
  }
});

async function expectConverted(name) {
  const p = path.join(tmp, name);
  const r = await intake.normalizeForPipeline(p, PY_OPTS);
  assert.equal(r.kind, EXPECT_KIND[name], `${name} kind`);
  assert.equal(r.converted, true, `${name} converted`);
  assert.equal(r.path, intake.normalizedPath(p));
  assert.ok(r.path.endsWith('.norm.jpg'), r.path);
  const head = fs.readFileSync(r.path).subarray(0, 3);
  assert.deepEqual([...head], [0xff, 0xd8, 0xff], `${name} output is a JPEG`);
  assert.equal(r.width, 64);
  assert.equal(r.height, 48);
  assert.ok(fs.existsSync(p), `${name}: the original is left for the caller to remove`);
  return r;
}

test('gif, webp, bmp and tiff come back as a JPEG beside the original', { skip: skipPy }, async () => {
  for (const name of ['a.gif', 'a.webp', 'a.bmp', 'a.tif']) await expectConverted(name);
});

test('heic and avif come back as a JPEG', { skip: skipHeif }, async () => {
  await expectConverted('a.heic');
  await expectConverted('a.avif');
});

test('a HEIC wearing a .jpg name is still recognised and converted', { skip: skipHeif }, async () => {
  const r = await expectConverted('renamed.jpg');
  assert.equal(r.kind, 'heif');
});

test('a file that claims to be HEIF but is garbage fails as 400, leaving nothing behind', { skip: skipPy }, async () => {
  const p = path.join(tmp, 'liar.heic');
  const buf = Buffer.alloc(256, 0x5a);
  ftyp('heic', ['mif1', 'heic']).copy(buf, 0);
  fs.writeFileSync(p, buf);
  await assert.rejects(intake.normalizeForPipeline(p, PY_OPTS), (err) => {
    assert.equal(err.status, 400);
    assert.equal(intake.isUnreadable(err), true);
    assert.equal(err.kind, 'heif');
    assert.ok(typeof err.detail === 'string' && err.detail.length > 0, 'detail is kept for the log');
    return true;
  });
  assert.equal(fs.existsSync(intake.normalizedPath(p)), false, 'no half-written .norm.jpg');
});

test('a Python that cannot start is a 400 with the reason in detail', { skip: skipPy }, async () => {
  const p = path.join(tmp, 'a.webp');
  await assert.rejects(
    intake.normalizeForPipeline(p, { pythonCmd: path.join(tmp, 'no-such-python'), projectRoot: PROJECT_ROOT }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(String(err.detail), /failed to start/);
      return true;
    });
});
