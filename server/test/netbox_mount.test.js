/**
 * The NetBox routers are mounted, guarded, and did not disturb what was there.
 *
 * Three facts, each of which has a distinct failure mode nobody would notice
 * from the log line alone:
 *   1. /api/nb/* exists — a 401 rather than a 404. If any of the five routers
 *      failed to load, the try/catch in app.js logs a warning and the URL
 *      would 404 while the server otherwise looks healthy.
 *   2. /api/nb/* is owner-only — 401 with no token. The NetBox build shipped
 *      with no login on 41 endpoints; this is the line that says it now has one.
 *   3. v1's own /api/scans still answers as before. The NetBox build has its
 *      own /api/scans, mounted as /api/nb/scans precisely so it cannot shadow
 *      this one.
 *
 * Same harness as smoke.test.js: NODE_ENV=test, PORT=0, worker pool skipped.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

after(() => { setImmediate(() => process.exit(0)); });

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = process.env.PORT || '0';
process.env.RACKTRACK_SKIP_WORKER_POOL = '1';

const { app } = require('../app');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

const NB_ROUTES = [
  '/api/nb/scans',
  '/api/nb/netbox/health',
  '/api/nb/switches',
  '/api/nb/unmanaged',
  '/api/nb/connectors/types',
];

test('every NetBox router is mounted under /api/nb and refuses an anonymous caller', async () => {
  const { server, port } = await listen();
  try {
    for (const path of NB_ROUTES) {
      const r = await get(port, path);
      assert.equal(r.status, 401, `${path} → ${r.status} (404 would mean the router did not load)`);
    }
  } finally {
    server.close();
  }
});

test("v1's own /api/scans is untouched — still there, still guarded, not shadowed", async () => {
  const { server, port } = await listen();
  try {
    const r = await get(port, '/api/scans');
    assert.equal(r.status, 401, `/api/scans → ${r.status}`);
  } finally {
    server.close();
  }
});

test('the NetBox data directory is its own, away from auth.db, and ignored by git', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const dataDir = process.env.RT_DATA_DIR;
  assert.ok(dataDir, 'RT_DATA_DIR should have been set by the mount in app.js');
  assert.equal(path.basename(dataDir), 'netbox');
  assert.equal(path.basename(path.dirname(dataDir)), 'data');
  const ignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^server\/data\/netbox\/$/m, 'server/data/netbox/ must be gitignored');
});

test('the engine points at this repo, not at a second copy of the weights', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const engine = process.env.RT_ENGINE_DIR;
  assert.ok(engine, 'RT_ENGINE_DIR should have been set by the mount in app.js');
  assert.equal(path.resolve(engine), path.resolve(__dirname, '..', '..'));
  for (const rel of ['Models', 'pipeline', 'switch_ocr', 'config.json']) {
    assert.ok(fs.existsSync(path.join(engine, rel)), `${rel} should exist at the engine root`);
  }
});
