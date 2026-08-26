// Browser smoke sweep — drives the built RackTrack client in a real browser
// as a signed-in owner and checks what the test suites cannot see.
//
// This exists because build, lint and 200+ unit tests once all passed while
// every icon in the product rendered as its own name ("logout", "edit", "dns")
// — a total UI break invisible to every automated gate except pixels. It walks
// each major route and fails the run on any of:
//   - a white screen or crash fallback (root empty / error boundary showing)
//   - an icon rendering as literal text (a glyph is ~square; the word "logout"
//     in the body font is several times wider than tall)
//   - horizontal overflow at 320px (the narrowest device testers use)
//   - a form input under 16px (triggers iOS focus auto-zoom)
//   - console errors or 5xx responses on any page
//
// Serve the built client (e.g. `vite preview`) and point BASE_URL at it. All
// APIs are stubbed in-browser, so it needs no server, no database and no
// network — just the static bundle.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://localhost:4173';
const CHANNEL = process.env.PW_CHANNEL || undefined; // undefined = bundled chromium (CI)

const j = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const USER = { id: 1, username: 'owner', role: 'owner', tenant_id: 2, organization: { status: 'active' } };
const SCAN = {
  ok: true, scanId: 'RK-DEMO0001', rackId: 'RK-DEMO0001', rack_id: 'RK-DEMO0001',
  timestamp: Date.now(), cached: true,
  imageUrl: '/outputs/RK-DEMO0001/original_image.jpg',
  overlayImageUrl: '/outputs/RK-DEMO0001/overlay.png',
  units_detected: [1, 2, 3, 4],
  devices: [
    { id: 1, class_name: 'switch', label: 'Core SW', unit: 1, ports: [], confidence: 0.95 },
    { id: 2, class_name: 'server', label: 'App-01', unit: 2, ports: [], confidence: 0.9 },
    { id: 3, class_name: 'patch_panel', label: 'PP-01', unit: 3, ports: [], confidence: 0.8 },
  ],
  rack: { unit_count: 42 },
};

const ROUTES = [
  ['/', 'home'], ['/login', 'login'], ['/signup', 'signup'], ['/scan', 'scan'],
  ['/history', 'history'], ['/profile', 'profile'], ['/help', 'help'],
  ['/results/RK-DEMO0001', 'results'], ['/results/RK-DEMO0001/ports', 'ports'],
  ['/results/RK-DEMO0001/topology', 'topology'], ['/org', 'org-console'],
  ['/connections', 'connections'], ['/marketplace', 'marketplace'],
];

function probe() {
  const root = document.getElementById('root');
  const icons = [...document.querySelectorAll('.material-symbols-outlined')];
  const iconsAsText = icons.map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((m) => m.h > 0 && m.text.length > 2 && m.w > m.h * 1.6);
  const smallInputs = [...document.querySelectorAll('input, select, textarea')]
    .map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((px) => px < 16).length;
  const bodyText = (document.body.innerText || '').trim();
  return {
    rootChildren: root ? root.children.length : 0,
    bootSkeletonPresent: !!document.getElementById('boot'),
    crashText: /something went wrong|couldn.t be loaded/i.test(bodyText.slice(0, 300)),
    iconsAsText, smallInputs,
  };
}

async function run() {
  const browser = await chromium.launch({ channel: CHANNEL });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('requestfailed', (r) => {
    // ERR_ABORTED is the browser cancelling its own request — a video stream
    // dropped when the sweep navigates away mid-load — not a served failure.
    const err = r.failure()?.errorText || '';
    if (err.includes('ERR_ABORTED')) return;
    failed.push(`${err} ${r.url().slice(-60)}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) failed.push(`HTTP ${r.status()} ${r.url().slice(-60)}`); });

  await page.addInitScript(() => {
    localStorage.setItem('racktrack:onboarded', '1');
    localStorage.setItem('rt_authToken', 'fake.jwt.token');
    localStorage.setItem('rt_assetToken', 'fake.asset.token');
    localStorage.setItem('rt_authUser', JSON.stringify({
      id: 1, username: 'owner', role: 'owner', tenant_id: 2, organization: { status: 'active' } }));
  });

  await page.route('**/api/**', (r) => j(r, { ok: true }));           // catch-all FIRST
  await page.route('**/api/auth/me*', (r) => j(r, { user: USER }));
  await page.route('**/api/assets/token*', (r) => j(r, { token: 'fake.asset.token', expiresIn: 43200 }));
  await page.route('**/api/scans*', (r) => j(r, { scans: [SCAN] }));
  await page.route('**/api/scan/*', (r) => j(r, SCAN));
  await page.route('**/api/scan/*/result*', (r) => j(r, SCAN));
  await page.route('**/api/topology/*', (r) => j(r, { devices: SCAN.devices, edges: [], stats: { device_count_in_rack: 3, edge_count: 0 }, rackId: 'RK-DEMO0001' }));
  await page.route('**/api/ocr/labels/*', (r) => j(r, { labels: [] }));
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAoLI9hkAAAAASUVORK5CYII=', 'base64');
  await page.route('**/outputs/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/uploads/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/support/status*', (r) => j(r, { ok: true }));
  await page.route('**/api/orgs*', (r) => j(r, { organizations: [], members: [], sites: [] }));
  await page.route('**/api/marketplace/**', (r) => j(r, { listings: [], orders: [] }));

  const problems = [];
  for (const [path, name] of ROUTES) {
    const before = { c: consoleErrors.length, f: failed.length };
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      problems.push(`${name}: navigation failed — ${e.message.slice(0, 70)}`);
      continue;
    }
    await page.waitForTimeout(700);
    const p = await page.evaluate(probe);
    if (p.rootChildren === 0) problems.push(`${name}: WHITE SCREEN (root empty)`);
    if (p.bootSkeletonPresent) problems.push(`${name}: boot skeleton never cleared`);
    if (p.crashText) problems.push(`${name}: crash/error fallback showing`);
    for (const it of p.iconsAsText) problems.push(`${name}: ICON AS TEXT "${it.text}" (${it.w}x${it.h})`);
    if (p.smallInputs) problems.push(`${name}: ${p.smallInputs} input(s) under 16px`);
    for (let w of [320]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(150);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 1) problems.push(`${name}: horizontal overflow ${over}px at ${w}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    consoleErrors.slice(before.c).forEach((e) => problems.push(`${name}: console: ${e}`));
    failed.slice(before.f).forEach((e) => problems.push(`${name}: net: ${e}`));
  }

  await browser.close();

  console.log(`\nBrowser sweep — ${ROUTES.length} routes against ${BASE}`);
  if (problems.length === 0) {
    console.log('PASS — no white screens, no icons-as-text, no overflow, no console errors.');
    process.exit(0);
  }
  console.log(`FAIL — ${problems.length} problem(s):`);
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}

run().catch((e) => { console.error('SWEEP ERROR:', e.message); process.exit(2); });
