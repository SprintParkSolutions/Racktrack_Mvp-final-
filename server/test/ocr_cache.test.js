'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('../lib/ocr_cache');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ocr-cache-'));
cache.init(tmp);

const imageA = path.join(tmp, 'a.jpg');
const imageB = path.join(tmp, 'b.jpg');
fs.writeFileSync(imageA, Buffer.from([0xff, 0xd8, 1, 2, 3]));
fs.writeFileSync(imageB, Buffer.from([0xff, 0xd8, 9, 9, 9]));

test('the same bytes hash the same, different bytes do not', () => {
  const a1 = cache.hashFile(imageA);
  const copy = path.join(tmp, 'a-copy.jpg');
  fs.copyFileSync(imageA, copy);
  assert.equal(a1, cache.hashFile(copy));
  assert.notEqual(a1, cache.hashFile(imageB));
});

test('a missing file hashes to null, and null never hits', () => {
  assert.equal(cache.hashFile(path.join(tmp, 'nope.jpg')), null);
  assert.equal(cache.get('labels', null), null);
});

test('what goes in comes back, for that image and that kind only', () => {
  const a = cache.hashFile(imageA);
  const b = cache.hashFile(imageB);
  cache.put('labels', a, { labels: [{ text: 'SWHOME' }] });
  assert.deepEqual(cache.get('labels', a), { labels: [{ text: 'SWHOME' }] });
  assert.equal(cache.get('labels', b), null);          // a different image
  assert.equal(cache.get('closeup_fast', a), null);    // a different question
});

test('it survives a restart — the answer is on disk, not only in memory', () => {
  const a = cache.hashFile(imageA);
  delete require.cache[require.resolve('../lib/ocr_cache')];
  const fresh = require('../lib/ocr_cache');
  fresh.init(tmp);
  assert.deepEqual(fresh.get('labels', a), { labels: [{ text: 'SWHOME' }] });
});
