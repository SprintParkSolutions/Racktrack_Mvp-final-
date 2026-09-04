const path     = require('path');
const fs       = require('fs');

// Load server/.env into process.env so SMTP_* (and anything else downstream
// modules read at require-time) is populated before the first require runs.
// Minimal parser: KEY=VALUE per line, # comments, no quoting or substitution.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    if (key in process.env) continue; // real env wins
    process.env[key] = s.slice(eq + 1).trim();
  }
})();

const express  = require('express');
const cors     = require('cors');
const cookieParser = require('cookie-parser');
const multer   = require('multer');
const crypto   = require('crypto');
const sharp    = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { WorkerPool, isFatalWorkerError } = require('./worker-pool');
const auth = require('./auth');
const audit = require('./audit');
const tenant = require('./lib/tenant');
const rackAccess = require('./lib/rack_access');
const rackGroups = require('./lib/rack_groups');
const { appendLineWithRotation } = require('./lib/jsonl_rotation');
const orphanGC = require('./lib/orphan_gc');
const jwt = require('jsonwebtoken');
const sshCreds = require('./lib/ssh-creds');
const scanJobs = require('./lib/scan-jobs');
const helmet = require('helmet');
const { uploadLimiter } = require('./lib/rate_limit');
// Central observability — must be required before anything that wants to
// log structured events. Provides logger + metrics + middleware + helpers.
const o11y = require('./lib/observability');
const { logger, withSpan, recordEvent } = o11y;
const portHistoryDb = require('./lib/port_history_db');
const reportInsights = require('./lib/report_insights');

// Merge stored env credentials (per vendor) into request body fields. Values
// sent explicitly by the client take precedence over the env-stored defaults.
// Why a switch request could not even be attempted, in words the person
// reading them can act on.
//
// These routes all used to answer "host, interface, and credentials (body or
// env) required" — one string for four different causes, naming the mechanism
// (body/env) instead of the fix. On a deployment with no stored credentials that
// surfaced on the live-switch page as "Probe failed: host, command, and
// credentials (body or env) required", which tells a user nothing about what to
// do and does not even reveal WHICH of the three was missing.
//
// Written for the person reading them, not for the developer who wrote the
// route: no "(body or env)", no variable names, no server paths or commands.
//
// NEVER put an operational instruction in here — no script names, no file paths,
// no CLI. An API error is read by whoever is holding the screen, it ends up in
// screenshots and support tickets, and on a public deployment it is readable by
// anyone with a login. "Run node server/encrypt-creds.js" tells an attacker the
// layout of the box and tells an ordinary user nothing they can use. Setup lives
// in the docs; this string's only job is to say what happened and what the
// person in front of it can do next.
//
// Returns null when nothing is missing.
// `interface: iface` — the callers pass the field under its request-body name.
// Destructuring plain `iface` here left it permanently undefined, so the
// needIface branch never fired and a missing port fell through to the
// credentials message instead.
function switchRequestBlocker({ host, username, password, command, interface: iface }, opts = {}) {
  if (!host) {
    return 'No switch selected yet. Add the switch’s IP address or hostname to read it live.';
  }
  if (opts.needCommand && !command) return 'Nothing to run yet — choose a check first.';
  if (opts.needIface && !iface)     return 'No port chosen yet — pick a port to look it up.';
  if (!username || !password) {
    return 'No sign-in saved for this switch. Enter a username and password to connect.';
  }
  return null;
}

// A host we are willing to spend stored credentials on: one that already has
// its own per-host entry, or a row in monitored_devices. Anything else is a
// host the caller invented.
function isKnownSwitchHost(host) {
  if (!host) return false;
  if (sshCreds.getForHost(host)) return true;
  try { return !!require('./lib/port_history_db').getDeviceByHost(host); }
  catch { return false; }
}

function resolveSwitchCreds(body) {
  // Precedence: explicit client-sent value → per-host stored → per-vendor stored.
  // Per-host lets two switches of the same vendor (e.g. .13 and .14, both
  // TP-Link) carry different passwords without one clobbering the other.
  const h = body.host ? (sshCreds.getForHost(body.host) || {}) : {};
  // Only fall back to the vendor-wide secret for a host we already know.
  //
  // This used to be unconditional, and it was a credential-exfiltration hole:
  // the vendor fallback ignored WHICH host was asked for, so any authenticated
  // caller — a member, i.e. any tester — could POST
  //   {"host":"evil.tld","vendor":"cisco-ios"}
  // with no username/password, and the server would dial evil.tld and offer our
  // real switch password to whatever was listening. The `!host || !username ||
  // !password` guards on those routes all PASSED, because the stored creds had
  // just filled the blanks in.
  //
  // Explicit client-supplied creds are still honoured for any host: that's the
  // "try these credentials against this switch" flow, and it leaks nothing we
  // didn't already receive from the caller.
  const v = isKnownSwitchHost(body.host)
    ? (sshCreds.getForVendor(body.vendor || 'cisco-ios') || {})
    : {};
  const clientEnable = body.enablePassword;
  return {
    username:       body.username || h.username || v.username || '',
    password:       body.password || h.password || v.password || '',
    enablePassword: (clientEnable != null && clientEnable !== '')
      ? clientEnable
      : (h.enablePassword || v.enablePassword || ''),
  };
}

// Best-effort: extract userId from a Bearer token if present and valid.
// Returns null when no token, an invalid token, or the auth module's secret
// path can't be read. Routes that *require* auth still use auth.requireAuth.
function softAuthUserId(req) {
  return softAuthPayload(req)?.sub || null;
}

// Resolve the JWT signing secret EXACTLY as auth.js:38 does:
//   const JWT_SECRET = process.env.JWT_SECRET || loadOrCreateSecret();
// This used to read data/jwt.secret and nothing else, which was a landmine:
// setting JWT_SECRET (the obvious thing to do in production) made auth.js sign
// with the env value while softAuthPayload verified against the file. Every
// verify would fail, softAuthPayload would return null for every request, and
// app.param('rackId') — whose `if (!auth) return next()` means "unauthenticated,
// let the route decide" — would wave EVERY request past the tenant check.
// Tenant isolation would silently vanish the day someone set an env var.
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretPath = path.join(__dirname, 'data', 'jwt.secret');
  if (!fs.existsSync(secretPath)) return null;
  return fs.readFileSync(secretPath, 'utf8').trim();
}

// Same as above but returns the whole JWT payload (so callers can also
// read tenantId for tenant-scoped reads on otherwise public routes).
function softAuthPayload(req) {
  // Reads the cookie as well as the header. Its contract is "no payload means
  // treat as anonymous", so the moment browsers stopped sending Authorization
  // every signed-in user would have silently looked anonymous on the ~25
  // endpoints that scope their reads through this — no error, just other
  // tenants' data quietly missing.
  //
  // Verification is delegated to auth.verifyAccessToken rather than done here.
  // The old local jwt.verify pinned no algorithm and asserted no issuer or
  // audience, so it accepted tokens requireAuth would have rejected; and it
  // re-read the secret from disk, returning null for every request whenever
  // JWT_SECRET came from the environment instead of the generated file.
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.cookies?.rt_access || bearer;
  return token ? auth.verifyAccessToken(token) : null;
}

// ── Report links ─────────────────────────────────────────────────────
// GET /api/scan/:rackId/report is loaded as an <iframe src>, which cannot
// carry an Authorization header — that is the only reason it was public, and
// being public it served any tenant's rack to anyone who knew (or guessed) an
// id. Instead of leaving it open, the client asks an authenticated endpoint
// for a short-lived token scoped to ONE rack and puts that in the iframe URL.
// Signed with the same secret, so no new key material and nothing to rotate.
const REPORT_TOKEN_TTL_SEC = 300;

function signReportToken(rackId) {
  const secret = jwtSecret();
  if (!secret) return null;
  return jwt.sign({ scope: 'report', rackId }, secret, { expiresIn: REPORT_TOKEN_TTL_SEC });
}

// ── Asset links ──────────────────────────────────────────────────────
// An <img> cannot send an Authorization header, so rack photographs need a
// capability that rides in the query string. This carries the caller's role
// and Site rather than a specific rack, so one token covers every image the
// user is entitled to — and it is re-checked against canAccessRack on each
// request, so it grants no more than the session it came from.
//
// Longer-lived than a report token (which is 5 minutes) because images must
// not break mid-session, but still expiring, unlike the rack id it replaces.
const ASSET_TOKEN_TTL_SEC = 12 * 60 * 60;

function signAssetToken(auth) {
  const secret = jwtSecret();
  if (!secret || !auth) return null;
  return jwt.sign({
    scope: 'asset',
    role: auth.role,
    tenantId: auth.tenantId ?? auth.tenant_id ?? null,
    organizationId: auth.organizationId ?? auth.organization_id ?? null,
  }, secret, { expiresIn: ASSET_TOKEN_TTL_SEC });
}

/** The principal an asset token stands for, or null. Scope-checked, so a
 *  session JWT cannot be used as an asset token or vice versa. */
function verifyAssetToken(token) {
  if (!token) return null;
  try {
    const secret = jwtSecret();
    if (!secret) return null;
    const p = jwt.verify(token, secret);
    return p && p.scope === 'asset' ? p : null;
  } catch { return null; }
}

// Returns true only for a live token minted for THIS rack. A general user JWT
// is deliberately rejected (scope check): a report token is a narrow capability
// and must not be interchangeable with a session token, in either direction.
function verifyReportToken(token, rackId) {
  if (!token) return false;
  try {
    const secret = jwtSecret();
    if (!secret) return false;
    const p = jwt.verify(token, secret);
    return p && p.scope === 'report' && p.rackId === rackId;
  } catch { return false; }
}

const app  = express();
const PORT = process.env.PORT || 3001;

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH  = path.join(PROJECT_ROOT, 'config.json');
const uploadsDir   = path.join(__dirname, 'uploads');
const outputsDir   = path.join(PROJECT_ROOT, 'outputs');

[uploadsDir, outputsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Windows sometimes keeps a lingering handle on files sharp just wrote,
// causing transient EPERM on unlink. Retry briefly, then give up — a
// leftover tmp file is harmless.
function safeUnlink(p) {
  if (!p || !fs.existsSync(p)) return;
  for (let i = 0; i < 5; i++) {
    try { fs.unlinkSync(p); return; }
    catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') return;
      // tight synchronous retry — usually clears within ~50ms
      const until = Date.now() + 50;
      while (Date.now() < until) {}
    }
  }
}

// ── Tenant guard for any route that takes :rackId ────────────────────
// Express's `app.param` callback fires whenever a route definition has
// `:rackId` in its path, just before the handler runs. This means EVERY
// scan/topology/ocr/share endpoint that takes a rackId is automatically
// gated by tenant ownership — no per-route wiring needed.
//
// Behavior:
//   * Authenticated request whose tenant doesn't own this rack → 404
//     (404 not 403 — don't reveal that the rack exists in another tenant)
//   * Unauthenticated request → falls through (preserves legacy
//     dev/test access; the routes themselves can require auth if they want)
// Role-aware rack access (single source of truth for owner/admin/member
// visibility). Owner → every rack; org admin → racks owned by a Site in their
// org; member → their own Site. Unauthenticated callers are left to the
// route's own logic (public report links). Returns true if access is allowed.
function canAccessRack(auth, rackId) {
  // COMPATIBILITY: shipped app builds (<= 17) call /api/select and the
  // /api/feedback/* routes with a plain fetch() that sends no Authorization
  // header, so `auth` is null for them. Failing closed here returned
  // "Rack not found" on Find Port and silently broke every feedback action for
  // everyone still on those builds.
  //
  // NOW CLOSED. The relaxation above was temporary, to keep app builds <= 17
  // working after they had already shipped. Two things make it safe to close:
  // every client call to these routes goes through authFetch, and the tunnel
  // moved to a new domain, so builds <= 20 point at a host that no longer
  // exists and cannot reach this server at all. Any client that can talk to us
  // is build 21+, and build 21 sends credentials.
  // Delegates to lib/rack_access so this, the app.param guard below, and the
  // router.param guards in cmdb_ticket_proxy.js and netdisco_proxy.js are one
  // policy rather than four copies that disagree — which is precisely what an
  // audit found them doing.
  return rackAccess.canAccessRack(auth, rackId, tenant);
}

// Fail CLOSED throughout. This used to `return next()` for a member whose
// tenantId is NULL — handing any such principal every rack on the platform —
// while canAccessRack refused the identical case. One policy, two guards, two
// answers. Both now come from lib/rack_access.
//
// The report-token escape hatch stays: it is a capability for exactly this
// rack, so it is checked before authentication rather than instead of it.
app.param('rackId', rackAccess.rackOwnershipParam({
  tenant,
  logger,
  getPrincipal: softAuthPayload,
  allow: (req, rackId) => verifyReportToken(req.query.t, rackId),
}));

// ── Observability middleware (must be installed before any routes) ───
// Order matters: requestId first (so other middleware can read req.id) →
// httpLogger (logs each request, inherits requestId) → httpMetrics
// (records duration histogram) → cors/json/static → routes.
app.use(o11y.requestId);
app.use(o11y.httpLogger);
app.use(o11y.httpMetrics);

// Security headers. CSP is left to the client's own build (the SPA ships
// separately); CORP is set to cross-origin so the web/native client can load
// scan images from /uploads and /outputs across origins. This still gives us
// HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and drops
// the x-powered-by banner.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS: allow-list from CORS_ALLOWED_ORIGINS (comma-separated). In dev, an
// empty list falls back to reflecting any origin so localhost:5173 etc. just
// work. In prod, an empty list means same-origin only (no CORS headers).
const _corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const _corsIsDev = (process.env.NODE_ENV || 'development') !== 'production';
// The Capacitor (iOS/Android) app runs from a FIXED local WebView origin and
// calls this API cross-origin, so unless these are allowed the packaged app
// gets no Access-Control-Allow-Origin and EVERY request dies as "Load failed"
// — the exact symptom testers hit at login, while the web app (same-origin) is
// unaffected. Allowing them is safe: auth is a Bearer token the client reads
// from its OWN origin's localStorage (never a cookie), and fetch never uses
// credentials:'include', so CORS carries no ambient credential a malicious
// local page could ride. iOS = capacitor://localhost, Android (default https
// scheme) = https://localhost, plus http/ionic variants for older configs.
const _nativeOrigins = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
]);
// Credentials are granted PER ORIGIN, not globally, and only to origins an
// operator listed explicitly in CORS_ALLOWED_ORIGINS.
//
// The safety argument in the comment above — that allowing http(s)://localhost
// costs nothing — holds only while no ambient credential rides along. Now that
// browser sessions are cookies, a blanket `credentials: true` would hand every
// page running on a user's own machine (any local dev server, any other app
// serving on localhost) the ability to make cookie-bearing calls to this API
// and read the replies. The native app authenticates with a Bearer token and
// needs no credentials at all, so it keeps CORS access without them.
app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  const isNative     = !!origin && _nativeOrigins.has(origin);
  const isConfigured = !!origin && _corsOrigins.includes(origin);
  const allowed = !origin || isNative || isConfigured
    || (_corsOrigins.length === 0 && _corsIsDev);
  cb(null, {
    origin: allowed ? (origin || true) : false,
    // Native counts as credentialed too.
    //
    // _nativeOrigins is a fixed, hardcoded set — the WebView origins our own
    // packaged app runs from — not something an operator or a caller can
    // widen, so this is not the blanket `credentials: true` the note above
    // warns against.
    //
    // It has to be here because the client now sends `credentials:'include'`
    // on every request, and a browser DISCARDS the response to such a request
    // unless the server answers Access-Control-Allow-Credentials: true. The
    // app was allowed through CORS, served correctly, and then had every reply
    // thrown away by its own WebView — indistinguishable from the API being
    // down, while the same server answered the web app (same-origin, and
    // configured) perfectly.
    credentials: isConfigured || isNative,
  });
}));
// Stripe signs the RAW request body, so its webhook must see the bytes exactly
// as sent. express.json() below would consume the stream first, leaving the
// route's own express.raw() a no-op and making signature verification
// impossible — the webhook could never be validated, so payments were never
// confirmed. Capturing the raw body here, ahead of the JSON parser, is the only
// place this can be done.
app.use('/api/marketplace/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
// Must precede anything that reads req.cookies — requireAuth, softAuthPayload
// and the CSRF check below all do.
app.use(cookieParser());

// CSRF: a cookie is sent by the browser automatically, so a form on someone
// else's site could trigger a state-changing call as the signed-in user. The
// Bearer path has never had this problem — an attacker cannot set a header on
// a cross-site request — so the check only engages when a request actually
// carries one of our auth cookies. That keeps the native app, curl and
// server-to-server callers (which authenticate by Bearer or app key, and have
// no ambient credential to abuse) working unchanged.
//
// SameSite=lax already blocks the classic cross-site POST; this is the second
// line, and the one that still holds if SameSite is ever loosened.
function csrfOriginCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.cookies?.rt_access && !req.cookies?.rt_refresh) return next();

  const isTrusted = (originStr) => {
    if (!originStr) return false;
    if (_corsOrigins.includes(originStr)) return true;
    if (_corsOrigins.length === 0 && _corsIsDev) return true;
    try { return new URL(originStr).host === req.headers.host; } catch { return false; }
  };

  const origin = req.headers.origin;
  if (origin) {
    return isTrusted(origin) ? next() : res.status(403).json({ error: 'Origin not allowed' });
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      if (isTrusted(new URL(referer).origin)) return next();
    } catch { /* unparseable — fall through to reject */ }
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  // A browser always sends one of the two on a mutating request. Neither
  // present, yet a session cookie attached, is not a shape a browser produces.
  return res.status(403).json({ error: 'Origin required' });
}
app.use(csrfOriginCheck);
// These are mounted before auth so that <img> tags (which cannot send an
// Authorization header) can load rack photos. That previously exposed the
// ENTIRE rack directory to anyone who knew the 8-char rack id — device maps,
// scan results, topology, CMDB ticket state, OCR output and SSH console
// transcripts were all world-readable, which defeated the report-token design.
//
// Only genuine assets are served statically now. Every data file is reachable
// only through the authenticated API, which applies tenant scoping.
// NOTE: rack images themselves are still guessable-by-rack-id; signing these
// URLs is the proper follow-up, but it needs a client change to match.
const PUBLIC_ASSET_RE = /\.(jpe?g|png|webp|gif|ico|heic|heif)$/i;
function assetsOnly(req, res, next) {
  if (PUBLIC_ASSET_RE.test(req.path)) return next();
  return res.status(404).json({ error: 'Not found' });
}

// Rack imagery is no longer readable by anyone who knows a rack id.
//
// Restricting these mounts to image extensions closed the JSON/topology/OCR/
// transcript leak, but left the photographs themselves open. That made a rack
// id a permanent, non-revocable bearer credential for that rack's photos — and
// ids travel: they sit in SPA URLs, report payloads, browser history, proxy
// logs and /api/scans responses. Report links deliberately expire after 300
// seconds, yet the images inside them needed no token at all, so anyone with a
// stale share link or a departed employee kept indefinite access. Rack photos
// show asset tags, serials, port labelling and physical topology.
//
// Three ways in, all of them checked:
//   * a report token for exactly this rack (what an <iframe> report carries)
//   * an asset token — a session-derived capability the client appends to
//     <img> URLs, because an image tag cannot send an Authorization header
//   * a normal Bearer token, for API-style fetches of the same paths
// Decide authorization on the SAME string express.static will serve.
//
// The first version of this matched the raw req.path, which is neither
// percent-decoded nor normalised, while `send` decodes and normalises before
// resolving the file. Every difference between those two strings was a bypass:
// `/outputs/rk-victim01/…` (NTFS is case-insensitive, and production is
// Windows) and `/outputs/%52K-VICTIM01/…` both missed the RK- regex, fell into
// the "not under a rack directory" branch, and were served to any signed-in
// caller. That turned "a rack id is a bearer credential" into "any login is a
// bearer credential for every rack's photos" — a worse hole than the one it
// replaced. Normalise first, then decide.
function normalizedAssetPath(p) {
  let decoded = String(p || '');
  // Decode repeatedly: a single pass leaves %252e as %2e, which the filesystem
  // layer would then decode again.
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes('\0')) return null;
  // Windows accepts backslash as a separator; posix normalize does not collapse
  // it, so fold it before normalising or `..\` walks out of the tree.
  const unified = decoded.replace(/\\/g, '/');
  const norm = path.posix.normalize(unified);
  // After normalising, a leading `..` means the path escapes the mount root.
  if (norm.startsWith('../') || norm === '..') return null;
  return norm;
}

function rackIdFromAssetPath(p) {
  const norm = normalizedAssetPath(p);
  if (norm === null) return { invalid: true, rackId: null };
  const seg = norm.split('/').filter(Boolean)[0] || '';
  // Compare case-insensitively because the filesystem does. `isValidRackId` is
  // deliberately case-SENSITIVE (ids are minted uppercase), so a lowercase
  // spelling must be treated as the same rack for authorization, not as "not a
  // rack at all".
  const canonical = seg.toUpperCase();
  return { invalid: false, rackId: rackAccess.isValidRackId(canonical) ? canonical : null };
}

function assetAuth(req, res, next) {
  const { invalid, rackId } = rackIdFromAssetPath(req.path);
  if (invalid) return res.status(404).json({ error: 'Not found' });

  // Not under a rack directory (e.g. /uploads/marketplace/...): any signed-in
  // caller may read it, but an anonymous one may not.
  if (!rackId) {
    const who = softAuthPayload(req) || verifyAssetToken(req.query.t);
    return who ? next() : res.status(404).json({ error: 'Not found' });
  }

  if (verifyReportToken(req.query.t, rackId)) return next();

  const principal = softAuthPayload(req) || verifyAssetToken(req.query.t);
  if (principal && rackAccess.canAccessRack(principal, rackId, tenant)) return next();

  return res.status(404).json({ error: 'Not found' });
}

app.use('/uploads', assetsOnly, assetAuth, express.static(uploadsDir));
app.use('/outputs', assetsOnly, assetAuth, express.static(outputsDir));

// Health + metrics — placed early so they bypass auth/static/etc and
// stay reachable even if the main app is degraded.
// The client asks for this once after sign-in and appends it to image URLs.
// Authenticated, so the token can only ever encode a session the caller
// already holds.
app.get('/api/assets/token', auth.requireAuth, (req, res) => {
  const token = signAssetToken(req.user);
  if (!token) return res.status(503).json({ error: 'Asset tokens unavailable' });
  res.json({ token, expiresIn: ASSET_TOKEN_TTL_SEC });
});

app.get('/healthz', o11y.healthHandler);
app.get('/metrics', o11y.metricsHandler);

// Which build is actually running — no auth, so you can hit
//   https://<tunnel>/api/version
// and instantly see the live commit + when the server last started. Ends the
// "did my push deploy?" guesswork.
const BUILD_COMMIT = (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') })
      .toString().trim();
  } catch { return 'unknown'; }
})();
const SERVER_STARTED_AT = new Date().toISOString();
app.get('/api/version', (req, res) => {
  res.json({ commit: BUILD_COMMIT, startedAt: SERVER_STARTED_AT });
});

// Netdisco integration — read-only proxy onto the local Netdisco docker
// stack so the UI can join scan output with live-network truth (LLDP
// neighbours, learned MACs, etc). All routes under /api/netdisco/*.
try {
  app.use(require('./netdisco_proxy'));
  logger.info({ event: 'proxy.loaded', proxy: 'netdisco' }, 'netdisco proxy loaded');
} catch (err) {
  logger.warn({ event: 'proxy.load_failed', proxy: 'netdisco', err: err.message },
    'netdisco proxy not loaded');
}

// Port-history / drift API — backed by the SSH poller. All routes under
// /api/ports/*. The poller itself is started later, inside the listen()
// callback, so the SSH runner export below is already in place.
try {
  app.use(require('./port_history'));
  logger.info({ event: 'router.loaded', router: 'port_history' }, 'port history router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'port_history', err: err.message },
    'port history router not loaded');
}

// Support assistant — grounded answers from a verified knowledge base
// (/api/support/*). Costs nothing to run: local BM25 search, with an optional
// local model. Degrades to search-only, and to 503, rather than ever guessing.
try {
  app.use(require('./support_routes'));
  logger.info({ event: 'router.loaded', router: 'support' }, 'support bot router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'support', err: err.message },
    'support bot router not loaded');
}

// Owner-only device admin for the same monitored_devices table (/api/lab/*).
// Split from port_history because it returns host/ssh_port, which the
// /api/ports views intentionally strip — see lab_devices.js for why.
try {
  app.use(require('./lab_devices'));
  logger.info({ event: 'router.loaded', router: 'lab_devices' }, 'lab devices router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'lab_devices', err: err.message },
    'lab devices router not loaded');
}

// RackTrack for NetBox — the standalone build's server, folded in as one unit
// under lib/netbox and routes/netbox, mounted under /api/nb/*. Nothing here
// touches an existing route: /api/scans is v1's, /api/nb/scans is this.
//
// OWNER-ONLY for now. The NetBox build had no login at all and its store has
// no tenant column, so until scans and switches are scoped per organisation,
// exposing it to org admins would show every tenant's switches to every
// tenant — the same reasoning that keeps /api/lab owner-only.
//
// Its libs read their environment at require time, so the paths have to be
// settled before the first one loads:
//   RT_DATA_DIR    where it keeps scans, uploads, switch credentials and its
//                  encryption key. Its own subfolder, away from auth.db.
//   RT_ENGINE_DIR  the Python CV engine. The NetBox build carried its own copy;
//                  its Models, switch_ocr, firmware_lookup and config.json are
//                  byte-identical to the ones at this repo's root, so it points
//                  here instead of duplicating 3 GB of weights.
//   RT_PYTHON      the interpreter. PYTHON_CMD is what the rest of this server
//                  already honours, so it wins; then the repo venv; then PATH.
try {
  const repoRoot = path.resolve(__dirname, '..');
  if (!process.env.RT_DATA_DIR) process.env.RT_DATA_DIR = path.join(__dirname, 'data', 'netbox');
  if (!process.env.RT_ENGINE_DIR) process.env.RT_ENGINE_DIR = repoRoot;
  if (!process.env.RT_PYTHON) {
    const venvPy = path.join(repoRoot, '.venv', 'bin', 'python');
    process.env.RT_PYTHON = process.env.PYTHON_CMD
      || (fs.existsSync(venvPy) ? venvPy : 'python3');
  }
  const nbOwner = auth.requireRole('owner');   // authenticates too — see requireRole
  app.use('/api/nb/scans',      nbOwner, require('./routes/netbox/scans'));
  app.use('/api/nb/netbox',     nbOwner, require('./routes/netbox/netbox'));
  app.use('/api/nb/switches',   nbOwner, require('./routes/netbox/switches'));
  app.use('/api/nb/unmanaged',  nbOwner, require('./routes/netbox/unmanaged'));
  app.use('/api/nb/connectors', nbOwner, require('./routes/netbox/connectors'));
  logger.info({ event: 'router.loaded', router: 'netbox', prefix: '/api/nb' },
    'NetBox routers loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'netbox', err: err.message },
    'NetBox routers not loaded');
}

// Demo tenant-mat — a prototype dataset for the /demo/topology UI.
//
// Gated like mock_routes, and for a stronger reason than "it's only demo
// data": the module header claims it "touches no real tenant data", but its
// ?source=cmdb branch spawns servicenow/demo_tenant_query.py, which reads the
// configured instance's credentials and pulls LIVE records. Unauthenticated,
// that was a customer's CMDB dataset available to anyone who could reach the
// tunnel, plus an unbounded Python-spawn amplifier.
if (process.env.ENABLE_DEMO_TOPOLOGY === '1' || process.env.NODE_ENV !== 'production') {
try {
  app.use(require('./demo_topology'));
  logger.info({ event: 'router.loaded', router: 'demo_topology' }, 'demo tenant-mat router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'demo_topology', err: err.message },
    'demo tenant-mat router not loaded');
}
} else {
  logger.info({ event: 'router.skipped', router: 'demo_topology' },
    'demo tenant-mat router disabled in production (set ENABLE_DEMO_TOPOLOGY=1 to enable)');
}

// Mock data-source routes — simulates ServiceNow, NetBox, Orion, Spectrum,
// and Generic REST APIs so the app works without real external services.
// Routes: /api/now/*, /api/dcim/*, /SolarWinds/*, /spectrum/*, /api/v1/*
// Gated: these serve fixture data with their own ad-hoc Basic auth, and were
// mounted unconditionally — publicly reachable over the tunnel in production.
// Enabled when MOCK_SERVER_URL is set (i.e. something is actually pointed at
// them) or outside production, so existing setups keep working unchanged.
if (process.env.MOCK_SERVER_URL || process.env.NODE_ENV !== 'production') {
  try {
    app.use(require('./mock_routes'));
    logger.info({ event: 'router.loaded', router: 'mock_routes' }, 'mock data-source routes loaded');
  } catch (err) {
    logger.warn({ event: 'router.load_failed', router: 'mock_routes', err: err.message },
      'mock data-source routes not loaded');
  }
} else {
  logger.info({ event: 'router.skipped', router: 'mock_routes' },
    'mock data-source routes disabled (production, MOCK_SERVER_URL unset)');
}

// CMDB-ticket integration — every CMDB write is gated behind an SR
// (sc_request) approval. Routes under /api/cmdb/ticket/*; the poller
// runs every 5 min.
let _cmdbTicketProxy = null;
try {
  _cmdbTicketProxy = require('./cmdb_ticket_proxy');
  app.use(_cmdbTicketProxy);
  if (typeof _cmdbTicketProxy.startTicketPoller === 'function') {
    _cmdbTicketProxy.startTicketPoller();
    logger.info({ event: 'poller.started', name: 'cmdb-ticket' },
      'cmdb-ticket poller started');
  }
  logger.info({ event: 'proxy.loaded', proxy: 'cmdb-ticket' }, 'cmdb-ticket proxy loaded');
} catch (err) {
  logger.warn({ event: 'proxy.load_failed', proxy: 'cmdb-ticket', err: err.message },
    'cmdb-ticket proxy not loaded');
}

// Connection profiles — per-user encrypted credentials for external data
// sources (ServiceNow, NetBox, Orion, Spectrum, generic SQL/REST). Routes
// under /api/connections/*. The active profile drives where CMDB-touching
// endpoints fetch their data from for that user's session.
try {
  app.use(require('./connection_profiles_routes'));
  logger.info({ event: 'router.loaded', router: 'connection_profiles' },
    'connection-profiles router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'connection_profiles', err: err.message },
    'connection-profiles router not loaded');
}

// Marketplace — secondary market for surplus networking/datacenter gear.
// Routes under /api/marketplace/*. Direct listings live in auth.db; partner
// redirects (eBay, Amazon, FS.com, Curvature) are URL-built on the fly.
try {
  app.use(require('./marketplace_routes'));
  logger.info({ event: 'router.loaded', router: 'marketplace' },
    'marketplace router loaded');
} catch (err) {
  logger.warn({ event: 'router.load_failed', router: 'marketplace', err: err.message },
    'marketplace router not loaded');
}

const clientDist = path.join(PROJECT_ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// ── File upload ───────────────────────────────────────────────
// The extension is taken from a whitelist match on the original name, not
// copied verbatim — otherwise an upload named `evil.jpg.bat` (filter passes
// on first match) or one with embedded path chars could land on disk with an
// attacker-controlled suffix.
// Extension for a file we are willing to store, from the NAME first and the
// declared CONTENT TYPE second.
//
// Name-only was the whole test, and a filename is not something the client
// controls. A camera capture is built here as `capture_<ts>.jpg` and always
// passed; a gallery pick is forwarded as the raw File, carrying whatever name
// the OS attached — and an Android content:// pick frequently has no extension
// at all. The same photograph was therefore accepted when taken through the
// camera and rejected as "Invalid file type" when chosen from the gallery,
// which is exactly the "sometimes works, sometimes doesn't" the testers hit.
// Falling back to the MIME type makes the decision about what the file IS.
const MIME_EXT = {
  'image/jpeg': '.jpg',  'image/jpg':  '.jpg',  'image/pjpeg': '.jpg',
  'image/png':  '.png',  'image/gif':  '.gif',  'image/webp':  '.webp',
  'image/tiff': '.tiff', 'image/avif': '.avif', 'image/bmp':   '.bmp',
  'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4':  '.mp4',  'video/quicktime': '.mov',
  'video/webm': '.webm', 'video/x-m4v': '.m4v', 'video/avi': '.avi',
};
function _safeExt(originalName, mimetype) {
  const m = String(originalName || '').match(/\.(jpe?g|jfif|png|gif|webp|tiff?|avif|bmp|heic|heif|mp4|mov|webm|m4v|avi)$/i);
  if (m) return '.' + m[1].toLowerCase();
  // `image/jpeg; charset=…` and casing both show up in the wild.
  const mt = String(mimetype || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[mt] || '';
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = _safeExt(file.originalname, file.mimetype);
    cb(null, `tmp_${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 340 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = _safeExt(file.originalname, file.mimetype) !== '';
    // Tag the rejection so the error handler answers 400 rather than 500.
    // A user picking the wrong file type is not a server fault, and every one
    // of these was polluting the uncaught-error rate that alerting watches.
    let err = null;
    if (!ok) { err = new Error('Invalid file type'); err.status = 400; }
    cb(err, ok);
  },
});

// Shared rate limiter for all upload-bound routes. Keyed by user id when
// available so multiple techs behind one NAT aren't starved by each other.
const scanLimit = uploadLimiter();
// The live viewfinder polls /api/detect every 400ms (~150/min) while the camera
// is open, but it shared the 20/min upload budget — so ~87% of frames were
// encoded, uploaded and then rejected with 429, and live detection effectively
// stopped a few seconds into every session. /api/detect is a lightweight
// detect-only call (no scan is written), so it gets its own realistic budget.
// Still bounded, so it remains a DoS guard rather than an open door.
// These four are UI-driven lookups that each fork one to three Python
// processes with a 90s timeout and no concurrency cap. They had neither auth
// nor a limiter, so an anonymous request loop could exhaust CPU and process
// slots — the rate-limit coverage had a hole exactly where per-request cost
// was highest.
//
// Burst is sized for a real rack, not a single call: the client fans these out
// per detected switch (scanPrefetch fires /specs AND /firmware for every OCR'd
// device in parallel, SwitchInformationPage re-fires per card, PortsPage adds
// /sfp/analyze), so an 8-switch rack legitimately makes ~16-24 near-simultaneous
// requests on one user's bucket. A burst of 5 threw 429s at ordinary use. 40
// covers a large rack while still capping a runaway client; env-tunable so a
// deployment with bigger racks can raise it without a code change.
const moduleLimit = uploadLimiter({
  rate:  Number(process.env.RATE_LIMIT_MODULE_RATE)  || 60,
  burst: Number(process.env.RATE_LIMIT_MODULE_BURST) || 40,
});

const detectLimit = uploadLimiter({
  rate:  Number(process.env.RATE_LIMIT_DETECT_PER_MIN) || 180,
  burst: Number(process.env.RATE_LIMIT_DETECT_BURST)   || 60,
});

// Stricter limiter for credential endpoints — throttles brute-force login /
// password-reset attempts. Keyed by the ACCOUNT (username / email in the body),
// NOT by IP: every tester reaches the server through the same Cloudflare tunnel,
// so an IP key would lump all of them into one shared bucket and lock everyone
// out. Per-account, 20 burst + 10/min is invisible to a real user but still caps
// per-account guessing. Falls back to IP when the body carries no identifier.
const authLimit = uploadLimiter({
  rate: 10, burst: 20,
  keyFn: (req) => {
    const id = String(req.body?.username || req.body?.email || '').trim().toLowerCase();
    return id ? `auth:${id}` : `authip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  },
});

// Crash reports from the client's error boundary. Deliberately unauthenticated:
// the most valuable report is the one from a screen that broke so badly the
// session could not be read, and a tester who hits a blank page cannot be asked
// to log in first. Everything is truncated and nothing is executed or echoed —
// this only ever appends to the log. Rate limited so it cannot be used to flood
// the log store.
const clientErrorLimit = uploadLimiter({ rate: 6, burst: 12 });
app.post('/api/client-error', clientErrorLimit, express.json({ limit: '32kb' }), (req, res) => {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  logger.warn({
    event: 'client.render_error',
    message:        s(req.body?.message, 300),
    path:           s(req.body?.path, 200),
    stack:          s(req.body?.stack, 2000),
    componentStack: s(req.body?.componentStack, 2000),
    userAgent:      s(req.body?.userAgent || req.get('user-agent'), 300),
  }, '[client] render error');
  res.status(204).end();
});

// ── Image normalization ───────────────────────────────────────
// Converts HEIC/HEIF to JPEG and applies EXIF rotation so downstream
// code (cv2, pipeline) always sees an upright standard JPEG.
async function normalizeImage(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const isVideo = /\.(mp4|mov|webm)$/i.test(ext);
  if (isVideo) {
    // Hand the video to the Python worker, which scores frames and writes
    // the best one to disk. From here on the rest of the pipeline treats
    // it as a normal photo upload.
    const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_frame.jpg';
    const res = await pool.request('extract_best_frame', {
      video_path: inputPath,
      output_path: outputPath,
    });
    if (!res.ok) {
      safeUnlink(inputPath);
      throw new Error(res.error || 'Could not extract a frame from the video.');
    }
    safeUnlink(inputPath);
    return outputPath;
  }

  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_norm.jpg';
  await sharp(inputPath)
    .rotate()             // auto-orient from EXIF, strips the tag
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
  safeUnlink(inputPath);
  return outputPath;
}

// ── Rack ID ───────────────────────────────────────────────────
// SHA-256 of the file contents, SCOPED TO THE OWNING ORGANISATION.
//
// Content-derived, so the same rack photo rescanned inside one organisation
// collapses onto the same id. That is deliberate: it is what lets several
// Sites (tenants) in an org co-own one RK- id and reuse a cached analysis.
//
// The scope prefix is what keeps that sharing INSIDE the org. This id keys
// both outputs/<rackId>/ and rack_owners, so hashing content alone meant two
// unrelated organisations that uploaded the same photo (a stock image, or the
// same physical rack) landed on one id: they co-owned it, each passed the
// tenant gate for the other’s rack, and the second scan overwrote the
// first’s results. 34 such ids already exist in the live database.
function rackScope(auth) {
  if (auth && auth.organizationId) return `org:${auth.organizationId}`;
  // No organisation (the platform owner’s own Site) — fall back to the tenant
  // so an id is still never shared across unrelated accounts.
  if (auth && auth.tenantId) return `tenant:${auth.tenantId}`;
  return 'global';
}

function computeRackId(filePath, scope = 'global') {
  const hash = crypto
    .createHash('sha256')
    .update(String(scope))
    .update('\0')            // delimiter: scope cannot bleed into content
    .update(fs.readFileSync(filePath))
    .digest('hex');
  return `RK-${hash.slice(0, 8).toUpperCase()}`;
}

// ── Persistent Python worker pool ─────────────────────────────
// Workers preload the YOLO models named in config.json at boot and never
// re-read it — a model swap there (e.g. models.devices_seg) takes effect only
// on the next server restart.
const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
const WORKER_COUNT = Math.max(1, parseInt(process.env.RACKTRACK_WORKERS, 10) || 1);

// ── Worker pool, and the seam for testing without one ────────────────
//
// Three ways to get a pool, in precedence order:
//
//   RACKTRACK_POOL_MODULE=<path>  load that module as the pool. This is the
//     seam: it lets a test substitute a fake pipeline entirely, so the scan
//     path can be exercised in-process with no Python, no GPU and no model
//     weights. The module must export { request, shutdown }.
//   RACKTRACK_SKIP_WORKER_POOL=1  a stub whose request() throws.
//   otherwise                     the real pool.
//
// The skip flag used to be the only option, and it is a boolean — you could
// turn the pipeline off but not replace it. That left the product's core
// workflow (upload an image, get a rack back) with zero automated coverage by
// construction rather than by oversight: any test of /api/analyze either
// shelled out to real Python and model weights or could not run at all. A
// toggle cannot be stubbed; an injection point can.
let pool;
if (process.env.RACKTRACK_POOL_MODULE) {
  const modPath = path.isAbsolute(process.env.RACKTRACK_POOL_MODULE)
    ? process.env.RACKTRACK_POOL_MODULE
    : path.resolve(PROJECT_ROOT, process.env.RACKTRACK_POOL_MODULE);
  pool = require(modPath);
  if (typeof pool?.request !== 'function') {
    throw new Error(`RACKTRACK_POOL_MODULE ${modPath} must export a request() function`);
  }
  if (typeof pool.shutdown !== 'function') pool.shutdown = () => Promise.resolve();
  logger.warn({ event: 'worker_pool.injected', module: modPath },
    'worker pool replaced by RACKTRACK_POOL_MODULE — not for production use');
} else if (process.env.RACKTRACK_SKIP_WORKER_POOL === '1') {
  logger.warn({ event: 'worker_pool.disabled' },
    'RACKTRACK_SKIP_WORKER_POOL=1 — Python worker pool disabled; AI/ML routes will 500');
  pool = {
    request: () => { throw new Error('worker pool disabled (RACKTRACK_SKIP_WORKER_POOL=1)'); },
    shutdown: () => Promise.resolve(),
  };
} else {
  pool = new WorkerPool({
    size: WORKER_COUNT,
    pythonCmd,
    pythonArgs: ['-u', '-m', 'pipeline.worker'],
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', YOLO_VERBOSE: 'False' },
  });
}

// A scan that died because the GPU fell over is neither the photographer's
// fault nor a permanent failure: the pool has already killed the poisoned
// worker, so the next attempt runs on a fresh CUDA context. Say that — instead
// of blaming the photo, or pasting a torch traceback into the owner's feed,
// which is what "CUDA error: unknown error CUDA kernel errors might be
// asynchronously reported…" did to nine consecutive rows of it.
const ENGINE_DOWN_MSG =
  'The scan engine lost its GPU and is restarting itself. Please try that photo again in a moment.';
const ENGINE_DOWN_AUDIT = 'Scan engine GPU fault — worker recycled; scan is retryable';

async function runQualityCheck(imagePath) {
  return withSpan('pipeline.quality_check', async (log) => {
    try {
      return await pool.request('quality_check', { image_path: imagePath });
    } catch (err) {
      log.warn({ err: err.message }, 'quality_check skipped');
      return { ok: true, metrics: { note: 'check-failed-skipped' } };
    }
  }, { imagePath });
}

async function runPipelineAnalyze(imagePath, outputDir, orgId = null) {
  return withSpan('pipeline.analyze', async () => {
    const payload = {
      image_path: imagePath,
      config_path: CONFIG_PATH,
      output_dir:  outputDir,
    };
    // Org scope lets device-class active learning apply this org's prior
    // corrections while devices are detected (same as cable learning).
    if (orgId != null) payload.org_id = orgId;
    const res = await pool.request('analyze', payload);
    if (!res.ok) throw new Error(res.error || 'pipeline analyze failed');
    return res;
  }, { imagePath, outputDir });
}

// Zero-LLM ticket-text extraction + reasoning chain + work-note preview.
// Runs in the warm Python worker (no model loads), so this is near-instant.
// Best-effort — never throws; on failure returns null so ticket-mode flows
// still complete with their primary payload.
async function runAgentExtraction(ticket, rackDir) {
  try {
    const cmdb = ticket?.cmdb || {};
    const text = [(ticket?.short_description || ''), (ticket?.description || '')].join(' ').trim();
    if (!text) return null;
    const res = await pool.request('extract_ticket', {
      text,
      cmdb_facts: {
        sys_class_name:  cmdb.sys_class_name  || null,
        model:           cmdb.model           || null,
        serial:          cmdb.serial          || null,
        mgmt_ip:         cmdb.mgmt_ip         || null,
        interface_alias: cmdb.interface_alias || null,
        rack_name:       cmdb.rack_name       || null,
        rack_scan_id:    cmdb.rack_scan_id    || null,
        u_position:      cmdb.u_position      || null,
      },
      last_scan_path:    path.join(rackDir, 'device_unit_map.json'),
      incident_number:   ticket?.incident_number || null,
      short_description: ticket?.short_description || null,
      priority:          ticket?.priority || null,
    });
    if (!res || res.ok === false) return null;
    return {
      extraction:        res.extraction,
      reasoning:         res.reasoning,
      work_note_preview: res.work_note_preview,
    };
  } catch (err) {
    logger.warn(`[agent] extract_ticket failed for ${ticket?.incident_number}: ${err.message}`);
    return null;
  }
}

async function runPipelineSelect(imagePath, outputDir, deviceIndex, port, portCategory, orgId, targetCount, indexOffset) {
  return withSpan('pipeline.select', async () => {
    const payload = {
      image_path:   imagePath,
      config_path:  CONFIG_PATH,
      output_dir:   outputDir,
      device_index: deviceIndex,
      port,
    };
    if (portCategory) payload.port_category = portCategory;
    if (orgId != null) payload.org_id = orgId;   // org-scoped cable learning lookup
    if (targetCount > 0) payload.target_count = targetCount;  // user-confirmed count
    // User's port-number shift, so the DRAWN index labels match the corrected
    // numbering (port the model called N is labelled N+offset on the image).
    if (indexOffset) payload.index_offset = indexOffset;
    const res = await pool.request('select', payload);
    if (!res.ok) throw new Error(res.error || 'pipeline select failed');
    return res;
  }, { imagePath, outputDir, deviceIndex, port, portCategory });
}

// The main-port count this device is PUBLISHED with — the number the port
// dropdown, the "N detected" caption and the 1-N input bound all read. Select
// must lay out exactly this many ports so "port N" means the same physical
// position on both sides of the wire.
//
// This used to return a count ONLY for devices the user had manually
// relabeled, which left every other device selecting against a fresh
// re-detection instead of the published layout. Those two numbers disagree
// whenever detection isn't perfectly repeatable against the published count —
// most often on a device whose count came from OCR + device_db, where
// runner.py --detect_only deliberately publishes the catalogue count
// (e.g. 48) after the visual pass under-counted (e.g. 30). The UI then offered
// 1-48 while the pipeline held a 30-entry list, so:
//   * port 40 fell past the end of that list and located nothing, and
//   * ports inside it were the Nth DETECTED port, not the Nth physical one.
// Low port numbers happened to line up, which is why the first lookup on a
// device looked correct and a later, higher one came back wrong or empty.
//
// Preference order is unchanged where it matters: a user relabel still wins,
// because runner.py --detect_only writes it straight into port_count.
function publishedPortCountFor(rackId, deviceIndex) {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(outputsDir, rackId, 'device_unit_map.json'), 'utf8'));
    const dev = (map.devices || [])[Number(deviceIndex) - 1];
    // port_count is the published number regardless of how it was arrived at
    // (user relabel, OCR/device_db grounding, or the visual count). Pin the
    // layout to it so the UI's bound and the pipeline's list agree.
    if (dev && Number(dev.port_count) > 0) return Number(dev.port_count);
  } catch (_) {}
  return 0;
}

// Re-detect ports for one device using a user-supplied target count.
// Updates device_unit_map.json and returns the patched device.
async function runRelabelPortCount(rackDir, deviceIndex, targetCount) {
  return await pool.request('relabel_port_count', {
    rack_dir:     rackDir,
    device_index: deviceIndex,
    target_count: targetCount,
    config_path:  CONFIG_PATH,
  });
}

// ── Helpers ───────────────────────────────────────────────────
function readMeta(rackId) {
  const p = path.join(outputsDir, rackId, 'scan_meta.json');
  if (!fs.existsSync(p)) return null;
  // A truncated/corrupt scan_meta.json (e.g. crash mid-write) must not throw —
  // callers treat null as "reconstruct or 404", not a 500.
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeMeta(rackId, meta) {
  const dir = path.join(outputsDir, rackId);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename, so a crash mid-write can't leave a
  // half-written scan_meta.json that readMeta then has to discard.
  const dest = path.join(dir, 'scan_meta.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, dest);
}

async function ensurePortCounts(rackId) {
  const rackDir = path.join(outputsDir, rackId);
  const meta = readMeta(rackId);
  if (!meta?.imagePath) return;

  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(jsonPath)) return;

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(data.devices)) return;
  if (data.devices.every(dev => typeof dev.port_count === 'number')) return;

  // meta.imagePath may be a stale absolute path from another machine — the
  // demo's outputs/ was copied off the retired Windows box, so its
  // scan_meta.json files still say D:\RACKTRACK\dark_mobile\outputs\...
  //
  // This checked that the FIELD was set, never that the FILE was there, and
  // handed the path straight to the pipeline. Every scan touching one of
  // those racks died with "Unable to open input image: D:\..." — 15 of them
  // on the demo in a single day, which testers experienced as a scan that
  // never finished. The other two readers of meta.imagePath already guard
  // this way; this one was missed.
  let imagePath = fs.existsSync(meta.imagePath) ? meta.imagePath : null;
  if (!imagePath) {
    for (const ext of ['jpg', 'jpeg', 'png']) {
      const candidate = path.join(rackDir, `original_image.${ext}`);
      if (fs.existsSync(candidate)) { imagePath = candidate; break; }
    }
  }
  // Nothing openable on this machine: leave the port counts as they are.
  // A refresh that cannot run is not a failed scan, and must not be reported
  // as one.
  if (!imagePath) {
    logger.warn({ event: 'scan.port_counts_skipped', rackId, storedPath: meta.imagePath },
      `port-count refresh skipped for ${rackId}: source image not on this machine`);
    return;
  }

  // Re-analyze scopes to the rack's org so device-class active-learning
  // corrections re-apply (and aren't clobbered) on this refresh.
  await runPipelineAnalyze(imagePath, rackDir, tenant.orgForRack(rackId));
}

// ── Heal-on-open for racks with no port data ──────────────────────────────
// A rack whose devices carry no port_count cannot be worked on: buildResponse
// maps the missing field to null, the client reads that as zero ports, and the
// results page opens with nothing to pick — no devices, no ports, and "We
// couldn't read how many ports this device has" the moment Find Port is
// pressed. Reopening a scan from Recent Scans is where testers hit this.
//
// ensurePortCounts() has always been able to rebuild it, but it was only wired
// to the three INGEST routes (analyze, stitch, analyze-video). Nothing ran it
// when an existing scan was reopened, so a rack that lost its port data stayed
// broken for good. The loss came from the select path overwriting
// device_unit_map.json (fixed in pipeline/runner.py), which is why this only
// struck *some* scans — the ones a port lookup had already been run on. Racks
// damaged before that fix still need healing, and this is what does it.
//
// A rack that was properly analysed has a numeric port_count on EVERY device,
// port-bearing or not (runner.py's --detect_only branch sets 0 for the rest),
// so an absent field is a reliable "this was never analysed, or was stripped".
function portDataMissing(rackId) {
  try {
    const jsonPath = path.join(outputsDir, rackId, 'device_unit_map.json');
    if (!fs.existsSync(jsonPath)) return false;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(data.devices) || data.devices.length === 0) return false;
    // Mirrors ensurePortCounts()'s own guard, so we never start a rebuild it
    // would immediately abandon.
    return !data.devices.every(dev => typeof dev.port_count === 'number');
  } catch (_) {
    return false;
  }
}

// Racks currently being rebuilt. Opening the same damaged scan twice (or a
// double-mount in the client) must share one pipeline run, not launch two.
const _portHealInFlight = new Map();

async function healPortDataIfMissing(rackId) {
  if (!portDataMissing(rackId)) return false;

  const pending = _portHealInFlight.get(rackId);
  if (pending) {
    await pending.catch(() => {});
    return true;
  }

  const run = (async () => {
    logger.warn({ event: 'scan.port_data_missing', rackId },
      `${rackId} has no per-device port data; rebuilding before serving the scan`);
    await ensurePortCounts(rackId);
    // scan_result.json was assembled FROM the stripped map, so it carries the
    // same portless devices. Without this the client keeps being served the
    // broken payload straight from cache and the heal looks like it did
    // nothing.
    try {
      writeCanonicalScanResult(rackId);
    } catch (err) {
      logger.error({ event: 'scan.port_data_heal_result_failed', rackId, error: err.message },
        `${rackId}: port data rebuilt but canonical result refresh failed`);
    }
    logger.info({ event: 'scan.port_data_healed', rackId, stillMissing: portDataMissing(rackId) },
      `${rackId}: port data rebuild complete`);
  })();

  _portHealInFlight.set(rackId, run);
  try {
    await run;
  } catch (err) {
    logger.error({ event: 'scan.port_data_heal_failed', rackId, error: err.message },
      `${rackId}: port data rebuild failed; serving the scan as-is`);
  } finally {
    _portHealInFlight.delete(rackId);
  }
  return true;
}

function buildResponse(rackId, cached) {
  const rackDir  = path.join(outputsDir, rackId);
  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  const data     = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const meta     = readMeta(rackId);
  // Prefer 2_devices_only.png; fall back to the combined render if it's missing.
  const imageFile = fs.existsSync(rackImagePath(rackDir, '2_devices_only.png'))
    ? rackImageUrlPath(rackDir, '2_devices_only.png')
    : rackImageUrlPath(rackDir, '3_units_and_devices.png');
  // Testing overlay: the full rack with device boxes + detected port boxes
  // drawn on it (7_rack_all_ports.png). Null if the render is missing.
  const overlayFile = fs.existsSync(rackImagePath(rackDir, '7_rack_all_ports.png'))
    ? rackImageUrlPath(rackDir, '7_rack_all_ports.png')
    : null;
  const devices = (data.devices || []).map(dev => ({
    ...dev,
    port_count: typeof dev.port_count === 'number' ? dev.port_count : null,
    ports: dev.ports || [],
    console_ports: dev.console_ports || [],
    sfp_ports: dev.sfp_ports || [],
    other_ports: dev.other_ports || [],
    connected_ports: dev.connected_ports || [],
  }));

  // The original photo, exactly as the phone sent it. The client used to
  // rebuild this path itself as `original_image.${originalExt || 'png'}`, so
  // any scan whose payload reached it without an extension asked for a .png
  // that has never existed — the file on disk is whatever the camera produced.
  // iPhones send JPEG (or HEIC), which is why testers on iOS saw the rack photo
  // as a broken image while every other part of the result loaded normally.
  //
  // Resolve the real filename here and hand the client a URL rather than the
  // ingredients to guess one. HEIC/HEIF and WEBP are in the list because the
  // upload accepts them.
  let originalExt = null;
  for (const ext of ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp']) {
    if (fs.existsSync(path.join(rackDir, `original_image.${ext}`))) {
      originalExt = ext;
      break;
    }
  }
  const originalImageUrl = originalExt
    ? `/outputs/${rackId}/original_image.${originalExt}`
    : null;

  return {
    rackId,
    scanId:          rackId,               // kept for backwards compat
    timestamp:       meta?.timestamp || new Date().toISOString(),
    cached,
    imageUrl:        `/outputs/${rackId}/${imageFile}`,
    overlayImageUrl: overlayFile ? `/outputs/${rackId}/${overlayFile}` : null,
    originalExt: originalExt || 'png',   // kept for older clients
    originalImageUrl,                     // authoritative: use this
    devices,
    units_detected:  data.units_detected || [],
    qualityWarning:    meta?.qualityWarning || null,
    qualityWarningMsg: meta?.qualityWarningMsg || null,
  };
}

// ── Report generation ─────────────────────────────────────────
// Single source of truth:
//   buildScanReportData(rackId)  → pure structured object (canonical content)
//   renderHTMLReport(data, ...)  → standalone HTML (the file saved to disk)
//   renderJSONReport(data)       → JSON string
//   renderCSVReport(data)        → CSV string (Excel-friendly)
// HTML is self-contained: CSS + images inline as base64, so the file is
// shareable as a single attachment (Slack, email, disk).
const CLASS_CODE_SRV = {
  'Switch': 'SW', 'Patch Panel': 'PP', 'Firewall': 'FW', 'Router': 'RO',
  'Server': 'SVR', 'Load Balancer': 'LB', 'Modem': 'MO',
  'Controller': 'CTRL', 'Recorder': 'REC', 'Amplifier': 'AMP', 'Gateway': 'GT',
  'PDU': 'PDU', 'PSU': 'PSU', 'UPS': 'UPS', 'Empty': 'EMP', 'Closed Unit': 'CL',
};

function formatUnitsRangeSrv(units = []) {
  const nums = [...new Set((units || [])
    .map(u => { const m = String(u).match(/\d+/); return m ? Number(m[0]) : null; })
    .filter(n => n !== null))].sort((a, b) => a - b);
  if (!nums.length) return '';
  const ranges = [];
  let start = nums[0], prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) { prev = nums[i]; continue; }
    ranges.push([start, prev]); start = nums[i]; prev = nums[i];
  }
  ranges.push([start, prev]);
  return ranges.map(([s, e]) =>
    s === e ? `U${String(s).padStart(2, '0')}`
            : `U${String(s).padStart(2, '0')}-U${String(e).padStart(2, '0')}`
  ).join(' ');
}

// Ported from client/src/pages/SwitchInformationPage.jsx so the report
// recovers the same models that page displays. The pipeline's own OCR
// model field is frequently null even when raw_text has enough to work
// with (e.g. U11 here: model=null but raw_text contains "CrS326") — the
// client re-parses raw_text with these patterns instead of trusting the
// pipeline's field. Keep in sync with the client copy if either changes.
function extractModelFromRawSrv(rawText, make) {
  if (!rawText) return '';
  const norm = rawText.replace(/[_][-]|[-][_]/g, '-').replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, '-');
  const patterns = [
    /\b(?:WS-C|C)\d{4,5}[A-Z]*-\d{1,3}[A-Z]{0,4}(?:-\w{1,4})?\b/,  // Cisco
    /\bTL-[A-Z]{2,4}\d{3,5}[A-Z]{0,4}\b/,                            // TP-Link
    /\bT[1-9]\d{2,3}[A-Z]{0,4}\b/,                                    // TP-Link JetStream
    /\bD[GX]S-\d{3,4}[A-Z]?-\d{1,3}[A-Z]{0,4}\b/,                   // D-Link
    /\b(?:EX|QFX|MX|SRX)\d{3,5}[A-Z0-9-]*\b/,                       // Juniper
    /\bCX\s?\d{4}[A-Z]?\b/,                                           // Aruba
    /\b(?:DCS-)?7\d{3}[A-Z]?-\d{1,3}[A-Z0-9-]*\b/,                  // Arista
    /\b(?:CRS|CCR)\d{3,4}(?:-[\w+]{1,12})*\b/i,                      // Mikrotik
  ];
  for (const rx of patterns) {
    const m = norm.match(rx);
    if (m) return m[0].toUpperCase();
  }
  if (make && make.toLowerCase().includes('mikro')) {
    const fuzzy = norm.match(/[A-Z@][A-Z]*[RS]\d{3,4}(?:-[\w+]{1,12})*/i);
    if (fuzzy) {
      const raw = fuzzy[0];
      const digits = raw.match(/\d{3,4}(?:-[\w+]{1,12})*/);
      if (digits) {
        const prefix = raw.toLowerCase().includes('ccr') ? 'CCR' : 'CRS';
        return prefix + digits[0].toUpperCase();
      }
    }
  }
  return '';
}
const PARTIAL_MODEL_MAP_SRV = [
  [/^CRS3265?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3261?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3541?/i,    'CRS354-48G-4S+2Q+RM'],
  [/^CRS3121?/i,    'CRS312-4C+8XG-RM'],
  [/^CRS3171?/i,    'CRS317-1G-16S+RM'],
  [/^CRS3051?/i,    'CRS305-1G-4S+IN'],
  [/^CRS3281?/i,    'CRS328-24P-4S+RM'],
  [/^CRS5181?/i,    'CRS518-16XS-2XQ-RM'],
  [/^CCR20041?/i,   'CCR2004-1G-12S+2XS'],
  [/^CCR20161?/i,   'CCR2016-1G-12S+2XS'],
  [/^C93001?$/i,    'C9300-24T'],
  [/^C93004?$/i,    'C9300-48T'],
  [/^C93002?$/i,    'C9300-24P'],
  [/^C93006?$/i,    'C9300-48P'],
  [/^TLSG24281?/i,  'TL-SG2428P'],
];
function expandPartialModelSrv(model) {
  if (!model) return model;
  const looksPartial = (!model.includes('-') && !model.includes('+') && model.length < 12)
    || /[A-Z]\d{1,2}$/i.test(model);
  if (!looksPartial) return model;
  for (const [rx, full] of PARTIAL_MODEL_MAP_SRV) {
    if (rx.test(model)) return full;
  }
  return model;
}

// Matches a report device (by its first occupied unit + class) against the
// per-device OCR pass (outputs/<rackId>/ocr_devices.json) to recover the
// make/model read off the physical faceplate. Best-effort: OCR frequently
// only gets the make, or nothing at all — callers must handle null fields.
// When the pipeline's own `model` field is empty, falls back to the same
// raw_text re-parse the Switch Information page uses, so the report shows
// the same model that page does instead of nothing.
function matchOcrDevice(rackDir, position, className) {
  try {
    const p = path.join(rackDir, 'ocr_devices.json');
    if (!fs.existsSync(p)) return null;
    const perDev = JSON.parse(fs.readFileSync(p, 'utf8'));
    const firstUnit = String(position || '').split(/[\s-]/)[0]; // "U04-U05" -> "U04"
    if (!firstUnit) return null;
    const rows = perDev?.devices || [];
    const row = rows.find(d => d.position === firstUnit && d.class_name === className)
             || rows.find(d => d.position === firstUnit)
             || null;
    if (row && !row.model) {
      const extracted = extractModelFromRawSrv(row.raw_text, row.make);
      const expanded = expandPartialModelSrv(extracted);
      if (expanded) return { ...row, model: expanded };
    }
    return row;
  } catch { return null; }
}

// outputs/<rackId>/device_overrides.json — user-entered corrections (make,
// model, firmware) from the Switch Information page, keyed by the same
// "U04" position string OCR uses. Saved via POST /api/scan/:rackId/device-override.
// A user override always wins over the OCR guess (see selectedDevice below).
function deviceOverridesPath(rackDir) {
  return path.join(rackDir, 'device_overrides.json');
}
function readDeviceOverride(rackDir, position) {
  try {
    const p = deviceOverridesPath(rackDir);
    if (!fs.existsSync(p)) return null;
    const all = JSON.parse(fs.readFileSync(p, 'utf8'));
    return all[position] || null;
  } catch { return null; }
}

// Pulls the existing SSH-poll drift history (server/lib/port_history_db.js)
// for the report's Drift section. There is currently no rackId column on
// monitored_devices, so this can't be scoped to "the switch in this rack" —
// but when a port has been identified in this scan, we DO scope to that
// port NUMBER (matching the trailing /N on the polled interface name, e.g.
// "Gi1/0/2" -> 2 — see server/lib/tplink_parser.js), irrespective of
// whether it was tagged RJ45/SFP/console in the scan. With no port context
// (nothing identified yet) it falls back to showing everything polled.
// Synchronous: better-sqlite3 has no async API.
// Which switches belong in THIS rack's report. Listing every monitored device
// filled the section with three "No drift events recorded yet" tables for
// switches that have never been reached at all, burying the one switch that
// actually has history.
//
//   * once the console-session join has found this rack's switch, that is the
//     only one shown — it is the only one the report can honestly claim is here
//   * with no join yet, fall back to switches we have actually polled. A device
//     we have never reached has nothing to report, and an empty table for it is
//     noise rather than information.
// The report's drift section covers exactly ONE thing: the port the technician
// selected, on the switch this rack's scan is joined to. Nothing else.
//
// It used to widen instead of narrow. When the console-session join couldn't
// name this rack's switch — the common case, since it needs the tech to have
// opened an SSH session — this fell through to `all.filter(d => d.last_seen)`
// and rendered a table for EVERY switch the poller has ever reached. That is
// the most-reported issue in the register: "showing drift for all switches
// rather than the selected switch port", filed four times.
//
// Widening was the wrong instinct twice over. A switch in some other rack has
// no bearing on this report, and presenting its history beside this rack's scan
// invites the reader to attribute it here. An empty section that says why is
// worth more than a full one that is about something else.
function driftDevicesFor(monitored) {
  // No join yet → we cannot honestly claim any switch is in this rack, so we
  // name none. Deliberately not a fallback: see above.
  if (!monitored) return [];
  return portHistoryDb.listDevices().filter(d => d.id === monitored.id);
}

function collectDriftHistory(selectedPort = null, monitored = null, eventsPerDevice = 30) {
  try {
    // No port identified yet → there is no "selected port" to report drift for.
    // Showing the switch's whole history here would answer a question nobody
    // asked, and it reads as drift on ports the user never looked at.
    if (selectedPort == null) return [];
    return driftDevicesFor(monitored).map(dev => {
      const all = portHistoryDb.eventsForDevice(dev.id, 1000);
      // Match the trailing /N of the polled interface name ("Gi1/0/2" -> 2),
      // irrespective of whether the scan tagged the port RJ45/SFP/console.
      const filtered = all.filter(e => {
        const m = String(e.port).match(/(\d+)$/);
        return m && Number(m[1]) === Number(selectedPort);
      });
      return {
        id: dev.id,
        host: dev.host,
        label: dev.label || dev.system_name || dev.host,
        vendor: dev.vendor,
        model: dev.model,
        sw_version: dev.sw_version,
        last_seen: dev.last_seen,
        events: filtered.slice(0, eventsPerDevice).map(e => ({
          port: e.port, field: e.field, from: e.from_val, to: e.to_val, at: e.at,
        })),
      };
    });
  } catch (e) {
    logger.warn(`[report] drift history unavailable: ${e.message}`);
    return [];
  }
}

// ── Join: a scanned rack → the switch we actually poll ───────────────
// These two halves have never known about each other. A scanned device is
// identified by where it sits (U08); a monitored switch by its address. The
// bridge already exists in the data and was simply never walked: when a
// technician identifies a port we save the console session, and that records
// the host we talked to. getDeviceByHost turns it into the polled device.
//
// Without this, drift can list what changed but cannot say WHICH switch it
// changed on — which is the difference between a table and a sentence.
// Returns null whenever the chain breaks (no console session yet, host not
// monitored); every caller treats that as "no live data", never as "fine".
const DRIFT_WINDOW_DAYS = 7;
function resolveMonitoredSwitch(portIdentifications, selectedPort) {
  try {
    const host = (portIdentifications || []).find(p => p.console?.host)?.console?.host;
    if (!host) return null;
    const dev = portHistoryDb.getDeviceByHost(host);
    if (!dev) return null;

    const cutoff = new Date(Date.now() - DRIFT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const events = portHistoryDb.eventsForDevice(dev.id, 2000)
      .filter(e => e.at >= cutoff)
      .map(e => ({ port: e.port, field: e.field, from: e.from_val, to: e.to_val, at: e.at }));

    // The switch's own reading of the port the technician picked — matched on
    // the trailing number, since the scan only ever knows "14" while the
    // switch may call it "Gi1/0/14".
    let portSnapshot = null;
    if (selectedPort != null) {
      const want = Number(selectedPort);
      portSnapshot = portHistoryDb.latestSnapshotsForDevice(dev.id)
        .find(s => Number(String(s.port).match(/(\d+)$/)?.[1]) === want) || null;
    }

    return {
      id: dev.id,
      host: dev.host,
      label: dev.label || dev.system_name || dev.host,
      vendor: dev.vendor,
      model: dev.model,
      serial: dev.serial,
      sw_version: dev.sw_version,
      last_seen: dev.last_seen,
      last_error: dev.last_error || null,
      window_days: DRIFT_WINDOW_DAYS,
      events,
      portSnapshot,
    };
  } catch (e) {
    logger.warn(`[report] monitored-switch join unavailable: ${e.message}`);
    return null;
  }
}

function buildScanReportData(rackId) {
  const rackDir = path.join(outputsDir, rackId);
  const meta    = readMeta(rackId);
  if (!meta) throw new Error(`Scan ${rackId} not found`);

  const mapPath = path.join(rackDir, 'device_unit_map.json');
  const mapData = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
  const rawDevices = mapData.devices || [];
  const unitsDetected = mapData.units_detected || [];

  const counts = {};
  const devices = rawDevices.map((dev, i) => {
    const code = CLASS_CODE_SRV[dev.class_name] || (dev.class_name || 'UNK').replace(/\s+/g, '').slice(0, 4).toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    const seq = String(counts[code]).padStart(2, '0');
    const labelUnits = dev.units?.length ? dev.units : unitsDetected.length ? [unitsDetected[0]] : [];
    const unitRange = formatUnitsRangeSrv(labelUnits) || 'U01';
    const label = `${unitRange.split(' ')[0]}-${code}${seq}`;
    return {
      index: i + 1,
      label,
      class_name: dev.class_name || 'Unknown',
      position: unitRange,
      port_count: dev.port_count || 0,
      console_ports: dev.console_ports?.length || 0,
      sfp_ports: dev.sfp_ports?.length || 0,
      other_ports: dev.other_ports?.length || 0,
      connected_ports: dev.connected_ports?.length || 0,
      // PDU power outlets (present only on PDU devices).
      power_total: dev.power_total || 0,
      power_connected: dev.power_connected || 0,
      power_empty: dev.power_empty || 0,
      powered: !!dev.powered,
    };
  });

  // Merge make/model/firmware onto every device, so the report shows a real
  // inventory ("Cisco C9300-48P") rather than only a class ("Switch").
  // Goes through matchOcrDevice (rather than reading ocr_devices.json flat)
  // so each device gets the same raw_text re-parse the Switch Information
  // page uses — the pipeline's own `model` field is often null even when the
  // faceplate text clearly carries a model. A user's manual correction
  // (device_overrides.json) outranks whatever OCR guessed.
  // Best-effort throughout: the report still renders if OCR never ran.
  for (const dv of devices) {
    const o = matchOcrDevice(rackDir, dv.position, dv.class_name);
    const ov = readDeviceOverride(rackDir, String(dv.position || '').split(/[\s–—-]/)[0]);
    if (o || ov) {
      dv.make     = ov?.make     || o?.make    || null;
      dv.model    = ov?.model    || o?.model   || null;
      dv.firmware = ov?.firmware || o?.version || null;
    }
  }

  // Latest port identification only — walk newest-first and take the first valid line
  const idsPath = path.join(rackDir, 'port_identifications.jsonl');
  const portIdentifications = [];
  if (fs.existsSync(idsPath)) {
    const raw = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
    for (let i = raw.length - 1; i >= 0; i--) {
      try {
        portIdentifications.push(JSON.parse(raw[i]));
        break;
      } catch { /* skip malformed line */ }
    }
  }

  const fbPath = path.join(rackDir, 'feedback.jsonl');
  let feedbackEntries = [];
  if (fs.existsSync(fbPath)) {
    feedbackEntries = fs.readFileSync(fbPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  const fbCorrect = feedbackEntries.filter(e => e.is_correct).length;

  // Candidate report images, resolved through rackImageUrlPath so that we
  // pick up either the new images/ subfolder or the legacy flat layout.
  const candidateImages = [
    '3_units_and_devices.png',
    '7_rack_all_ports.png',
    '5_selected_device_with_port.png',
    '6_full_rack_selected_port.png',
  ];
  const images = candidateImages
    .filter(f => fs.existsSync(rackImagePath(rackDir, f)))
    .map(f => rackImageUrlPath(rackDir, f));
  // Report's "Rack Image" section shows the plain original upload, not an
  // annotated derivative — falls back to whatever's available if the
  // original file is somehow missing.
  const originalImageExt = ['jpg', 'jpeg', 'png']
    .find(ext => fs.existsSync(rackImagePath(rackDir, `original_image.${ext}`)));
  const rackOverviewImage = originalImageExt
    ? rackImageUrlPath(rackDir, `original_image.${originalImageExt}`)
    : (images[0] || null);

  const portIdentificationsOut = portIdentifications.map(e => {
    const p = e.port_info || {};
    const dev = devices[e.device_index - 1];
    const console_transcript = readConsoleTranscript(rackDir, e.device_index, e.port);
    return {
      timestamp: e.timestamp,
      device_index: e.device_index,
      device_label: dev?.label || null,
      device_class: dev?.class_name || null,
      device_position: dev?.position || null,
      port: e.port,
      port_category: p.port_category || null,
      status: p.status || null,
      confidence: p.confidence ?? null,
      location: p.location || null,
      cable_color: p.cable_color || null,
      cable_connector: p.cable_connector || null,
      cable_type: p.cable_type || null,
      cable_confidence: p.cable_confidence ?? null,
      port_type: p.port_type || null,
      port_type_confidence: p.port_type_confidence ?? null,
      device_image: e.device_image || null,
      full_rack_image: e.full_rack_image || null,
      console: console_transcript ? {
        host: console_transcript.host,
        interface: console_transcript.interface,
        updated_at: console_transcript.updated_at,
        entries: console_transcript.entries || [],
      } : null,
    };
  });

  // "Selected device" = the device behind the most recent port identification
  // (same one the Port Identifications section already highlights), enriched
  // with whatever the per-device OCR pass read off its faceplate. make/model/
  // firmware were already resolved (override > OCR) on the devices array above.
  let selectedDevice = null;
  if (portIdentificationsOut.length) {
    const latest = portIdentificationsOut[0];
    const dev = devices[latest.device_index - 1];
    if (dev) {
      const firstUnit = String(dev.position || '').split(/[\s–—-]/)[0];
      const ocr = matchOcrDevice(rackDir, dev.position, dev.class_name);
      const override = readDeviceOverride(rackDir, firstUnit);
      selectedDevice = {
        ...dev,
        make: override?.make || ocr?.make || null,
        model: override?.model || ocr?.model || null,
        model_source: (override?.make || override?.model) ? 'user' : (ocr?.source || null),
        model_confidence: (override?.make || override?.model) ? null : (ocr?.match_conf ?? null),
        firmware_version_ocr: override?.firmware || ocr?.version || null,
        // Populated best-effort in buildScanReport (needs a live/cached
        // spec+firmware lookup) — placeholders here so JSON/CSV consumers
        // that skip that step still see stable keys.
        specs: null,
        firmware: null,
      };
    }
  }

  // Resolve the join once: the drift section is scoped by it, and the summary
  // reads its events. Computing it inside the object literal would run it twice.
  const selectedPortNumber = portIdentificationsOut[0]?.port ?? null;
  const monitoredSwitch = resolveMonitoredSwitch(portIdentificationsOut, selectedPortNumber);

  return attachInsights({
    rackId,
    timestamp: meta.timestamp || null,
    quality_note: meta.quality?.note || null,
    units_detected: unitsDetected,
    units_range: formatUnitsRangeSrv(unitsDetected),
    devices,
    selectedDevice,
    port_identifications: portIdentificationsOut,
    driftHistory: collectDriftHistory(selectedPortNumber, monitoredSwitch),
    // Why the drift section is empty, when it is. Without this the reader can't
    // tell "nothing has changed on your port" from "we couldn't scope this",
    // and the section reads as broken rather than quiet.
    driftScope: selectedPortNumber == null
      ? { ok: false, reason: 'no_port_selected', port: null }
      : !monitoredSwitch
        ? { ok: false, reason: 'switch_not_joined', port: selectedPortNumber }
        : { ok: true, reason: null, port: selectedPortNumber,
            switchLabel: monitoredSwitch.label || monitoredSwitch.system_name || monitoredSwitch.host || null },
    // The joined switch, plus its recent events — what lets the summary name
    // a switch rather than list changes from every device we happen to poll.
    monitoredSwitch,
    feedback: {
      total: feedbackEntries.length,
      correct: fbCorrect,
      wrong: feedbackEntries.length - fbCorrect,
      accuracy: feedbackEntries.length ? fbCorrect / feedbackEntries.length : null,
      entries: feedbackEntries,
    },
    images, // relative filenames under outputs/<rackId>/
    rackOverviewImage,
    _rackDir: rackDir, // internal: used by renderers, not exported in JSON
  });
}

// The summary box. Computed here so the JSON export carries it too, and
// computed AGAIN in buildScanReport once specs/firmware have been filled in —
// the firmware rule can only speak after that lookup, and the report should
// not show a weaker summary than the data can support. Best-effort by design:
// a summary that throws must never take the whole report down with it.
function attachInsights(data) {
  try {
    data.insights = reportInsights.buildInsights(data, { formatTimestamp });
  } catch (e) {
    logger.warn(`[report] summary could not be built: ${e.message}`);
    data.insights = null;
  }
  return data;
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function imageToDataUri(absPath) {
  try {
    // Prefer a pre-shrunk report copy (<name>.rpt.jpg) if one exists — see
    // shrinkImagesForReport. A full-resolution rack render can be several MB,
    // and a base64 image that large black-screens the HTML report inside a
    // mobile WebView. The shrunk copy renders fine and keeps the report
    // self-contained for download/email.
    const shrunk = absPath.replace(/\.(png|jpe?g)$/i, '.rpt.jpg');
    const useAbs = fs.existsSync(shrunk) ? shrunk : absPath;
    const buf = fs.readFileSync(useAbs);
    const ext = path.extname(useAbs).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

let _sharpLib;
try { _sharpLib = require('sharp'); } catch { _sharpLib = null; }

// Create downscaled JPEG copies (<name>.rpt.jpg) of large rack images so the
// self-contained report stays small enough to render in a mobile WebView.
// Fully best-effort: if sharp is missing or any file fails, the original is
// used and the report still works (just heavier). Cached by mtime.
async function shrinkImagesForReport(rackDir) {
  if (!_sharpLib || !rackDir) return;
  let imgDir = rackDir;
  try {
    if (fs.existsSync(path.join(rackDir, 'images'))) imgDir = path.join(rackDir, 'images');
    const files = fs.readdirSync(imgDir)
      .filter(f => /\.(png|jpe?g)$/i.test(f) && !/\.rpt\.jpg$/i.test(f))
      .map(f => path.join(imgDir, f));
    await Promise.all(files.map(async (abs) => {
      try {
        const src = fs.statSync(abs);
        if (src.size < 500 * 1024) return;   // already small enough — skip
        const out = abs.replace(/\.(png|jpe?g)$/i, '.rpt.jpg');
        if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src.mtimeMs) return; // cached
        await _sharpLib(abs).rotate()
          .resize({ width: 1400, withoutEnlargement: true })
          .jpeg({ quality: 76 }).toFile(out);
      } catch { /* keep the original for this file */ }
    }));
  } catch { /* directory unreadable — skip entirely */ }
}

// Single subtle near-black accent everywhere — the report used to
// color-code every card by device type (cyan/blue/purple/orange/...),
// which read as busy. One consistent dark accent keeps focus on the data.
const accentFor = () => '#18181b';

// Reports are rendered SERVER-side, so an unqualified toLocaleString formats
// in the container's timezone — not the technician's. Nothing sets TZ in the
// Dockerfile or either compose file, so the demo container runs UTC and every
// scan timestamp read 5h30m behind the people who took it. It looked correct
// in development for the worst possible reason: the build Mac is already in
// the team's zone, so the bug was invisible exactly where it would have been
// caught.
//
// REPORT_TZ pins the zone the reports are written in, independent of whatever
// the host happens to be set to. The zone name is always printed: a bare
// "13:14" is the thing that made this hard to spot, and a reader who can see
// "13:14 UTC" can tell at a glance that it is not their local time.
const REPORT_TZ = process.env.REPORT_TZ || process.env.TZ || undefined;

function formatTimestamp(ts) {
  if (!ts) return 'unknown time';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZoneName: 'short',
      ...(REPORT_TZ ? { timeZone: REPORT_TZ } : {}),
    });
  } catch { return String(ts); }
}

function renderHTMLReport(data, { inlineImages = true } = {}) {
  const d = data;
  const srcFor = (fname) => {
    if (!fname) return null;
    // Resolve through the helper so old (flat) and new (subfolder) layouts both work
    const abs = resolveRelativeArtifact(d._rackDir, fname);
    return inlineImages ? imageToDataUri(abs) : fname;
  };

  // Same category labels the Results page shows (main→RJ45, sfp→SFP,
  // console→Console, other→USB) — the raw backend value ("main") isn't
  // what the user actually picked/sees in the app.
  const PORT_CATEGORY_LABELS = { main: 'RJ45', sfp: 'SFP', console: 'Console', other: 'USB' };

  const portIdsHtml = d.port_identifications.map(p => {
    const a = accentFor(p.device_class || '');
    // Only the selected-device crop — the full rack image is covered by
    // the report's own "Rack Image" section, no need to repeat it here.
    const devSrc = srcFor(p.device_image);
    const imgs = devSrc ? `<div class="portImg"><img src="${devSrc}" alt=""/></div>` : '';

    // Status / cable / confidence detail grid — the data was already
    // computed by buildScanReportData but previously never rendered anywhere.
    const statusClass = p.status === 'connected' ? 'ok' : p.status === 'empty' ? 'muted' : 'warn';
    const detailItems = [];
    if (p.status) detailItems.push(['Status', `<span class="statusPill ${statusClass}">${htmlEscape(p.status)}</span>`]);
    if (p.port_category) detailItems.push(['Category', htmlEscape(PORT_CATEGORY_LABELS[p.port_category] || p.port_category)]);
    if (p.cable_type) detailItems.push(['Cable', htmlEscape(p.cable_type)]);
    else if (p.cable_connector || p.cable_color) {
      detailItems.push(['Cable', htmlEscape([p.cable_connector, p.cable_color].filter(Boolean).join(' · '))]);
    }
    if (p.cable_color) detailItems.push(['Cable Color', htmlEscape(p.cable_color)]);
    if (p.port_type) detailItems.push(['Port type', htmlEscape(p.port_type)]);
    if (p.confidence != null) detailItems.push(['Confidence', `${Math.round(p.confidence * 100)}%`]);
    const detailsHtml = detailItems.length
      ? `<div class="portDetails">${detailItems.map(([k, v]) => `<div class="detailItem"><div class="k">${htmlEscape(k)}</div><div class="v">${v}</div></div>`).join('')}</div>`
      : '';

    let consoleHtml = '';
    if (p.console && Array.isArray(p.console.entries) && p.console.entries.length) {
      const entryBlocks = p.console.entries.map(e => `
  <article class="cmdBlock">
    <header class="cmdHeader">
      <span class="cmdName">${htmlEscape(e.name || 'Command')}</span>
      <code class="cmdLine">${htmlEscape(e.cmd)}</code>
    </header>
    ${e.error
      ? `<pre class="cmdErr">${htmlEscape(e.error)}</pre>`
      : `<pre class="cmdOut">${htmlEscape(e.output || '(no output)')}</pre>`}
  </article>`).join('');
      consoleHtml = `
  <div class="consoleWrap">
    <div class="consoleHead">
      <span class="consoleKey">Console · ${htmlEscape(p.console.host || '—')}${p.console.interface ? ` · ${htmlEscape(p.console.interface)}` : ''}</span>
    </div>
    ${entryBlocks}
  </div>`;
    }

    return `
<section class="portCard" style="--accent:${a}">
  <div class="portCardHead">
    <div class="portBadge" style="background:${a};box-shadow:0 0 14px ${a}90">Port ${htmlEscape(p.port)}</div>
    <div class="portCardTitle">
      <div class="portDevice">${htmlEscape(p.device_label || `Device ${p.device_index}`)}</div>
      <div class="portDeviceSub">${htmlEscape(p.device_class || '')}${p.device_position ? ` · ${htmlEscape(p.device_position)}` : ''}</div>
    </div>
  </div>
  ${imgs ? `<div class="portImgs">${imgs}</div>` : ''}
  ${detailsHtml}
  ${consoleHtml}
</section>`;
  }).join('\n');

  const ts = formatTimestamp(d.timestamp);

  // ── Inventory rollup ──────────────────────────────────────────────
  const devs = d.devices || [];

  // The detector emits a row for every rack position it resolves, and some of
  // those positions hold no equipment: `Empty` is an unoccupied U and
  // `Closed Unit` is a blanking panel. Counting them as devices inflated the
  // headline number on every report — across the sample scans in outputs/,
  // 29 of 205 rows are one of these two, and one rack reported 23 devices for
  // 15 actual units. A patch panel IS equipment and stays counted.
  const RACK_SLOT_CLASSES = new Set(['empty', 'closed unit', 'blank', 'blanking panel']);
  const isRackSlot = (dv) => RACK_SLOT_CLASSES.has(String(dv.class_name || '').trim().toLowerCase());
  const equipment = devs.filter(dv => !isRackSlot(dv));

  const deviceCount   = equipment.length;
  const totalPorts     = devs.reduce((s, dv) => s + (dv.port_count || 0), 0);
  const connectedPorts = devs.reduce((s, dv) => s + (dv.connected_ports || 0), 0);

  // ── Summary ──
  // The four tiers, in reading order: verdict → what to do → the facts →
  // what we could not check. Deliberately the inverse of the order the data
  // was gathered in: someone up a ladder wants the answer, not the working.
  // Urgency is carried by a WORD as well as a colour — this gets printed to
  // PDF, mailed on, and read on a phone in a badly lit aisle.
  const ins = d.insights;
  // Only things a person could act on get a "Recommendation" heading.
  //
  // When nothing needs doing, buildInsights still appends an all-clear entry
  // ("Otherwise — Nothing in this scan needs attention") so the JSON and CSV
  // exports carry an explicit result rather than an empty list. Rendering it
  // put a Recommendation heading over a non-recommendation, and repeated what
  // the verdict directly above had already said. The entry stays in the data;
  // it just no longer prints a heading promising advice that is not there.
  const actionable = (ins?.actions || []).filter(a => a.level === 'crit' || a.level === 'warn');
  const summaryHtml = !ins ? '' : `
<section class="sumCard sev-${htmlEscape(ins.severity)}">
  <div class="sumVerdict">
    <h2>${htmlEscape(ins.verdict)}</h2>
    <span class="sumStamp">${htmlEscape(ins.stamp)}</span>
  </div>
  ${ins.summary ? `
  <div class="sumProse">
    <p>${htmlEscape(ins.summary)}</p>
  </div>` : ''}
  ${actionable.length ? `<div class="sumActs">
    <div class="sumLabel">Recommendation</div>
    ${actionable.map(a => `
    <div class="sumAct">
      <span class="sumTag ${htmlEscape(a.level)}">${htmlEscape(a.tag)}</span>
      <div>
        <p>${htmlEscape(a.text)}</p>
        ${a.evidence ? `<p class="ev">${htmlEscape(a.evidence)}</p>` : ''}
      </div>
    </div>`).join('')}</div>` : ''}
  ${ins.facts.length ? `<div class="sumFacts">${ins.facts.map(f => `
    <div class="sumFact">
      <div class="k">${htmlEscape(f.k)}</div>
      <div class="v">${htmlEscape(f.v)}${f.pill ? ` <span class="sumPill ${htmlEscape(f.pill.tone)}">${htmlEscape(f.pill.text)}</span>` : ''}${f.detail ? `<small>${htmlEscape(f.detail)}</small>` : ''}</div>
    </div>`).join('')}</div>` : ''}
  ${''/* The "Not checked" line is deliberately not rendered — dropped on
        request as noise on racks where OCR reads little. buildInsights still
        returns insights.gaps, so the JSON export carries it and putting the
        line back is one template change, not a rebuild. The verdict still
        softens to "in what we could check" when coverage was partial, so the
        box does not silently claim a result it never measured. */}
</section>`;

  // ── Rack Image ──
  const rackImgSrc = srcFor(d.rackOverviewImage);
  const rackImageHtml = rackImgSrc
    ? `<div class="rackHero"><img src="${rackImgSrc}" alt="Rack overview"/></div>`
    : `<p class="empty">No rack image available.</p>`;

  // ── Devices ──
  // "Closed Unit" and "Empty" aren't real devices — placeholder classes for
  // rack slots with nothing identifiable in them — so they're excluded here
  // (and their units aren't counted toward anything shown).
  // "Unidentified" joins the placeholder classes: a row reading
  // "U11-UNID02 · Unidentified · U11" states only that something occupies the
  // slot, which the rack image already shows. On these racks it was half the
  // list, pushing the devices we DID identify off the first screen.
  const NON_DEVICE_CLASSES = new Set(['Closed Unit', 'Empty', 'Unidentified']);
  const realDevices = devs.filter(dev => !NON_DEVICE_CLASSES.has(dev.class_name));
  const devicesHtml = realDevices.length ? `
<div class="deviceList">
${realDevices.map(dev => {
    const initials = (CLASS_CODE_SRV[dev.class_name] || dev.class_name || '?').replace(/\s+/g, '').slice(0, 2).toUpperCase();
    // Make & model carried over from the old inventory table — the faceplate
    // read is the single most useful thing to see per row, so keep it on the
    // subtitle line rather than losing it with the table.
    const makeModel = [dev.make, dev.model].filter(Boolean).join(' ');
    const stats = [];
    if (dev.port_count) stats.push(`${dev.port_count} ports`);
    if (dev.sfp_ports) stats.push(`${dev.sfp_ports} SFP`);
    if (dev.console_ports) stats.push(`${dev.console_ports} console`);
    if (dev.connected_ports) stats.push(`${dev.connected_ports} connected`);
    if (dev.power_total) stats.push(`${dev.power_connected}/${dev.power_total} powered`);
    return `
  <div class="deviceRow" style="--accent:${accentFor(dev.class_name)}">
    <div class="deviceRowIcon">${htmlEscape(initials)}</div>
    <div class="deviceRowMain">
      <div class="deviceRowLabel">${htmlEscape(dev.label)}${makeModel ? ` <span class="deviceRowModel">${htmlEscape(makeModel)}</span>` : ''}</div>
      <div class="deviceRowClass">${htmlEscape(dev.class_name)} · ${htmlEscape(dev.position)}</div>
    </div>
    <div class="deviceRowStats">${stats.map(s => `<span class="deviceRowStat">${htmlEscape(s)}</span>`).join('')}</div>
  </div>`;
  }).join('')}
</div>` : `<p class="empty">No devices detected.</p>`;

  // ── Selected Device (make/model/firmware/specs) ──
  let selectedDeviceHtml = `<p class="empty">No device has been selected yet.</p>`;
  const sd = d.selectedDevice;
  if (sd) {
    const specs = sd.specs;
    // Top 5 spec-sheet fields only — the full sheet has ~12 fields, but
    // this section is meant as a quick summary, not the whole datasheet.
    // Only rendered when the agent actually found a match; skipped
    // entirely otherwise, same "no placeholder" rule as firmware.
    const SPEC_SUMMARY_KEYS = ['SKU', 'Ports', 'Port config', 'Max port speed (Gbps)', 'Switching capacity (Gbps)'];
    const specEntries = (specs?.ok && specs.specs)
      ? SPEC_SUMMARY_KEYS.filter(k => specs.specs[k] != null).map(k => [k, specs.specs[k]])
      : [];
    const specsBlockHtml = specEntries.length ? `
  <div class="infoSubhead">Specifications</div>
  <div class="infoGrid">
    ${specEntries.map(([k, v]) => `<div class="infoItem"><div class="k">${htmlEscape(k)}</div><div class="v">${htmlEscape(v)}</div></div>`).join('')}
  </div>` : '';
    const fw = sd.firmware;
    const firmwareCurrent = (fw?.ok && fw.currentVersion) || sd.firmware_version_ocr || null;
    // Make/model/firmware/specs are ALL skipped entirely when not
    // found/entered — no "Not detected" placeholder clutter. Whatever the
    // user manually saved (device_overrides.json) already wins over OCR
    // in selectedDevice, so this naturally shows the user's entry once set.
    const makeRow  = sd.make  ? `<div class="infoItem"><div class="k">Make</div><div class="v">${htmlEscape(sd.make)}</div></div>` : '';
    const modelRow = sd.model ? `<div class="infoItem"><div class="k">Model</div><div class="v">${htmlEscape(sd.model)}</div></div>` : '';
    let firmwareRows = '';
    if (firmwareCurrent) {
      firmwareRows += `<div class="infoItem"><div class="k">Firmware (current)</div><div class="v">${htmlEscape(firmwareCurrent)}</div></div>`;
    }
    if (fw?.ok && fw.latestVersion) {
      const badge = fw.upToDate === true ? `<span class="pill ok">Up to date</span>`
                  : fw.upToDate === false ? `<span class="pill warn">Update available</span>` : '';
      firmwareRows += `<div class="infoItem"><div class="k">Latest available</div><div class="v">${htmlEscape(fw.latestVersion)} ${badge}</div></div>`;
    }
    // Ports count: prefer the vendor spec sheet (authoritative); fall back
    // to the scan's own detection when no spec match exists. The fallback
    // is RJ45 + Console + SFP combined — sd.port_count alone is only the
    // main/RJ45 count, which reads as "0 ports" on an SFP-only switch even
    // though it clearly has ports (just not RJ45 ones).
    const specPorts = (specs?.ok && specs.specs?.Ports) ? specs.specs.Ports : null;
    const detectedPortsTotal = (sd.port_count || 0) + (sd.console_ports || 0) + (sd.sfp_ports || 0);
    const portsValue = specPorts != null ? specPorts : (detectedPortsTotal || null);
    // Dropped entirely when there is neither a spec sheet nor a single
    // detected port, rather than asserting "Ports 0" — on a device the scan
    // found no ports for (a router, an unidentified unit), a literal zero
    // reads as a measurement rather than the absence of one.
    const portsRow = portsValue != null
      ? `<div class="infoItem"><div class="k">Ports</div><div class="v">${htmlEscape(portsValue)}</div></div>` : '';
    selectedDeviceHtml = `
<div class="infoCard" style="--accent:${accentFor(sd.class_name)}">
  <div class="portCardHead">
    <div class="portCardTitle">
      <div class="portDevice">${htmlEscape(sd.label)}</div>
      <div class="portDeviceSub">${htmlEscape(sd.class_name)} · ${htmlEscape(sd.position)}</div>
    </div>
  </div>
  <div class="infoGrid">
    ${makeRow}
    ${modelRow}
    ${firmwareRows}
    ${portsRow}
  </div>
  ${specsBlockHtml}
</div>`;
  }

  // ── Drift History ──
  const driftHtml = (d.driftHistory || []).length ? d.driftHistory.map(dev => {
    const rows = dev.events.length ? dev.events.map(e => `
    <tr>
      <td>${htmlEscape(formatTimestamp(e.at))}</td>
      <td>${htmlEscape(e.port)}</td>
      <td>${htmlEscape(e.field)}</td>
      <td>${htmlEscape(e.from ?? '—')}</td>
      <td>${htmlEscape(e.to ?? '—')}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">No drift events recorded yet.</td></tr>`;
    return `
<div class="driftCard">
  <div class="portCardHead">
    <div class="portCardTitle">
      <div class="portDevice">${htmlEscape(dev.label)}</div>
      <div class="portDeviceSub">${[dev.vendor, dev.model, dev.sw_version ? `v${dev.sw_version}` : null, dev.host].filter(Boolean).map(htmlEscape).join(' · ')}</div>
    </div>
  </div>
  <div class="tableScroll">
    <table class="driftTable">
      <thead><tr><th>Time</th><th>Port</th><th>Field</th><th>From</th><th>To</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
  }).join('\n') : (() => {
    // Say which of the three empty cases this is. The old copy — "No switches
    // are currently being monitored for drift" — was the one message for all of
    // them, and was simply untrue whenever a switch WAS monitored but the report
    // couldn't scope to it.
    const s = d.driftScope || {};
    if (s.reason === 'no_port_selected') {
      return `<p class="empty">No port has been identified on this rack yet, so there is no port to report drift for. Find a port first and the change history for that port appears here.</p>`;
    }
    if (s.reason === 'switch_not_joined') {
      return `<p class="empty">Port ${htmlEscape(String(s.port))} was identified, but this rack has not been linked to a monitored switch — that link is made when a technician opens a console session on it. Drift is deliberately not shown for other switches, as their history says nothing about this rack.</p>`;
    }
    return `<p class="empty">No drift recorded on port ${htmlEscape(String(s.port ?? '—'))}${
      s.switchLabel ? ` of ${htmlEscape(s.switchLabel)}` : ''
    } in the last ${DRIFT_WINDOW_DAYS} days.</p>`;
  })();

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>Rack Scan Report — ${htmlEscape(d.rackId)}</title>
<style>
  /* Minimal light theme — white surfaces, one subtle black accent, tight
     spacing. Looks the same on screen and in PDF.
     color-scheme:light opts this report out of Android WebView force-dark
     (the app's index.css does the same); with the native force-dark theme
     fix this is belt-and-suspenders so the report never darkens. */
  :root {
    color-scheme: light;
    --bg:#ffffff; --bg2:#ffffff;
    --card:#ffffff;
    --fg:#18181b; --muted:#7a7a7f; --softMuted:#a8a8ad;
    --accent:#18181b; --accent2:#3f3f46; --accent3:#0a0a0b;
    --border:#e4e4e7; --borderSoft:#f1f1f3;
    --shadow:0 1px 2px rgba(0,0,0,0.03), 0 4px 12px rgba(0,0,0,0.04);
    --shadowSm:0 1px 2px rgba(0,0,0,0.04);
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden}
  body{
    background:#ffffff;
    color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    line-height:1.45; min-height:100vh;
  }
  .wrap{width:100%;max-width:1080px;margin:0 auto;padding:18px 20px 36px}

  /* ── Hero ── */
  .hero{
    position:relative;
    padding:20px 22px 18px;
    border-radius:14px;
    color:#fff;
    background:#121214;
    overflow:hidden;
  }
  .heroEyebrow{
    display:inline-flex;align-items:center;gap:7px;
    font-size:.64rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
    color:rgba(255,255,255,0.75);
  }
  .heroEyebrow::before{content:'';width:5px;height:5px;border-radius:50%;background:#fff}
  h1{
    font-size:1.5rem;margin:8px 0 4px;letter-spacing:-0.02em;
    color:#fff;font-weight:700;
  }
  .heroMeta{display:flex;flex-wrap:wrap;gap:12px;color:rgba(255,255,255,0.7);font-size:.8rem}
  .heroMeta .k{color:rgba(255,255,255,0.5);margin-right:4px}
  .heroMeta code{
    font-family:'SF Mono',Menlo,Consolas,monospace;
    background:rgba(255,255,255,0.12);padding:2px 8px;border-radius:5px;
    color:#fff;
  }

  /* ── Stat cards ── */
  .stats{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 4px}
  .stats .stat{flex:0 1 auto;min-width:150px}
  .stat{
    padding:12px 14px;border-radius:10px;
    background:var(--card);
    border:1px solid var(--border);
    overflow:hidden;
  }
  .stat .k{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .stat .v{font-size:1.4rem;font-weight:700;margin-top:2px;letter-spacing:-0.01em;color:var(--fg)}
  .stat .statOf{font-size:.9rem;font-weight:600;color:var(--softMuted)}

  /* ── Summary box (the four tiers) ──
     Sits above everything else and is the only block allowed type this large,
     so the eye lands here first whether or not the reader meant to read. */
  .sumCard{
    position:relative;margin:14px 0 4px;border:1px solid var(--border);
    background:var(--card);overflow:hidden;
  }
  .sumCard::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
  .sumCard.sev-critical::before{background:#991b1b}
  .sumCard.sev-attention::before{background:#92400e}
  .sumCard.sev-clear::before{background:#166534}

  /* tier 1 — verdict */
  .sumVerdict{
    padding:16px 18px 14px 20px;border-bottom:1px solid var(--borderSoft);
    display:flex;align-items:baseline;justify-content:space-between;gap:8px 24px;flex-wrap:wrap;
  }
  .sumVerdict h2{margin:0;font-size:1.42rem;font-weight:800;letter-spacing:-0.025em;line-height:1.15;color:var(--fg)}
  .sumStamp{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.68rem;color:var(--muted);white-space:nowrap}

  /* the prose account, for reading rather than scanning */
  .sumProse{padding:12px 18px 12px 20px;border-bottom:1px solid var(--borderSoft)}
  .sumProse p{margin:0;font-size:.85rem;line-height:1.55;color:var(--fg);max-width:78ch}
  .sumLabel{
    font-size:.58rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;
    color:var(--muted);margin-bottom:5px;
  }

  /* tier 2 — what to do */
  .sumActs{padding:13px 18px 14px 20px;display:grid;gap:8px}
  .sumAct{display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:start}
  .sumTag{
    font-family:'SF Mono',Menlo,Consolas,monospace;
    font-size:.58rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
    padding:3px 6px;white-space:nowrap;min-width:82px;text-align:center;
  }
  .sumTag.crit{background:#fdeaea;color:#991b1b}
  .sumTag.warn{background:#fdf1de;color:#92400e}
  .sumTag.ok{background:#e8f5ec;color:#166534}
  .sumAct p{margin:0;font-size:.92rem;font-weight:600;line-height:1.38;color:var(--fg)}
  .sumAct p.ev{margin-top:2px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.68rem;font-weight:400;color:var(--muted)}

  /* tier 3 — the facts. Never bolder than tier 2. */
  .sumFacts{
    border-top:1px solid var(--borderSoft);background:#fcfcfd;
    padding:13px 18px 14px 20px;
    display:grid;gap:11px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  }
  .sumFact .k{font-size:.59rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
  .sumFact .v{font-size:.8rem;font-weight:600;margin-top:2px;line-height:1.4;color:var(--fg)}
  .sumFact .v small{display:block;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.68rem;font-weight:400;color:var(--muted);margin-top:1px}
  .sumPill{
    display:inline-block;font-size:.58rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
    padding:1px 6px;margin-left:4px;vertical-align:1px;
  }
  .sumPill.warn{background:#fdf1de;color:#92400e}
  .sumPill.ok{background:#e8f5ec;color:#166534}
  .sumPill.muted{background:#f4f4f5;color:#71717a}

  /* tier 4 — the quietest line, and never omitted */

  /* ── Rack image ── */
  .rackHero{
    max-width:320px;margin:0 auto;
    border-radius:10px;overflow:hidden;border:1px solid var(--border);
    background:#fafafa;
  }
  .rackHero img{width:100%;display:block}

  /* ── Device list ── */
  .deviceList{display:flex;flex-direction:column;gap:6px}
  .deviceRow{
    display:flex;align-items:center;gap:12px;
    padding:8px 12px 8px 11px;border-radius:9px;
    background:var(--card);
    border:1px solid var(--border);border-left:2px solid var(--accent);
  }
  .deviceRowIcon{
    flex-shrink:0;width:28px;height:28px;border-radius:7px;
    display:flex;align-items:center;justify-content:center;
    background:var(--accent);
    color:#fff;font-weight:700;font-size:.62rem;letter-spacing:.02em;
  }
  .deviceRowMain{flex:1;min-width:0}
  .deviceRowLabel{font-weight:700;font-size:.82rem;color:var(--fg)}
  .deviceRowModel{font-weight:600;color:var(--muted);font-size:.76rem;margin-left:4px}
  .deviceRowClass{font-size:.72rem;color:var(--muted);margin-top:1px}
  .deviceRowStats{display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end;max-width:45%}
  .deviceRowStat{
    font-size:.64rem;font-weight:600;color:var(--muted);white-space:nowrap;
    background:#f4f4f5;padding:2px 8px;border-radius:999px;
  }

  /* ── Info card (Selected Device) ── */
  .infoCard{
    position:relative;padding:14px 16px 16px;border-radius:12px;
    background:var(--card);border:1px solid var(--border);
    overflow:hidden;
  }
  .infoCard::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
    background:var(--accent);
  }
  .infoGrid{
    display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;
    margin-top:10px;
  }
  .infoSubhead{
    margin-top:14px;padding-top:10px;border-top:1px solid var(--borderSoft);
    font-size:.64rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
  }
  .infoItem .k{font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .infoItem .v{font-size:.86rem;font-weight:600;color:var(--fg);margin-top:2px}
  .infoItem .v.muted{color:var(--softMuted);font-weight:500;font-style:italic}
  .pill{
    display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;
    font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
    margin-left:5px;
  }
  .pill.ok{background:#e8f5ec;color:#166534}
  .pill.warn{background:#fdf1de;color:#92400e}

  /* ── Port detail grid (inside port cards) ── */
  .portDetails{
    display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;
    margin-top:10px;padding-top:10px;border-top:1px solid var(--borderSoft);
  }
  .detailItem .k{font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .detailItem .v{font-size:.8rem;font-weight:600;color:var(--fg);margin-top:2px}
  .statusPill{
    display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;
    font-size:.68rem;font-weight:700;text-transform:capitalize;
  }
  .statusPill.ok{background:#e8f5ec;color:#166534}
  .statusPill.muted{background:#f4f4f5;color:#71717a}
  .statusPill.warn{background:#fdf1de;color:#92400e}

  /* ── Drift history ── */
  .driftCard{
    margin-top:10px;padding:14px 16px 16px;border-radius:12px;
    background:var(--card);border:1px solid var(--border);
  }
  .tableScroll{overflow-x:auto;margin-top:10px}
  .driftTable{width:100%;min-width:420px;border-collapse:collapse;font-size:.76rem}
  .driftTable th{
    text-align:left;padding:6px 8px;font-size:.62rem;font-weight:700;
    letter-spacing:.06em;text-transform:uppercase;color:var(--muted);
    border-bottom:1px solid var(--border);
  }
  .driftTable td{padding:6px 8px;border-bottom:1px solid var(--borderSoft);color:var(--fg)}
  .driftTable tr:last-child td{border-bottom:none}

  /* ── Section heading ── */
  .section{margin-top:22px}
  .sectionTitle{
    display:flex;align-items:center;gap:8px;margin:0 0 10px;
    font-size:.68rem;font-weight:700;letter-spacing:.14em;
    text-transform:uppercase;color:var(--muted);
  }
  .sectionTitle::before{content:'';width:14px;height:2px;border-radius:1px;background:var(--accent)}
  .sectionTitle::after{content:'';flex:1;height:1px;background:var(--border)}

  /* ── Port identification cards ── */
  .portCard{
    position:relative;margin-top:10px;
    padding:14px 16px 16px;border-radius:12px;
    background:var(--card);
    border:1px solid var(--border);
    overflow:hidden;
  }
  .portCard::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
    background:var(--accent);
  }
  .portCardHead{display:flex;align-items:center;gap:12px;margin-bottom:10px}
  .portBadge{
    display:inline-flex;align-items:center;justify-content:center;
    padding:6px 11px;border-radius:8px;
    font-family:'SF Mono',Menlo,Consolas,monospace;
    font-size:.76rem;font-weight:700;color:#fff;letter-spacing:.02em;
    background:var(--accent);
    flex-shrink:0;
  }
  .portCardTitle{display:flex;flex-direction:column;gap:1px;min-width:0}
  .portDevice{font-size:.92rem;font-weight:700;color:var(--fg);letter-spacing:-0.01em}
  .portDeviceSub{font-size:.72rem;color:var(--muted);font-weight:500}
  .portImgs{
    display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;
  }
  .portImg{
    border-radius:9px;overflow:hidden;
    border:1px solid var(--border);
    background:#fafafa;
  }
  .portImg img{width:100%;display:block}

  .empty{
    color:var(--muted);font-style:italic;padding:18px;text-align:center;
    font-size:.82rem;
    background:var(--card);border:1px dashed var(--border);border-radius:10px;
  }

  /* ── Console transcript inside port card ── */
  .consoleWrap{margin-top:10px;padding-top:10px;border-top:1px solid var(--borderSoft)}
  .consoleHead{margin-bottom:6px}
  .consoleKey{font-size:.64rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .cmdBlock{
    margin-top:8px;background:#fafafa;border:1px solid var(--border);
    border-radius:8px;overflow:hidden;
  }
  .cmdHeader{
    display:flex;align-items:baseline;gap:8px;padding:6px 10px;
    background:#f4f4f5;border-bottom:1px solid var(--border);
  }
  .cmdName{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
  .cmdLine{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.72rem;color:#3f3f46;background:transparent}
  .cmdOut,.cmdErr{
    margin:0;padding:10px 12px;
    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.74rem;line-height:1.5;
    color:#27272a;background:transparent;
    white-space:pre-wrap;word-break:break-word;
    max-height:380px;overflow:auto;
  }
  .cmdErr{color:#b91c1c;background:#fef2f2}

  @media (max-width:600px){
    .wrap{padding:14px 12px 30px}
    .hero{padding:16px 16px}
    h1{font-size:1.3rem}
    .stat .v{font-size:1.2rem}
    .portCardHead{flex-wrap:wrap}
  }

  /* ── Sticky top bar (PDF download button) ── */
  .topBar{
    position:sticky; top:0; z-index:20;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:10px 18px;
    background:rgba(255,255,255,0.92);
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    border-bottom:1px solid var(--border);
  }
  .topBarTitle{font-size:.78rem;font-weight:700;color:var(--muted);letter-spacing:.04em}
  .pdfBtn{
    display:inline-flex;align-items:center;gap:8px;
    padding:8px 14px;border-radius:10px;
    font-size:.82rem;font-weight:700;
    background:var(--accent);
    color:#fff;border:none;
    cursor:pointer; font-family:inherit;
    transition:opacity .12s;
  }
  .pdfBtn:hover{opacity:.85}
  .pdfBtn svg{width:14px;height:14px}

  /* ── PDF / print niceties ── */
  /* Hide the sticky bar in print and html2pdf snapshots. */
  body.pdfMode .topBar, @media print { .topBar{display:none} }
  body.pdfMode .cmdOut, body.pdfMode .cmdErr,
  @media print { .cmdOut, .cmdErr { max-height:none !important; overflow:visible !important } }
  /* The gradient-text fallbacks that used to live here are gone with the
     gradients themselves — h1 and .stat .v are now solid colours, which
     html2canvas renders correctly without help. */
  body.pdfMode .portImg img { max-height:300px; object-fit:contain; }
  /* Allow port cards to split across pages so we never leave huge gaps. */
  body.pdfMode .portCard { break-inside:auto; page-break-inside:auto; }
  @media print {
    .portCard { break-inside:auto; page-break-inside:auto; }
  }
</style>
</head><body>

<div class="topBar">
  <span class="topBarTitle">Rack Scan Report · ${htmlEscape(d.rackId)}</span>
  <button class="pdfBtn" id="pdfBtn" type="button">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    <span id="pdfBtnLabel">Download PDF</span>
  </button>
</div>

<script>
(function () {
  var btn = document.getElementById('pdfBtn');

  // Hand the user a REAL PDF, rendered server-side (format=pdf → headless
  // Chromium). An Android WebView can't save/display a PDF itself, so we open
  // it in the device's browser / PDF viewer where it can be saved or shared.
  // The URL is this report's URL with format=html swapped for format=pdf (keeps
  // any app_key), hash stripped. Replaces the old html2pdf-from-CDN button,
  // which needed an external script and rendered blank on mobile.
  function openPdf() {
    var url = location.href.replace('format=html', 'format=pdf').replace(/#.*$/, '');
    window.open(url, '_blank');
  }

  if (btn) btn.addEventListener('click', openPdf);

  // Auto-open when the report is loaded with #download in the hash — the app's
  // "Download" button links here so one tap goes straight to the PDF.
  if (window.location.hash === '#download') {
    if (document.readyState === 'complete') setTimeout(openPdf, 300);
    else window.addEventListener('load', function () { setTimeout(openPdf, 300); }, { once: true });
  }

  // #ports — opened straight after the user found a port, so land them on the
  // port detail rather than the top of the report. Done in script because the
  // report renders inside an iframe, and a fragment on an iframe src is not
  // honoured the way it is on a normal navigation.
  if (window.location.hash === '#ports') {
    var goPorts = function () {
      var el = document.getElementById('ports');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    if (document.readyState === 'complete') setTimeout(goPorts, 250);
    else window.addEventListener('load', function () { setTimeout(goPorts, 250); }, { once: true });
  }
})();
</script>

<div class="wrap">

<div class="hero">
  <span class="heroEyebrow">Rack Scan Report</span>
  <h1>${htmlEscape(d.rackId)}</h1>
  <div class="heroMeta">
    <span><span class="k">Scanned:</span> <code>${htmlEscape(ts)}</code></span>
    ${d.units_range ? `<span><span class="k">Occupies:</span> <code>${htmlEscape(d.units_range)}</code></span>` : ''}
    <span><span class="k">Devices:</span> <code>${deviceCount}</code></span>
  </div>
</div>

<!-- One tile, not two. The Devices count was printed three lines above it in
     the hero meta, so the report opened by saying the same number twice under
     different labels — which is the whole of what a reader took from the strip.
     Ports in use is the figure that is NOT stated anywhere else. -->
<div class="stats">
  <div class="stat"><div class="k">Ports · in use</div><div class="v">${connectedPorts}<span class="statOf"> / ${totalPorts}</span></div></div>
</div>

${summaryHtml}

<div class="section">
  <div class="sectionTitle">Rack Image</div>
  ${rackImageHtml}
</div>

<div class="section">
  <div class="sectionTitle">Devices</div>
  ${devicesHtml}
</div>

<div class="section">
  <div class="sectionTitle">Selected Device</div>
  ${selectedDeviceHtml}
</div>

<div class="section" id="ports">
  <div class="sectionTitle">Port Identifications</div>
  ${d.port_identifications.length
    ? portIdsHtml
    : `<p class="empty">No individual ports have been located yet. Use “Find Port” on a switch to add per-port detail here.</p>`}
</div>

<div class="section">
  <div class="sectionTitle">Drift History</div>
  ${driftHtml}
</div>

</div></body></html>`;
}

function renderJSONReport(data) {
  const { _rackDir, ...publicData } = data;
  return JSON.stringify(publicData, null, 2);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCSVReport(data) {
  const lines = [];
  lines.push(`# Rack Scan Report,${data.rackId}`);
  lines.push(`# Timestamp,${data.timestamp || ''}`);
  lines.push(`# Units,${data.units_range || ''}`);
  if (data.port_identifications?.length) {
    lines.push('');
    lines.push('## Port Identifications');
    lines.push(['timestamp','device_index','device_label','device_class','device_position','port','status','cable_color','cable_connector','cable_type'].join(','));
    data.port_identifications.forEach(p => {
      lines.push([p.timestamp, p.device_index, p.device_label, p.device_class, p.device_position, p.port, p.status, p.cable_color, p.cable_connector, p.cable_type].map(csvEscape).join(','));
    });

    // Per-port console transcripts. One row per command run, with the
    // raw output collapsed into a single CSV cell.
    const portsWithConsole = data.port_identifications.filter(p =>
      p.console && Array.isArray(p.console.entries) && p.console.entries.length
    );
    if (portsWithConsole.length) {
      lines.push('');
      lines.push('## Port Command Transcripts');
      lines.push(['timestamp','device_index','device_label','port','host','interface','command_name','command','output','error'].join(','));
      portsWithConsole.forEach(p => {
        const host = p.console.host || '';
        const iface = p.console.interface || '';
        p.console.entries.forEach(e => {
          lines.push([
            p.timestamp, p.device_index, p.device_label, p.port,
            host, iface,
            e.name || '', e.cmd || '', e.output || '', e.error || '',
          ].map(csvEscape).join(','));
        });
      });
    }
  }
  if (data.feedback.total > 0) {
    lines.push('');
    lines.push('## Feedback');
    lines.push(`total,correct,wrong,accuracy`);
    lines.push([data.feedback.total, data.feedback.correct, data.feedback.wrong, data.feedback.accuracy].map(csvEscape).join(','));
    lines.push('');
    lines.push('## Feedback Entries');
    lines.push(['timestamp','feedback_type','device_index','device_class','predicted_port','actual_port','predicted_device_class','actual_device_class','predicted_cable_color','actual_cable_color','predicted_port_count','actual_port_count','is_correct','port_status','cable_color','cable_connector'].join(','));
    data.feedback.entries.forEach(e => {
      lines.push([
        e.timestamp, e.feedback_type, e.device_index, e.device_class,
        e.predicted_port, e.actual_port,
        e.predicted_device_class, e.actual_device_class,
        e.predicted_cable_color, e.actual_cable_color,
        e.predicted_port_count, e.actual_port_count,
        e.is_correct, e.port_status, e.cable_color, e.cable_connector,
      ].map(csvEscape).join(','));
    });
  }
  return lines.join('\n');
}

// Generates the canonical HTML file on disk and returns all formats + paths.
// Best-effort make/model → spec-sheet port count + firmware freshness for
// the report's "Selected Device" section. Deliberately DB-cache-only
// (--no-live): the report regenerates on every open, so this must never
// trigger Agent_scrap's live web fallback (which the /api/specs comments
// document as ~4-9s, up to the 60s worst case) — an unknown model here
// just renders as "not in local catalog" instead of stalling the report.
// Mutates selectedDevice.specs / .firmware in place; never throws.
async function enrichSelectedDeviceSpecsFirmware(selectedDevice) {
  const vendor = selectedDevice?.make;
  let   model  = selectedDevice?.model;
  if (!vendor || !model) return;

  // OCR often garbles a digit or two (e.g. "CRS326-246-2S" for the real
  // "CRS326-24G-2S+RM"). A plain DB lookup would miss that outright, so
  // mirror /api/specs's fromOcr correction — but DB-only (no live retry) to
  // keep this report path bounded. If the top suggestion is a strong match,
  // switch to it for both the specs AND the firmware lookup below, so the
  // two agree on which device they're describing.
  try {
    const specRes = await runAgentCli(['--no-live', `${vendor} ${model}`]);
    if (specRes.ok) {
      selectedDevice.specs = specPayloadFromAgent(specRes, vendor, model);
    } else {
      const suggestions = specRes?.response?.suggestions || [];
      const best = _bestSuggestion(suggestions, model);
      if (best && best.toLowerCase() !== model.toLowerCase()) {
        const retry = await runAgentCli(['--no-live', `${vendor} ${best}`]);
        if (retry.ok) {
          selectedDevice.specs = specPayloadFromAgent(retry, vendor, best);
          selectedDevice.model_matched_from = model;
          model = best; // use the corrected model for the firmware lookup too
          selectedDevice.model = best;
        } else {
          selectedDevice.specs = specPayloadFromAgent(specRes, vendor, model);
        }
      } else {
        selectedDevice.specs = specPayloadFromAgent(specRes, vendor, model);
      }
    }
  } catch (e) {
    selectedDevice.specs = { ok: false, error: e.message };
  }

  // Firmware needs a currentVersion, which OCR only rarely reads off the
  // faceplate. Fall back to the polled monitored_devices row whose model
  // best matches — there's no rackId link between the two, so this is a
  // best-effort fuzzy guess, not a guaranteed "this rack's switch" match.
  let currentVersion = selectedDevice.firmware_version_ocr || null;
  let versionSource = currentVersion ? 'ocr' : null;
  if (!currentVersion) {
    try {
      const scored = portHistoryDb.listDevices()
        .filter(d => d.sw_version && d.model)
        .map(d => ({ d, score: _modelSimilarity(d.model, model) }))
        .sort((a, b) => b.score - a.score);
      if (scored.length && scored[0].score >= 0.5) {
        currentVersion = scored[0].d.sw_version;
        versionSource = `monitored:${scored[0].d.host}`;
      }
    } catch { /* best-effort */ }
  }
  if (!currentVersion) return;

  try {
    const fwRes = await runAgentCli(['--no-live', '--firmware', `${vendor} ${model}`, currentVersion]);
    selectedDevice.firmware = firmwarePayloadFromAgent(fwRes, { vendor, model, currentVersion });
    selectedDevice.firmware.currentVersionSource = versionSource;
  } catch (e) {
    selectedDevice.firmware = { ok: false, error: e.message };
  }
}

// The original upload can be several MB at full camera resolution — fine
// for the pipeline's detection accuracy, way more than a report needs to
// just show what the rack looks like. Downscales + re-compresses to a
// cached copy so the (base64-inlined) report HTML doesn't balloon in size.
// Cached: only regenerated when the source file is newer than the cached
// copy, so repeat report opens don't pay the resize cost again.
async function ensureResizedRackImage(rackDir, relPath) {
  if (!relPath) return relPath;
  try {
    const abs = resolveRelativeArtifact(rackDir, relPath);
    if (!fs.existsSync(abs)) return relPath;
    const imagesDir = path.join(rackDir, 'images');
    const thumbAbs = path.join(imagesDir, 'report_rack_image.jpg');
    const srcStat = fs.statSync(abs);
    const needsBuild = !fs.existsSync(thumbAbs) || fs.statSync(thumbAbs).mtimeMs < srcStat.mtimeMs;
    if (needsBuild) {
      fs.mkdirSync(imagesDir, { recursive: true });
      await sharp(abs)
        .resize({ width: 720, withoutEnlargement: true })
        .jpeg({ quality: 68 })
        .toFile(thumbAbs);
    }
    return 'images/report_rack_image.jpg';
  } catch (e) {
    logger.warn(`[report] rack image resize failed, using original: ${e.message}`);
    return relPath;
  }
}

async function buildScanReport(rackId, { inlineImages = true } = {}) {
  const data = buildScanReportData(rackId);
  data.rackOverviewImage = await ensureResizedRackImage(data._rackDir, data.rackOverviewImage);
  if (data.selectedDevice) {
    await enrichSelectedDeviceSpecsFirmware(data.selectedDevice).catch((e) => {
      logger.warn(`[report] specs/firmware enrichment failed for ${rackId}: ${e.message}`);
    });
    // Recompute now that specs and firmware are populated — the firmware rule
    // and the "on paper" fact are only knowable after the lookup above.
    attachInsights(data);
  }
  const html = renderHTMLReport(data, { inlineImages });
  const reportPath = path.join(data._rackDir, 'report.html');
  fs.writeFileSync(reportPath, html, 'utf8');
  // Keep the canonical scan_result.json in sync whenever a report is built.
  // Failures are swallowed inside writeCanonicalScanResult.
  writeCanonicalScanResult(rackId, data);
  return {
    rackId,
    data,
    html,
    json: renderJSONReport(data),
    csv: renderCSVReport(data),
    reportPath,
  };
}

const SCAN_RESULT_SCHEMA = 'scan_result.v1';

// Writes outputs/<rackId>/scan_result.json — the single canonical merged view
// of one scan: metadata + devices + units + ports + selection + console +
// feedback. Atomic (write tmp → rename) so partial writes can't be observed.
//
// Pass `prebuiltData` when you already have the result of buildScanReportData
// to avoid re-reading the source files; otherwise we build it ourselves.
function writeCanonicalScanResult(rackId, prebuiltData) {
  let outPath;
  try {
    const data = prebuiltData || buildScanReportData(rackId);
    const { _rackDir, ...publicData } = data;

    let selectedPort = null;
    const selPath = path.join(_rackDir, 'selected_port_info.json');
    if (fs.existsSync(selPath)) {
      try { selectedPort = JSON.parse(fs.readFileSync(selPath, 'utf8')); }
      catch (e) { logger.warn(`[scan_result] selected_port_info parse failed for ${rackId}: ${e.message}`); }
    }

    const meta = readMeta(rackId) || {};
    const result = {
      schema: SCAN_RESULT_SCHEMA,
      rackId,
      createdAt: meta.timestamp || null,
      updatedAt: new Date().toISOString(),
      createdBy: meta.userId ? { userId: meta.userId } : null,
      image: {
        imageHash:         meta.imageHash || null,
        originalImagePath: meta.imagePath || null,
        qualityWarning:    meta.qualityWarning || null,
        qualityWarningMsg: meta.qualityWarningMsg || null,
      },
      ...publicData,
      selectedPort,
    };

    // Overlay any user feedback corrections on top of the model's
    // predictions before persisting. Mutates `result` in place; the
    // original predictions are preserved on each modified field's
    // `_correction.original` for audit.
    applyFeedbackOverrides(rackId, result);

    outPath = path.join(_rackDir, 'scan_result.json');
    const tmpPath = outPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
    fs.renameSync(tmpPath, outPath);
    // After every canonical write, regen the topology snapshot in the
    // background so the topology view stays in sync with the scan.
    scheduleTopologyRegen(rackId);
    return result;
  } catch (err) {
    logger.error(`[scan_result] write failed for ${rackId}: ${err.message}`);
    return null;
  }
}

// Schedule a canonical-result refresh for after the response is sent. Used by
// mutation endpoints that don't already build the report inline. Also kicks
// off per-device OCR in the background — fully silent, the user never sees
// it; the result lands in outputs/<rackId>/ocr_devices.json and synth.py
// picks it up the next time CMDB is built.
function scheduleCanonicalRefresh(rackId) {
  setImmediate(() => {
    writeCanonicalScanResult(rackId);
    scheduleOcrDevices(rackId);
    scheduleOcrLabels(rackId);
    scheduleCableEnrichment(rackId);
  });
}

// Fire-and-forget: classify the cable (connector + colour) on EVERY connected
// port after a scan finishes, so the whole rack shows cable info — not just the
// one port a user taps. Runs in a worker so the initial analyze response stays
// fast; when it finishes we rewrite scan_result.json so the client picks the
// cable_* fields up on its next load. Idempotent + guarded: skips racks whose
// device_unit_map.json is already marked cables_enriched.
// Cheap gate for the confirmed-rack bypass: is there anything to match against
// for this org? Avoids paying the pHash+embedding CLI cost on every analyze
// when the org has never confirmed a rack.
const _AL_DATA_DIR = path.join(PROJECT_ROOT, 'active_learning_Cache', 'data');
function hasConfirmedRacks(orgId) {
  const base = orgId ? path.join(_AL_DATA_DIR, `org_${orgId}`) : _AL_DATA_DIR;
  const p = path.join(base, 'confirmed_racks', 'confirmed_racks.json');
  try {
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && Object.keys(j).length > 0;
  } catch (_) { return false; }
}

const _cableEnrichRunning = new Set();
function scheduleCableEnrichment(rackId) {
  if (!rackId || _cableEnrichRunning.has(rackId)) return;
  const rackDir  = path.join(outputsDir, rackId);
  const mapPath  = path.join(rackDir, 'device_unit_map.json');
  const metaPath = path.join(rackDir, 'scan_meta.json');
  if (!fs.existsSync(mapPath) || !fs.existsSync(metaPath)) return;
  // Already enriched? Nothing to do — keeps repeated canonical refreshes cheap.
  try {
    const dm = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (dm && dm.cables_enriched) return;
  } catch (_) { return; }
  let imagePath = null;
  try { imagePath = JSON.parse(fs.readFileSync(metaPath, 'utf8'))?.imagePath; } catch (_) { return; }
  if (!imagePath || !fs.existsSync(imagePath)) return;

  _cableEnrichRunning.add(rackId);
  pool.request('enrich_cables', {
    image_path:  imagePath,
    config_path: CONFIG_PATH,
    output_dir:  rackDir,
  })
    .then(() => {
      // Surface the freshly-attached cable_* fields into the canonical result.
      writeCanonicalScanResult(rackId);
      logger.info({ event: 'cable.enriched', rackId }, `cable enrichment done for ${rackId}`);
    })
    .catch(err => {
      logger.warn(`[cable-enrich] ${rackId} failed: ${err.message}`);
    })
    .finally(() => { _cableEnrichRunning.delete(rackId); });
}

// Fire-and-forget full-image label OCR after a scan finishes. Per-device OCR
// (scheduleOcrDevices) only sees the crop YOLO produced, so when the detector
// misses a device or boxes it tight enough to clip its faceplate label, the
// per-device pass returns empty text. Running label OCR on the whole rack
// photo recovers brand badges (PLANAR, TRIPP-LITE, AUDIOCODES, SONY, …) and
// rack-applied labels that fall outside any single device's bbox — the GET
// /api/ocr/labels/:rackId endpoint then maps those tokens back to devices by
// Y-overlap and surfaces a brand-token reclassification for the client.
const _ocrLabelsRunning = new Set();
function scheduleOcrLabels(rackId) {
  if (!rackId || _ocrLabelsRunning.has(rackId)) return;
  const rackDir   = path.join(outputsDir, rackId);
  const frontPath = path.join(rackDir, 'labels-front.json');
  const metaPath  = path.join(rackDir, 'scan_meta.json');
  if (!fs.existsSync(metaPath) || fs.existsSync(frontPath)) return;
  let imagePath = null;
  try { imagePath = JSON.parse(fs.readFileSync(metaPath, 'utf8'))?.imagePath; } catch (_) { return; }
  if (!imagePath || !fs.existsSync(imagePath)) return;
  _ocrLabelsRunning.add(rackId);
  runOcrLabels(imagePath)
    .then(result => {
      fs.mkdirSync(rackDir, { recursive: true });
      fs.writeFileSync(frontPath, JSON.stringify(result, null, 2));
    })
    .catch(err => {
      logger.warn(`[ocr_labels] ${rackId} failed: ${err.message}`);
    })
    .finally(() => { _ocrLabelsRunning.delete(rackId); });
}

// Fire-and-forget per-device OCR after a scan finishes. Runs only when
// outputs/<rackId>/ocr_devices.json doesn't already exist — re-running OCR
// on every canonical refresh would be wasteful (1-2 min on CPU). The user
// can still trigger a re-run via POST /api/scan/:rackId/ocr-devices.
//
// When OCR completes, we re-trigger downstream syncs (Netdisco, topology,
// canonical scan_result) so Netdisco/CMDB pick up real make/model instead
// of synth values. Without this re-sync, Netdisco would always be 1-2 min
// behind reality because its initial sync fires before OCR finishes.
const _ocrRunning = new Set();
function scheduleOcrDevices(rackId) {
  if (!rackId || _ocrRunning.has(rackId)) return;
  const rackDir = path.join(outputsDir, rackId);
  const ocrPath = path.join(rackDir, 'ocr_devices.json');
  const dumPath = path.join(rackDir, 'device_unit_map.json');
  // Need a device_unit_map to know what to crop; skip silently otherwise.
  if (!fs.existsSync(dumPath) || fs.existsSync(ocrPath)) return;
  _ocrRunning.add(rackId);
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.ocr_devices', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  // Don't keep node process alive waiting on this; we just want it to run.
  if (typeof child.unref === 'function') child.unref();
  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('close', () => {
    _ocrRunning.delete(rackId);
    if (!fs.existsSync(ocrPath)) {
      logger.warn(`[ocr_devices] ${rackId} produced no output: ${stderr.slice(-300)}`);
      return;
    }
    // OCR ran — re-sync downstream consumers so they pick up the real
    // make/model. All silent / fire-and-forget; the user never sees this.
    try { writeCanonicalScanResult(rackId); } catch (_) {}
    try {
      const ndProxy = require('./netdisco_proxy');
      if (ndProxy && typeof ndProxy.scheduleNetdiscoSync === 'function') {
        ndProxy.scheduleNetdiscoSync(rackId);
      }
    } catch (e) {
      logger.warn(`[ocr_devices→netdisco] resync skipped for ${rackId}: ${e.message}`);
    }
  });
  child.on('error', err => {
    _ocrRunning.delete(rackId);
    logger.warn(`[ocr_devices] spawn failed for ${rackId}: ${err.message}`);
  });
}

// Resolve a working Python interpreter once at startup. Prefer the project
// venv if it actually runs (cross-machine venvs can be broken stubs pointing
// at user-specific Python paths that don't exist on this PC), otherwise fall
// back to PYTHON_BIN env or "python" on PATH.
let _resolvedPython = null;
function resolvePythonBin() {
  if (_resolvedPython) return _resolvedPython;
  const { spawnSync } = require('child_process');
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe'));
  } else {
    candidates.push(path.join(__dirname, '..', 'venv', 'bin', 'python'));
  }
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN);
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');
  candidates.push('python');

  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import sys; sys.exit(0)'], {
        stdio: 'ignore', timeout: 5000, windowsHide: true,
      });
      if (r.status === 0) {
        _resolvedPython = c;
        logger.info(`[python] using interpreter: ${c}`);
        return c;
      }
    } catch (_) { /* try next */ }
  }
  _resolvedPython = candidates[candidates.length - 1];
  logger.warn(`[python] no working interpreter found; falling back to ${_resolvedPython}`);
  return _resolvedPython;
}

// Background topology snapshot regeneration — runs servicenow/topology_generate.py
// after every canonical refresh so the topology view works for any scanned
// rack without a manual bootstrap step. Pure file I/O on the Python side
// (no ServiceNow API calls), so failure here is non-fatal and doesn't block
// the scan flow. Coalesces concurrent refreshes per rack.
const _topoRegenInflight = new Set();
function scheduleTopologyRegen(rackId) {
  if (!rackId || _topoRegenInflight.has(rackId)) return;
  _topoRegenInflight.add(rackId);
  const { spawn } = require('child_process');
  const pyBin = resolvePythonBin();
  const script = path.join(__dirname, '..', 'servicenow', 'topology_generate.py');
  const child = spawn(pyBin, [script, '--rack-id', rackId], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('close', (code) => {
    _topoRegenInflight.delete(rackId);
    if (code === 0) {
      logger.info({ event: 'topology.regenerated', rackId },
        `topology regenerated for ${rackId}`);
      recordEvent('topology.regenerated', { rackId });
    } else {
      logger.warn({ event: 'topology.regen_failed', rackId, exit: code,
        stderr: (err.trim() || out.trim()).slice(0, 500) },
        `topology regen failed for ${rackId} (exit ${code})`);
      recordEvent('topology.regen_failed', { rackId, exit: code });
    }
    // Whether topology regen succeeded or not, push the scan into Netdisco
    // so its DB stays in lock-step with what's on disk. Best-effort —
    // failure is logged inside the proxy module and never blocks the response.
    try {
      const ndProxy = require('./netdisco_proxy');
      if (ndProxy && typeof ndProxy.scheduleNetdiscoSync === 'function') {
        ndProxy.scheduleNetdiscoSync(rackId);
      }
    } catch (e) {
      logger.warn(`[netdisco] sync skipped for ${rackId}: ${e.message}`);
    }

    // Compute the CMDB diff and (if non-empty) auto-open / update the SR.
    // No direct CMDB writes happen here; the actual push waits for the
    // ticket to be approved + closed-complete in ServiceNow, at which
    // point the 5-min poller invokes bootstrap_cmdb_full.py.
    try {
      if (_cmdbTicketProxy && typeof _cmdbTicketProxy.scheduleCmdbTicket === 'function') {
        _cmdbTicketProxy.scheduleCmdbTicket(rackId);
      }
    } catch (e) {
      logger.warn(`[cmdb-ticket] auto-create skipped for ${rackId}: ${e.message}`);
    }
  });
  child.on('error', (e) => {
    _topoRegenInflight.delete(rackId);
    logger.warn(`[topology] failed to spawn for ${rackId}: ${e.message}`);
  });
}

// Lazy-loaded puppeteer + a single shared browser, kept warm across requests
// because launching Chromium is ~1s and we hit it from every share endpoint.
let _puppeteer = null;
let _browserPromise = null;
async function getBrowser() {
  if (!_puppeteer) _puppeteer = require('puppeteer');
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      if (b.connected ?? b.isConnected?.()) return b;
    } catch (_) { /* fall through and relaunch */ }
  }
  _browserPromise = _puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // Belt and braces for the crashpad failure the Dockerfile's HOME fixes.
      // We never collect crash reports from this browser — it renders one HTML
      // file to PDF and exits — so the handler is pure liability: when it
      // cannot write its database it does not degrade, it aborts the launch.
      '--disable-crash-reporter',
    ],
  }).catch((err) => {
    // Every caller turns this into "Could not generate the report. Please try
    // again.", which says nothing about the cause and sent the last failure to
    // be diagnosed by reading the Dockerfile. Name the real one in the log:
    // the two that actually happen are a missing Chromium (the download went to
    // a cache directory this user cannot read) and a missing shared library.
    logger.error(
      { err: err.message, cacheDir: process.env.PUPPETEER_CACHE_DIR || '(default: $HOME/.cache/puppeteer)', home: process.env.HOME, uid: process.getuid?.() },
      '[pdf] headless Chromium failed to launch — every report share and download will fail until this is fixed',
    );
    _browserPromise = null;   // don't cache the rejection; let the next call retry
    throw err;
  });
  return _browserPromise;
}

// Renders the canonical report.html through headless Chromium and writes
// report.pdf next to it. Body class `pdfMode` triggers the print-mode CSS that
// already lives in the HTML (hides the top bar, unclamps console output, etc.).
// Which tenant should own a scan this person just ran.
//
// Their own, when they have one. Owners and org_admins do NOT — role is what
// gets them access, not membership of a site — and rack_owners.tenant_id is
// NOT NULL, so `claimRack` returned early for them and their scans were never
// recorded at all. The owner dashboard counts rows in that table, which is why
// an owner could run a dozen scans and watch the total sit at one or two: it
// was counting everyone's scans except their own.
//
// The `default` tenant always exists (auth.js creates it at startup), so it is
// a real row to point at rather than a placeholder. created_by still records
// who ran it, so nothing about attribution is lost.
function scanOwnerTenantId(authPayload) {
  const own = authPayload?.tenantId;
  if (own) return own;
  if (!authPayload?.sub) return null;      // not signed in — nothing to claim
  try { return auth.getDefaultTenantId() || null; } catch { return null; }
}

async function buildScanReportPDF(rackId) {
  const built = await buildScanReport(rackId);
  const pdfPath = path.join(built.data._rackDir, 'report.pdf');
  const fileUrl = 'file:///' + built.reportPath.replace(/\\/g, '/').replace(/^\//, '');

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Block external network requests — the report HTML embeds an html2pdf
    // CDN script we don't need server-side, and we don't want PDF generation
    // to hang if the host is offline or behind a firewall.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('file:') || url.startsWith('data:')) return req.continue();
      return req.abort();
    });

    await page.goto(fileUrl, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(() => document.body.classList.add('pdfMode'));
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
    });
  } finally {
    await page.close().catch(() => {});
  }
  return { ...built, pdfPath };
}

// ── Routes ────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', service: 'RackTrack API' });
});

// Auth endpoints (signup, verify, login, resend, me)
// Throttle credential endpoints before the auth routes handle them.
// Every endpoint that accepts a credential OR a one-time code must be
// throttled. verify-reset-code and verify were missing: they check a 6-digit
// code without consuming it and with no attempt counter, so an unthrottled
// caller could brute-force the ~10^6 space in seconds and then mint a full
// token via login-with-code — account takeover without the password.
app.use(['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/auth/login-with-code',
  '/api/auth/verify-reset-code', '/api/auth/verify', '/api/auth/resend-code'], authLimit);
auth.registerRoutes(app);
// "Continue with Google / Apple / Facebook". Registered after auth so it can
// reuse the same token minting; its routes live under /api/auth/oauth/* and are
// therefore already exempt from the pending-org gate in requireAuth.
require('./socialAuth').registerRoutes(app);

// ── Audit log query (auth-required) ───────────────────────────
//
// GET /api/audit?action=&targetType=&targetId=&status=&since=&until=&limit=&offset=
//
// By default returns ONLY the calling user's events. Pass `?scope=all` to see
// every event — but only if the caller's username appears in the
// AUDIT_ADMINS env var (comma-separated). Without admin status, scope=all is
// silently downgraded to scope=self so we never leak other users' actions.
app.get('/api/audit', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isAdmin = adminUsers.includes(req.user.username);
  // scope=self  → only this user's events
  // scope=tenant → every event in this user's tenant (admin-gated)
  // scope=all   → cross-tenant view (super-admin; downgraded to tenant
  //               for non-admins so we never leak across tenants)
  let scope = req.query.scope || 'self';
  if (scope === 'all' && !isAdmin) scope = 'tenant';
  if (scope === 'tenant' && !isAdmin) scope = 'self';

  try {
    const rows = audit.query({
      userId:     scope === 'self'   ? req.user.id        : undefined,
      tenantId:   scope === 'tenant' ? req.user.tenant_id : undefined,
      action:     req.query.action     || undefined,
      targetType: req.query.targetType || undefined,
      targetId:   req.query.targetId   || undefined,
      status:     req.query.status     || undefined,
      sinceTs:    req.query.since      || undefined,
      untilTs:    req.query.until      || undefined,
      limit:      req.query.limit      || 100,
      offset:     req.query.offset     || 0,
    });
    res.json({ ok: true, scope, count: rows.length, events: rows });
  } catch (err) {
    logger.error('[audit] query failed:', err);
    res.status(500).json({ ok: false, error: 'Audit query failed' });
  }
});

// ── Application log dashboard (admin-gated) ───────────────────────────
//
// The pino log stream is mirrored into SQLite by lib/log-store.js. These
// endpoints back the LogsPage: a filterable, auto-refreshing view of what the
// server has actually been logging (email/SMTP results, errors, HTTP, etc.).
// Gated to owners or the AUDIT_ADMINS allow-list — same bar as the ops
// dashboard — since logs can carry operational detail members shouldn't see.
const logStore = require('./lib/log-store');

function requireLogAdmin(req, res) {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowed = req.user.role === 'owner' || adminUsers.includes(req.user.username);
  if (!allowed) { res.status(403).json({ error: 'Admin access required' }); return false; }
  return true;
}

// GET /api/logs?level=&q=&requestId=&since=&until=&limit=&offset=
app.get('/api/logs', auth.requireAuth, (req, res) => {
  if (!requireLogAdmin(req, res)) return;
  try {
    const { rows, total } = logStore.queryLogs({
      level:     req.query.level     || undefined,
      q:         req.query.q         || undefined,
      requestId: req.query.requestId || undefined,
      since:     req.query.since     || undefined,
      until:     req.query.until     || undefined,
      limit:     req.query.limit     || 200,
      offset:    req.query.offset    || 0,
    });
    res.json({ ok: true, count: rows.length, total, logs: rows });
  } catch (err) {
    logger.error({ err: err.message }, '[logs] query failed');
    res.status(500).json({ ok: false, error: 'Log query failed' });
  }
});

// GET /api/logs/stats?since=  → level histogram + totals for the stat tiles.
app.get('/api/logs/stats', auth.requireAuth, (req, res) => {
  if (!requireLogAdmin(req, res)) return;
  try {
    res.json({ ok: true, ...logStore.logStats(req.query.since || undefined) });
  } catch (err) {
    logger.error({ err: err.message }, '[logs] stats failed');
    res.status(500).json({ ok: false, error: 'Log stats failed' });
  }
});

// POST /api/logs/clear  → wipe every stored log line ("start fresh").
// Same admin gate as reading them. Audited, and we log one line immediately
// afterwards so the fresh log records who cleared it and when.
app.post('/api/logs/clear', auth.requireAuth, (req, res) => {
  if (!requireLogAdmin(req, res)) return;
  try {
    const removed = logStore.clearAll();
    audit.log({ req, action: 'logs.clear', status: 'ok', payload: { removed } });
    logger.info({ event: 'logs.cleared', removed, by: req.user?.username },
      `logs cleared (${removed} entries removed)`);
    res.json({ ok: true, removed });
  } catch (err) {
    logger.error({ err: err.message }, '[logs] clear failed');
    res.status(500).json({ ok: false, error: 'Could not clear logs' });
  }
});

// GET /api/logs/:id  → one row with its full parsed JSON line (row detail).
app.get('/api/logs/:id', auth.requireAuth, (req, res) => {
  if (!requireLogAdmin(req, res)) return;
  try {
    const row = logStore.getLog(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, log: row });
  } catch (err) {
    logger.error({ err: err.message }, '[logs] detail failed');
    res.status(500).json({ ok: false, error: 'Log detail failed' });
  }
});

// ── Live operations dashboard ────────────────────────────────────────
// GET /api/admin/dashboard → one JSON snapshot the DashboardPage polls every
// few seconds. Aggregates the audit log (who did what, ok/fail, errors),
// the user/org tables, and feedback.jsonl (right/wrong accuracy) — all cheap
// indexed SQLite reads plus one small file scan. Owner-only, or anyone in the
// AUDIT_ADMINS allow-list, so per-org data never leaks to ordinary members.
app.get('/api/admin/dashboard', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowed = req.user.role === 'owner' || adminUsers.includes(req.user.username);
  if (!allowed) return res.status(403).json({ error: 'Owner access required' });

  try {
    const adb  = audit._db;
    const one  = (sql, ...p) => adb.prepare(sql).get(...p);
    const many = (sql, ...p) => adb.prepare(sql).all(...p);

    // Correlated sub-select turns a tenant_id into its org name in one shot.
    const orgOf = `(SELECT o.name FROM tenants t JOIN organizations o
                      ON o.id = t.organization_id WHERE t.id = a.tenant_id)`;

    // Headline totals.
    const users   = one("SELECT COUNT(*) n FROM users").n;
    const orgs    = one("SELECT COUNT(*) n FROM organizations").n;
    const scansOk = one("SELECT COUNT(*) n FROM audit_log WHERE action='scan.create' AND status='ok'").n;
    const scansFail = one("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'scan.%' AND status='fail'").n;
    const scansToday = one("SELECT COUNT(*) n FROM audit_log WHERE action='scan.create' AND status='ok' AND ts >= datetime('now','start of day')").n;
    const activeToday = one("SELECT COUNT(DISTINCT user_id) n FROM audit_log WHERE ts >= datetime('now','start of day') AND user_id IS NOT NULL").n;
    const totalEvents = one("SELECT COUNT(*) n FROM audit_log").n;
    const totalFails  = one("SELECT COUNT(*) n FROM audit_log WHERE status='fail'").n;

    // Feedback accuracy (right vs wrong), from the memoised tally.
    const { right: fbRight, wrong: fbWrong } = feedbackTally();

    // Live activity feed — most recent events, org-resolved.
    // Events at the auth gate (sign-in / sign-up / reset) have no logged-in
    // session, so username is NULL. We fall back to the *attempted* identifier
    // captured in the payload and flag the row as a guest so the UI can label
    // it clearly instead of showing a bare "anonymous".
    const recent = many(`
      SELECT a.ts,
             COALESCE(NULLIF(a.username,''), json_extract(a.payload,'$.ident')) AS username,
             (SELECT public_id FROM users u WHERE u.id = a.user_id) AS actor_id,
             CASE WHEN COALESCE(a.username,'') = '' THEN 1 ELSE 0 END AS guest,
             a.action, a.target_id, a.status, a.error, ${orgOf} AS org
      FROM audit_log a ORDER BY a.id DESC LIMIT 80`);

    // Recent failures with their error text.
    const errors = many(`
      SELECT a.ts,
             COALESCE(NULLIF(a.username,''), json_extract(a.payload,'$.ident')) AS username,
             CASE WHEN COALESCE(a.username,'') = '' THEN 1 ELSE 0 END AS guest,
             a.action, a.error, ${orgOf} AS org
      FROM audit_log a
      WHERE a.status='fail' AND a.error IS NOT NULL AND a.error <> ''
      ORDER BY a.id DESC LIMIT 30`);

    // Busiest scanners. Resolve the real name from the user the event is
    // attributed to (a.user_id) — the denormalized a.username is often blank
    // for owner/admin scans, which is why the board showed "(anonymous)".
    const topUsers = many(`
      SELECT COALESCE(NULLIF(u.username,''), NULLIF(a.username,''), '(anonymous)') AS username,
             COUNT(*) AS scans
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action='scan.create' AND a.status='ok'
      GROUP BY COALESCE(a.user_id, a.username) ORDER BY scans DESC LIMIT 10`);

    // Scans per organization. Resolve the org via the Site first, then the
    // user's own organization (owners/admins have no tenant_id, which is why
    // their scans fell into "(no org)").
    const orgOfUser = `(SELECT o.name FROM users u JOIN organizations o
                          ON o.id = u.organization_id WHERE u.id = a.user_id)`;
    const byOrg = many(`
      SELECT COALESCE(${orgOf}, ${orgOfUser}, '(no org)') AS org, COUNT(*) AS scans
      FROM audit_log a WHERE a.action='scan.create' AND a.status='ok'
      GROUP BY org ORDER BY scans DESC LIMIT 10`);

    // Site (tenant) name straight off the event, for scan attribution.
    const siteOf = `(SELECT t.name FROM tenants t WHERE t.id = a.tenant_id)`;

    // Scans per site — the same board as byOrg, one level finer.
    const bySite = many(`
      SELECT COALESCE(${siteOf}, '(no site)') AS site, COUNT(*) AS scans
      FROM audit_log a WHERE a.action='scan.create' AND a.status='ok'
      GROUP BY site ORDER BY scans DESC LIMIT 10`);

    // The scans themselves — each recent scan with who made it and where
    // (site + org), so the dashboard can show the work, not just the counts.
    const recentScans = many(`
      SELECT a.ts, a.target_id AS rack,
             COALESCE(NULLIF(u.username,''), NULLIF(a.username,''), '(anonymous)') AS username,
             ${siteOf} AS site,
             COALESCE(${orgOf}, ${orgOfUser}) AS org
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action='scan.create' AND a.status='ok'
      ORDER BY a.id DESC LIMIT 100`);

    // Action mix — EVERY action type (ok vs fail), nothing capped.
    const actions = many(`
      SELECT action,
             SUM(CASE WHEN status='ok'   THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) AS fail
      FROM audit_log GROUP BY action ORDER BY (ok+fail) DESC`);

    // EVERY user with their full activity — role, org, scans, total events,
    // failures, and when they were last seen.
    const allUsers = many(`
      SELECT u.username, u.email, u.role, u.active, u.public_id,
             (SELECT o.name FROM organizations o WHERE o.id = u.organization_id) AS org,
             (SELECT COUNT(*) FROM audit_log a WHERE a.user_id = u.id AND a.action='scan.create' AND a.status='ok') AS scans,
             (SELECT COUNT(*) FROM audit_log a WHERE a.user_id = u.id) AS events,
             (SELECT COUNT(*) FROM audit_log a WHERE a.user_id = u.id AND a.status='fail') AS fails,
             (SELECT MAX(a.ts) FROM audit_log a WHERE a.user_id = u.id) AS last_active
      FROM users u ORDER BY events DESC, scans DESC`);

    // EVERY organization with members + scans + status.
    const allOrgs = many(`
      SELECT o.name, o.status,
             (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS members,
             (SELECT COUNT(*) FROM audit_log a WHERE a.action='scan.create' AND a.status='ok'
                AND a.tenant_id IN (SELECT t.id FROM tenants t WHERE t.organization_id = o.id)) AS scans
      FROM organizations o ORDER BY scans DESC`);

    // Auth activity.
    const auth_ = {
      logins_ok:   one("SELECT COUNT(*) n FROM audit_log WHERE action='auth.login' AND status='ok'").n,
      logins_fail: one("SELECT COUNT(*) n FROM audit_log WHERE action='auth.login' AND status='fail'").n,
      signups:     one("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'auth.signup%' AND status='ok'").n,
      resets:      one("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'auth.forgot_password%'").n,
      invites:     one("SELECT COUNT(*) n FROM audit_log WHERE action='invite.accept'").n,
    };

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      totals: {
        users, orgs, scansOk, scansFail, scansToday, activeToday,
        totalEvents, totalFails,
        successRate: totalEvents ? Math.round((1 - totalFails / totalEvents) * 100) : null,
      },
      feedback: {
        right: fbRight, wrong: fbWrong,
        accuracy: (fbRight + fbWrong) ? Math.round(fbRight / (fbRight + fbWrong) * 100) : null,
      },
      auth: auth_,
      recent, errors, topUsers, byOrg, bySite, recentScans, actions,
      allUsers, allOrgs,
    });
  } catch (err) {
    logger.error('[dashboard] query failed:', err);
    res.status(500).json({ ok: false, error: 'Dashboard query failed' });
  }
});

// ── Active-learning loop ─────────────────────────────────────────────
// POST /api/admin/active-learning/cycle  → fire one ingest+retrain cycle.
// Heavy job: spawned as a detached subprocess so the HTTP request returns
// immediately. Caller polls GET /api/admin/active-learning/status for state.
//
// Restricted to AUDIT_ADMINS (same allow-list used for org-wide audit
// access). Logs every invocation as a business event so it shows up in
// metrics + the audit trail.
const _alState = { running: false, lastRunAt: null, lastExitCode: null, lastResult: null };

app.post('/api/admin/active-learning/cycle', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminUsers.length && !adminUsers.includes(req.user.username)) {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }
  if (_alState.running) {
    return res.status(409).json({ ok: false, error: 'cycle already running',
      startedAt: _alState.lastRunAt });
  }

  _alState.running = true;
  _alState.lastRunAt = new Date().toISOString();
  recordEvent('active_learning.cycle.started', { triggeredBy: req.user.username });
  audit.log({ req, action: 'active_learning.cycle', status: 'ok',
    payload: { triggeredBy: req.user.username } });

  const py = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
  const child = require('child_process').spawn(
    py, ['-m', 'retraining_learning.run_loop', '--once'],
    { cwd: PROJECT_ROOT, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('exit', (code) => {
    _alState.running = false;
    _alState.lastExitCode = code;
    _alState.lastResult = {
      finishedAt: new Date().toISOString(),
      exitCode: code,
      stdoutTail: stdout.split('\n').slice(-30).join('\n'),
      stderrTail: stderr.split('\n').slice(-30).join('\n'),
    };
    logger.info({
      event: 'active_learning.cycle.finished',
      exitCode: code,
      stdoutTail: stdout.slice(-500),
      stderrTail: stderr.slice(-500),
    }, `active-learning cycle exit=${code}`);
    recordEvent('active_learning.cycle.finished', { exitCode: code });
  });

  res.status(202).json({
    ok: true, started: true,
    startedAt: _alState.lastRunAt,
    pollAt: '/api/admin/active-learning/status',
  });
});

app.get('/api/admin/active-learning/status', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminUsers.length && !adminUsers.includes(req.user.username)) {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }
  res.json({ ok: true, ..._alState });
});

// ── Orphan GC (admin-only) ──────────────────────────────────────────
// POST /api/admin/orphan-gc/run  body: { dryRun?: bool, retentionDays?: int }
// Lists outputs/<rackId>/ folders with no rack_owners row + (when
// dryRun=false) deletes them. Default dryRun=true so it never destroys
// anything by accident.
function _isAdmin(req) {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return adminUsers.length === 0 || adminUsers.includes(req.user.username);
}

app.post('/api/admin/orphan-gc/run', auth.requireAuth, (req, res) => {
  if (!_isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin only' });
  const dryRun = req.body?.dryRun !== false;       // default true
  const retentionDays = Number(req.body?.retentionDays) || 14;
  try {
    const summary = orphanGC.run({ dryRun, retentionDays });
    audit.log({ req, action: 'orphan_gc.run', status: 'ok', payload: {
      dryRun, retentionDays,
      scanned: summary.scanned, removed: summary.removed,
      freedBytes: summary.freedBytes,
    }});
    recordEvent('orphan_gc.run', { dryRun, removed: summary.removed });
    res.json({ ok: true, ...summary });
  } catch (e) {
    logger.error({ event: 'orphan_gc.failed', err: e.message }, 'orphan GC failed');
    res.status(500).json({ ok: false, error: 'orphan GC failed' });
  }
});

// Scheduled daily orphan GC. Default: dry-run only (logs counts but
// doesn't delete) so an operator can review the metric before
// flipping ORPHAN_GC_APPLY=1.
const _orphanGcIntervalMs = 24 * 60 * 60 * 1000;
const _orphanGcApply = process.env.ORPHAN_GC_APPLY === '1';
const _orphanGcRetentionDays = parseInt(process.env.ORPHAN_GC_RETENTION_DAYS, 10) || 14;
setInterval(() => {
  try {
    const summary = orphanGC.run({
      dryRun: !_orphanGcApply,
      retentionDays: _orphanGcRetentionDays,
    });
    logger.info({
      event: 'orphan_gc.scheduled',
      ...summary, orphans: undefined,   // omit per-folder list from log
      sampleOrphans: (summary.orphans || []).slice(0, 5).map(o => o.rackId),
    }, `scheduled orphan GC: ${summary.removed}/${summary.scanned} ${_orphanGcApply ? 'pruned' : 'would-prune'}`);
    // When the scheduled job actually deletes customer data, record it in the
    // tamper-evident audit trail — same as the manual endpoint does. A system
    // actor (no req) stands in for the cron. Dry-runs delete nothing, so this
    // only fires once apply is deliberately enabled.
    if (_orphanGcApply && summary.removed > 0) {
      audit.log({
        user: { id: null, username: 'system' },
        action: 'orphan_gc.scheduled',
        status: 'ok',
        payload: {
          scheduled: true,
          retentionDays: _orphanGcRetentionDays,
          scanned: summary.scanned, removed: summary.removed,
          freedBytes: summary.freedBytes,
          sampleOrphans: (summary.orphans || []).slice(0, 5).map(o => o.rackId),
        },
      });
    }
  } catch (e) {
    logger.warn({ event: 'orphan_gc.scheduled_failed', err: e.message },
      `scheduled orphan GC failed: ${e.message}`);
  }
}, _orphanGcIntervalMs).unref();

/**
 * POST /api/detect
 * Stateless live-overlay detection — runs only YOLO bbox classification on
 * the uploaded JPEG. NO rack folder, NO OCR, NO port detection, NO audit
 * log, NO image renders. Used by the Camera viewfinder's per-frame loop.
 *
 * Response: { devices: [{ class_name, confidence, bbox:[x,y,w,h] }],
 *             image_size: { w, h } }
 */
app.post('/api/detect', detectLimit, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  const tmpPath = req.file.path;
  try {
    const result = await pool.request('detect_only', {
      image_path:  tmpPath,
      config_path: CONFIG_PATH,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'detection failed' });
    }
    res.json({
      devices:    result.devices || [],
      image_size: result.image_size || null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'detect failed');
    res.status(500).json({ error: 'detection failed' });
  } finally {
    safeUnlink(tmpPath);
  }
});

/**
 * POST /api/analyze
 * 1. Hash the uploaded image → RK-XXXXXXXX
 * 2. If outputs/RK-XXXXXXXX/device_unit_map.json exists → return cached result
 * 3. Otherwise run pipeline --detect_only, save outputs, return fresh result
 */
// Lets a mobile client reclaim a scan it started but lost when iOS suspended
// the app mid-analysis. The client sends a random `clientJobId`; we record
// jobId -> rackId here by hooking res.json, so every return path (cache hit,
// success, error) is captured even if the client socket already closed — the
// handler still runs to completion server-side. No-op without a clientJobId,
// so web and older clients are unaffected.
function trackScanJob(req, res) {
  const jobId = req.body && req.body.clientJobId;
  if (!scanJobs.isValidId(jobId)) return;
  scanJobs.start(jobId);
  const _json = res.json.bind(res);
  res.json = (payload) => {
    try {
      const rackId = payload && (payload.rackId
        || (Array.isArray(payload.racks) && (payload.racks.find(r => r && r.rackId) || {}).rackId));
      if (res.statusCode < 400 && rackId) scanJobs.done(jobId, rackId);
      else if (res.statusCode >= 400) scanJobs.fail(jobId, (payload && payload.error) || 'Analysis failed');
    } catch (_) { /* tracking must never break the response */ }
    return _json(payload);
  };
}

// Poll target for the resume flow above. Returns { status, rackId } for a
// previously-started clientJobId. 'missing' means we never saw it (expired or
// wrong id) — the client then just falls back to the normal upload screen.
app.get('/api/analyze/result/:jobId', (req, res) => {
  const j = scanJobs.get(req.params.jobId);
  if (!j) return res.json({ status: 'missing' });
  res.json({ status: j.status, rackId: j.rackId || null, error: j.error || null });
});

app.post('/api/analyze', auth.requireAuth, scanLimit, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  trackScanJob(req, res);
  // Scans only happen through an approved organization: block a user whose
  // org is still pending owner approval (legacy/no-org users are unaffected).
  // NOT block-scoped: `_a` is also needed further down for rackScope() when the
  // rack id is computed. It used to live in a bare block, which put it out of
  // scope at the call site and made every scan throw ReferenceError — surfaced
  // to the user as "Please upload a clearer photo", blaming their image.
  const _a = softAuthPayload(req);
  if (_a?.organizationId && !auth.isOrgActive(_a.organizationId)) {
    safeUnlink(req.file.path);
    return res.status(403).json({ error: 'Your organization is awaiting owner approval before you can scan.' });
  }

  let tmpPath = req.file.path;
  const reqStart = Date.now();
  const timings = {};

  try {
    const tNormStart = Date.now();
    tmpPath = await normalizeImage(tmpPath);
    timings.normalize_ms = Date.now() - tNormStart;
    const rackId    = computeRackId(tmpPath, rackScope(_a));
    const rackDir   = path.join(outputsDir, rackId);
    const jsonPath  = path.join(rackDir, 'device_unit_map.json');

    // Tenant ownership: anyone scanning an image (cached or fresh) is
    // making a tenant-scoped claim on this rack. Idempotent — multiple
    // tenants can co-own the same RK-id when they scan the same image.
    const _authPayload = softAuthPayload(req);
    const _scanTenantId = scanOwnerTenantId(_authPayload);
    const _scanUserId = _authPayload?.sub || null;
    if (_scanTenantId) tenant.claimRack(_scanTenantId, rackId, _scanUserId);

    // ── Cache hit ──────────────────────────────────────────
    if (fs.existsSync(jsonPath)) {
      safeUnlink(tmpPath); // discard duplicate upload
      logger.info({ event: 'scan.cache_hit', rackId, tenantId: _scanTenantId }, `cache hit ${rackId}`);
      recordEvent('scan.cache_hit', { rackId, tenantId: _scanTenantId });
      await ensurePortCounts(rackId);

      // AL auto-apply also on cache hit. Even though it's the same image,
      // a previously-saved correction may not yet be reflected in
      // device_unit_map.json — apply it now so the cached result shows
      // the user's corrected device classes.
      let _alAppliedCacheHit = 0;
      try {
        const alResult = await runActiveLearningCli(
          { cmd: 'apply_to_scan', rack_dir: rackDir, org_id: _authPayload?.organizationId || null },
          90000
        );
        _alAppliedCacheHit = alResult?.applied || 0;
        if (_alAppliedCacheHit > 0) {
          logger.info({
            event: 'al.auto_applied_cache',
            rackId, applied: _alAppliedCacheHit, changes: alResult.changes,
          }, `AL applied ${_alAppliedCacheHit} corrections to cached ${rackId}`);
        }
      } catch (err) {
        logger.warn({ event: 'al.auto_apply_cache_failed', rackId, error: err.message },
          'AL auto-apply on cache hit failed (non-fatal)');
      }

      // Synchronously rebuild scan_result.json BEFORE responding, so the
      // client's next /api/scan/:rackId/result call gets the AL-corrected
      // view — avoids the setImmediate race in scheduleCanonicalRefresh().
      if (_alAppliedCacheHit > 0) {
        try { writeCanonicalScanResult(rackId); } catch (_) {}
      }

      // Re-scanning the same image is a cache hit (same content-hash RK-id),
      // but the user still just scanned it — so Recent Scans should show "now",
      // not the first scan's time. Refresh the scan timestamp (preserving the
      // original as first_scanned_at). /api/scans sorts + displays by timestamp.
      try {
        const m = readMeta(rackId) || {};
        if (!m.first_scanned_at) m.first_scanned_at = m.timestamp || new Date().toISOString();
        m.timestamp = new Date().toISOString();
        writeMeta(rackId, m);
      } catch (_) { /* non-fatal — history just keeps the old time */ }

      timings.total_ms = Date.now() - reqStart;
      timings.cached = true;
      timings.al_applied = _alAppliedCacheHit;
      audit.log({ req, action: 'scan.create', status: 'ok', targetType: 'rack', targetId: rackId, payload: { cached: true, al_applied: _alAppliedCacheHit } });
      scheduleCanonicalRefresh(rackId);
      return res.json({ ...buildResponse(rackId, true), timings });
    }

    // ── Confirmed-rack bypass ──────────────────────────────
    // A re-shot photo of a rack the user already CONFIRMED gets a new content
    // hash, so it misses the cache above. If it perceptually matches a confirmed
    // rack, serve that confirmed result instead of re-detecting — "show what's
    // already confirmed." Only runs when this org has confirmed racks (cheap
    // file check first, so the ~pHash+embedding lookup cost is paid only when it
    // can possibly match). Strict thresholds guard against a wrong-rack match.
    const _forceFresh = req.body?.forceFresh === '1' || req.body?.forceFresh === 'true';
    try {
      const _orgId = _authPayload?.organizationId || null;
      if (!_forceFresh && hasConfirmedRacks(_orgId)) {
        const cr = await runActiveLearningCli(
          { cmd: 'find_confirmed_rack', image_path: tmpPath, org_id: _orgId }, 90000);
        const matchId = cr?.confirmed?.rack_id;
        if (matchId && matchId !== rackId &&
            fs.existsSync(path.join(outputsDir, matchId, 'device_unit_map.json'))) {
          safeUnlink(tmpPath);
          logger.info({ event: 'scan.confirmed_bypass', uploadedAs: rackId, matchId,
            match: cr.confirmed.match_type }, `served confirmed rack ${matchId} for re-upload`);
          recordEvent('scan.confirmed_bypass', { matchId, match: cr.confirmed.match_type });
          if (_scanTenantId) tenant.claimRack(_scanTenantId, matchId, _scanUserId);
          timings.total_ms = Date.now() - reqStart;
          timings.confirmed_bypass = true;
          audit.log({ req, action: 'scan.create', status: 'ok', targetType: 'rack',
            targetId: matchId, payload: { confirmed_bypass: true, match: cr.confirmed.match_type } });
          return res.json({ ...buildResponse(matchId, true), timings,
            servedFromConfirmed: true, confirmedRackId: matchId });
        }
      }
    } catch (err) {
      logger.warn(`[confirmed-rack] lookup skipped: ${err.message}`);
    }

    // ── Quality pre-check (tilt) ───────────────────────────
    const skipQualityCheck = req.body?.skipQualityCheck === '1' || req.body?.skipQualityCheck === 'true';
    const tQualStart = Date.now();
    const quality = skipQualityCheck
      ? { ok: true, metrics: { note: 'user-override' } }
      : await runQualityCheck(tmpPath);
    timings.quality_check_ms = Date.now() - tQualStart;
    if (!quality.ok) {
      safeUnlink(tmpPath);
      return res.status(400).json({
        error: quality.error,
        metrics: quality.metrics,
        kind: quality.kind || null,
        retryable: quality.retryable === true,
      });
    }

    // ── Rack-presence gate (reject non-racks at the first step) ──
    // A photo of a person / laptop / random object passes the tilt check but
    // contains no rack devices. A quick detect-only pass (~1s) rejects it here,
    // BEFORE the full pipeline, so the user isn't left watching an "analyzing"
    // spinner that returns nothing. Best-effort: if detect errors, fall through
    // to the full pipeline (whose own 0-device check still catches it).
    // Two tiers, because "is this a rack" is not a yes/no the detector can
    // answer confidently. Zero detections is a clear miss. But a photo of a
    // desktop tower is NOT zero — it yields a couple of boxes the model can
    // only call Empty or Unidentified — and the old single test (devices === 0)
    // waved it through, which is why 2D and 3D views were being generated for
    // things that are not racks at all.
    //
    // So: nothing found, or nothing found that is actual rack EQUIPMENT, and we
    // stop and say so. Both stay `retryable`, which the scan page renders as
    // "Retake / Proceed anyway": a real rack shot in bad light can detect
    // nothing, and refusing outright would strand the person holding the phone
    // in front of it. Blocking without an override is the worse failure —
    // guessing wrong about a genuine rack costs more than analysing a desk.
    if (!skipQualityCheck) {
      try {
        const det = await pool.request('detect_only', { image_path: tmpPath, config_path: CONFIG_PATH });
        if (det && det.ok && Array.isArray(det.devices)) {
          // Empty / Closed Unit / Unidentified are rack-slot placeholders, not
          // equipment — the same set the client hides from its overlay. A photo
          // whose only detections are these has not shown us a rack.
          const PLACEHOLDER = new Set(['Empty', 'Closed Unit', 'Unidentified']);
          const equipment = det.devices.filter(d => d && !PLACEHOLDER.has(d.class_name));
          if (det.devices.length === 0 || equipment.length === 0) {
            safeUnlink(tmpPath);
            logger.info({ event: 'scan.not_a_rack', detected: det.devices.length,
                          equipment: equipment.length,
                          classes: [...new Set(det.devices.map(d => d && d.class_name))].slice(0, 6) },
              `rejected upload: ${det.devices.length} detection(s), ${equipment.length} of them equipment`);
            return res.status(400).json({
              error: det.devices.length === 0
                ? "This doesn't look like a server rack. Point the camera at the front of a rack so its devices and ports are visible."
                : "No rack equipment was recognised in this photo — nothing that looks like a switch, patch panel, server or PDU. Point the camera at the front of a rack.",
              retryable: true,
              kind: 'not_a_rack',
            });
          }
        }
      } catch (_) { /* detect failed — let the full pipeline decide */ }
    }

    // ── Cache miss — run pipeline ──────────────────────────
    fs.mkdirSync(rackDir, { recursive: true });

    // Persist image inside the rack folder so /api/select always finds it.
    // normalizeImage() outputs JPEG, so always use .jpg regardless of original extension.
    const ext          = path.extname(tmpPath) || '.jpg';
    const imagePath    = path.join(rackDir, `original_image${ext}`);
    fs.copyFileSync(tmpPath, imagePath);
    safeUnlink(tmpPath); // remove from uploads/

    const meta = {
      rackId,
      userId:     softAuthUserId(req),  // null for unauthenticated scans
      tenantId:   softAuthPayload(req)?.tenantId ?? null,  // owning Site, so the folder carries a tenant signal on disk
      imageHash:  crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'),
      imagePath,
      timestamp:  new Date().toISOString(),
      quality:    quality.metrics || null,
      qualityWarning:    quality.warning || null,
      qualityWarningMsg: quality.warning_msg || null,
    };
    writeMeta(rackId, meta);

    const tPipeStart = Date.now();
    await runPipelineAnalyze(imagePath, rackDir, softAuthPayload(req)?.organizationId || null);
    timings.pipeline_ms = Date.now() - tPipeStart;

    // ── Front-of-rack + framing check (post-pipeline) ──────
    const mapData = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
    const deviceCount = Array.isArray(mapData.devices) ? mapData.devices.length : 0;
    const unitCount = Array.isArray(mapData.units_detected) ? mapData.units_detected.length : 0;

    // When the user clicked "Proceed" on the quality warning, they have
    // explicitly asked us to accept whatever the pipeline produces. Don't
    // re-gate on deviceCount / unitCount in that case — the pipeline ran,
    // so whatever it found is what they'll see.
    if (!skipQualityCheck) {
      if (deviceCount === 0) {
        // Deliberately NOT deleting rackDir. The pipeline has already run — the
        // expensive part is done — and this is a retryable warning, not a
        // failure. Deleting it meant "Proceed anyway" had nothing to reuse and
        // re-ran the whole analysis on an image that had just been processed.
        // Rack ids are content hashes, so keeping the output lets the retry hit
        // the cache and return immediately.
        return res.status(400).json({
          error: 'Please take the photo from the front of the rack — we need to see the devices and ports face-on.',
          retryable: true,
          kind: 'quality',
        });
      }

      if (unitCount < 3) {
        // Kept for the same reason as above — "Proceed anyway" reuses it.
        // Say what was actually seen. "Upload a clearer photo" on a photo that
        // IS clear reads as the app being broken, and gives the user nothing
        // to act on — a small or partly visible rack needs different advice
        // from a blurry one.
        return res.status(400).json({
          error: `Only ${unitCount} rack unit${unitCount === 1 ? '' : 's'} could be made out in that photo. `
               + `Move back so the whole rack fits in the frame, or get closer if the rack is small — `
               + `we need to see at least three units to map it.`,
          retryable: true,
          kind: 'quality',
        });
      }
    }

    timings.total_ms = Date.now() - reqStart;
    timings.cached = false;
    logger.info({ event: 'scan.created', rackId, durationMs: timings.total_ms, timings },
      `new scan ${rackId} (analyze ${timings.total_ms}ms)`);
    recordEvent('scan.created', { rackId, durationMs: timings.total_ms });
    audit.log({
      req,
      action: 'scan.create',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { devices: deviceCount, units: unitCount, totalMs: timings.total_ms },
    });

    // ── Active-learning auto-apply ────────────────────────
    // Overlay any matching device-class corrections from the AL memory
    // store BEFORE the canonical refresh, so the user's prior
    // corrections (saved on past scans of similar images) take effect
    // on this fresh scan. Mutates device_unit_map.json in place.
    // Awaited so the canonical refresh (next line) sees the updates.
    let _alAppliedMiss = 0;
    try {
      const alResult = await runActiveLearningCli(
        { cmd: 'apply_to_scan', rack_dir: rackDir, org_id: _authPayload?.organizationId || null },
        90000
      );
      _alAppliedMiss = alResult?.applied || 0;
      if (_alAppliedMiss > 0) {
        logger.info({
          event: 'al.auto_applied',
          rackId,
          applied: _alAppliedMiss,
          changes: alResult.changes,
        }, `AL auto-applied ${_alAppliedMiss} device corrections to ${rackId}`);
        timings.al_applied = _alAppliedMiss;
      }
    } catch (err) {
      logger.warn({ event: 'al.auto_apply_failed', rackId, error: err.message },
        'AL auto-apply failed (non-fatal)');
    }

    // Synchronously rebuild scan_result.json BEFORE responding so the
    // client's next read picks up AL corrections without a race.
    if (_alAppliedMiss > 0) {
      try { writeCanonicalScanResult(rackId); } catch (_) {}
    }

    scheduleCanonicalRefresh(rackId);
    res.json({ ...buildResponse(rackId, false), timings });

  } catch (err) {
    // Clean up tmp if still around
    safeUnlink(tmpPath);
    logger.error({ event: 'scan.failed', err: err.message, stack: String(err.stack || '').slice(0, 1500) },
      `[scan] analyze failed: ${err.message}`);
    const deviceDown = isFatalWorkerError(err.message);
    audit.log({ req, action: 'scan.create', status: 'fail',
      error: deviceDown ? ENGINE_DOWN_AUDIT : err.message });
    if (deviceDown) {
      return res.status(503).json({ error: ENGINE_DOWN_MSG, retryable: true, kind: 'engine' });
    }

    // This used to answer "Please upload a clearer photo" for EVERY exception —
    // a crashed worker, a timeout, a bug in our own code — so the app blamed
    // the user's photograph for its own failures. Testers duly re-took clear
    // photos over and over and got the same message, and we lost the real
    // error. Only genuine image problems get the photo advice now; anything
    // else says plainly that the failure was ours.
    const m = String(err.message || '');
    const isImageProblem = /image|decode|corrupt|unsupported|format|heic|exif|dimension|too large|empty file/i.test(m);
    if (isImageProblem) {
      return res.status(400).json({
        error: 'That image could not be read. Try a JPG or PNG taken straight from the camera.',
        retryable: true,
        kind: 'quality',
      });
    }
    res.status(500).json({
      error: 'Something went wrong on our side analysing that photo — it is not a problem with your image. It has been logged; please try again.',
      retryable: true,
      kind: 'server',
    });
  }
});

/**
 * POST /api/stitch
 * Multi-image upload for tall racks. Accepts 2–8 photos (top-to-bottom),
 * normalizes each, runs pipeline/rack_stitch.py to produce a single
 * stitched panorama, then funnels the result through the SAME analyze
 * path as /api/analyze and returns the same shape — plus a `stitch`
 * sub-object describing the seams (so the client can warn the user
 * when an overlap fell back to "butt-flush").
 *
 * Form fields:
 *   images (file[], required) — 2–8 image files, ORDER MATTERS (top→bottom)
 *   skipQualityCheck (string, optional) — same as /api/analyze
 */
function runStitcher(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pyBin = resolvePythonBin();
    const script = path.join(__dirname, '..', 'pipeline', 'rack_stitch.py');
    const args = [script, '--inputs', ...inputPaths, '--output', outputPath];
    const child = spawn(pyBin, args, {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`stitcher failed (exit ${code}): ${err.trim() || 'no output'}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`stitcher output was not JSON: ${e.message} / stderr: ${err.trim()}`));
      }
    });
    child.on('error', reject);
  });
}

app.post('/api/stitch', scanLimit, upload.array('images', 8), async (req, res) => {
  trackScanJob(req, res);
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length < 2) {
    files.forEach(f => safeUnlink(f.path));
    return res.status(400).json({ error: 'Please upload at least 2 images to stitch (top-to-bottom).' });
  }

  const reqStart = Date.now();
  const timings = {};
  const tmpPaths = [];
  let stitchedPath = null;

  try {
    // Normalize every input (HEIC->JPEG, EXIF rotate) before stitching.
    const tNormStart = Date.now();
    for (const f of files) {
      const p = await normalizeImage(f.path);
      tmpPaths.push(p);
    }
    timings.normalize_ms = Date.now() - tNormStart;

    stitchedPath = path.join(uploadsDir, `tmp_stitched_${uuidv4()}.jpg`);

    const tStitchStart = Date.now();
    const stitchResult = await runStitcher(tmpPaths, stitchedPath);
    timings.stitch_ms = Date.now() - tStitchStart;

    if (!stitchResult.ok) {
      tmpPaths.forEach(safeUnlink);
      safeUnlink(stitchedPath);
      return res.status(400).json({
        error: stitchResult.error || 'Could not stitch the uploaded images.',
        retryable: true,
        kind: 'stitch',
        stitch: { seams: stitchResult.seams || [], uncertain: stitchResult.uncertain || [] },
      });
    }

    // Inputs no longer needed — only the stitched output goes downstream.
    tmpPaths.forEach(safeUnlink);

    // ── Now mirror /api/analyze flow on the stitched image ───────
    const rackId   = computeRackId(stitchedPath, rackScope(softAuthPayload(req)));
    const rackDir  = path.join(outputsDir, rackId);
    const jsonPath = path.join(rackDir, 'device_unit_map.json');

    const _authPayload = softAuthPayload(req);
    const _scanTenantId = scanOwnerTenantId(_authPayload);
    const _scanUserId = _authPayload?.sub || null;
    if (_scanTenantId) tenant.claimRack(_scanTenantId, rackId, _scanUserId);

    // Cache hit — same stitched image was scanned before.
    if (fs.existsSync(jsonPath)) {
      safeUnlink(stitchedPath);
      logger.info({ event: 'scan.cache_hit', rackId, tenantId: _scanTenantId, stitched: true }, `stitch cache hit ${rackId}`);
      recordEvent('scan.cache_hit', { rackId, tenantId: _scanTenantId, stitched: true });
      await ensurePortCounts(rackId);
      timings.total_ms = Date.now() - reqStart;
      timings.cached = true;
      audit.log({ req, action: 'scan.create', status: 'ok', targetType: 'rack', targetId: rackId, payload: { cached: true, stitched: true, inputs: files.length } });
      scheduleCanonicalRefresh(rackId);
      return res.json({
        ...buildResponse(rackId, true),
        stitch: {
          seams: stitchResult.seams,
          uncertain: stitchResult.uncertain,
          image_size: stitchResult.image_size,
          input_count: files.length,
          input_order: stitchResult.input_order || null,
          auto_order: stitchResult.auto_order || null,
        },
        timings,
      });
    }

    // Quality check (optional override).
    const skipQualityCheck = req.body?.skipQualityCheck === '1' || req.body?.skipQualityCheck === 'true';
    const tQualStart = Date.now();
    const quality = skipQualityCheck
      ? { ok: true, metrics: { note: 'user-override' } }
      : await runQualityCheck(stitchedPath);
    timings.quality_check_ms = Date.now() - tQualStart;
    if (!quality.ok) {
      safeUnlink(stitchedPath);
      return res.status(400).json({
        error: quality.error,
        metrics: quality.metrics,
        kind: quality.kind || null,
        retryable: quality.retryable === true,
        stitch: { seams: stitchResult.seams, uncertain: stitchResult.uncertain },
      });
    }

    fs.mkdirSync(rackDir, { recursive: true });
    const imagePath = path.join(rackDir, 'original_image.jpg');
    fs.copyFileSync(stitchedPath, imagePath);
    safeUnlink(stitchedPath);

    const meta = {
      rackId,
      userId:     softAuthUserId(req),
      tenantId:   softAuthPayload(req)?.tenantId ?? null,  // owning Site, so the folder carries a tenant signal on disk
      imageHash:  crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'),
      imagePath,
      timestamp:  new Date().toISOString(),
      quality:    quality.metrics || null,
      qualityWarning:    quality.warning || null,
      qualityWarningMsg: quality.warning_msg || null,
      stitched:   true,
      stitch:     { seams: stitchResult.seams, uncertain: stitchResult.uncertain, input_count: files.length },
    };
    writeMeta(rackId, meta);

    const tPipeStart = Date.now();
    await runPipelineAnalyze(imagePath, rackDir, softAuthPayload(req)?.organizationId || null);
    timings.pipeline_ms = Date.now() - tPipeStart;

    // Post-pipeline framing check (looser than /api/analyze — the user
    // explicitly stitched a tall rack, so we expect more units, but be
    // forgiving about per-tile detection quality).
    const mapData = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
    const deviceCount = Array.isArray(mapData.devices) ? mapData.devices.length : 0;
    if (!skipQualityCheck && deviceCount === 0) {
      fs.rmSync(rackDir, { recursive: true, force: true });
      return res.status(400).json({
        error: 'No devices were detected on the stitched rack — make sure each photo shows the front of the rack and the shots overlap.',
        retryable: true,
        kind: 'quality',
        stitch: { seams: stitchResult.seams, uncertain: stitchResult.uncertain },
      });
    }

    timings.total_ms = Date.now() - reqStart;
    timings.cached = false;
    logger.info({ event: 'scan.created', rackId, durationMs: timings.total_ms, timings, stitched: true, inputs: files.length },
      `new stitched scan ${rackId} (${files.length} inputs, ${timings.total_ms}ms)`);
    recordEvent('scan.created', { rackId, durationMs: timings.total_ms, stitched: true });
    audit.log({
      req,
      action: 'scan.create',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { devices: deviceCount, totalMs: timings.total_ms, stitched: true, inputs: files.length },
    });
    scheduleCanonicalRefresh(rackId);
    res.json({
      ...buildResponse(rackId, false),
      stitch: {
          seams: stitchResult.seams,
          uncertain: stitchResult.uncertain,
          image_size: stitchResult.image_size,
          input_count: files.length,
          input_order: stitchResult.input_order || null,
          auto_order: stitchResult.auto_order || null,
        },
      timings,
    });

  } catch (err) {
    tmpPaths.forEach(safeUnlink);
    if (stitchedPath) safeUnlink(stitchedPath);
    logger.error(err.message);
    const deviceDown = isFatalWorkerError(err.message);
    audit.log({ req, action: 'scan.create', status: 'fail',
      error: deviceDown ? ENGINE_DOWN_AUDIT : err.message, payload: { stitched: true } });
    if (deviceDown) {
      // Same trap as the single-image path: a GPU fault has nothing to do with
      // how the photos overlap, and telling the user to re-shoot the rack sends
      // them round a loop they cannot win.
      return res.status(503).json({ error: ENGINE_DOWN_MSG, retryable: true, kind: 'engine' });
    }
    res.status(400).json({
      error: 'Could not stitch and analyze the rack. Make sure each photo shows the rack front and adjacent shots overlap by ~20–40%.',
      retryable: true,
      kind: 'stitch',
    });
  }
});

/**
 * POST /api/ocr/labels
 * Runs EasyOCR on an uploaded rack-front image and returns extracted text
 * labels with bounding boxes. Used to enrich device names in the analyze
 * flow when physical labels exist on the rack/devices.
 *
 * Body (multipart/form-data):
 *   image  (file, required)         — JPEG/PNG of the rack front
 *   rackId (string, optional)       — if provided, labels are cached under
 *                                     outputs/<rackId>/labels-front.json so
 *                                     they can be mapped to detected devices.
 *
 * Response:
 *   {
 *     image_size: { w, h },
 *     labels:     [ { text, conf, bbox } ],
 *     summary:    { count, highConfCount, hasLabels }
 *   }
 */
function runOcrLabels(imagePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pyBin = resolvePythonBin();
    const script = path.join(__dirname, '..', 'pipeline', 'ocr_labels.py');
    const child = spawn(pyBin, [script, imagePath], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`OCR failed (exit ${code}): ${err.trim() || out.trim() || 'no output'}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`OCR output was not JSON: ${e.message}`));
      }
    });
    child.on('error', e => reject(e));
  });
}

app.post('/api/ocr/labels', scanLimit, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const rackId = (req.body?.rackId || '').trim() || null;

  let tmpPath = req.file.path;
  try {
    tmpPath = await normalizeImage(tmpPath);
    const result = await runOcrLabels(tmpPath);

    // Cache labels under the rack folder so they can be mapped to devices later.
    if (rackId) {
      const rackDir = path.join(outputsDir, rackId);
      fs.mkdirSync(rackDir, { recursive: true });
      fs.writeFileSync(
        path.join(rackDir, 'labels-front.json'),
        JSON.stringify(result, null, 2)
      );
    }

    safeUnlink(tmpPath);

    const HIGH_CONF  = 0.6;
    const MIN_LABELS = 3;
    const labels = Array.isArray(result.labels) ? result.labels : [];
    const highConfCount = labels.filter(l => (l.conf || 0) >= HIGH_CONF).length;

    res.json({
      image_size: result.image_size || null,
      labels,
      summary: {
        count: labels.length,
        highConfCount,
        hasLabels: highConfCount >= MIN_LABELS,
      },
    });
  } catch (e) {
    safeUnlink(tmpPath);
    logger.warn(`[ocr] failed: ${e.message}`);
    res.status(500).json({ error: 'OCR failed', labels: [] });
  }
});

/**
 * POST /api/ocr/device-label
 * Identifies one device from a close-up photo of its label — the recovery
 * path for a device the rack scan couldn't read.
 *
 * A rack photo gives each device only its slice of the frame, so a model
 * string that was perfectly legible in person arrives here 20px tall and the
 * identifier comes back empty. Rather than dead-ending the user in a text
 * field, the app asks for one more photo — of that device alone, framed on
 * its label — where the pixels actually exist. Same OCR engine and same
 * make/model identifier as the rack pass; only the framing changes.
 *
 * The answer is a SUGGESTION for the user to confirm in the manual-entry
 * editor, never a value written straight through. A close-up read is far
 * better than a rack-crop read, which is not the same as trustworthy.
 *
 * Body (multipart/form-data):
 *   image  (file, required)    — JPEG/PNG/HEIC close-up of one device
 *   preset (string, optional)  — 'closeup' (default) | 'fast' | 'accurate'
 *
 * Response 200 (a read that found nothing is still a 200 — the client falls
 * back to manual entry, which is an outcome, not an error):
 *   { ok, make, model, version, raw_text, ocr_conf, match_conf,
 *     alternates: [{make, model, conf}], source, elapsed_ms }
 */
const CLOSEUP_PRESETS = new Set(['closeup', 'fast', 'accurate']);

app.post('/api/ocr/device-label', auth.requireAuth, scanLimit, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image file provided' });

  const preset = CLOSEUP_PRESETS.has(req.body?.preset) ? req.body.preset : 'closeup';
  const t0 = Date.now();
  let tmpPath = req.file.path;
  try {
    // Auto-orients from EXIF and re-encodes to JPEG, so a HEIC from the iOS
    // photo library and a canvas capture from the in-app camera arrive at
    // the OCR engine identically.
    tmpPath = await normalizeImage(tmpPath);
    const result = await pool.request('closeup_ocr', { image_path: tmpPath, preset });
    safeUnlink(tmpPath);

    const elapsedMs = Date.now() - t0;
    audit.log({ req, action: 'ocr.device_label',
                status: result?.ok ? 'ok' : 'fail',
                targetType: 'device', targetId: result?.model || result?.make || 'unread',
                payload: { source: result?.source, preset, elapsed_ms: elapsedMs } });

    if (!result?.ok) {
      return res.status(500).json({ ok: false,
        error: 'Could not read that photo. Enter the make and model instead.' });
    }
    res.json({ ...result, elapsed_ms: elapsedMs });
  } catch (e) {
    safeUnlink(tmpPath);
    logger.warn(`[ocr] device-label failed: ${e.message}`);
    res.status(500).json({ ok: false,
      error: 'Could not read that photo. Enter the make and model instead.' });
  }
});

/**
 * GET /api/ocr/labels/:rackId
 * Returns the cached OCR labels for a rack's front image and maps each label
 * to its best-matching detected device by vertical bbox overlap with the
 * device's U-slot region. Falls back to ocr_devices.json (per-device crop
 * OCR) when no front label file is present — so any physical label captured
 * during the analyze flow is surfaced as a candidate name. When at least one
 * label is detected, also infers the pattern (prefix-CODE-NN) so the client
 * can mint matching names for unlabeled devices in the same rack.
 *
 * Response:
 *   {
 *     front:  { labels: [...], image_size: {w,h} } | null,
 *     deviceLabels: [
 *       { device_index, synthetic_name, label, conf,
 *         source: 'front'|'per_device' }
 *     ],
 *     pattern: { prefix, sep, classTok, padding } | null
 *   }
 */
// Pull the first identifier-shaped token out of raw OCR text. Repairs the
// most common EasyOCR confusions (O↔0, I↔1) when they sit next to digits, so
// "RVEW-CORE-SWO1 STACK MEMBER 2" yields "RVEW-CORE-SW01".
function normalizeOcrLabelText(rawText) {
  if (!rawText) return null;
  const s = String(rawText).trim();
  if (!s) return null;
  for (const tok of s.split(/\s+/)) {
    const fixed = tok
      .replace(/([A-Z])O(?=\d)/g, '$10')
      .replace(/(\d)O/g, '$10')
      .replace(/([A-Z])I(?=\d)/g, '$11')
      .replace(/(\d)I/g, '$11')
      .toUpperCase();
    // Require at least one separator and a letters-then-digits final segment,
    // e.g. RVEW-CORE-SW01 or RACK01_PDU3. Bare tokens like "SW01" don't
    // qualify on their own — they're ambiguous without a site/rack prefix.
    if (/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_][A-Z]+\d+$/.test(fixed)) return fixed;
  }
  return null;
}

// Parse RVEW-CORE-SW01 → { prefix:'RVEW-CORE', sep:'-', classTok:'SW', padding:2 }
function inferLabelPattern(label) {
  if (!label) return null;
  const m = label.match(/^(.+)([-_])([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], sep: m[2], classTok: m[3], padding: m[4].length };
}

// Brand → class-name lookup. The YOLO detector can't see vendor badges, so
// when OCR catches a known brand inside (or adjacent to) a device's bbox we
// upgrade the class. Order matters — more specific brands first so e.g.
// "Cisco Catalyst" hits CATALYST before CISCO.
const BRAND_CLASS = [
  ['MEDIAPACK',  'Gateway'],
  ['AUDIOCODES', 'Gateway'],
  ['PLANAR',     'Controller'],
  ['TRIPP-LITE', 'PDU'],
  ['TRIPPLITE',  'PDU'],
  ['TRIPP LITE', 'PDU'],
  ['CATALYST',   'Switch'],
  ['NEXUS',      'Switch'],
  ['ARUBA',      'Switch'],
  ['JUNIPER',    'Switch'],
  ['CEDGE',      'Router'],
  ['MERAKI',     'Switch'],
  ['PALOALTO',   'Firewall'],
  ['PALO ALTO',  'Firewall'],
  ['FORTIGATE',  'Firewall'],
  ['FORTINET',   'Firewall'],
  ['CHECKPOINT', 'Firewall'],
  ['APC',        'UPS'],
  ['EATON',      'UPS'],
  ['SCHNEIDER',  'UPS'],
  ['SONY',       'Recorder'],
  ['POLYCOM',    'Gateway'],
  ['CISCO',      'Switch'],
];

function classifyByBrand(text) {
  if (!text) return null;
  const s = String(text).toUpperCase();
  for (const [brand, cls] of BRAND_CLASS) {
    if (s.includes(brand)) return { brand, class_name: cls };
  }
  // Fuzzy matches for common OCR errors that ocr_devices.py emits on these
  // brands (verified against real captures in outputs/).
  if (/\bBON\s+SON\b/.test(s)) return { brand: 'SONY',      class_name: 'Recorder' };
  if (/\bMEDIA\s*PACK\b/.test(s)) return { brand: 'MEDIAPACK', class_name: 'Gateway' };
  if (/\bMEDLA\s*PACK\b/.test(s)) return { brand: 'MEDIAPACK', class_name: 'Gateway' };
  // TRIPP-LITE OCR variants seen in the wild: TRIPPLITE, TRIPP-LITE,
  // TRIPPLME (l→m), TRIPPLE (dropped suffix), TRIPP_LITE, TRIPPL!TE, etc.
  // The TRIPP prefix is distinctive enough that any token starting with it
  // and continuing as letters is safely Tripp-Lite.
  if (/\bTRIPP[A-Z]{1,8}\b/.test(s)) return { brand: 'TRIPP-LITE', class_name: 'PDU' };
  if (/\bRIPP[-\s]?LITE\b/.test(s)) return { brand: 'TRIPP-LITE', class_name: 'PDU' };
  if (/\bPLAN[A4]R\b/.test(s)) return { brand: 'PLANAR', class_name: 'Controller' };
  if (/\bCED[O0]E[K_]?[O0]?[I1]?\b/.test(s)) return { brand: 'CEDGE', class_name: 'Router' };
  return null;
}

app.get('/api/ocr/labels/:rackId', (req, res) => {
  const rackId  = req.params.rackId;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) return res.status(404).json({ error: `Rack ${rackId} not found` });

  const readJson = (p) => {
    try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
    catch { return null; }
  };

  // For racks scanned before scheduleOcrLabels existed (or where it hasn't
  // completed yet), trigger the full-image OCR pass in the background so
  // brand-token reclassification becomes available on the next refresh.
  if (!fs.existsSync(path.join(rackDir, 'labels-front.json'))) {
    try { scheduleOcrLabels(rackId); } catch (_) {}
  }

  const front = readJson(path.join(rackDir, 'labels-front.json'));
  const dum   = readJson(path.join(rackDir, 'device_unit_map.json'));
  const perDev = readJson(path.join(rackDir, 'ocr_devices.json'));

  const deviceLabels = [];
  if (dum && Array.isArray(dum.devices)) {
    // For each device, find the best-matching front label by Y-overlap.
    // device_unit_map.json stores boxes as `box: [x1,y1,x2,y2]` in pixel
    // coords; label bboxes are also pixel-absolute. Compare Y centers directly
    // rather than going through percentages — dum has no image_size field,
    // and the percentages from labels-front are tied to their own image_size.
    //
    // matchSide only considers identifier-shaped labels (RVEW-CORE-SW01,
    // RACK01-PDU3, …) for naming. Brand badges (PLANAR, TRIPPLME) and
    // descriptive chatter (STACK MEMBER 2, 1044248) are ignored here —
    // they're still consumed by mapFullImageLabels below for reclassification.
    // Without this filter the device chip would show "PLANAR" as its name,
    // and inferLabelPattern would pick a non-pattern token as the template.
    const matchSide = (sideName, sideData) => {
      if (!sideData?.labels?.length) return null;
      return dum.devices.map((dev, idx) => {
        const box = dev.box;
        if (!Array.isArray(box) || box.length < 4) return null;
        const dy = box[1];
        const dh = box[3] - box[1];
        let best = null, bestScore = -1;
        for (const l of sideData.labels) {
          if (!normalizeOcrLabelText(l.text)) continue;
          const ly = (l.bbox?.y ?? 0);
          const lh = (l.bbox?.h ?? 0);
          const lYCenter = ly + lh / 2;
          if (lYCenter < dy - 6 || lYCenter > dy + dh + 6) continue;
          const score = (l.conf || 0);
          if (score > bestScore) { bestScore = score; best = l; }
        }
        return best ? { idx, label: best, side: sideName } : null;
      }).filter(Boolean);
    };

    const frontMatches = matchSide('front', front) || [];

    const matched = new Map();
    for (const m of frontMatches) matched.set(m.idx, m);

    // Find a "stack member N" hint near a device's Y-band — captured as a
    // separate OCR label, e.g. "STACK MEMBER 2". Used to differentiate two
    // physically distinct switches that share the same hostname sticker.
    const findStackMember = (sideData, dy, dh) => {
      if (!sideData?.labels?.length) return null;
      for (const l of sideData.labels) {
        const ly = (l.bbox?.y ?? 0);
        const lh = (l.bbox?.h ?? 0);
        const lyc = ly + lh / 2;
        if (lyc < dy - 6 || lyc > dy + dh + 6) continue;
        const m = String(l.text || '').match(/(?:stack\s*)?mem(?:ber|rer|8er|ber)\s*(\d+)/i);
        if (m) return m[1];
      }
      return null;
    };

    dum.devices.forEach((dev, idx) => {
      const m = matched.get(idx);
      if (!m) {
        deviceLabels.push({ device_index: idx, synthetic_name: dev.name || `dev${idx}`, label: null, conf: null, source: null });
        return;
      }
      const rawText = m.label.text;
      const normalized = normalizeOcrLabelText(rawText) || rawText;
      const box = dev.box;
      const stackN = findStackMember(front, box[1], box[3] - box[1]);
      const finalLabel = stackN ? `${normalized}/${stackN}` : normalized;
      deviceLabels.push({
        device_index:   idx,
        synthetic_name: dev.name || `dev${idx}`,
        label:          finalLabel,
        conf:           m.label.conf,
        source:         m.side,
        stack_base:     normalized,
      });
    });

    // Per-device crop OCR fills any slot still missing a label. We match by
    // U-slot since ocr_devices.json and device_unit_map.json are generated
    // from the same detection pass. Two relaxations from the front/rear path:
    //   - Threshold 0.4 instead of 0.6 — Cisco stack members often produce
    //     mid-confidence OCR on the second/third stack switch because cables
    //     partially occlude the label, but the text is still recognizable.
    //   - Duplicate labels are kept (with a /N stack-member suffix when the
    //     raw text contains "STACK MEMBER N") so two physical switches with
    //     identical hostnames don't collapse to a single chip.
    if (perDev && Array.isArray(perDev.devices)) {
      const seenLabels = new Map(); // normalized label → count assigned
      for (const od of perDev.devices) {
        if (!od.raw_text || (od.ocr_conf || 0) < 0.4) continue;
        const norm = normalizeOcrLabelText(od.raw_text);
        if (!norm) continue;
        const pos = String(od.position || '').toLowerCase();
        const idx = dum.devices.findIndex(d => (d.units || []).some(u => String(u).toLowerCase() === pos));
        if (idx < 0) continue;
        const slot = deviceLabels[idx];
        if (!slot || slot.label) continue;
        // Stack-member differentiation: prefer the explicit "STACK MEMBER N"
        // from raw_text, otherwise increment a /N counter for repeated labels.
        let finalLabel = norm;
        const stackM = od.raw_text.match(/stack\s*member\s*(\d+)/i);
        const seenCount = seenLabels.get(norm) || 0;
        if (stackM) {
          finalLabel = `${norm}/${stackM[1]}`;
        } else if (seenCount > 0) {
          finalLabel = `${norm}/${seenCount + 1}`;
        }
        seenLabels.set(norm, seenCount + 1);
        slot.label  = finalLabel;
        slot.conf   = od.ocr_conf;
        slot.source = 'per_device';
        slot.stack_base = norm; // for the client / debugging
      }
    }
  }

  // Post-pass: symmetric stack-member suffixing. When two+ devices share the
  // same stack_base (e.g. two switches both labelled RVEW-CORE-SW01 because
  // they form a Cisco stack), suffix every member with /N — not just the
  // duplicates after the first. That way the UI doesn't visually merge the
  // primary into a single chip and leave the others looking like /2, /3.
  if (dum && Array.isArray(dum.devices)) {
    const byBase = new Map();
    deviceLabels.forEach(d => {
      if (!d.stack_base) return;
      if (!byBase.has(d.stack_base)) byBase.set(d.stack_base, []);
      byBase.get(d.stack_base).push(d);
    });
    for (const group of byBase.values()) {
      if (group.length < 2) continue;
      // Order by Y (top-down) so suffix /1 is always physically highest.
      group.sort((a, b) => (dum.devices[a.device_index]?.box?.[1] ?? 0) - (dum.devices[b.device_index]?.box?.[1] ?? 0));
      group.forEach((d, i) => {
        // Keep an explicit /N already set (from "STACK MEMBER N" text), otherwise
        // assign by Y-order.
        const existing = d.label?.match(/\/(\d+)$/);
        if (!existing) d.label = `${d.stack_base}/${i + 1}`;
      });
    }
  }

  // Pick the highest-confidence label as the pattern template. Prefer the
  // base label (without stack suffix) so the pattern doesn't include /N.
  const bestLabeled = deviceLabels
    .filter(d => d.label && (d.conf || 0) >= 0.6)
    .sort((a, b) => (b.conf || 0) - (a.conf || 0))[0];
  const pattern = bestLabeled ? inferLabelPattern(bestLabeled.stack_base || bestLabeled.label) : null;

  // Brand-token reclassification — read every OCR'd token we have (front
  // image labels + per-device crop text) and, when a known brand name lands
  // inside or atop a device's bbox, upgrade that device's class. This
  // recovers Planar/Sony/Audiocodes/Tripp-Lite/CEdge etc. that YOLO
  // mislabels as UPS / Empty / Server based on silhouette alone.
  const reclassifications = {};
  const noteReclass = (idx, hit, srcText, conf) => {
    if (idx == null || idx < 0 || !hit) return;
    const prev = reclassifications[idx];
    if (prev && (prev.conf || 0) >= (conf || 0)) return;
    reclassifications[idx] = {
      device_index: idx,
      class_name:   hit.class_name,
      brand:        hit.brand,
      raw_text:     srcText,
      conf:         conf || 0,
    };
  };

  if (dum && Array.isArray(dum.devices)) {
    // Per-device crop text — direct device-to-text mapping.
    if (perDev && Array.isArray(perDev.devices)) {
      for (const od of perDev.devices) {
        const hit = classifyByBrand(od.raw_text);
        if (!hit) continue;
        const pos = String(od.position || '').toLowerCase();
        const idx = dum.devices.findIndex(d => (d.units || []).some(u => String(u).toLowerCase() === pos));
        noteReclass(idx, hit, od.raw_text, od.ocr_conf);
      }
    }
    // Full-image OCR labels — match to the device whose bbox vertically
    // contains the label's center. Pixel-absolute comparison; dum has no
    // image_size and dev uses `box: [x1,y1,x2,y2]`.
    const mapFullImageLabels = (sideData) => {
      if (!sideData?.labels?.length) return;
      for (const lbl of sideData.labels) {
        const hit = classifyByBrand(lbl.text);
        if (!hit) continue;
        const ly = lbl.bbox?.y ?? 0;
        const lh = lbl.bbox?.h ?? 0;
        const lYCenter = ly + lh / 2;
        let bestIdx = -1, bestDist = Infinity;
        dum.devices.forEach((dev, idx) => {
          const box = dev.box;
          if (!Array.isArray(box) || box.length < 4) return;
          const dy = box[1];
          const dh = box[3] - box[1];
          if (lYCenter < dy - 6 || lYCenter > dy + dh + 6) return;
          const dist = Math.abs(lYCenter - (dy + dh / 2));
          if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
        });
        noteReclass(bestIdx, hit, lbl.text, lbl.conf);
      }
    };
    mapFullImageLabels(front);

    // Label-driven reclassification: when YOLO marked a device Unidentified
    // (or Empty) but OCR captured an identifier-shaped label whose class
    // token names a known class — e.g. "RVEW-CORE-SW01" → SW → Switch — use
    // the label's own evidence to upgrade the class. Only applies to
    // low-confidence YOLO classes so we don't overrule strong detections.
    const CLASS_FROM_CODE = {
      SW:'Switch', SWITCH:'Switch', SWT:'Switch',
      PP:'Patch Panel', PANEL:'Patch Panel',
      FW:'Firewall', FWL:'Firewall',
      RO:'Router', RTR:'Router', RT:'Router',
      SVR:'Server', SRV:'Server', SERVER:'Server',
      LB:'Load Balancer',
      GW:'Gateway', GT:'Gateway', GTW:'Gateway',
      MO:'Modem', MDM:'Modem',
      CTRL:'Controller', CTL:'Controller',
      REC:'Recorder',
      AMP:'Amplifier',
      PDU:'PDU', PSU:'PSU', UPS:'UPS',
    };
    const WEAK_CLASSES = new Set(['Unidentified', 'Empty', 'Closed Unit']);
    for (const d of deviceLabels) {
      if (!d.stack_base) continue;
      const dev = dum.devices[d.device_index];
      if (!dev || !WEAK_CLASSES.has(dev.class_name)) continue;
      const codeM = d.stack_base.match(/[-_]([A-Z]+)\d+$/);
      const inferred = codeM ? CLASS_FROM_CODE[codeM[1]] : null;
      if (inferred) {
        noteReclass(d.device_index, { brand: 'LABEL', class_name: inferred }, d.stack_base, d.conf || 0.5);
      }
    }
  }

  res.json({
    front, deviceLabels, pattern,
    reclassifications: Object.values(reclassifications),
  });
});

/**
 * POST /api/select
 * Runs full pipeline with --device_index and --port on the cached rack image.
 * Reads imagePath from scan_meta.json — no in-memory state required.
 */
app.post('/api/select', auth.requireAuth, async (req, res) => {
  const { scanId, device_index, port, port_category } = req.body;
  const rackId = scanId;

  if (!rackId || device_index == null || port == null) {
    return res.status(400).json({ error: 'scanId, device_index, and port are required' });
  }

  // This route takes the rack id from the BODY (scanId), so the
  // app.param('rackId') guard — which only fires for routes with :rackId in
  // the path — never runs here. Enforce both checks manually:
  //   1. shape-validate to block path traversal (rackId flows into path.join
  //      and writeMeta below),
  //   2. tenant-ownership (same soft check as the app.param guard).
  if (!/^RK-[A-Za-z0-9]{4,32}$/.test(rackId)) {
    return res.status(400).json({ error: 'Invalid scanId' });
  }
  const _selAuth = softAuthPayload(req);
  if (!canAccessRack(_selAuth, rackId)) {
    return res.status(404).json({ error: 'Rack not found' });
  }

  const VALID_CATEGORIES = new Set(['main', 'sfp', 'console', 'other']);
  const portCategory = port_category && VALID_CATEGORIES.has(port_category)
    ? port_category
    : 'main';

  let meta = readMeta(rackId);

  // meta.imagePath may be a stale absolute path from another machine
  // (e.g. scans copied between systems). Fall back to scanning the rack
  // folder for original_image.{jpg,jpeg,png} — same pattern as the
  // ticket-mode select route below.
  const rackDir = path.join(outputsDir, rackId);
  let imagePath = meta?.imagePath && fs.existsSync(meta.imagePath) ? meta.imagePath : null;
  if (!imagePath) {
    for (const ext of ['jpg', 'jpeg', 'png']) {
      const candidate = path.join(rackDir, `original_image.${ext}`);
      if (fs.existsSync(candidate)) { imagePath = candidate; break; }
    }
  }
  if (!imagePath) {
    return res.status(404).json({ error: `Rack ${rackId} not found. Please re-upload the image.` });
  }

  // scan_meta.json can go missing even when the analysis is fully intact —
  // e.g. the cache-hit analyze path skips writeMeta, or the folder was
  // created by a flow that didn't persist it. /api/select only needs the
  // device map + original image (both present here), so reconstruct and
  // heal the meta instead of hard-404ing with "please re-upload".
  if (!meta) {
    // Backfill provenance from an existing canonical result so healing the
    // meta doesn't null out userId / imageHash / the original scan time.
    let prov = {};
    try {
      const srPath = path.join(rackDir, 'scan_result.json');
      if (fs.existsSync(srPath)) {
        const sr = JSON.parse(fs.readFileSync(srPath, 'utf8'));
        prov = {
          userId: sr?.createdBy?.userId ?? null,
          imageHash: sr?.image?.imageHash ?? null,
          timestamp: sr?.createdAt || sr?.timestamp || null,
        };
      }
    } catch (_) { /* fall back to defaults below */ }
    meta = {
      rackId, imagePath,
      userId: prov.userId ?? null,
      imageHash: prov.imageHash ?? null,
      timestamp: prov.timestamp || new Date().toISOString(),
      reconstructed: true,
    };
    try { writeMeta(rackId, meta); } catch (_) {}
  }

  const reqStart = Date.now();
  const timings = {};

  // ── Apply user's port-number shift before highlighting ──
  // If the user previously corrected this device's port numbering
  // (e.g. "this is port 5, model said 7"), every later "select port N"
  // must hit the same physical position N would have under the user's
  // corrected numbering. We translate the user-visible port number
  // back to the raw port number for the pipeline, then re-stamp the
  // user-visible number on the response.
  const userPort = Number(port);
  let rawPort = userPort;
  let appliedShift = 0;
  if (portCategory === 'main') {
    try {
      // Latest correction only — the offset is absolute (predicted_port is
      // stored raw), so it never compounds across corrections.
      const shift = _latestPortShift(_readFeedbackForScan(rackId), device_index);
      if (shift !== 0) {
        rawPort = userPort - shift;
        appliedShift = shift;
        logger.info({ event: 'select.port_shift_applied',
                      rackId, device_index, userPort, rawPort, shift },
          `select: user port ${userPort} → raw port ${rawPort} (shift ${shift})`);
      }
    } catch (err) {
      logger.warn({ event: 'select.port_shift_failed', rackId, error: err.message },
        'port-shift translation failed; using raw port number');
    }
  }
  if (rawPort < 1) {
    // The accumulated numbering shift pushes this port before the device's
    // first physical port — the correction history has compounded into an
    // out-of-range offset. Rather than hard-block the user, fall back to the
    // raw (un-shifted) numbering for this selection so they can still inspect
    // the port. They can re-apply a correction to fix the numbering.
    logger.warn({ event: 'select.port_shift_out_of_range',
                  rackId, device_index, userPort, rawPort, appliedShift },
      `select: shift ${appliedShift} pushes port ${userPort} out of range — ignoring shift`);
    rawPort = userPort;
    appliedShift = 0;
  }

  try {
    const tPipeStart = Date.now();
    const _targetCount = portCategory === 'main' ? publishedPortCountFor(rackId, device_index) : 0;
    await runPipelineSelect(imagePath, rackDir, device_index, rawPort, portCategory, _selAuth?.organizationId, _targetCount, appliedShift);
    timings.pipeline_ms = Date.now() - tPipeStart;

    const infoPath = path.join(rackDir, 'selected_port_info.json');
    const fullData = fs.existsSync(infoPath)
      ? JSON.parse(fs.readFileSync(infoPath, 'utf8'))
      : {};
    const portInfo = fullData.port_info || {};

    // 'invalid' is the pipeline's signal that the requested number fell outside
    // this category's port list, so it never located a port at all (runner.py
    // sets it in the `else` of `if 1 <= port_number <= cat_count`). That is a
    // different fact from "found the port, couldn't measure it", and the
    // coercion below used to flatten the two together — so an unlocatable port
    // came back as a perfectly ordinary EMPTY port. The user saw a result for a
    // port the pipeline had not found, which is the "wrong port / no port"
    // half of the second-lookup bug. Answer honestly instead, and name the real
    // range so the number they should have typed is on screen.
    if (portInfo.status === 'invalid') {
      // port_classification carries console/main/sfp only, so 'other' (USB)
      // resolves to 0 and takes the generic wording below rather than naming a
      // range we can't actually vouch for.
      const realCount = Number(fullData.port_classification?.[portCategory]) || 0;
      const catLabel = portCategory === 'main' ? '' : `${portCategory} `;
      logger.warn({ event: 'select.port_out_of_range', rackId, device_index,
                    userPort, rawPort, portCategory, realCount, targetCount: _targetCount },
        `select: ${portCategory} port ${userPort} outside detected range (${realCount})`);
      audit.log({
        req, action: 'scan.select_port', status: 'fail',
        targetType: 'rack', targetId: rackId,
        error: 'port out of range',
        payload: { device_index: Number(device_index), port: userPort, portCategory, realCount },
      });
      return res.status(422).json({
        error: realCount > 0
          ? `This device has ${realCount} ${catLabel}port${realCount === 1 ? '' : 's'} — enter a number between 1 and ${realCount}.`
          : `We couldn't locate ${catLabel}port ${userPort} on this device. Confirm the port count below, then pick a port.`,
        portOutOfRange: true,
        detectedCount: realCount,
        portCategory,
      });
    }

    // Occupancy is 'connected', 'empty', or 'unknown' — 'unknown' meaning the
    // status model couldn't measure THIS port (a coverage gap). The pipeline is
    // deliberately honest about that and never guesses, because guessing once
    // fed wrong data into topology and the CMDB (see pipeline/runner.py). But
    // testers found a bare "Unknown" on the Port Located screen confusing, so
    // for the FIND-PORT DISPLAY ONLY we present an unmeasured port as 'empty' —
    // the conservative reading (don't claim a link we didn't see). The honest
    // value is preserved on occupancy_source, and the data that feeds topology
    // and the CMDB is the pipeline's, untouched by this line.
    if (portInfo.status !== 'connected' && portInfo.status !== 'empty') {
      portInfo.occupancy_source = portInfo.occupancy_source || 'unknown';
      portInfo.status_measured = portInfo.status || 'unknown';
      portInfo.status = 'empty';
    }

    // Re-stamp port_info with the user-visible number so the UI sees
    // its own corrected numbering, not the raw pipeline output.
    if (appliedShift !== 0) {
      portInfo.port_number = userPort;
      portInfo._port_shift = { applied: appliedShift, raw_port: rawPort };
    }

    // Apply the tech's stored cable-colour correction for THIS port so a
    // re-located port shows the colour they confirmed — not the model's guess
    // again. Matched by device + port-location signature (same key the report
    // path uses). Without this, cable-colour feedback never "sticks".
    try {
      const loc = (portInfo.location || []).join(',');
      const cfb = _readFeedbackForScan(rackId)
        .filter(r => r.feedback_type === 'port'
          && Number(r.device_index) === Number(device_index)
          && (r.port_location || []).join(',') === loc
          && r.actual_cable_color)
        .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      const last = cfb[cfb.length - 1];
      if (last && last.actual_cable_color && last.actual_cable_color !== portInfo.cable_color) {
        portInfo._cable_color_model = portInfo.cable_color;
        portInfo.cable_color = last.actual_cable_color;
        const nt = _swapCableTypeColor(portInfo.cable_type, last.actual_cable_color);
        if (nt) portInfo.cable_type = nt;
        portInfo._corrected = true;
        logger.info({ event: 'select.cable_color_corrected', rackId, device_index,
          from: portInfo._cable_color_model, to: last.actual_cable_color },
          `select: applied cable-colour correction → ${last.actual_cable_color}`);
      }
    } catch (err) {
      logger.warn({ event: 'select.cable_fb_failed', rackId, error: err.message },
        'cable-colour feedback application failed');
    }

    // Archive per-port image copies + log this identification so the report
    // can show every port the user has inspected (not just the last one).
    // New layout: copies live under <rack>/ports/, source pipeline PNGs
    // under <rack>/images/.
    const idsPath = path.join(rackDir, 'port_identifications.jsonl');
    const baseDevice = `d${device_index}_p${port}_device.png`;
    const baseFull   = `d${device_index}_p${port}_full.png`;
    const srcDevice = rackImagePath(rackDir, '5_selected_device_with_port.png');
    const srcFull   = rackImagePath(rackDir, '6_full_rack_selected_port.png');
    const dstDevice = rackPortPath(rackDir, baseDevice);
    const dstFull   = rackPortPath(rackDir, baseFull);
    try {
      if (fs.existsSync(srcDevice)) fs.copyFileSync(srcDevice, dstDevice);
      if (fs.existsSync(srcFull))   fs.copyFileSync(srcFull, dstFull);
    } catch (e) { logger.error('port image archive failed:', e.message); }

    const idEntry = {
      timestamp: new Date().toISOString(),
      device_index: Number(device_index),
      port: Number(port),
      port_info: portInfo,
      port_classification: fullData.port_classification || null,
      device_image: fs.existsSync(dstDevice) ? rackPortRelative(rackDir, baseDevice) : null,
      full_rack_image: fs.existsSync(dstFull) ? rackPortRelative(rackDir, baseFull) : null,
    };
    try {
      fs.appendFileSync(idsPath, JSON.stringify(idEntry) + '\n');
    } catch (e) { logger.error('port id log failed:', e.message); }

    timings.total_ms = Date.now() - reqStart;
    audit.log({
      req,
      action: 'scan.select_port',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { device_index: Number(device_index), port: Number(port) },
    });
    scheduleCanonicalRefresh(rackId);
    res.json({
      resultImageUrl: `/outputs/${rackId}/${rackImageUrlPath(rackDir, '5_selected_device_with_port.png')}`,
      rackImageUrl:   `/outputs/${rackId}/${rackImageUrlPath(rackDir, '6_full_rack_selected_port.png')}`,
      portInfo,
      portClassification: fullData.port_classification || null,
      timings,
    });
  } catch (err) {
    logger.error(err.message);
    audit.log({
      req,
      action: 'scan.select_port',
      status: 'fail',
      targetType: 'rack',
      targetId: rackId,
      error: err.message,
      payload: { device_index, port },
    });
    res.status(500).json({ error: 'Pipeline failed', details: err.message });
  }
});

// ── ServiceNow incident integration ────────────────────────────
// Poller writes tickets into ../servicenow_inbox/. Scan page reads them
// via /api/incidents/active and targets the specific port without any
// manual device/port selection.

const INBOX_DIR = path.join(__dirname, '..', 'servicenow_inbox');

function readActiveTickets() {
  const p = path.join(INBOX_DIR, 'active_tickets.json');
  if (!fs.existsSync(p)) return { count: 0, tickets: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { count: 0, tickets: [] };
  }
}

function readTicketByNumber(inc) {
  const p = path.join(INBOX_DIR, `${inc}.ticket.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── Rack identity (CMDB) ─────────────────────────────────────
// Manually-seeded canonical rack records live in cmdb_racks/<rack_name>.json.
// Each carries the expected label pattern + the device labels we expect to
// see on the front of that rack. Used by verifyRackIdentity() to gate
// ticket-driven uploads — i.e. "you said this is RACK-RVEW-CORE-01; the
// labels in this photo say otherwise; please upload the correct rack."
const CMDB_RACKS_DIR = path.join(__dirname, '..', 'cmdb_racks');

function readCmdbRack(rackName) {
  if (!rackName) return null;
  const p = path.join(CMDB_RACKS_DIR, `${rackName}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Run label OCR + read whatever's cached, then return all identifier-shaped
// tokens we recognise from this rack's image. Tokens are upper-cased and
// normalised the same way labels-front / per-device OCR are processed in
// /api/ocr/labels/:rackId, so equality comparisons with CMDB expected
// labels work directly.
function collectIdentifierTokens(rackDir) {
  const readJson = (p) => {
    try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
    catch { return null; }
  };
  const tokens = new Set();
  const front  = readJson(path.join(rackDir, 'labels-front.json'));
  const perDev = readJson(path.join(rackDir, 'ocr_devices.json'));
  const pushNorm = (text) => {
    const n = normalizeOcrLabelText(text);
    if (n) tokens.add(n);
  };
  if (front?.labels) for (const l of front.labels) pushNorm(l.text);
  if (perDev?.devices) for (const d of perDev.devices) pushNorm(d.raw_text);
  return [...tokens];
}

// Verify that an uploaded rack image (already analyzed → rackDir populated)
// is the rack the ticket says it is. Returns { ok, reason, detected,
// expected, matches, missing, pattern_ok }. The caller decides what to do
// on a `false` result (typically 409 + ask user to upload the correct rack).
//
// Match rule (soft mode, default): accept if ≥ min_label_matches expected
// labels appear in the upload's OCR tokens, OR if the upload's label pattern
// (prefix-CODE-NN) matches the CMDB rack's pattern AND we read at least one
// identifier token. Soft mode also accepts when no labels were detected at
// all — that's a "no signal either way" case, surfaced to the client with
// `reason: 'no_labels_detected'` so the UI can prompt for a manual confirm.
//
// Strict mode (when cmdbRack.verification.mode === 'strict'): rejects on
// no_labels_detected and demands at least min_label_matches concrete hits.
function verifyRackIdentity(rackDir, ticket) {
  const rackName = ticket?.cmdb?.rack_name;
  const cmdbRack = readCmdbRack(rackName);
  if (!cmdbRack) {
    // No CMDB record for this rack → can't verify, fall through (open by default).
    return { ok: true, reason: 'no_cmdb_record', detected: [], expected: [], matches: [] };
  }
  const detected = collectIdentifierTokens(rackDir);
  const expected = (cmdbRack.expected_devices || []).map(d => String(d.label || '').toUpperCase()).filter(Boolean);
  const expectedSet = new Set(expected);
  const matches = detected.filter(t => expectedSet.has(t));
  const min = cmdbRack.verification?.min_label_matches ?? 1;
  const mode = cmdbRack.verification?.mode || 'soft';

  // Pattern check — RVEW-CORE-* style. Useful when a label is OCR'd that
  // *isn't* in the expected list (e.g. a new device added to this rack)
  // but still clearly belongs to this rack's naming scheme.
  const pat = cmdbRack.label_pattern;
  const patternRegex = pat?.regex ? new RegExp(pat.regex) : null;
  const patternHits = patternRegex ? detected.filter(t => patternRegex.test(t)) : [];
  const patternOk = patternHits.length > 0;

  if (matches.length >= min) {
    return { ok: true, reason: 'expected_label_match', detected, expected, matches, pattern_ok: patternOk };
  }
  if (patternOk && mode === 'soft') {
    return { ok: true, reason: 'pattern_match_only', detected, expected, matches, pattern_ok: true };
  }
  if (detected.length === 0) {
    // No legible labels — soft mode accepts and falls back to the
    // synthesized U-prefixed pattern downstream; strict mode rejects.
    return {
      ok: mode === 'soft' ? true : false,
      reason: 'no_labels_detected',
      detected, expected, matches, pattern_ok: false,
    };
  }
  return {
    ok: false,
    reason: 'rack_mismatch',
    detected, expected, matches,
    pattern_ok: patternOk,
    missing: expected.filter(e => !detected.includes(e)),
  };
}


/**
 * Map a CMDB device name (e.g. SW-U10) to a device_index inside a scan's
 * device_unit_map.json. Matching rule: class matches the name prefix
 * (SW→Switch, PP→Patch Panel, SRV→Server) AND the scan lists the device at
 * the same U position that the name encodes (U10 → "u10" in units).
 */
function deviceIndexFromTicket(rackDir, cmdbDeviceName) {
  const r = resolveTicketDevice(rackDir, cmdbDeviceName);
  return r.device_index;
}

/**
 * Resolve a CMDB device name to a scan device_index + full diagnostic about
 * what the scan sees at the expected U. Used for drift detection.
 *
 * Returns:
 *   {
 *     device_index: number | null,         // null on drift / miss / bad name
 *     expected_class: "Switch" | ...,       // derived from name prefix
 *     expected_u: number | null,           // derived from name suffix
 *     detections_at_u: [{class_name, confidence}],  // everything the scan sees at expected_u
 *   }
 */
// Map of class codes used in device names (RVEW-CORE-SW01, SW-U10, …) to
// canonical class_name values from the YOLO detector. Lets us derive the
// expected class from a CMDB device name regardless of which naming
// convention the site uses.
const CLASS_CODE_TO_NAME = {
  SW:'Switch', SWT:'Switch', SWITCH:'Switch',
  PP:'Patch Panel', PANEL:'Patch Panel',
  FW:'Firewall', FWL:'Firewall',
  RO:'Router', RTR:'Router', RT:'Router',
  SRV:'Server', SVR:'Server', SERVER:'Server',
  LB:'Load Balancer',
  GW:'Gateway', GT:'Gateway', GTW:'Gateway',
  MO:'Modem', MDM:'Modem',
  CTRL:'Controller', CTL:'Controller',
  REC:'Recorder',
  AMP:'Amplifier',
  PDU:'PDU', PSU:'PSU', UPS:'UPS',
};

function resolveTicketDevice(rackDir, cmdbDeviceName, cmdbHint = null) {
  const result = { device_index: null, expected_class: null, expected_u: null, detections_at_u: [] };
  const mapPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(mapPath)) return result;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const name = String(cmdbDeviceName || '').toUpperCase();

  // Strategy A — legacy "<CODE>-U<NN>" names (SW-U10, PP-U08, SRV-U02).
  // Class comes from the prefix, U-position from the suffix.
  const legacyPrefix = { 'SW-':'Switch', 'PP-':'Patch Panel', 'SRV-':'Server' };
  const lp = Object.keys(legacyPrefix).find(p => name.startsWith(p));
  let uNum = null;
  if (lp) {
    result.expected_class = legacyPrefix[lp];
    const m = /U(\d{1,2})$/i.exec(name);
    if (m) uNum = parseInt(m[1], 10);
  }

  // Strategy B — pattern-style names like RVEW-CORE-SW01. The last segment
  // (split on - or _) is "<CLASS_CODE><digits>"; class is the code,
  // U-position comes from the ticket's cmdb.u_position (the name itself
  // doesn't encode U). Anything that resolves a class here is preferred
  // over the legacy parse only when the legacy parse hasn't already
  // populated expected_class.
  if (!result.expected_class) {
    const tail = name.match(/([-_])([A-Z]+)(\d+)(?:\/\d+)?$/);
    if (tail) {
      const code = tail[2];
      const cls  = CLASS_CODE_TO_NAME[code];
      if (cls) result.expected_class = cls;
    }
  }

  // U-position fallback: take it from the CMDB hint when the name didn't
  // encode it. Common for hostnames like RVEW-CORE-SW01 where U is a
  // separate CMDB field rather than part of the name.
  if (uNum == null && cmdbHint?.u_position != null) {
    const n = parseInt(cmdbHint.u_position, 10);
    if (!Number.isNaN(n)) uNum = n;
  }

  // Final class fallback: derive from cmdb.sys_class_name when the name
  // gave us nothing useful (e.g. CMDB shipped a free-form hostname).
  if (!result.expected_class && cmdbHint?.sys_class_name) {
    const k = String(cmdbHint.sys_class_name).toLowerCase();
    if (k.includes('switch'))     result.expected_class = 'Switch';
    else if (k.includes('router'))     result.expected_class = 'Router';
    else if (k.includes('firewall'))   result.expected_class = 'Firewall';
    else if (k.includes('server'))     result.expected_class = 'Server';
    else if (k.includes('pdu'))        result.expected_class = 'PDU';
    else if (k.includes('ups'))        result.expected_class = 'UPS';
  }

  if (uNum == null || !result.expected_class) return result;
  result.expected_u = uNum;
  const uTarget = `u${String(uNum).padStart(2, '0')}`;
  const devices = map.devices || [];
  let best = -1;
  let bestConf = -1;
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    if ((d.units || []).includes(uTarget)) {
      result.detections_at_u.push({ class_name: d.class_name, confidence: d.confidence, device_index: i });
    }
    if (d.class_name === result.expected_class && (d.units || []).includes(uTarget)) {
      if ((d.confidence || 0) > bestConf) { best = i; bestConf = d.confidence; }
    }
  }
  if (best >= 0) result.device_index = best;
  // Sort detections by confidence desc for display
  result.detections_at_u.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return result;
}

/**
 * POST /api/analyze-video
 *
 * Multi-rack scan: user uploads ONE video that pans across N parallel
 * racks. The server:
 *   1. Saves the video, computes a stable hash (group key).
 *   2. Splits the video into N best-frames via the worker
 *      (`split_video_racks` command → pipeline.multi_rack_split).
 *   3. For each best-frame, runs the same /api/analyze flow that single
 *      images use — produces a normal RK-XXXXXXXX scan with full output
 *      directory, port detection, etc. So every per-rack feature
 *      (Ports / Topology / SFP advisor / Firmware) works as-is.
 *   4. Records the parent group (rack_groups) + members so the UI can
 *      navigate "Rack 1 / Rack 2 / Rack 3" from a single entry point.
 *
 * Returns:
 *   { ok: true, groupId, count, racks: [
 *       { rackId, position, label, deviceCount, score, cached }
 *     ] }
 */
app.post('/api/analyze-video', auth.requireAuth, scanLimit, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  trackScanJob(req, res);
  const reqStart = Date.now();
  const videoPath = req.file.path;

  // Tenant required — multi-rack scans always go into someone's tenant.
  const authPayload = softAuthPayload(req);
  const tenantId = authPayload?.tenantId;
  const userId   = authPayload?.sub || null;
  if (!tenantId) {
    safeUnlink(videoPath);
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // 1. Split video into per-rack best frames (worker call).
    const splitResult = await withSpan('multi_rack.split', async () => {
      const r = await pool.request('split_video_racks', {
        video_path: videoPath,
        // Every other command sends this; without it the splitter fell back to
        // its own config.json and could resolve a different model than the
        // single-rack path on a non-default deployment.
        config_path: CONFIG_PATH,
      });
      if (!r.ok) throw new Error(r.error || 'split failed');
      return r;
    }, { videoPath });

    const detected = Array.isArray(splitResult.racks) ? splitResult.racks : [];
    if (detected.length === 0) {
      safeUnlink(videoPath);
      return res.status(400).json({ error: 'No racks detected in the video. Try a clearer pan.' });
    }

    // 2. Run /api/analyze logic on each best frame, in series so we
    //    don't melt the worker pool. (For 2-3 racks this is fine; for
    //    huge videos we'd parallelize.)
    const racks = [];
    const videoHash = crypto.createHash('sha256')
      .update(fs.readFileSync(videoPath))
      .digest('hex').slice(0, 16);
    const groupId = rackGroups.create({ tenantId, userId, videoHash });

    for (const r of detected) {
      try {
        // Normalize the JPEG so it goes through the same pipeline as
        // an image upload (auto-orient, mozjpeg, etc.)
        const normalizedPath = await normalizeImage(r.best_frame_path);
        const rackId = computeRackId(normalizedPath, rackScope(authPayload));
        const rackDir = path.join(outputsDir, rackId);
        const jsonPath = path.join(rackDir, 'device_unit_map.json');

        // Tenant ownership for each member rack
        tenant.claimRack(tenantId, rackId, userId);

        let cached = false;
        if (fs.existsSync(jsonPath)) {
          // Cache hit — just record group membership, no re-analysis.
          cached = true;
          await ensurePortCounts(rackId);
        } else {
          // Fresh analysis — same path /api/analyze takes. We save the
          // file under the same name single-rack scans use ("original_image")
          // so:
          //   * the Results-page hero image URL (/outputs/<rackId>/original_image.<ext>) resolves
          //   * pipeline.ocr_devices can find the source crop
          //   * scheduleCanonicalRefresh / Netdisco / CMDB all use the same file
          fs.mkdirSync(rackDir, { recursive: true });
          const ext = path.extname(normalizedPath) || '.jpg';
          const imagePath = path.join(rackDir, `original_image${ext}`);
          fs.copyFileSync(normalizedPath, imagePath);
          await runPipelineAnalyze(imagePath, rackDir, softAuthPayload(req)?.organizationId || null);
          await ensurePortCounts(rackId);
          writeMeta(rackId, {
            rackId, userId, tenantId,
            imageHash: crypto.createHash('sha256')
              .update(fs.readFileSync(imagePath)).digest('hex'),
            imagePath,
            timestamp: new Date().toISOString(),
          });
        }
        safeUnlink(normalizedPath);

        rackGroups.addMember({
          groupId, rackId,
          position: r.position,
          label:    r.label,
          deviceCount: r.device_count,
          score:    r.score,
        });

        racks.push({
          rackId, position: r.position, label: r.label,
          deviceCount: r.device_count, score: r.score, cached,
        });
        scheduleCanonicalRefresh(rackId);
      } catch (err) {
        logger.warn({
          event: 'multi_rack.member_failed',
          err: err.message, frameIndex: r.frame_index, position: r.position,
        }, `member rack ${r.position} failed: ${err.message}`);
      }
    }

    safeUnlink(videoPath);

    audit.log({
      req, action: 'scan.video', status: 'ok', targetType: 'rack_group',
      targetId: groupId,
      payload: { count: racks.length, durationMs: Date.now() - reqStart },
    });
    recordEvent('multi_rack.scan_completed', {
      groupId, count: racks.length, tenantId,
    });
    logger.info({
      event: 'multi_rack.scan_completed',
      groupId, count: racks.length, durationMs: Date.now() - reqStart,
    }, `multi-rack scan: ${racks.length} racks under ${groupId}`);

    res.json({
      ok: true, groupId, count: racks.length,
      durationMs: Date.now() - reqStart,
      racks,
    });
  } catch (err) {
    safeUnlink(videoPath);
    logger.error({
      event: 'multi_rack.scan_failed', err: err.message,
    }, 'multi-rack scan failed');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rack-group/:groupId
 *
 * Returns the parent group + each member rack. Tenant-scoped: 404 if
 * the group's tenant doesn't match the caller's tenant.
 */
app.get('/api/rack-group/:groupId', auth.requireAuth, (req, res) => {
  const data = rackGroups.get(req.params.groupId);
  if (!data) return res.status(404).json({ error: 'Group not found' });
  if (data.group.tenant_id !== req.user.tenant_id) {
    // 404 not 403 — don't reveal cross-tenant existence
    return res.status(404).json({ error: 'Group not found' });
  }
  res.json({ ok: true, ...data });
});

/**
 * GET /api/rack/:rackId/group
 *
 * Returns the parent rack-group (if any) for a single rack. Used by
 * per-rack pages (Results, Ports, Topology) to detect that a rack is
 * part of a multi-rack scan and render the rack-switcher tabs at the
 * top. Returns { ok: true, group: null } when the rack is standalone.
 */
app.get('/api/rack/:rackId/group', auth.requireAuth, (req, res) => {
  // A rack can belong to several groups (same photo scanned in multiple
  // two-rack sessions). Honour an explicit ?group=<id> hint when the rack is
  // actually a member of it — that's the group the caller just created and is
  // asking about. Otherwise fall back to the most recent group.
  const hint = req.query.group ? String(req.query.group) : null;
  const groupId = (hint && rackGroups.isMember(hint, req.params.rackId))
    ? hint
    : rackGroups.findGroupForRack(req.params.rackId);
  if (!groupId) return res.json({ ok: true, group: null });
  const data = rackGroups.get(groupId);
  if (!data) return res.json({ ok: true, group: null });
  // Don't reveal cross-tenant membership
  if (data.group.tenant_id !== req.user.tenant_id) {
    return res.json({ ok: true, group: null });
  }
  res.json({ ok: true, ...data });
});

/**
 * GET /api/rack-groups
 * List recent multi-rack scans for the caller's tenant.
 */
app.get('/api/rack-groups', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const groups = rackGroups.listForTenant(req.user.tenant_id, limit);
  res.json({ ok: true, groups });
});

/**
 * POST /api/rack-groups
 * Pair two (or more) already-analyzed racks into a group — the two-IMAGE
 * entry point. (Video already creates groups inside /api/analyze-video.)
 * Body: { rackIds: ["RK-…","RK-…"], label? }
 * Each rackId must already exist under outputs/. Returns { groupId }.
 */
app.post('/api/rack-groups', auth.requireAuth, (req, res) => {
  const rackIds = Array.isArray(req.body?.rackIds) ? req.body.rackIds.map(String) : [];
  const uniq = [...new Set(rackIds)].filter(Boolean);
  if (uniq.length < 2) {
    return res.status(400).json({ error: 'Provide at least two rackIds to group.' });
  }
  if (uniq.length > 8) {
    return res.status(400).json({ error: 'A group can hold at most 8 racks.' });
  }
  // Every rack must already be analyzed (device_unit_map.json is the existence key).
  for (const rid of uniq) {
    if (!/^RK-[A-Za-z0-9]+$/.test(rid) ||
        !fs.existsSync(path.join(outputsDir, rid, 'device_unit_map.json'))) {
      return res.status(404).json({ error: `Rack ${rid} not found — analyze it first.` });
    }
  }
  try {
    // Content-addressed group key so re-pairing the same racks is idempotent-ish
    // (still a new row, but the hash records which racks it came from).
    const groupHash = 'imgpair-' + crypto.createHash('sha256')
      .update(uniq.slice().sort().join('|')).digest('hex').slice(0, 12);
    const groupId = rackGroups.create({
      tenantId: req.user.tenant_id,
      userId:   req.user.id,
      videoHash: groupHash,
    });
    uniq.forEach((rid, i) => {
      // Pull a friendly label + device count from the rack's own result.
      let label = `Rack ${i + 1}`, deviceCount = null;
      try {
        const dm = JSON.parse(fs.readFileSync(path.join(outputsDir, rid, 'device_unit_map.json'), 'utf8'));
        deviceCount = Array.isArray(dm.devices) ? dm.devices.length
                    : (dm.units ? Object.keys(dm.units).length : null);
      } catch (_) {}
      rackGroups.addMember({
        groupId, rackId: rid, position: i + 1, label, deviceCount, score: null,
      });
    });
    // Best-effort: seed the inter-rack CMDB relationship in the background so
    // the dummy link also lands in ServiceNow (view renders from the synthesized
    // links regardless of whether this succeeds).
    try { scheduleInterRackCmdbLink(groupId); } catch (_) {}
    audit.log({ req, action: 'rack_group.create', targetType: 'rack_group',
                targetId: groupId, status: 'ok', payload: { rackIds: uniq } });
    res.json({ ok: true, groupId, count: uniq.length });
  } catch (err) {
    logger.error({ err: err.message }, 'rack-group create failed');
    res.status(500).json({ error: 'Failed to create rack group' });
  }
});

// ── Inter-rack link synthesis ────────────────────────────────────────
// There's no live network between two independently-photographed racks, so —
// exactly like the single-rack cabling, which synth.py fabricates — we
// synthesize the rack-to-rack uplinks. Each rack's "uplink end" is its
// aggregation switch (AGG-CORE, rendered out-of-rack) when present, else its
// top-most in-rack switch. Adjacent racks (by capture position) are chained.
// Deterministic: same members → same links, so the view is stable.
function readMemberTopo(rackId) {
  try {
    const p = path.join(outputsDir, rackId, 'topology.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return null;
}

// A rack's candidate uplink endpoints, most-core-like first: the out-of-rack
// aggregation/core switch, then the top-most in-rack switches. Only a few of
// these ever cross to the neighbour — the rest of each switch's ports stay
// wired inside its own rack (those edges live in the rack's own topology.json).
// The switch endpoints in a rack that cross-rack cables attach to. Prefers the
// REAL in-rack switches (so cables originate from actual devices inside the
// rack, at their real U-heights) over the out-of-rack aggregation box. Each
// endpoint carries its u_position/u_size so the 3D view can anchor the cable to
// that switch's exact height. Up to 2 uplink ports per switch → redundant runs.
function _uplinkPorts(topo, max = 6) {
  if (!topo || !Array.isArray(topo.devices)) return [];
  // The detector emits "Switch", not "switch" — an exact match found none of
  // them, so no rack ever offered an uplink endpoint and cross-rack cables had
  // nothing real to attach to. Normalise rather than trust upstream casing.
  const clsOf = (d) => String(d?.class ?? d?.class_name ?? '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  const switches = topo.devices.filter(d => clsOf(d) === 'switch');
  if (!switches.length) return [];
  const inRack = switches.filter(d => d.in_rack !== false && d.u_position != null);
  // In-rack switches, top-of-rack first; fall back to any switch if none are racked.
  const ordered = (inRack.length ? inRack : switches).slice().sort((a, b) =>
    (b.u_position || 0) - (a.u_position || 0));
  const eps = [];
  for (const sw of ordered) {
    const role = sw.in_rack === false ? 'core' : 'tor';
    const ups  = (sw.ports || []).filter(p => p.is_uplink);
    const pool = (ups.length ? ups : (sw.ports || [])).slice(0, 2);  // ≤2 ports/switch
    for (const p of pool) {
      eps.push({
        device: sw.name, port: p.label || p.name, role, model: sw.model || null,
        u_position: sw.u_position ?? null,
        u_size: sw.u_size || 1,
        in_rack: sw.in_rack !== false,
      });
      if (eps.length >= max) return eps;
    }
  }
  return eps;
}

// Deterministic small-integer from a string — keeps the synthesized link count
// stable for a given pair of racks (same racks → same wiring every render).
function _hashInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h;
}

const _LINK_ROLES = ['Primary uplink', 'Redundant uplink', 'Cross-connect', 'Backup link'];

// Synthesize a realistic set of rack-to-rack cables — one per in-rack switch
// pair (each rack's switches uplink to the neighbour's), plus a redundant run
// on the primary pair. NOT a one-to-one mesh: most cabling stays inside each
// rack (drawn from that rack's own topology); these are only the few links that
// cross. Endpoints carry u_position so the 3D view anchors each cable to the
// actual switch inside the rack, not a floating box on top.
function deriveInterRackLinks(members) {
  const withTopo = members
    .map(m => ({ ...m, topo: readMemberTopo(m.rack_id) }))
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  const links = [];
  for (let i = 0; i < withTopo.length - 1; i++) {
    const A = withTopo[i], B = withTopo[i + 1];
    const ea = _uplinkPorts(A.topo), eb = _uplinkPorts(B.topo);
    if (!ea.length || !eb.length) continue;
    // One cross-rack cable per switch pair, +1 redundant on the primary pair;
    // capped so a dense rack doesn't produce a mesh.
    const pairs = Math.min(ea.length, eb.length);
    const n = Math.min(pairs + 1, 5);
    for (let k = 0; k < n; k++) {
      // k == pairs → the redundant run: reuse switch 0 with its 2nd uplink port.
      const si = k < pairs ? k : 0;
      const s = ea[si], d = eb[si];
      const redundant = k >= pairs;
      links.push({
        cable_id:   `IRL-${A.rack_id.replace(/^RK-/, '')}-${B.rack_id.replace(/^RK-/, '')}-${k + 1}`,
        cable_type: (s.role === 'core' || d.role === 'core') ? 'fiber' : 'dac',
        role:       redundant ? 'Redundant uplink' : (_LINK_ROLES[k] || `Uplink ${k + 1}`),
        synthetic:  true,
        src: { rackId: A.rack_id, position: A.position, label: A.label, device: s.device,
               port: s.port, endRole: s.role, u_position: s.u_position, u_size: s.u_size, in_rack: s.in_rack },
        dst: { rackId: B.rack_id, position: B.position, label: B.label, device: d.device,
               port: d.port, endRole: d.role, u_position: d.u_position, u_size: d.u_size, in_rack: d.in_rack },
      });
    }
  }
  return links;
}

// Best-effort push of the synthesized inter-rack uplinks into the ServiceNow
// CMDB as `cmdb_rel_ci` "Connects to" relationships between the two racks'
// switch CIs. Fire-and-forget: the combined-topology view renders from the
// synthesized links regardless, so a missing ServiceNow config or a failed
// push never blocks the feature. No-op if ServiceNow isn't configured.
const _interRackCmdbInflight = new Set();
function scheduleInterRackCmdbLink(groupId) {
  if (!groupId || _interRackCmdbInflight.has(groupId)) return;
  if (!process.env.SN_INSTANCE) return;  // ServiceNow not configured — skip.
  const script = path.join(__dirname, '..', 'servicenow', 'cmdb_interrack_link.py');
  if (!fs.existsSync(script)) return;
  _interRackCmdbInflight.add(groupId);
  const { spawn } = require('child_process');
  const child = spawn(resolvePythonBin(), [script, '--group-id', groupId], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('close', (code) => {
    _interRackCmdbInflight.delete(groupId);
    if (code === 0) {
      logger.info({ event: 'cmdb.interrack_linked', groupId }, `inter-rack CMDB link pushed for ${groupId}`);
    } else {
      logger.warn({ event: 'cmdb.interrack_failed', groupId, exit: code,
        stderr: err.trim().slice(0, 500) }, `inter-rack CMDB push failed for ${groupId}`);
    }
  });
  child.on('error', (e) => {
    _interRackCmdbInflight.delete(groupId);
    logger.warn(`[cmdb-interrack] spawn skipped for ${groupId}: ${e.message}`);
  });
}

/**
 * GET /api/rack-group/:groupId/links
 * The synthesized rack-to-rack uplinks for a group — drives the spanning
 * cables + connection panel in the combined topology view.
 */
app.get('/api/rack-group/:groupId/links', auth.requireAuth, (req, res) => {
  const data = rackGroups.get(req.params.groupId);
  if (!data || data.group.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: 'Group not found' });
  }
  try {
    const links = deriveInterRackLinks(data.members);
    res.json({ ok: true, groupId: data.group.id, count: links.length, links });
  } catch (err) {
    logger.error({ err: err.message }, 'inter-rack links failed');
    res.status(500).json({ error: 'Failed to derive inter-rack links' });
  }
});

/**
 * GET /api/rack-group/:groupId/report?format=html
 * One combined report document covering EVERY rack in the group — each rack's
 * standard scan report stacked in order under a cover page. Reuses the per-rack
 * report renderer; splices each rack's <body> into a shared shell so it's a
 * single printable page (browser Print → PDF for a PDF).
 */
app.get('/api/rack-group/:groupId/report', auth.requireAuth, async (req, res) => {
  const data = rackGroups.get(req.params.groupId);
  if (!data || data.group.tenant_id !== req.user.tenant_id) {
    return res.status(404).json({ error: 'Group not found' });
  }
  const members = data.members || [];
  if (!members.length) return res.status(404).json({ error: 'Group has no racks' });

  try {
    let head = '';
    const sections = [];
    for (const m of members) {
      try {
        try { await shrinkImagesForReport(path.join(outputsDir, m.rack_id)); } catch (_) {}
        const { html } = await buildScanReport(m.rack_id);
        if (!head) {
          const hm = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
          head = hm ? hm[1] : '';
        }
        const bm = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        sections.push({ member: m, body: bm ? bm[1] : html });
      } catch (e) {
        sections.push({ member: m, body: `<p style="padding:20px;color:#b00">Report unavailable for ${htmlEscape(m.rack_id)}: ${htmlEscape(e.message)}</p>` });
      }
    }

    const cover = `
      <div style="padding:28px 24px;font-family:system-ui,-apple-system,sans-serif">
        <div style="font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#888">RackTrack · Combined report</div>
        <h1 style="font-size:2rem;font-weight:850;margin:8px 0 4px">Two-Rack Report</h1>
        <div style="color:#666">${members.length} racks · ${new Date().toISOString().slice(0, 10)}</div>
        <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:10px">
          ${members.map(m => `<span style="font-size:.82rem;font-weight:600;background:#f0f0f0;border-radius:999px;padding:5px 12px">#${m.position} ${htmlEscape(m.label || m.rack_id)} <code style="color:#888">${m.rack_id}</code></span>`).join('')}
        </div>
      </div>`;
    const rackHdr = (m) => `
      <div style="page-break-before:always;border-top:4px solid #1a1c1d;margin-top:8px"></div>
      <div style="padding:16px 24px;background:#1a1c1d;color:#fff;font-family:system-ui,sans-serif;font-weight:800;font-size:1.15rem">
        Rack #${m.position} — ${htmlEscape(m.label || m.rack_id)}
        <span style="font-weight:500;font-size:.8rem;opacity:.7;margin-left:8px">${m.rack_id}</span>
      </div>`;

    const combined =
      `<!DOCTYPE html><html><head>${head}</head><body>` +
      cover +
      sections.map((s, i) => (i > 0 ? rackHdr(s.member) : rackHdr(s.member)) + s.body).join('') +
      `</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('X-Frame-Options');
    return res.send(combined);
  } catch (err) {
    logger.error({ err: err.message }, 'combined report failed');
    res.status(500).json({ error: 'Failed to build combined report' });
  }
});

/**
 * GET /api/incidents/active
 * Returns the current list of RackTrack-actionable tickets pulled from
 * ServiceNow by the poller, plus the top one as a convenience field.
 */
app.get('/api/incidents/active', auth.requireAuth, (req, res) => {
  const data = readActiveTickets();
  res.json({
    polled_at: data.polled_at || null,
    source_instance: data.source_instance || null,
    count: data.count || 0,
    top: (data.tickets && data.tickets[0]) || null,
    tickets: data.tickets || [],
  });
});

// Latest /api/incidents/refresh job state. Polled by the client so the UI
// doesn't have to hold an HTTP request open while a slow ServiceNow PDI
// wakes up. Global (not per-user) for MVP — multi-user concurrent
// refresh is rare and the worst case is just a re-poll.
let _refreshState = null;   // { state, instance, startedAt, finishedAt, count, error }
let _refreshChild = null;   // handle on the running poll.py subprocess so we
                            // can cancel it when the user switches profiles
                            // mid-poll. Otherwise the banner shows the OLD
                            // instance's data, which is exactly the "I picked
                            // dev266363 but the banner says dev340483" bug.

/**
 * GET /api/incidents/refresh/status
 * Reports the latest refresh job state. Used by the client to poll
 * progress after kicking off /api/incidents/refresh.
 *
 * Returns: { state: 'idle'|'running'|'done'|'failed', instance, startedAt, finishedAt, count, error }
 */
app.get('/api/incidents/refresh/status', auth.requireAuth, (req, res) => {
  res.json(_refreshState || { state: 'idle' });
});

/**
 * POST /api/incidents/refresh
 * Kicks off servicenow_inbox/poll.py against the calling user's ACTIVE
 * connection profile, then returns IMMEDIATELY. The client polls
 * /api/incidents/refresh/status to know when it's done.
 *
 * This is the endpoint the client triggers right after the user activates
 * a new ServiceNow profile — otherwise the inbox cache stays pinned to
 * whichever account ran the last poll, which is the "I switched accounts
 * but incidents didn't change" symptom.
 */
app.post('/api/incidents/refresh', auth.requireAuth, async (req, res) => {
  const creds = getSnCreds(req.user);
  if (!creds) {
    return res.status(400).json({
      ok: false,
      error: 'No active ServiceNow connection. Add one under Profile → Connections.',
    });
  }
  const POLL_SCRIPT = path.join(__dirname, '..', 'servicenow_inbox', 'poll.py');
  if (!fs.existsSync(POLL_SCRIPT)) {
    return res.status(500).json({ ok: false, error: `poll.py not found at ${POLL_SCRIPT}` });
  }
  const { spawn } = require('child_process');
  // When MOCK_SERVER_URL is set in .env, ALL ServiceNow connections route
  // through the integrated mock routes so the app works without a real PDI.
  // The mock routes are now mounted in this same server, so the URL points
  // back to ourselves (http://localhost:<PORT>/api/now).
  const mockUrl = process.env.MOCK_SERVER_URL;  // e.g. http://localhost:3001
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    SN_INSTANCE: creds.instance,
    SN_USER:     creds.user,
    SN_PASSWORD: creds.password,
    ...(mockUrl ? { SN_BASE_URL: `${mockUrl}/api/now` } : {}),
  };
  // If a previous poll is still running, cancel it. The user has chosen a
  // new active profile (or hit Refresh again), and waiting on the old poll
  // would surface the wrong instance's data in the result banner.
  if (_refreshState && _refreshState.state === 'running' && _refreshChild) {
    logger.info(`[incidents.refresh] cancelling in-flight poll for ${_refreshState.instance} ` +
                `to start a fresh one for ${creds.instance}`);
    try { _refreshChild.kill('SIGKILL'); } catch (_) {}
    _refreshState = {
      ..._refreshState,
      state: 'cancelled',
      finishedAt: new Date().toISOString(),
    };
    _refreshChild = null;
  }

  logger.info(`[incidents.refresh] starting poll for ${creds.instance} (user=${req.user?.id || 'anon'})`);
  _refreshState = {
    state:      'running',
    instance:   creds.instance,
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    count:      null,
    error:      null,
  };

  // Return immediately so the client doesn't have to hold an HTTP
  // connection open while a slow PDI wakes up. The client polls
  // /api/incidents/refresh/status until state !== 'running'.
  res.status(202).json({
    ok: true,
    started: true,
    instance: creds.instance,
    startedAt: _refreshState.startedAt,
  });

  const child = spawn(pythonCmd, ['-u', POLL_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    env,
  });
  _refreshChild = child;
  // Capture the instance this child was spawned for, so we can ignore
  // late-arriving close events from a child we already cancelled.
  const myInstance = creds.instance;
  let stderr = '';
  let stdout = '';

  // 5 minutes — generous cap for a cold PDI + CMDB walks. The job lives
  // in _refreshState; the user can navigate freely while it runs.
  const TIMEOUT_MS = 300_000;
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    logger.warn(`[incidents.refresh] timed out for ${creds.instance}. stdout so far: ${stdout.slice(-500)}`);
    _refreshState = {
      ..._refreshState,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: `Poll timed out after ${TIMEOUT_MS / 1000}s talking to ${creds.instance}.service-now.com. ` +
             `Open ${creds.instance}.service-now.com in a browser, sign in to confirm it's awake, then try again.`,
    };
  }, TIMEOUT_MS);

  child.stdout.on('data', d => {
    const chunk = d.toString();
    stdout += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) logger.info(`[poll.py:${myInstance}] ${line.trim()}`);
    }
  });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('close', (code) => {
    clearTimeout(killer);
    // If this child was cancelled (because the user switched profiles
    // mid-poll, or hit Refresh again for the same profile), the global
    // state has already been replaced — don't overwrite the new poll's
    // status with our late-arriving result. The `child !== _refreshChild`
    // check catches the same-instance double-refresh case that the
    // instance-name guard alone would miss.
    if (child !== _refreshChild || _refreshState?.state !== 'running') {
      logger.info(`[incidents.refresh] ignoring close from cancelled poll for ${myInstance}`);
      return;
    }
    if (code === 0) {
      const data = readActiveTickets();
      try {
        data.source_instance = myInstance;
        data.polled_at = new Date().toISOString();
        fs.writeFileSync(
          path.join(INBOX_DIR, 'active_tickets.json'),
          JSON.stringify(data, null, 2)
        );
      } catch (e) {
        logger.warn(`[incidents.refresh] could not tag source: ${e.message}`);
      }
      try { _cmdbCache.clear(); } catch (_) {}
      _refreshState = {
        ..._refreshState,
        state: 'done',
        finishedAt: new Date().toISOString(),
        count: data.count || 0,
        error: null,
      };
      _refreshChild = null;
      logger.info({
        event: 'incidents.refreshed',
        instance: myInstance,
        count: data.count || 0,
        userId: req.user?.id || null,
      }, `inbox refreshed for ${myInstance} (${data.count || 0} tickets)`);
      return;
    }
    _refreshState = {
      ..._refreshState,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: stderr.slice(-500) || `poll exited ${code}`,
    };
    _refreshChild = null;
  });
  child.on('error', (e) => {
    clearTimeout(killer);
    if (_refreshState?.instance !== myInstance) return;
    _refreshState = {
      ..._refreshState,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: `Failed to start poller: ${e.message}`,
    };
    _refreshChild = null;
  });
});

/**
 * GET /api/incidents/:inc/expected-rack
 * Returns what the field tech should photograph for this incident — the
 * site/row/position breadcrumb and the rack's expected labels — so the
 * client can render a clear "upload THIS rack" prompt before the user
 * picks an image. No upload required.
 */
// Authenticated, like its three sibling incident routes. Without it this
// returned incident number, target, rack name, rack scan id, site, row, rack
// position and the full expected-device list to anyone — and ServiceNow
// incident numbers are sequential, so the whole inbox was enumerable.
app.get('/api/incidents/:inc/expected-rack', auth.requireAuth, (req, res) => {
  const ticket = readTicketByNumber(req.params.inc);
  if (!ticket) return res.status(404).json({ ok: false, error: `Ticket ${req.params.inc} not in inbox` });
  const cmdbRack = readCmdbRack(ticket.cmdb?.rack_name);
  res.json({
    ok: true,
    incident_number: ticket.incident_number,
    target: ticket.target || null,
    rack: {
      rack_name:     ticket.cmdb?.rack_name      || null,
      rack_scan_id:  ticket.cmdb?.rack_scan_id   || null,
      site:          ticket.cmdb?.site           || cmdbRack?.site           || null,
      row:           ticket.cmdb?.row            || cmdbRack?.row            || null,
      position:      ticket.cmdb?.rack_position  || cmdbRack?.position       || null,
      u_position:    ticket.cmdb?.u_position     || null,
      label_pattern: cmdbRack?.label_pattern     || null,
      expected_labels: (cmdbRack?.expected_devices || []).map(d => d.label),
      verification:  cmdbRack?.verification      || null,
    },
  });
});

/**
 * POST /api/incidents/:inc/verify-rack
 * Field-tech identity check before they're allowed to act on a ticket.
 * Body: multipart/form-data with `image` (front-of-rack photo).
 *
 * Runs analyze + label OCR on the upload, then checks the detected
 * identifier-shaped labels against the ticket's CMDB rack record. Three
 * outcomes:
 *   - 200 {ok:true}                       → rack identity confirmed, proceed
 *   - 409 {ok:false, reason:'rack_mismatch', detected, expected, missing}
 *                                         → wrong rack — tell the tech to
 *                                           upload the correct one
 *   - 200 {ok:null, reason:'no_labels_detected'}
 *                                         → soft mode, couldn't verify either
 *                                           way — UI prompts for manual confirm
 *
 * Always returns `detected` and `expected` so the client can show a diff.
 */
app.post('/api/incidents/:inc/verify-rack', scanLimit, upload.single('image'), async (req, res) => {
  const incNumber = req.params.inc;
  const ticket = readTicketByNumber(incNumber);
  if (!ticket) return res.status(404).json({ ok: false, error: `Ticket ${incNumber} not in inbox` });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image file provided' });

  let tmpPath = req.file.path;
  try {
    tmpPath = await normalizeImage(tmpPath);
    const rackId  = computeRackId(tmpPath, rackScope(softAuthPayload(req)));
    const rackDir = path.join(outputsDir, rackId);
    const dumPath = path.join(rackDir, 'device_unit_map.json');

    // Re-use the cached analysis if we've already seen this exact image.
    if (!fs.existsSync(dumPath)) {
      fs.mkdirSync(rackDir, { recursive: true });
      const ext = path.extname(tmpPath) || '.jpg';
      const imagePath = path.join(rackDir, `original_image${ext}`);
      fs.copyFileSync(tmpPath, imagePath);
      await runPipelineAnalyze(imagePath, rackDir, softAuthPayload(req)?.organizationId || null);
    }
    safeUnlink(tmpPath);

    // Make sure both OCR passes have run so verification has every signal
    // available — per-device crops (ocr_devices.json) AND full-image labels
    // (labels-front.json). Per-device is part of runPipelineAnalyze; the
    // full-image pass we trigger here so verification isn't racing the
    // background scheduler.
    const frontPath = path.join(rackDir, 'labels-front.json');
    if (!fs.existsSync(frontPath)) {
      try {
        const imgPath = path.join(rackDir, fs.readdirSync(rackDir).find(f => /^original_image\./.test(f)) || 'original_image.jpg');
        if (fs.existsSync(imgPath)) {
          const result = await runOcrLabels(imgPath);
          fs.writeFileSync(frontPath, JSON.stringify(result, null, 2));
        }
      } catch (e) {
        logger.warn(`[verify-rack] labels OCR failed for ${rackId}: ${e.message}`);
      }
    }

    const verdict = verifyRackIdentity(rackDir, ticket);
    audit.log({
      req,
      action: 'incident.verify_rack',
      meta: { incNumber, rackId, ok: verdict.ok, reason: verdict.reason, matches: verdict.matches?.length || 0 },
    });

    const status = verdict.ok === false ? 409 : 200;
    return res.status(status).json({
      ok: verdict.ok,
      reason: verdict.reason,
      incident_number: incNumber,
      uploaded_rack_id: rackId,
      expected_rack_name: ticket.cmdb?.rack_name || null,
      detected: verdict.detected,
      expected: verdict.expected,
      matches: verdict.matches,
      missing: verdict.missing || [],
      pattern_ok: verdict.pattern_ok || false,
      message: verdict.ok === true
        ? 'Rack identity confirmed.'
        : verdict.ok === null
          ? `This might not be ${ticket.cmdb?.rack_name}. Please check manually and confirm, or upload the correct rack.`
          : `This isn't ${ticket.cmdb?.rack_name}. Please upload the correct rack.`,
    });
  } catch (e) {
    safeUnlink(tmpPath);
    logger.warn(`[verify-rack] ${incNumber} failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/analyze-for-ticket
 * Scan-page one-shot: upload image + incident_number. Server does:
 *   1. Normal analyze (or cache hit)
 *   2. Resolve ticket → device_index via CMDB u_position + class
 *   3. Run the port-select pipeline for that device+port
 *   4. Try LLDP over SSH to the switch's mgmt_ip for the interface
 * Returns the bundled payload so the client has one round trip.
 */
app.post('/api/analyze-for-ticket', scanLimit, upload.single('image'), async (req, res) => {
  trackScanJob(req, res);
  const incNumber = req.body?.incident_number;
  if (!incNumber) return res.status(400).json({ error: 'incident_number is required' });

  const ticket = readTicketByNumber(incNumber);
  if (!ticket) return res.status(404).json({ error: `Ticket ${incNumber} not in inbox` });

  const cmdb = ticket.cmdb || {};
  const target = ticket.target || {};
  if (!target.device || target.port == null) {
    return res.status(400).json({ error: 'ticket missing target.device or target.port' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const reqStart = Date.now();
  const timings = {};

  try {
    // STEP 1 — analyze the rack (reuse logic from /api/analyze inline)
    let tmpPath = req.file.path;
    tmpPath = await normalizeImage(tmpPath);
    const rackId   = computeRackId(tmpPath, rackScope(softAuthPayload(req)));
    const rackDir  = path.join(outputsDir, rackId);
    const jsonPath = path.join(rackDir, 'device_unit_map.json');

    // Tenant ownership claim (same logic as /api/analyze).
    const _ticketAuth = softAuthPayload(req);
    if (_ticketAuth?.tenantId) {
      tenant.claimRack(_ticketAuth.tenantId, rackId, _ticketAuth.sub || null);
    }

    if (fs.existsSync(jsonPath)) {
      safeUnlink(tmpPath);
      logger.info({ event: 'ticket.cache_hit', rackId }, `ticket cache hit ${rackId}`);
      recordEvent('ticket.cache_hit', { rackId });
    } else {
      // Skip quality check in ticket mode — the tech is directed to a specific
      // rack by the ticket, we don't want to gate on tilt/lighting.
      fs.mkdirSync(rackDir, { recursive: true });
      const ext = path.extname(tmpPath) || '.jpg';
      const imagePath = path.join(rackDir, `original_image${ext}`);
      fs.copyFileSync(tmpPath, imagePath);
      safeUnlink(tmpPath);
      const tPipeStart = Date.now();
      await runPipelineAnalyze(imagePath, rackDir, softAuthPayload(req)?.organizationId || null);
      timings.analyze_ms = Date.now() - tPipeStart;
    }

    // STEP 1b — rack identity verification. Refuse to proceed if the OCR'd
    // labels on this image don't match the ticket's expected rack. This is
    // the "did the tech upload the right physical rack?" guard. Skipped
    // when the upload caller has explicitly waived verification (e.g. an
    // earlier verify-rack step already approved, or a confirmed manual
    // override) via `verified=1` in the form body.
    const verifyWaived = req.body?.verified === '1' || req.body?.verified === 'true';
    if (!verifyWaived) {
      // Ensure full-image labels exist before verifying — per-device OCR
      // (run by analyze above) is sometimes too narrowly cropped.
      const frontPath = path.join(rackDir, 'labels-front.json');
      if (!fs.existsSync(frontPath)) {
        try {
          const imgFile = fs.readdirSync(rackDir).find(f => /^original_image\./.test(f));
          if (imgFile) {
            const result = await runOcrLabels(path.join(rackDir, imgFile));
            fs.writeFileSync(frontPath, JSON.stringify(result, null, 2));
          }
        } catch (e) {
          logger.warn(`[analyze-for-ticket] labels OCR failed for ${rackId}: ${e.message}`);
        }
      }
      const verdict = verifyRackIdentity(rackDir, ticket);
      if (verdict.ok === false) {
        timings.total_ms = Date.now() - reqStart;
        audit.log({
          req,
          action: 'scan.analyze_for_ticket.rack_mismatch',
          meta: { incNumber, rackId, expected: ticket.cmdb?.rack_name, detected: verdict.detected },
        });
        return res.status(409).json({
          ok: false,
          error: 'rack_mismatch',
          incident_number: incNumber,
          uploaded_rack_id: rackId,
          expected_rack_name: ticket.cmdb?.rack_name || null,
          detected: verdict.detected,
          expected: verdict.expected,
          matches: verdict.matches,
          missing: verdict.missing || [],
          message: `This isn't ${ticket.cmdb?.rack_name}. Please upload the correct rack.`,
          timings,
        });
      }
      // ok === true or ok === null both proceed; client surfaces the
      // 'no_labels_detected' case downstream if it wants a manual confirm.
    }

    // STEP 2 — resolve ticket device to a scan device_index, and in the same
    // call gather "what is physically there at the expected U" for drift reporting.
    // Pass the CMDB block so the resolver can use u_position and sys_class_name
    // when the device name itself (e.g. RVEW-CORE-SW01) doesn't encode them.
    const resolved = resolveTicketDevice(rackDir, target.device, cmdb);
    if (resolved.device_index == null) {
      // PHYSICAL DRIFT — CMDB says there should be a `expected_class` at U`expected_u`,
      // but the scan sees something else (or nothing). Return a drift payload with
      // enough context for the client to render a "something is wrong" view.
      const analyzeResp = buildResponse(rackId, fs.existsSync(jsonPath));
      const seen = resolved.detections_at_u;
      const reason = seen.length === 0
        ? `CMDB says ${target.device} (${resolved.expected_class}) should be at U${String(resolved.expected_u).padStart(2,'0')}, but the scan detected nothing at that position.`
        : `CMDB says ${target.device} (${resolved.expected_class}) should be at U${String(resolved.expected_u).padStart(2,'0')}, but the scan sees ${seen.map(d => d.class_name).join(', ')} instead.`;
      timings.total_ms = Date.now() - reqStart;
      audit.log({
        req,
        action: 'scan.analyze_for_ticket',
        status: 'ok',
        targetType: 'rack',
        targetId: rackId,
        payload: { incident: incNumber, device: target.device, drift: true, expected_u: resolved.expected_u, seen: seen.map(d => d.class_name) },
      });
      const agent = await runAgentExtraction(ticket, rackDir);
      return res.json({
        ...analyzeResp,
        ticket,
        resolved: null,
        driftDetected: true,
        drift: {
          expected_device: target.device,
          expected_class: resolved.expected_class,
          expected_u: resolved.expected_u,
          detections_at_u: seen,
          reason,
        },
        rackImageUrl: analyzeResp.imageUrl,
        resultImageUrl: analyzeResp.imageUrl,
        portInfo: null,
        portClassification: null,
        lldp: null,
        agent,
        timings,
      });
    }
    const device_index = resolved.device_index;

    // STEP 3 — run port-select for this device + port. Find the cached image:
    // readMeta() may miss it (demo folders shipped without scan_meta.json), so
    // fall back to scanning rackDir for original_image.{jpg,jpeg,png}.
    const meta = readMeta(rackId);
    let imagePath = meta && meta.imagePath && fs.existsSync(meta.imagePath) ? meta.imagePath : null;
    if (!imagePath) {
      for (const ext of ['jpg', 'jpeg', 'png']) {
        const candidate = path.join(rackDir, `original_image.${ext}`);
        if (fs.existsSync(candidate)) { imagePath = candidate; break; }
      }
    }
    if (!imagePath) {
      return res.status(500).json({ error: `Cached image not found in ${rackDir}. Please upload the image again.` });
    }
    // Python pipeline expects 1-based device_index (runner.py:373 validates
    // `1 <= args.device_index <= len(devices)`); our resolveTicketDevice uses
    // 0-based. Convert on the wire.
    const pipelineDeviceIdx = device_index + 1;
    const tSelStart = Date.now();
    await runPipelineSelect(imagePath, rackDir, pipelineDeviceIdx, target.port);
    timings.select_ms = Date.now() - tSelStart;

    const infoPath = path.join(rackDir, 'selected_port_info.json');
    const fullData = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
    const portInfo = fullData.port_info || {};

    // Archive per-port images (use the 1-based index to match ResultsPage conventions)
    const baseDevice = `d${pipelineDeviceIdx}_p${target.port}_device.png`;
    const baseFull   = `d${pipelineDeviceIdx}_p${target.port}_full.png`;
    const srcDevice  = rackImagePath(rackDir, '5_selected_device_with_port.png');
    const srcFull    = rackImagePath(rackDir, '6_full_rack_selected_port.png');
    const dstDevice  = rackPortPath(rackDir, baseDevice);
    const dstFull    = rackPortPath(rackDir, baseFull);
    try {
      if (fs.existsSync(srcDevice)) fs.copyFileSync(srcDevice, dstDevice);
      if (fs.existsSync(srcFull))   fs.copyFileSync(srcFull, dstFull);
    } catch (e) { logger.error('port image archive failed:', e.message); }

    // STEP 4 — LLDP / SSH (best-effort; network is often unreachable in demo)
    let lldp = null;
    const host  = cmdb.mgmt_ip;
    const iface = cmdb.interface_alias;
    if (host && iface) {
      const vendorKey = VENDORS[cmdb.vendor] ? cmdb.vendor : 'tplink';
      const { username, password, enablePassword } = resolveSwitchCreds({ vendor: vendorKey });
      if (username && password) {
        const tLldpStart = Date.now();
        try {
          const out = await findNeighborChain({ host, port: 22, username, password, enablePassword, iface, vendor: vendorKey });
          lldp = { ok: true, ...out };
        } catch (err) {
          lldp = { ok: false, error: err.message, host, iface, vendor: vendorKey };
        }
        timings.lldp_ms = Date.now() - tLldpStart;
      } else {
        lldp = { ok: false, error: 'No SSH creds configured for this vendor', host, iface, vendor: vendorKey };
      }
    } else {
      lldp = { ok: false, error: 'Ticket CMDB has no mgmt_ip or interface_alias', host, iface };
    }

    timings.total_ms = Date.now() - reqStart;
    audit.log({
      req,
      action: 'scan.analyze_for_ticket',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { incident: incNumber, device: target.device, port: target.port, device_index },
    });

    // Merge full analyze response (devices list, units_detected, imageUrl, etc.)
    // with the ticket-specific fields so ResultsPage has the same shape it's
    // used to, plus the bundled ticket/resolved/lldp/agent extras.
    const analyzeResp = buildResponse(rackId, fs.existsSync(jsonPath));
    const tAgentStart = Date.now();
    const agent = await runAgentExtraction(ticket, rackDir);
    timings.agent_ms = Date.now() - tAgentStart;
    res.json({
      ...analyzeResp,
      ticket,
      // device_index returned to the client is 1-based to match the Python
      // pipeline + ResultsPage conventions (devices[selectedIdx - 1]).
      resolved: { device_index: pipelineDeviceIdx, device_name: target.device, port: Number(target.port) },
      rackImageUrl:   `/outputs/${rackId}/${rackImageUrlPath(rackDir, '6_full_rack_selected_port.png')}`,
      resultImageUrl: `/outputs/${rackId}/${rackImageUrlPath(rackDir, '5_selected_device_with_port.png')}`,
      portInfo,
      portClassification: fullData.port_classification || null,
      lldp,
      agent,
      timings,
    });
  } catch (err) {
    logger.error('[analyze-for-ticket]', err.message);
    res.status(400).json({
      error: 'Analysis failed. Please check the image and try again.',
      retryable: true,
      kind: 'quality',
    });
  }
});

// ── Agent dashboard routes ───────────────────────────────────────────────
// ServiceNow credentials come ONLY from the calling user's active connection
// profile (per-user, encrypted in auth.db). There is no env/file fallback —
// if the user has not set up a connection, callers get null and must return
// a 400 telling the user to add one under Profile → Connections.
function getSnCreds(user = null) {
  // Accept either a user object (preferred) or a bare userId (legacy).
  const userId = (typeof user === 'number') ? user : (user?.id || user?.sub || null);
  const orgId  = (typeof user === 'object' && user) ? (user.organization_id || null) : null;
  if (!userId && !orgId) return null;
  try {
    const profiles = require('./lib/connection_profiles');
    // Prefer the ORG-wide credential the admin configured; fall back to a
    // personal profile only if the org has none.
    const resolved = (orgId && profiles.resolveCredsForOrg(orgId, 'servicenow'))
      || (userId && profiles.resolveCredsForType(userId, 'servicenow'));
    if (resolved && resolved.secret &&
        resolved.secret.instance && resolved.secret.user && resolved.secret.password) {
      return {
        instance: resolved.secret.instance,
        user:     resolved.secret.user,
        password: resolved.secret.password,
      };
    }
  } catch (_) { /* no profile → return null */ }
  return null;
}

/**
 * GET /api/agent/feedback/scoreboard
 * Returns the agent accuracy scoreboard (local state — no SN call).
 */
app.get('/api/agent/feedback/scoreboard', auth.requireAuth, async (req, res) => {
  try {
    const r = await pool.request('feedback_scoreboard', {});
    if (!r.ok) return res.status(500).json({ error: r.error || 'scoreboard failed' });
    res.json(r.scoreboard || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agent/feedback/refresh
 * Pulls recently resolved incidents from ServiceNow, evaluates each against
 * the agent's stored prediction, and returns the updated scoreboard.
 */
app.post('/api/agent/feedback/refresh', auth.requireAuth, async (req, res) => {
  const sn_creds = getSnCreds(req.user);
  if (!sn_creds) return res.status(400).json({ error: 'No active ServiceNow connection. Add one under Profile → Connections.' });
  try {
    const r = await pool.request('feedback_refresh', { sn_creds, limit: req.body?.limit });
    if (!r.ok) return res.status(502).json({ error: r.error || 'refresh failed' });
    audit.log({ req, action: 'agent.feedback_refresh', status: 'ok', payload: { evaluations: (r.evaluations || []).length } });
    res.json({ evaluations: r.evaluations || [], scoreboard: r.scoreboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agent/proactive/insights
 * Returns the most recently cached proactive insights (no SN call).
 */
app.get('/api/agent/proactive/insights', auth.requireAuth, async (req, res) => {
  try {
    const r = await pool.request('proactive_cached', {});
    if (!r.ok) return res.status(500).json({ error: r.error || 'cached fetch failed' });
    res.json({ insights: r.insights || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agent/proactive/refresh
 * Regenerates proactive insights from live SN data and returns the new list.
 */
app.post('/api/agent/proactive/refresh', auth.requireAuth, async (req, res) => {
  const sn_creds = getSnCreds(req.user);
  if (!sn_creds) return res.status(400).json({ error: 'No active ServiceNow connection. Add one under Profile → Connections.' });
  try {
    const r = await pool.request('proactive_refresh', { sn_creds });
    if (!r.ok) return res.status(502).json({ error: r.error || 'refresh failed' });
    audit.log({ req, action: 'agent.proactive_refresh', status: 'ok', payload: { insights: (r.insights || []).length } });
    res.json({ insights: r.insights || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/incidents/:inc/post-work-note
 * Posts the agent's work-note text to ServiceNow on the named incident.
 * Honors agent.py's guards: confidence >= POST_CONFIDENCE_FLOOR, no re-post
 * if the analysis hash hasn't changed, and a 24h rate-limit per incident.
 *
 * Body (JSON):
 *   { force?: boolean }   // skip rate-limit + no-change guards
 *
 * Requires: server/.env (or s_agent/.env) has SN_INSTANCE / SN_USER / SN_PASSWORD.
 * Requires: an extract_ticket call was made previously (so we have the
 *   reasoning + extracted fields). We rebuild ticket context from the inbox
 *   + a fresh agent extraction so callers don't have to round-trip the whole
 *   ticket payload back through the wire.
 */
app.post('/api/incidents/:inc/post-work-note', auth.requireAuth, async (req, res) => {
  const incNumber = req.params.inc;
  const sn_creds = getSnCreds(req.user);
  if (!sn_creds) return res.status(400).json({ error: 'No active ServiceNow connection. Add one under Profile → Connections.' });

  const ticket = readTicketByNumber(incNumber);
  if (!ticket) return res.status(404).json({ error: `Ticket ${incNumber} not in inbox` });
  if (!ticket.sys_id) return res.status(400).json({ error: 'inbox ticket is missing sys_id — cannot post' });

  try {
    // Rebuild the agent's extraction + reasoning so the worker has the
    // current analysis to post. We pass last_scan_path when we know the
    // rack-scan-id from the ticket so drift steps surface in the note.
    const rackDir = ticket.cmdb?.rack_scan_id
      ? path.join(outputsDir, ticket.cmdb.rack_scan_id)
      : outputsDir;
    const agentRes = await runAgentExtraction(ticket, rackDir);
    if (!agentRes) return res.status(500).json({ error: 'agent extraction failed — try /api/analyze-for-ticket first' });

    const richTicket = {
      ...ticket,
      extracted: agentRes.extraction,
      reasoning: agentRes.reasoning,
    };

    const r = await pool.request('post_work_note', {
      ticket:   richTicket,
      sn_creds,
      force:    !!req.body?.force,
    });
    if (!r.ok) return res.status(502).json({ error: r.error || 'post failed' });

    audit.log({
      req,
      action: 'agent.post_work_note',
      status: r.status || 'unknown',
      targetType: 'incident',
      targetId: incNumber,
      payload: { status: r.status, hash: r.hash, reason: r.reason || null, confidence: agentRes.extraction?.confidence },
    });
    res.json({
      ok: true,
      status: r.status,
      hash: r.hash || null,
      reason: r.reason || null,
      incident_number: incNumber,
      preview: agentRes.work_note_preview,
    });
  } catch (err) {
    logger.error('[post-work-note]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/racks
 * Tenant-scoped: returns only racks the calling user's tenant has scanned.
 * If no auth token is present, falls back to the legacy "all racks" view
 * but logged so we can see if anything still hits it that way.
 */
app.get('/api/racks', auth.requireAuth, (req, res) => {
  try {
    const auth = softAuthPayload(req);
    const tid = auth?.tenantId;
    let allowed;
    if (tid) {
      allowed = tenant.tenantRackIds(tid);
    } else {
      logger.warn({ event: 'racks.unauthenticated' },
        'GET /api/racks served without auth — returning unfiltered list');
      allowed = null; // unfiltered (legacy)
    }
    const racks = fs.readdirSync(outputsDir)
      .filter(name => name.startsWith('RK-'))
      .filter(name => allowed === null || allowed.has(name))
      .map(name => {
        const meta = readMeta(name);
        return meta ? { rackId: name, timestamp: meta.timestamp } : { rackId: name };
      })
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ racks });
  } catch (err) {
    res.json({ racks: [] });
  }
});

// ── Per-user scan history ────────────────────────────────────
// Returns the rich list of scans owned by the authenticated user, with
// device/unit counts and the timestamp of the latest port identification.
// Used by the Profile page's history list.
app.get('/api/scans', auth.requireAuth, (req, res) => {
  const userId = req.user.id;
  const tenantId = req.user.tenant_id;
  const role = req.user.role;
  const orgId = req.user.organization_id;
  // Visibility by role:
  //   owner     → every rack on the platform, all users' scans
  //   org_admin → every rack in their org's Sites, all users' scans
  //   member    → only racks their Site owns, and only their own scans
  // `allowedRacks === null` means no rack-set restriction (owner).
  let allowedRacks;
  if (role === 'owner') allowedRacks = null;
  else if (role === 'org_admin' && orgId) allowedRacks = tenant.orgRackIds(orgId);
  // Member: only racks THEY claimed (rack_owners.created_by), so their own
  // cache-hit scans of already-scanned images still appear. The claim set is
  // already user-scoped, so we no longer also gate on the file-based
  // meta.userId (which holds the original scanner, not the current member).
  else allowedRacks = tenantId ? tenant.tenantUserRackIds(tenantId, userId) : new Set();
  try {
    const scans = fs.readdirSync(outputsDir)
      .filter(name => name.startsWith('RK-'))
      .map(rackId => {
        if (allowedRacks && !allowedRacks.has(rackId)) return null;
        const meta = readMeta(rackId);
        if (!meta) return null;
        // Note: no meta.userId gate for members — allowedRacks is already the
        // set of racks THIS member claimed (tenantUserRackIds), which is the
        // correct per-user ownership signal for shared RK-ids.
        const rackDir  = path.join(outputsDir, rackId);
        // One readdir instead of up to five existsSync calls. Every check
        // below is now a Set lookup: this handler is fully synchronous and
        // runs per rack, unbounded for the owner (whose allowedRacks is null,
        // so the filter above never short-circuits), and each syscall blocks
        // every other request on the server. Cheap here, but the shape is
        // linear and worst for the account most likely to hold every rack.
        let entries;
        try { entries = new Set(fs.readdirSync(rackDir)); }
        catch (_) { return null; }   // rack directory vanished between calls

        let deviceCount = 0, unitCount = 0;
        try {
          if (entries.has('device_unit_map.json')) {
            const data = JSON.parse(fs.readFileSync(path.join(rackDir, 'device_unit_map.json'), 'utf8'));
            deviceCount = Array.isArray(data.devices) ? data.devices.length : 0;
            unitCount   = Array.isArray(data.units_detected) ? data.units_detected.length : 0;
          }
        } catch (_) {}
        // Latest port identification timestamp (if any) for activity sorting
        let lastPortAt = null, portCount = 0;
        if (entries.has('port_identifications.jsonl')) {
          const lines = fs.readFileSync(path.join(rackDir, 'port_identifications.jsonl'), 'utf8')
            .split('\n').filter(Boolean);
          portCount = lines.length;
          if (lines.length) {
            try { lastPortAt = JSON.parse(lines[lines.length - 1]).timestamp || null; } catch {}
          }
        }
        // Original scan image (for a history thumbnail). Extension varies, and
        // matching against the listing also picks up the ones the old
        // hardcoded jpg/jpeg/png probe missed — .webp and iPhone .heic.
        const imageName = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
          .map(ext => `original_image.${ext}`)
          .find(name => entries.has(name));
        const image = imageName ? `/outputs/${rackId}/${imageName}` : null;
        return {
          rackId,
          timestamp: meta.timestamp || null,
          deviceCount,
          unitCount,
          portCount,
          lastPortAt,
          image,
          qualityWarning: meta.qualityWarning || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ scans });
  } catch (err) {
    logger.error('/api/scans failed:', err.message);
    res.status(500).json({ error: 'Failed to load scans' });
  }
});

// ════════════════════════════════════════════════════════════════════
// Ground Truth — technicians tell us the real identity of detected
// devices so we can find where the model is wrong and retrain on it.
//
// WRITES reuse the existing, battle-tested POST /api/feedback/device
// (atomic map update + append-only feedback.jsonl + AL memory + scoreboard).
// This section only adds the owner-only READ surfaces the tab needs:
//   GET /api/ground-truth/queue            → least-confident, still-untruthed
//                                            devices across all scans (worklist)
//   GET /api/ground-truth/scans            → per-scan truth progress (browse)
//   GET /api/ground-truth/scan/:rackId     → every device in one scan
//   GET /api/ground-truth/crop/:rackId/:i  → lazy, cached crop of one device
//
// Gated to `owner` for now. The rack-visibility logic below is already
// role-correct, so opening this to other roles later is a one-line change
// to the guard — the queries do not need to change.
// ════════════════════════════════════════════════════════════════════

// Latest device-class verdict per device_index for a rack, from feedback.jsonl.
function _gtDeviceFeedbackMap(rackDir) {
  const m = new Map();
  const fp = path.join(rackDir, 'feedback.jsonl');
  if (!fs.existsSync(fp)) return m;
  let lines = [];
  try { lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean); }
  catch (_) { return m; }
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (e && e.feedback_type === 'device' && e.device_index != null) {
      // File is append-order, so the last write for an index wins.
      m.set(Number(e.device_index), {
        is_correct: !!e.is_correct,
        actual_class: e.actual_device_class || null,
        predicted_class: e.predicted_device_class || null,
        timestamp: e.timestamp || null,
      });
    }
  }
  return m;
}

// Rack-slot placeholders, not real equipment. The CV model emits one entry
// per rack unit, so blank/closed slots come through as "Empty" / "Closed Unit"
// (the "U01 / unit 2" rows). Ground Truth is for verifying actual devices, so
// these are dropped from the list — matching the app-wide HIDDEN_DEVICE_TYPES
// used on the Results view. "Unidentified" is deliberately KEPT: an unlabelled
// device is exactly what ground-truthing exists to correct.
const GT_UNIT_CLASSES = new Set(['Empty', 'Closed Unit']);

// Normalised device list for one scan, with predicted class, confidence,
// position, a stable label, and current truth verdict. null if the scan has
// no device_unit_map.json yet. Shared by the queue, browse and detail routes.
function _gtScanDevices(rackId) {
  const rackDir = path.join(outputsDir, rackId);
  const mapPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(mapPath)) return null;
  let map;
  try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch { return null; }
  const meta = readMeta(rackId);
  const fbMap = _gtDeviceFeedbackMap(rackDir);
  const unitsDetected = map.units_detected || [];
  const overlayName = fs.existsSync(rackImagePath(rackDir, '3_units_and_devices.png'))
    ? '3_units_and_devices.png'
    : (fs.existsSync(rackImagePath(rackDir, '7_rack_all_ports.png')) ? '7_rack_all_ports.png' : null);
  const overlay = overlayName ? `/outputs/${rackId}/${rackImageUrlPath(rackDir, overlayName)}` : null;

  const counts = {};
  const devices = (map.devices || []).map((dev, i) => {
    const idx = i + 1;
    const code = CLASS_CODE_SRV[dev.class_name] || (dev.class_name || 'UNK').replace(/\s+/g, '').slice(0, 4).toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    const labelUnits = dev.units?.length ? dev.units : (unitsDetected.length ? [unitsDetected[0]] : []);
    const position = formatUnitsRangeSrv(labelUnits) || '—';
    const fb = fbMap.get(idx) || null;
    return {
      scanId: rackId,
      device_index: idx,
      predicted_class: dev.class_name || 'Unknown',
      confidence: typeof dev.confidence === 'number' ? dev.confidence : null,
      position,
      label: `${(position.split(/[\s–—-]/)[0] || 'U')}-${code}${String(counts[code]).padStart(2, '0')}`,
      source: dev.source || null,
      truthed: !!fb,
      truth: fb ? { is_correct: fb.is_correct, actual_class: fb.actual_class } : null,
      cropUrl: `/api/ground-truth/crop/${rackId}/${idx}`,
    };
  })
  // Drop the blank rack-slot rows AFTER indexing, so every kept device keeps
  // its original 1-based device_index (the crop + truth endpoints key off it).
  .filter(d => !GT_UNIT_CLASSES.has(d.predicted_class));
  return { rackId, meta, overlay, devices };
}

// Which racks may this caller see. Owner → all (null). Kept general so the
// route guard is the only thing to relax when opening the tab to other roles.
function _gtAllowedRacks(reqUser) {
  const role = reqUser?.role;
  const orgId = reqUser?.organization_id;
  const tenantId = reqUser?.tenant_id;
  const userId = reqUser?.id;
  if (role === 'owner') return null;
  if (role === 'org_admin' && orgId) return tenant.orgRackIds(orgId);
  return tenantId ? tenant.tenantUserRackIds(tenantId, userId) : new Set();
}

function _gtRackNames() {
  try { return fs.readdirSync(outputsDir).filter(n => n.startsWith('RK-')); }
  catch (_) { return []; }
}

// GET /api/ground-truth/queue?limit=150 — the labelling worklist.
// Every still-untruthed device across visible scans, least-confident first
// (unknown confidence is treated as most urgent), plus platform-wide stats.
app.get('/api/ground-truth/queue', auth.requireRole('owner'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
  const allowed = _gtAllowedRacks(req.user);

  let scans = 0, totalDevices = 0, truthed = 0, correct = 0, wrong = 0;
  const items = [];
  for (const rackId of _gtRackNames()) {
    if (allowed && !allowed.has(rackId)) continue;
    const sd = _gtScanDevices(rackId);
    if (!sd) continue;
    scans++;
    for (const dv of sd.devices) {
      totalDevices++;
      if (dv.truthed) {
        truthed++;
        if (dv.truth?.is_correct) correct++; else wrong++;
        continue; // worklist shows only what still needs truth
      }
      items.push({ ...dv, scannedAt: sd.meta?.timestamp || null, rackImageUrl: sd.overlay });
    }
  }
  items.sort((a, b) => ((a.confidence ?? -1) - (b.confidence ?? -1)));
  const graded = correct + wrong;
  res.json({
    items: items.slice(0, limit),
    truncated: items.length > limit,
    stats: {
      scans, devices: totalDevices, truthed, remaining: totalDevices - truthed,
      correct, wrong, accuracy: graded ? correct / graded : null,
    },
  });
});

// GET /api/ground-truth/scans — one row per scan with truth progress (browse).
app.get('/api/ground-truth/scans', auth.requireRole('owner'), (req, res) => {
  const allowed = _gtAllowedRacks(req.user);
  const scans = _gtRackNames().map((rackId) => {
    if (allowed && !allowed.has(rackId)) return null;
    const sd = _gtScanDevices(rackId);
    if (!sd) return null;
    const deviceCount = sd.devices.length;
    const truthedCount = sd.devices.filter(d => d.truthed).length;
    const correct = sd.devices.filter(d => d.truth?.is_correct).length;
    const wrong = sd.devices.filter(d => d.truthed && !d.truth?.is_correct).length;
    return { rackId, timestamp: sd.meta?.timestamp || null, deviceCount, truthedCount, correct, wrong, image: sd.overlay };
  }).filter(Boolean).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  res.json({ scans });
});

// GET /api/ground-truth/scan/:rackId — every device in one scan (browse detail).
// :rackId is guarded by app.param('rackId') (tenant scope) before we get here.
app.get('/api/ground-truth/scan/:rackId', auth.requireRole('owner'), (req, res) => {
  const { rackId } = req.params;
  const sd = _gtScanDevices(rackId);
  if (!sd) return res.status(404).json({ error: `Scan ${rackId} not found` });
  res.json({ rackId, timestamp: sd.meta?.timestamp || null, rackImageUrl: sd.overlay, devices: sd.devices });
});

// GET /api/ground-truth/crop/:rackId/:index — a tight crop of one device from
// the original photo, so the technician sees exactly what to identify. Cropped
// once on first request and cached to outputs/<rackId>/gt_crops/dev<i>.png.
app.get('/api/ground-truth/crop/:rackId/:index', auth.requireRole('owner'), async (req, res) => {
  const { rackId } = req.params;
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 1) {
    return res.status(400).json({ error: 'Invalid device index' });
  }
  const rackDir = path.join(outputsDir, rackId);
  const mapPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(mapPath)) return res.status(404).json({ error: 'Scan not found' });

  let box = null;
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    box = (map.devices || [])[index - 1]?.box || null;
  } catch (_) {}
  if (!box) return res.status(404).json({ error: 'Device not found' });

  const cropDir = path.join(rackDir, 'gt_crops');
  const dest = path.join(cropDir, `dev${index}.png`);
  try {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(cropDir, { recursive: true });
      const ok = await cropBoxImage(rackId, box, dest, 0.12, 6);
      if (!ok) return res.status(404).json({ error: 'Crop unavailable' });
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', 'image/png');
    return res.sendFile(dest);
  } catch (err) {
    logger.warn('ground-truth crop failed: ' + err.message);
    return res.status(404).json({ error: 'Crop unavailable' });
  }
});

// ── Report endpoints ──────────────────────────────────────────
// One source of truth (buildScanReportData), four output formats:
//   GET /api/scan/:rackId/report                 → JSON metadata (no file written)
//   GET /api/scan/:rackId/report?format=html     → standalone HTML (regenerates + saves to disk)
//   GET /api/scan/:rackId/report?format=json     → JSON data
//   GET /api/scan/:rackId/report?format=csv      → CSV (Excel opens this directly)
//   POST /api/scan/:rackId/report                → regenerates HTML file and returns metadata
// The HTML file lives at outputs/<rackId>/report.html (single self-contained file with inline images).
// Mints a short-lived token for ONE rack so the report <iframe src> can prove
// access without an Authorization header. requireAuth runs first, and
// app.param('rackId') has already enforced tenant scope by the time we get
// here — so a caller can only ever mint a token for a rack they can already
// read.
app.get('/api/scan/:rackId/report-token', auth.requireAuth, (req, res) => {
  const t = signReportToken(req.params.rackId);
  if (!t) return res.status(500).json({ error: 'cannot sign report token' });
  res.json({ token: t, expires_in: REPORT_TOKEN_TTL_SEC });
});

// Reachable two ways: a normal Authorization header (ProfilePage fetches
// format=json via authFetch), or ?t=<report token> for the iframe. Either way
// app.param('rackId') above has already authorised this rack — this route does
// not need its own gate, and adding requireAuth here would break the iframe.
app.get('/api/scan/:rackId/report', async (req, res) => {
  const { rackId } = req.params;
  const format = (req.query.format || 'meta').toLowerCase();
  // The app's Download button asks for ?download=1. Without it the PDF is
  // served inline, which makes a browser render the report rather than save
  // it — reported by testers as "the download does nothing". The in-report
  // "Open PDF" link deliberately omits the flag, so viewing still works.
  const asAttachment = req.query.download === '1' || req.query.download === 'true';
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (format === 'html') {
      // Downscale big renders first so the report renders on phones.
      try { await shrinkImagesForReport(path.join(outputsDir, rackId)); } catch (_) {}
      const { html } = await buildScanReport(rackId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // The app shows this report inside an <iframe>. helmet's default
      // X-Frame-Options: SAMEORIGIN blocks that because the iframe's parent
      // (the app WebView origin) differs from this server's origin, so the
      // WebView fails with ERR_BLOCKED_BY_RESPONSE. Drop it for THIS response
      // only — clickjacking protection stays on for every other route.
      res.removeHeader('X-Frame-Options');
      return res.send(html);
    }
    if (format === 'pdf') {
      // Real PDF, rendered server-side by headless Chromium (puppeteer) — the
      // same path the Slack/email share uses. Reliable everywhere, unlike the
      // in-WebView print sheet. Inline by default so a viewer can show it;
      // `attachment` when the caller explicitly asked to save it.
      const { pdfPath } = await buildScanReportPDF(rackId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `${asAttachment ? 'attachment' : 'inline'}; filename="rack-report-${rackId}.pdf"`);
      res.removeHeader('X-Frame-Options');
      return res.sendFile(pdfPath);
    }
    if (format === 'json') {
      const data = buildScanReportData(rackId);
      res.setHeader('Content-Type', 'application/json');
      return res.send(renderJSONReport(data));
    }
    if (format === 'csv') {
      const data = buildScanReportData(rackId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${rackId}_report.csv"`);
      return res.send(renderCSVReport(data));
    }
    // Default: metadata + URLs for each format
    const data = buildScanReportData(rackId);
    res.json({
      rackId,
      timestamp: data.timestamp,
      summary: {
        devices: data.devices.length,
        units: data.units_range,
        feedback_total: data.feedback.total,
        accuracy: data.feedback.accuracy,
      },
      htmlUrl: `/api/scan/${rackId}/report?format=html`,
      jsonUrl: `/api/scan/${rackId}/report?format=json`,
      csvUrl:  `/api/scan/${rackId}/report?format=csv`,
      htmlFileUrl: `/outputs/${rackId}/report.html`,
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/scan/:rackId/report', async (req, res) => {
  const { rackId } = req.params;
  try {
    const { reportPath, data } = await buildScanReport(rackId);
    audit.log({ req, action: 'report.regen', status: 'ok', targetType: 'rack', targetId: rackId });
    res.json({
      rackId,
      reportPath,
      htmlFileUrl: `/outputs/${rackId}/report.html`,
      summary: {
        devices: data.devices.length,
        feedback_total: data.feedback.total,
        accuracy: data.feedback.accuracy,
      },
    });
  } catch (err) {
    audit.log({ req, action: 'report.regen', status: 'fail', targetType: 'rack', targetId: rackId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scan/:rackId/device-override  body: { position, make, model, firmware }
// Persists a user's manual make/model/firmware correction (from the Switch
// Information page) server-side, keyed by the device's "U04"-style
// position — the same key the per-device OCR pass uses, so the report's
// Selected Device section can prefer it over the (often partial/garbled)
// OCR read. Previously this only lived in the browser's localStorage,
// invisible to anything server-side including the report.
app.post('/api/scan/:rackId/device-override', (req, res) => {
  const { rackId } = req.params;
  if (!/^RK-[A-Za-z0-9]{4,32}$/.test(rackId)) {
    return res.status(400).json({ error: 'Invalid scanId' });
  }
  const _auth = softAuthPayload(req);
  if (!canAccessRack(_auth, rackId)) {
    return res.status(404).json({ error: 'Rack not found' });
  }
  const { position, make, model, firmware } = req.body || {};
  if (!position || typeof position !== 'string') {
    return res.status(400).json({ error: 'position is required' });
  }
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  try {
    const overridesPath = deviceOverridesPath(rackDir);
    let overrides = {};
    if (fs.existsSync(overridesPath)) {
      try { overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8')); } catch { overrides = {}; }
    }
    const entry = { ...(overrides[position] || {}) };
    if (make     !== undefined) entry.make     = make     || null;
    if (model    !== undefined) entry.model    = model    || null;
    if (firmware !== undefined) entry.firmware = firmware || null;
    entry.updated_at = new Date().toISOString();
    // Drop the row once every field is cleared, so the file doesn't
    // accumulate empty placeholders for corrections the user undid.
    if (!entry.make && !entry.model && !entry.firmware) {
      delete overrides[position];
    } else {
      overrides[position] = entry;
    }
    fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), 'utf8');
    res.json({ ok: true, position, override: overrides[position] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan/:rackId/result
// Returns the canonical merged scan_result.json (schema scan_result.v1).
// If the file doesn't exist yet (e.g. older scan, or it was never refreshed),
// regenerate it on the fly so callers always get a current view.
// GET /api/cmdb/rack/:rackId/switches
// Returns { rack, switches: [{ name, serial_number, model_number, ip_address, mac_address, os_version, manufacturer, position }] }.
// Spawns servicenow/list_rack_switches.py which queries cmdb_ci_rack by
// u_racktrack_scan_id and walks Contains-relations to its switch children.
// Empty switches[] when SN env vars aren't set or the rack isn't in CMDB —
// the UI just shows "—" for serials in that case.
const _cmdbCache = new Map(); // rackId -> { at, payload }
app.get('/api/cmdb/rack/:rackId/switches', auth.requireAuth, (req, res) => {
  const { rackId } = req.params;
  const cached = _cmdbCache.get(rackId);
  if (cached && Date.now() - cached.at < 60_000) {
    return res.json(cached.payload);
  }
  const scriptPath = path.join(PROJECT_ROOT, 'servicenow', 'list_rack_switches.py');
  if (!fs.existsSync(scriptPath)) {
    return res.json({ rack: null, switches: [] });
  }
  // Inject ServiceNow credentials from the user's active connection profile.
  // No env/file fallback — if no profile is configured, return 400 so the
  // user knows to set one up under Profile → Connections.
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const profiles = require('./lib/connection_profiles');
  const resolved = profiles.resolveCredsForOrg(req.user?.organization_id, 'servicenow') || profiles.resolveCredsForType(req.user?.id, 'servicenow');
  if (!resolved || !resolved.secret ||
      !resolved.secret.instance || !resolved.secret.user || !resolved.secret.password) {
    return res.status(400).json({
      error: 'No active ServiceNow connection. Add one under Profile → Connections.',
      rack: null, switches: [],
    });
  }
  env.SN_INSTANCE = resolved.secret.instance;
  env.SN_USER     = resolved.secret.user;
  env.SN_PASSWORD = resolved.secret.password;
  const child = spawnChild(pythonCmd, ['-u', scriptPath, rackId], {
    cwd: PROJECT_ROOT,
    env,
  });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => { if (settled) return; settled = true; res.status(status).json(body); };
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} send(504, { error: 'CMDB lookup timed out', switches: [] }); }, 15_000);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let payload = null;
    try { payload = JSON.parse(lastLine); } catch (_) {}
    if (!payload || typeof payload !== 'object') {
      return send(200, { rack: null, switches: [], error: stderr.slice(-500) || 'no JSON from script' });
    }
    _cmdbCache.set(rackId, { at: Date.now(), payload });
    send(200, payload);
  });
});

// GET /api/topology/:rackId
// Serves the topology snapshot written by servicenow/bootstrap_cmdb_full.py
// (mirror of CMDB rack→device→port tree + Connects-to cable edges).
// Snapshot lives at outputs/<rackId>/topology.json.
app.get('/api/topology/:rackId', auth.requireAuth, (req, res) => {
  const { rackId } = req.params;
  res.setHeader('Cache-Control', 'no-store');
  const snapPath = path.join(outputsDir, rackId, 'topology.json');
  if (!fs.existsSync(snapPath)) {
    // Fire-and-forget: try to (re)generate the snapshot in the background so a
    // refresh in a few seconds returns the real topology.
    try { scheduleTopologyRegen(rackId); } catch (_) {}
    return res.status(404).json({ error: 'pending' });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(snapPath, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read topology snapshot', details: err.message });
  }
});

// GET /api/scan/:rackId
// Returns the same shape as POST /api/analyze (cached) — devices array with
// per-port arrays, units_detected, originalExt, etc. The All Components and
// Topology pages call this on mount so port counts stay in sync with the
// underlying device_unit_map.json after re-detection runs.
app.get('/api/scan/:rackId', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  res.setHeader('Cache-Control', 'no-store');
  const rackDir = path.join(outputsDir, rackId);
  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  try {
    // Reopening a scan whose port data went missing must rebuild it before
    // answering, or the page opens with no devices and no pickable ports.
    await healPortDataIfMissing(rackId);
    res.json(buildResponse(rackId, true));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan/:rackId/result', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  res.setHeader('Cache-Control', 'no-store');
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  const resultPath = path.join(rackDir, 'scan_result.json');
  try {
    // Same as above — and it must run BEFORE the cached scan_result.json is
    // read, because that cache is what carries the portless devices onward.
    // A successful heal rewrites scan_result.json itself, so the read below
    // picks up the repaired payload.
    await healPortDataIfMissing(rackId);
    if (!fs.existsSync(resultPath)) {
      const result = writeCanonicalScanResult(rackId);
      // Internal filename kept out of the response — it goes in the log instead.
      if (!result) return res.status(500).json({ error: 'Could not assemble the scan result.' });
      return res.json(result);
    }
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(resultPath, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Switch LLDP neighbor lookup ───────────────────────────────
// SSH into a Cisco-IOS-style switch, run
//   show lldp neighbors <interface> detail
// and parse the output for the neighbor on the other end of the cable.
// Credentials come per-request — never stored on the server.
const { Client: SSHClient } = require('ssh2');

// Open an interactive shell, retrying a couple of times on a transient
// channel-open failure ("Unable to open shell"). Small switches (TP-Link
// JetStream, some D-Link) allow very few concurrent SSH sessions, so if a
// previous session is still closing or the device is momentarily at its cap,
// the first shell() request is refused even though auth succeeded. A short
// retry lets the slot free up instead of failing the whole probe.
function openShellWithRetry(conn, opts, cb, attempts = 1, delayMs = 2500) {
  try {
    conn.shell(opts, (err, stream) => {
      if (err && attempts > 1) {
        logger.warn(`[ssh] shell open failed (${err.message}); retrying, ${attempts - 1} left`);
        setTimeout(() => openShellWithRetry(conn, opts, cb, attempts - 1, delayMs), delayMs);
        return;
      }
      cb(err, stream);
    });
  } catch (e) {
    // conn.shell() can THROW synchronously (e.g. "Not connected" if the SSH
    // link dropped between attempts) instead of invoking the callback. Because
    // retries fire from a setTimeout, an escaping throw becomes an
    // uncaughtException and crashes the server — so catch it and surface it as
    // a normal error to the caller instead.
    cb(e);
  }
}

// Per-host SSH serialization. IPSSH / embedded switch SSH stacks typically
// allow only ONE session, so the background port poller (every few seconds) and
// a manual probe hitting the same host at the same time collide → "Not
// connected" / "Unable to open shell". We queue all SSH to a given host through
// a per-host promise chain, so only one session talks to a switch at a time.
const _sshHostLocks = new Map();
function withHostLock(host, fn) {
  const prev = _sshHostLocks.get(host) || Promise.resolve();
  const next = prev.then(fn, fn);           // run after the previous one settles
  _sshHostLocks.set(host, next.then(() => {}, () => {}));
  return next;
}
// Transport-level errors that warrant a FULL reconnect (brand-new TCP + SSH
// handshake), as opposed to reopening a shell on a handle that's already dead.
// Small managed switches (TP-Link JetStream, some D-Link) cap concurrent SSH
// sessions and tear the whole session down under load — ssh2 then surfaces
// "Not connected" / "Unable to open shell" / a reset. openShellWithRetry can't
// recover from these because it retries on the SAME (dead) connection; a fresh
// connection almost always succeeds once the switch frees the session slot.
const _TRANSIENT_SSH_RE = /not connected|unable to open shell|channel open failure|econnreset|epipe|handshake failed/i;

// attempts=1 → NO reconnect. On switches that don't promptly free SSH sessions
// (TP-Link JetStream et al.), every reconnect leaves another stuck session and
// makes saturation worse, not better. One clean attempt per probe; if the switch
// is momentarily busy the user just retries — far better than piling on sessions.
async function _runWithReconnect(fn, opts, attempts = 1, delayMs = 5000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(opts);
    } catch (e) {
      lastErr = e;
      const transient = _TRANSIENT_SSH_RE.test(e?.message || '');
      if (i < attempts - 1 && transient) {
        logger.warn(`[ssh] transient "${e.message}" on ${opts.host}; full reconnect ${i + 1}/${attempts - 1}`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Tell the background poller to yield this switch while a MANUAL probe runs,
// so they don't fight over the switch's single SSH session. Only manual calls
// do this — the poller tags its own calls with _fromPoller so it never yields
// to itself.
function _maybeNoteManual(opts) {
  if (opts && opts.host && !opts._fromPoller) {
    try { require('./lib/port_poller').noteManualProbe(opts.host); } catch (_) {}
  }
}
// These two runners are the ONLY way anything reaches a switch, and they always
// open a real SSH session — there is no fixture seam here, deliberately. The
// screens they feed (the owner Lab page, the Live Network Switch page, the port
// poller's drift history) all state on their face that they are showing a live
// switch, so answering them from invented transcripts made every one of them
// lie: PoE watts and negotiated speeds on virtual EVE-NG nodes that have
// neither, "Live" pills on switches that were stopped. An unreachable switch
// saying so is worth more than a reachable-looking fake. The demo box gets its
// seeded network at the Netdisco seam only (see lib/demo_data.js).
// ── Deployments that are not on the switch's network ────────────────
//
// RackTrack reads switches over SSH from the network it runs on. That works in a
// customer install, which sits on the same network as their switches. It cannot
// work on a public cloud instance — the demo — where every private address a
// visitor could type is unroutable.
//
// The login form still works and the attempt still runs: someone typing their
// own switch details deserves a real answer, not a disabled button. Two changes
// only, so that answer arrives quickly and explains itself:
//
//   1. FAIL FAST. A route that does not exist takes the full SSH timeout to
//      admit it — up to 30s of spinner before a reply. Clamped to a few seconds
//      here, because "no route" is knowable long before then.
//   2. SAY WHY. The raw failure is a handshake timeout, which the UI renders as
//      "The switch didn't respond" — sending the reader off to check a switch
//      that is fine. Replace it with the operator's sentence, which names the
//      real reason and that it works on their own network.
//
// Only connectivity failures are rewritten. A rejected password still says the
// password was rejected — that answer is true here and worth keeping.
//
// Deliberately NOT inferred from "no credentials stored": a customer install
// mid-setup must keep getting the actionable "add a sign-in" message rather than
// being told the network is wrong.
const OFF_NETWORK = process.env.LIVE_SWITCH_OFF_NETWORK === '1'
                 || process.env.LIVE_SWITCH_OFF_NETWORK === 'true';
const OFF_NETWORK_TIMEOUT_MS = 6000;
const OFF_NETWORK_NOTE = process.env.LIVE_SWITCH_NOTE
  || 'This server isn’t on your switch’s network, so it can’t reach it. '
   + 'RackTrack reads switches when it runs on the same network as them.';

// ECONNREFUSED is deliberately ABSENT: a refused connection proves the host was
// reached, which directly contradicts "not on your network". That case keeps its
// own truthful message ("refused the connection — is SSH enabled on it?").
// DNS failures stay in: an internal name like sw1.office.local genuinely cannot
// resolve from off the network.
const NO_ROUTE_RE = /timed out|etimedout|ehostunreach|enetunreach|no route|handshake|enotfound|eai_again/i;

// The two runners name their timeouts differently, and the batch one keeps the
// handshake timeout separate from the per-command one — so cap all three, or the
// cap silently does nothing on whichever path the caller happened to use. The
// handshake timeout is the one that actually matters here: an unroutable address
// fails at connect, long before any command runs.
function offNetworkOpts(opts) {
  if (!OFF_NETWORK) return opts;
  const cap = (v) => Math.min(Number(v) || OFF_NETWORK_TIMEOUT_MS, OFF_NETWORK_TIMEOUT_MS);
  return {
    ...opts,
    timeoutMs:       cap(opts?.timeoutMs),        // _runSwitchCommandRaw
    timeoutMsPerCmd: cap(opts?.timeoutMsPerCmd),  // _runSwitchCommandsSequentialRaw
    readyTimeoutMs:  OFF_NETWORK_TIMEOUT_MS,      // the handshake, on both paths
  };
}
function offNetworkRethrow(err) {
  if (OFF_NETWORK && NO_ROUTE_RE.test(String(err?.message || ''))) {
    const wrapped = new Error(OFF_NETWORK_NOTE);
    wrapped.offNetwork = true;
    wrapped.cause = err;
    throw wrapped;
  }
  throw err;
}

function runSwitchCommand(opts) {
  // Serialize per host AND retry the whole connection on a transient drop.
  _maybeNoteManual(opts);
  return withHostLock(opts.host, () => _runWithReconnect(_runSwitchCommandRaw, offNetworkOpts(opts)))
    .catch(offNetworkRethrow);
}
function runSwitchCommandsSequential(opts) {
  // Same treatment as runSwitchCommand: serialize per host AND full-reconnect on
  // a transient drop. Previously this multi-command path only had the host lock,
  // so a TP-Link "Not connected" mid-probe failed the whole thing instead of
  // reconnecting once the switch freed its single SSH session.
  _maybeNoteManual(opts);
  return withHostLock(opts.host, () => _runWithReconnect(_runSwitchCommandsSequentialRaw, offNetworkOpts(opts)))
    .catch(offNetworkRethrow);
}

function _runSwitchCommandRaw({ host, port = 22, username, password, command, timeoutMs = 20000, pagingOff = 'terminal length 0', enable = null, enablePassword = null }) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let resolved = false;
    // Track how far the session got, so the `close` handler below can report an
    // accurate reason: auth-succeeded-but-shell-refused (session saturation) is a
    // very different failure from auth-failed (bad creds / unreachable).
    let authOk = false;
    let shellErr = null;
    const finish = (err, data) => {
      if (resolved) return;
      resolved = true;
      try { conn.end(); } catch (_) {}
      clearTimeout(killer);
      err ? reject(err) : resolve(data);
    };
    const killer = setTimeout(() => finish(new Error(`SSH/command timed out after ${timeoutMs}ms`)), timeoutMs);

    // Shell prompts vary by vendor: `Switch>`, `Switch#`, `TL-SG2428P>`, `rtr(config)#`, etc.
    // We match `>` / `#` at end-of-buffer after optional whitespace/ANSI escapes.
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const PROMPT_RE   = /[>#]\s*$/;
    const PASSWD_RE   = /password\s*:\s*$/i;
    const PROMPT_OR_PASSWD_RE = /(?:password\s*:\s*$)|(?:[>#]\s*$)/i;

    conn
      .on('keyboard-interactive', (_name, _instructions, _lang, _prompts, cb) => {
        // Many switches (notably TP-Link and some D-Link) only accept
        // keyboard-interactive auth, not the default `password` method.
        cb(_prompts.map(() => password));
      })
      .on('ready', () => {
        authOk = true;
        // Advertise a tall, wide PTY so vendor pagers don't kick in mid-output.
        // ssh2 defaults to 24×80 — TP-Link JetStream then paginates `show interface
        // status` on a 28-port switch, dropping rows around the page boundary even
        // with `disable pager` set. Real terminals (PuTTY etc.) send their actual
        // window size and the switch fits everything in one page.
        openShellWithRetry(conn, { term: 'vt100', rows: 1000, cols: 200 }, (err, stream) => {
          if (err) { shellErr = err.message; return finish(err); }

          let buf = '';
          let pagedAt = -1;
          const PAGING_RE = /Press any key to continue|--More--|<--- More --->/i;
          const waiters = []; // { re, resolve, timer }
          const checkWaiters = () => {
            const clean = stripAnsi(buf);
            for (let i = waiters.length - 1; i >= 0; i--) {
              const w = waiters[i];
              if (w.re.test(clean)) {
                clearTimeout(w.timer);
                waiters.splice(i, 1);
                w.resolve(buf);
              }
            }
          };
          stream
            .on('data', (chunk) => {
              buf += chunk.toString();
              // Auto-advance past --More-- pagination prompts.
              // Search from after the last acknowledged prompt so we detect
              // subsequent pages (buf.match() only returns the first hit).
              const searchFrom = pagedAt < 0 ? 0 : pagedAt + 1;
              if (searchFrom < buf.length) {
                const tail = buf.slice(searchFrom);
                const m = tail.match(PAGING_RE);
                if (m) {
                  pagedAt = searchFrom + m.index;
                  try { stream.write(' '); } catch (_) {}
                }
              }
              checkWaiters();
            })
            .on('close', () => finish(null, buf))
            .stderr.on('data', (chunk) => { buf += chunk.toString(); checkWaiters(); });
          stream.setEncoding('utf8');

          const waitFor = (re, timeout = 4000) => new Promise((res) => {
            if (re.test(stripAnsi(buf))) return res(buf);
            const w = { re, resolve: res };
            w.timer = setTimeout(() => {
              const idx = waiters.indexOf(w);
              if (idx >= 0) waiters.splice(idx, 1);
              res(buf); // resolve with whatever we have; caller decides
            }, timeout);
            waiters.push(w);
          });
          // Reset buffer so subsequent waitFor() only sees new output.
          const resetBuf = () => { buf = ''; pagedAt = -1; };

          (async () => {
            try {
              await waitFor(PROMPT_RE, 5000); // initial banner + prompt

              if (enable) {
                resetBuf();
                stream.write(`${enable}\r\n`);
                await waitFor(PROMPT_OR_PASSWD_RE, 4000);
                if (PASSWD_RE.test(stripAnsi(buf))) {
                  resetBuf();
                  stream.write(`${enablePassword || ''}\r\n`);
                  await waitFor(PROMPT_RE, 4000);
                }
              }

              if (pagingOff) {
                resetBuf();
                stream.write(`${pagingOff}\r\n`);
                await waitFor(PROMPT_RE, 3000);
              }

              resetBuf();
              stream.write(`${command}\r\n`);
              await waitFor(PROMPT_RE, timeoutMs - 3000);
              const output = buf;

              try { stream.end('exit\r\n'); } catch (_) {}
              finish(null, output);
            } catch (e) {
              finish(null, buf);
            }
          })();
        });
      })
      .on('error', finish)
      // Some switches accept auth then immediately tear down the session when a
      // shell/exec channel is requested — a low-privilege account, a one-session
      // cap, or AAA closing the CLI. ssh2 emits 'close' for that WITHOUT an
      // 'error', so with only the handler above the promise would hang until the
      // command timeout. Settle it fast with a clear reason instead. (On a normal
      // run finish() has already resolved, so this no-ops via the `resolved` guard.)
      .on('close', () => {
        // If auth already succeeded, the creds are fine — the switch accepted the
        // login and then refused/closed the shell channel. On TP-Link JetStream and
        // similar switches that means all concurrent SSH sessions are in use (they
        // don't free a session when the TCP connection drops, only on idle timeout),
        // so a burst of probes/reconnects saturates the ~1-session limit. Report that
        // precisely instead of blaming the account's CLI privileges.
        const msg = authOk
          ? 'The switch accepted the login but refused a CLI session — its concurrent-session limit is saturated by stuck sessions. Do NOT keep retrying (each attempt adds another session). Clear it out-of-band: log into the switch web UI and disable/enable SSH, or reboot the switch; then a single probe will succeed.'
          : 'SSH session closed before login completed — the switch is unreachable, or the credentials are wrong (some switches drop the connection mid-handshake on a bad password instead of returning a clean auth failure).';
        finish(new Error(msg));
      })
      .connect({
        host, port, username, password,
        tryKeyboard: true, // fall back to keyboard-interactive if password auth fails
        readyTimeout: timeoutMs,
        // Legacy-friendly algorithm set. Only include names that node's `ssh2`
        // library actually supports — passing unknown strings throws
        // "Unsupported algorithm: <name>" even if the switch asks for them.
        algorithms: {
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ],
          cipher: [
            'chacha20-poly1305@openssh.com',
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
            'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
            '3des-cbc',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
            'rsa-sha2-512', 'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          hmac: [
            'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
            'hmac-sha2-256', 'hmac-sha2-512',
            'hmac-sha1', 'hmac-sha1-96',
          ],
        },
      });
  });
}

// Run a list of commands over ONE persistent SSH shell. This is the path the
// streaming /run-auto-stream endpoint uses: opening a fresh session per command
// was causing the switch to throttle rapid reconnects, hanging after the first
// command. Using one shell makes every command ~instant after the first login.
//
// onEntry(i, entry) is invoked after each command completes (or fails).
// Returns a promise that resolves once every command has been attempted.
function _runSwitchCommandsSequentialRaw({
  host, port = 22, username, password,
  commands,                      // [{ name, cmd }]
  onEntry,                       // (index, entry) => void
  timeoutMsPerCmd = 20000,
  // How long to wait for the SSH handshake itself. Was hardcoded to 15000 at the
  // connect() call below, which made it the one timeout on this path a caller
  // could not influence — so an unroutable host always cost a full 15s here even
  // when the caller had asked to fail sooner.
  readyTimeoutMs = 15000,
  pagingOff = 'terminal length 0',
  enable = null,
  enablePassword = null,
  isCancelled = () => false,
}) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      err ? reject(err) : resolve();
    };

    const overallTimeoutMs = (commands.length + 2) * timeoutMsPerCmd + 30000;
    const overallTimer = setTimeout(
      () => settle(new Error(`SSH session timed out after ${overallTimeoutMs}ms`)),
      overallTimeoutMs,
    );

    conn
      .on('keyboard-interactive', (_name, _instr, _lang, prompts, cb) => {
        cb(prompts.map(() => password));
      })
      .on('error', (err) => { clearTimeout(overallTimer); settle(err); })
      .on('ready', () => {
        // Advertise a tall, wide PTY so vendor pagers don't kick in mid-output.
        // ssh2 defaults to 24×80 — TP-Link JetStream then paginates `show interface
        // status` on a 28-port switch, dropping rows around the page boundary even
        // with `disable pager` set. Real terminals (PuTTY etc.) send their actual
        // window size and the switch fits everything in one page.
        openShellWithRetry(conn, { term: 'vt100', rows: 1000, cols: 200 }, (err, stream) => {
          if (err) { clearTimeout(overallTimer); return settle(err); }

          const stripAnsi = (s) => s
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '');
          const PROMPT_RE   = /[>#]\s*$/;
          const PASSWD_RE   = /password\s*:\s*$/i;
          const PROMPT_OR_PASSWD_RE = /(?:password\s*:\s*$)|(?:[>#]\s*$)/i;
          // Some switches page output even with `terminal length 0`; auto-advance.
          const PAGING_RE   = /Press any key to continue|--More--|<--- More --->/i;

          let buf = '';
          let pagedAt = -1;
          const resetBuf = () => { buf = ''; pagedAt = -1; };

          stream.setEncoding('utf8');
          stream.on('data', (chunk) => {
            buf += chunk;
            const m = buf.match(PAGING_RE);
            if (m && m.index > pagedAt) {
              pagedAt = m.index;
              try { stream.write(' '); } catch (_) {}
            }
          });
          stream.stderr.on('data', (chunk) => { buf += chunk; });
          stream.on('close', () => { /* handled by settle */ });

          const waitFor = (re, timeout) => new Promise((res) => {
            const t0 = Date.now();
            const tick = () => {
              if (re.test(stripAnsi(buf))) return res(true);
              if (Date.now() - t0 > timeout) return res(false);
              setTimeout(tick, 50);
            };
            tick();
          });

          (async () => {
            try {
              await waitFor(PROMPT_RE, 5000);

              if (enable) {
                resetBuf();
                stream.write(`${enable}\r\n`);
                await waitFor(PROMPT_OR_PASSWD_RE, 4000);
                if (PASSWD_RE.test(stripAnsi(buf))) {
                  resetBuf();
                  stream.write(`${enablePassword || ''}\r\n`);
                  await waitFor(PROMPT_RE, 4000);
                }
              }

              if (pagingOff) {
                resetBuf();
                stream.write(`${pagingOff}\r\n`);
                await waitFor(PROMPT_RE, 3000);
              }

              for (let i = 0; i < commands.length; i++) {
                if (isCancelled()) break;
                const { name, cmd } = commands[i];
                const startedAt = new Date().toISOString();
                let entry;
                try {
                  resetBuf();
                  stream.write(`${cmd}\r\n`);
                  await waitFor(PROMPT_RE, timeoutMsPerCmd);
                  entry = {
                    name, cmd,
                    output: cleanShellOutput(buf, cmd),
                    error: null, startedAt, source: 'auto',
                  };
                } catch (e) {
                  entry = { name, cmd, output: '', error: e.message, startedAt, source: 'auto' };
                }
                try { onEntry(i, entry); } catch (_) {}
              }

              try { stream.end('exit\r\n'); } catch (_) {}
              clearTimeout(overallTimer);
              settle(null);
            } catch (e) {
              clearTimeout(overallTimer);
              settle(e);
            }
          })();
        });
      })
      .connect({
        host, port, username, password,
        tryKeyboard: true,
        readyTimeout: readyTimeoutMs,
        algorithms: {
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ],
          cipher: [
            'chacha20-poly1305@openssh.com',
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
            'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
            '3des-cbc',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
            'rsa-sha2-512', 'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          hmac: [
            'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
            'hmac-sha2-256', 'hmac-sha2-512',
            'hmac-sha1', 'hmac-sha1-96',
          ],
        },
      });
  });
}

// ── Vendor configuration ──────────────────────────────────────
// Each vendor defines the CLI commands it speaks for LLDP / CDP / MAC / ARP,
// the paging-off command to disable "--More--" prompts, and how a port
// number maps to an interface name in its CLI.
const VENDORS = {
  'cisco-ios': {
    label: 'Cisco IOS',
    paging_off: 'terminal length 0',
    commands: {
      lldp:      'show lldp neighbors {iface} detail',
      cdp:       'show cdp neighbors {iface} detail',
      mac_table: 'show mac address-table interface {iface}',
      arp:       'show arp | include {mac}',
    },
    // The console's auto-command list is sourced from console_commands.json
    // (per-vendor section). Edit that file to change commands — no code edit needed.
    derive_interface: (p) => `Gi1/0/${p}`,
  },
  'dlink': {
    label: 'D-Link',
    paging_off: 'disable clipaging',
    commands: {
      lldp:      'show lldp remote_ports {iface}',
      cdp:       null, // D-Link does not speak CDP
      mac_table: 'show fdb port {iface}',
      arp:       'show arpentry',
    },
    derive_interface: (p) => String(p),
  },
  'tplink': {
    label: 'TP-Link',
    // TP-Link JetStream `show lldp neighbor-information` etc. require
    // privileged (enable) mode — user-mode prompt `>` rejects them.
    enable: 'enable',
    paging_off: 'disable pager',
    commands: {
      // TP-Link JetStream uses `gigabitEthernet` as the port-type keyword.
      // `ethernet 1/0/24` errors with "Invalid parameter" / "Too many parameters".
      lldp:      'show lldp neighbor-information interface gigabitEthernet {iface}',
      cdp:       null, // TP-Link does not speak CDP
      mac_table: 'show mac address-table interface gigabitEthernet {iface}',
      arp:       'show ip arp',
    },
    derive_interface: (p) => `1/0/${p}`,
  },
};

// ── Vendor-agnostic "loose" parsers ───────────────────────────
// These extract common fields (system name, port id, MAC, IP, VLAN, etc.)
// from LLDP/CDP output across Cisco, D-Link, TP-Link, Aruba, Juniper, etc.
// They trade precision for breadth — good enough for reporting a neighbor.
function parseLooseNeighbor(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const result = {
    system_name:        pick(/(?:^|\n)\s*(?:System Name|Device ID|Remote System Name|SysName|System name|Neighbor name)\s*[:=][ \t]*([^\n]+)/i),
    // "(outgoing port)" tolerated because CDP writes "Port ID (outgoing port): Et0/0",
    // and requiring the colon immediately after "Port ID" dropped every CDP remote port.
    port_id:            pick(/(?:(?:^|\n)\s*|,\s*)(?:Port ID|Remote Port|Port id|Port Identifier|Neighbor port|PortID)(?:\s*\([^)]*\))?\s*[:=][ \t]*([^\n]+)/i),
    port_description:   pick(/(?:^|\n)\s*(?:Port Description|Port Desc|Remote Port Description)\s*[:=][ \t]*([^\n]+)/i),
    chassis_id:         pick(/(?:^|\n)\s*(?:Chassis ID|Chassis Identifier|Chassis Id|Neighbor chassis)\s*[:=][ \t]*([^\n]+)/i),
    system_description: pick(/(?:System Description|Version|Remote System Description)\s*[:=]\s*([\s\S]*?)(?:\n\s*\n|\n[A-Z][^:\n]{0,40}:)/i),
    management_address: pick(/(?:Management Address|Management IP|Management Addresses?|Mgmt IP|Address)\s*[:=]?[^\n]{0,80}?\b((?:\d{1,3}\.){3}\d{1,3})\b/i),
    vlan_id:            pick(/(?:Vlan ID|VLAN|Native VLAN|Port VLAN ID|PVID)\s*[:=][ \t]*(\d+)/i),
    capabilities:       pick(/(?:System Capabilities|Capabilities|Enabled Capabilities)\s*[:=][ \t]*([^\n]+)/i),
  };
  const noData = /no (?:lldp|cdp) neighbors|no entries|no entry|not found/i.test(text);
  const found = !noData && !!(result.system_name || result.port_id || result.management_address || result.chassis_id);
  return { found, ...result };
}

// Per-port console log path, so the report can pick it up later.
// New layout: <rack>/console/d{idx}_p{port}.json
// Falls back to the legacy flat path if the file already exists there.
function consoleLogPath(rackDir, deviceIndex, port) {
  // deviceIndex and port are interpolated straight into the filename, so a
  // value like "../../OTHER-RACK/console/d0" walks the write out of this rack
  // and into another tenant's — or out of outputs/ entirely. The earlier
  // hardening validated scanId (which reaches rackDir) but not these two,
  // which are the values that actually reach the path. Coerce to integers and
  // refuse anything else; there is no legitimate non-integer device or port.
  const di = Number(deviceIndex), pt = Number(port);
  if (!Number.isInteger(di) || !Number.isInteger(pt) || di < 0 || pt < 0) return null;
  const dir = path.join(rackDir, 'console');
  fs.mkdirSync(dir, { recursive: true });
  const newPath = path.join(dir, `d${di}_p${pt}.json`);
  const legacy  = path.join(rackDir, `port_console_d${di}_p${pt}.json`);
  if (!fs.existsSync(newPath) && fs.existsSync(legacy)) return legacy;
  return newPath;
}

// Resolve a pipeline image filename to a real path inside the rack.
// Prefers the new images/ subfolder, falls back to legacy flat layout.
function rackImagePath(rackDir, fname) {
  const inSub = path.join(rackDir, 'images', fname);
  if (fs.existsSync(inSub)) return inSub;
  return path.join(rackDir, fname); // legacy
}
// Same idea but returns the URL-relative path that the client uses to
// fetch the file via /outputs/<rackId>/...
function rackImageUrlPath(rackDir, fname) {
  return fs.existsSync(path.join(rackDir, 'images', fname)) ? `images/${fname}` : fname;
}
// Per-port artifacts (5/6 PNG copies) — new layout: <rack>/ports/<base>.png
function rackPortPath(rackDir, baseName) {
  const dir = path.join(rackDir, 'ports');
  fs.mkdirSync(dir, { recursive: true });
  const newPath = path.join(dir, baseName);
  const legacy  = path.join(rackDir, `port_${baseName}`);
  if (!fs.existsSync(newPath) && fs.existsSync(legacy)) return legacy;
  return newPath;
}
function rackPortRelative(rackDir, baseName) {
  // What we store in the JSONL log so the report can find the file later.
  // Always returns the new-layout name; reading code resolves either path.
  return path.join('ports', baseName).replace(/\\/g, '/');
}
function resolveRelativeArtifact(rackDir, rel) {
  // For values stored in port_identifications.jsonl that may be old-style
  // ("port_d1_p2_device.png") or new-style ("ports/d1_p2_device.png").
  if (!rel) return null;
  const direct = path.join(rackDir, rel);
  if (fs.existsSync(direct)) return direct;
  // Try interpreting as a legacy basename
  const legacy = path.join(rackDir, rel.replace(/^ports\//, 'port_'));
  if (fs.existsSync(legacy)) return legacy;
  return direct; // let caller see the missing file
}

// Read console_commands.json and return the auto-command list for the given
// vendor. Falls back to the top-level `auto_commands` list if the vendor has
// no section — keeps legacy installs working.
function loadConsoleCommandsForVendor(vendor) {
  const raw = loadConsoleCommands();
  const vlist = raw?.vendors?.[vendor]?.auto_commands;
  if (Array.isArray(vlist) && vlist.length) return vlist;
  return raw?.auto_commands || [];
}

// Returns the user-facing intent list for a vendor (label + cmd template).
function loadConsoleIntentsForVendor(vendor) {
  const raw = loadConsoleCommands();
  const list = raw?.vendors?.[vendor]?.intents;
  return Array.isArray(list) ? list : [];
}

function loadConsoleCommands() {
  const p = path.join(__dirname, 'console_commands.json');
  if (!fs.existsSync(p)) return { auto_commands: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { logger.error('console_commands.json parse error:', e.message); return { auto_commands: [] }; }
}

function substIface(cmd, iface) {
  return String(cmd || '').replace(/\{iface\}/g, iface);
}

// ── Console allowlist for non-owners ────────────────────────────────
//
// /api/switch/console/run takes its command straight from the request body, and
// the Results console renders a free-form terminal box that posts to it. That is
// the right tool for an owner debugging a switch and completely wrong for anyone
// else: every /api/switch/* route is requireAuth, not requireRole, so without
// this gate any approved member could POST
//   {"host":"192.168.1.62","command":"configure terminal"}
// and reconfigure real equipment. It matters most where "member" means a person
// we handed a demo login to, which is the whole point of a public demo.
//
// TWO independent gates, both of which a non-owner must pass:
//   1. ALLOWLIST — the command must be one the product itself is built to send:
//      every intent and auto-command in console_commands.json (all vendors),
//      plus AUDIT_CMDS and the Switch Info commands. That is the complete set
//      any UI control can produce, so the honest UI loses nothing.
//   2. READ SHAPE — it must still begin with a read verb. Gate 1 alone would
//      widen silently the day someone adds a write command to the JSON.
//
// Enforced on the command AFTER {iface} substitution — that is the string that
// actually reaches the switch, so it is the only one worth checking.
//
// Owners keep the free-form box. They can already reach the credential store
// and the lab admin routes, so restricting them protects nothing.
const CONSOLE_READ_VERB_RE = /^(?:show|display|dir)\b/i;

// A single interface token. Deliberately excludes whitespace and every CLI
// separator (; | & newline), so a substituted {iface} cannot smuggle a second
// command past a pattern that matched the first.
const CONSOLE_IFACE_TOK = '[A-Za-z0-9][A-Za-z0-9/._:-]{0,31}';

// The Switch Info modal's per-vendor command (client SWITCH_INFO_CMD). Kept
// here too because that modal posts it to /console/run like any other command.
const SWITCH_INFO_CMDS = ['show version', 'show system-info', 'show switch'];

const normalizeConsoleCmd = (s) =>
  String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every command template the product can legitimately send, normalized.
function consoleCommandTemplates() {
  const raw = loadConsoleCommands();
  const out = new Set();
  const add = (c) => { const n = normalizeConsoleCmd(c); if (n) out.add(n); };

  for (const item of (Array.isArray(raw?.auto_commands) ? raw.auto_commands : [])) add(item?.cmd);
  for (const vconf of Object.values(raw?.vendors || {})) {
    for (const key of ['intents', 'auto_commands']) {
      for (const item of (Array.isArray(vconf?.[key]) ? vconf[key] : [])) add(item?.cmd);
    }
  }
  for (const set of Object.values(AUDIT_CMDS)) for (const c of Object.values(set)) add(c);
  for (const c of SWITCH_INFO_CMDS) add(c);
  return out;
}

// Is this a command a non-owner is allowed to send to a switch?
function isAllowedConsoleCommand(cmd) {
  const n = normalizeConsoleCmd(cmd);
  if (!n) return false;
  // Gate 2 first — it is the cheap one, and it holds even if the JSON drifts.
  if (!CONSOLE_READ_VERB_RE.test(n)) return false;
  // An unsubstituted placeholder would reach the switch literally and fail
  // there anyway; refuse it here rather than pattern-matching a broken command.
  if (n.includes('{')) return false;
  for (const tmpl of consoleCommandTemplates()) {
    if (tmpl === n) return true;
    if (!tmpl.includes('{iface}')) continue;
    const re = new RegExp(`^${tmpl.split('{iface}').map(escapeRe).join(CONSOLE_IFACE_TOK)}$`);
    if (re.test(n)) return true;
  }
  return false;
}

// Persist the current console transcript for a (scanId, device_index, port) tuple.
// Guard for routes that take the rack id in the BODY rather than the path.
// `app.param('rackId')` only fires for `:rackId` in a route pattern, so these
// bypassed every tenant check in the server. Returns true when the request may
// proceed; sends the response and returns false when it may not.
//
// scanId is optional on these routes (the transcript is only persisted when
// one is supplied), so a missing id is allowed through — it just means nothing
// gets written.
function bodyRackAllowed(req, res, scanId) {
  if (scanId === undefined || scanId === null || scanId === '') return true;
  if (!rackAccess.isValidRackId(scanId)) {
    res.status(400).json({ error: 'Invalid scanId' });
    return false;
  }
  if (!rackAccess.canAccessRack(req.user || softAuthPayload(req), scanId, tenant)) {
    // 404 not 403: a 403 would confirm the rack exists in another tenant.
    res.status(404).json({ error: 'Rack not found' });
    return false;
  }
  return true;
}

function saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries }) {
  if (!scanId) return null;
  // Defence in depth at the sink. The callers now authorise scanId, but this
  // function joins it into a path and then mkdirs inside the result, so a bad
  // id here creates attacker-named directories anywhere the process can write.
  // The existsSync below was the only guard and it does not confine anything —
  // any existing directory reachable by a relative walk qualified.
  if (!rackAccess.isValidRackId(scanId)) return null;
  const rackDir = path.join(outputsDir, scanId);
  if (!fs.existsSync(rackDir)) return null;
  const filePath = consoleLogPath(rackDir, device_index, port);
  if (!filePath) return null;   // device_index/port failed integer validation
  // Assert containment on the ACTUAL write target, not on rackDir (which the
  // scanId check already made safe). This is the value fs.writeFileSync uses.
  if (!path.resolve(filePath).startsWith(path.resolve(outputsDir) + path.sep)) return null;
  const payload = {
    scanId,
    device_index: Number(device_index),
    port: Number(port),
    interface: iface,
    host,
    updated_at: new Date().toISOString(),
    entries,
  };
  try { fs.writeFileSync(filePath, JSON.stringify(payload, null, 2)); return filePath; }
  catch (e) { logger.error('console transcript save failed:', e.message); return null; }
}

function readConsoleTranscript(rackDir, deviceIndex, port) {
  const p = consoleLogPath(rackDir, deviceIndex, port);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Strip the command echo, paging prompts, and trailing shell prompts from output.
function cleanShellOutput(raw, cmd) {
  if (!raw) return '';
  let out = raw.replace(/\r/g, '');
  // Replace null bytes (TP-Link inserts them after paging prompts) with a
  // newline so the data that follows the prompt becomes its own line. If we
  // strip them outright the next regex eats the prompt PLUS the next port row
  // up to the next \n — that was the "27 of 28 ports" bug (Gi1/0/23 vanished).
  out = out.replace(/\x00/g, '\n');
  // Strip paging prompts: "Press any key to continue (Q to quit)", "--More--", etc.
  // Only consume the prompt text (and trailing spaces/tabs) — never the data
  // that may follow it on the same line. The "(Q to quit)" suffix is optional
  // because some firmware revisions omit it.
  out = out.replace(/Press any key to continue(?:\s*\(Q to quit\))?[ \t]*/gi, '');
  out = out.replace(/--More--[ \t]*/g, '');
  out = out.replace(/<--- More --->[ \t]*/g, '');
  // remove the first occurrence of the command (which the switch echoed back)
  if (cmd) {
    const idx = out.indexOf(cmd);
    if (idx >= 0) out = out.slice(idx + cmd.length);
  }
  // drop any trailing lines that look like a shell prompt (`hostname#` or `hostname>`)
  const lines = out.split('\n');
  while (lines.length && /^[A-Za-z0-9._-]+[>#]\s*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').trim();
}

// GET /api/switch/console/intents?vendor=cisco-ios
// Returns the user-facing dropdown list for the console (intent id + English
// label + command template). Used by the client to populate the picker.
app.get('/api/switch/console/intents', auth.requireAuth, (req, res) => {
  const vendor = String(req.query.vendor || 'cisco-ios');
  res.json({ vendor, intents: loadConsoleIntentsForVendor(vendor) });
});

// GET /api/switch/creds-status?vendor=X
// Booleans only — never returns the actual secret values. Lets the client
// know whether the encrypted env store already has username / password /
// enable for this vendor, so the login modal can hide those fields and ask
// the user for only the switch IP.
app.get('/api/switch/creds-status', auth.requireAuth, (req, res) => {
  const vendor = String(req.query.vendor || 'cisco-ios');
  const v = sshCreds.getForVendor(vendor) || {};
  res.json({
    vendor,
    has_username: !!(v.username && String(v.username).length),
    has_password: !!(v.password && String(v.password).length),
    has_enable:   !!(v.enablePassword && String(v.enablePassword).length),
  });
});

// GET /api/switch/default-host
// Suggests a switch IP without asking the user. Two sources, in order:
//   1. The current user's last successful SSH host (kept in scan_meta of the
//      most recent scan they own — small read, no extra storage).
//   2. The server machine's default gateway (on most LANs the gateway IS
//      the switch, or one hop away). Best-effort, may be null.
// Always responds with JSON; missing values come back as null instead of
// errors so the client can prefill what it has.
const { execSync } = require('child_process');
function detectDefaultGateway() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('route print 0.0.0.0', { timeout: 2000 }).toString();
      // Match the IPv4 default route line: "0.0.0.0  0.0.0.0  <gateway>  ..."
      const m = out.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m);
      return m ? m[1] : null;
    }
    // Linux / macOS
    const out = execSync("ip route show default 2>/dev/null || route -n get default 2>/dev/null", { timeout: 2000, shell: '/bin/sh' }).toString();
    const m = out.match(/(?:default via|gateway:)\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
let _gatewayCache = null;
let _gatewayCachedAt = 0;
function defaultGateway() {
  // Cache for 60s — gateway rarely changes and shelling out per-request is wasteful.
  const now = Date.now();
  if (_gatewayCache !== null && (now - _gatewayCachedAt) < 60_000) return _gatewayCache;
  _gatewayCache = detectDefaultGateway();
  _gatewayCachedAt = now;
  return _gatewayCache;
}

// Path of a per-user "last host" file — keyed by userId so each account
// keeps its own most-recent switch IP separately.
const lastHostDir = path.join(__dirname, 'data', 'last-hosts');
function readLastHost(userId) {
  if (!userId) return null;
  try {
    const p = path.join(lastHostDir, `${userId}.txt`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null;
  } catch { return null; }
}
function writeLastHost(userId, host) {
  if (!userId || !host) return;
  try {
    fs.mkdirSync(lastHostDir, { recursive: true });
    fs.writeFileSync(path.join(lastHostDir, `${userId}.txt`), String(host).trim());
  } catch (err) { logger.error('[last-host] write failed:', err.message); }
}

// ── MAC vendor lookup (IEEE OUI registry) ────────────────────
// The first three octets of a MAC are the manufacturer's IEEE-assigned block,
// so a downstream MAC can be labelled with the company that built the device.
// The registry is ~1 MB, so it stays here and the client asks only for the
// prefixes it is about to draw — the APK never ships the table.
// Regenerate with: node server/refresh-oui.js
let ouiTable = null;
function loadOuiTable() {
  if (ouiTable) return ouiTable;
  try {
    ouiTable = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'oui-vendors.json'), 'utf8'));
  } catch (err) {
    logger.error('[oui] table unavailable:', err.message);
    ouiTable = {};
  }
  return ouiTable;
}

app.post('/api/oui/lookup', (req, res) => {
  const prefixes = Array.isArray(req.body?.prefixes) ? req.body.prefixes : [];
  if (prefixes.length > 512) return res.status(400).json({ error: 'Too many prefixes.' });
  const table = loadOuiTable();
  const out = {};
  for (const p of prefixes) {
    // Accept 5C:35:48, 5C-35-48 or 5C3548 — normalise to the registry's key.
    const key = String(p).replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 6);
    if (key.length === 6 && table[key]) out[key] = table[key];
  }
  res.json({ vendors: out });
});

app.get('/api/switch/default-host', auth.requireAuth, (req, res) => {
  const userId = softAuthUserId(req);
  const last    = readLastHost(userId);
  const gateway = defaultGateway();

  // A REGISTERED switch, when this user has never probed one themselves.
  //
  // Without this the live-switch page had no way to learn an address on a fresh
  // deployment: readLastHost is per-user and empty until that user has probed
  // something, and the gateway is explicitly not the switch. The client used to
  // paper over the gap with a hardcoded office IP compiled into every build.
  // monitored_devices already holds the answer — an operator registered those
  // switches deliberately — so ask it.
  //
  // SCOPED. monitored_devices grew a tenant_id precisely because this table
  // leaked every customer's switch inventory to any authenticated caller, and
  // this route is requireAuth, not owner-only. A member must only ever be
  // offered a switch belonging to a Site they can see.
  let registered = null;
  try {
    const portsDb = require('./lib/port_history_db');
    const scope   = require('./lib/tenant').visibleTenantIds(req.user);
    const mine    = portsDb.listDevices({ enabledOnly: true, scope });
    registered    = mine.length ? mine[0].host : null;
  } catch (_) { /* table missing on a fresh install — stay null */ }

  // Suggested = last → registered → gateway. The gateway stays LAST and is
  // never handed to the probe (see portsProbe.js): it is a router, not a switch.
  res.json({
    suggested: last || registered || gateway || null,
    last_host: last,
    registered_host: registered,
    gateway,
  });
});

// POST /api/switch/console/run-auto
// Body: { host, username, password, interface, scanId?, device_index?, port? }
// Runs every configured auto-command, one SSH session per command, returns full list.
// If scanId/device_index/port provided, persists transcript for the report.
app.post('/api/switch/console/run-auto', auth.requireAuth, async (req, res) => {
  const { host, sshPort, interface: iface, vendor,
          scanId, device_index, port } = req.body || {};
  if (!bodyRackAllowed(req, res, scanId)) return;
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    const blocked = switchRequestBlocker({ host, username, password, interface: iface }, { needIface: true });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  // Vendor-specific auto-commands override the JSON file. The file is still
  // used as the default for vendors without a bundled list (e.g. cisco-ios).
  const autoCommands = loadConsoleCommandsForVendor(vendor || 'cisco-ios');
  const entries = [];
  for (const item of autoCommands) {
    const cmd = substIface(item.cmd, iface);
    const startedAt = new Date().toISOString();
    try {
      const raw = await runSwitchCommand({ host, port: sshPort, username, password, command: cmd, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword });
      entries.push({ name: item.name, cmd, output: cleanShellOutput(raw, cmd), error: null, startedAt, source: 'auto' });
    } catch (err) {
      entries.push({ name: item.name, cmd, output: '', error: err.message, startedAt, source: 'auto' });
    }
  }
  const saved = saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries });
  audit.log({ req, action: 'console.run_auto', status: 'ok',
              targetType: scanId ? 'rack' : null, targetId: scanId || null,
              payload: { host, interface: iface, vendor: vendor || 'cisco-ios', cmd_count: entries.length, transcript_saved: Boolean(saved) } });
  if (saved && scanId) scheduleCanonicalRefresh(scanId);
  res.json({ ok: true, host, interface: iface, vendor: vendor || 'cisco-ios', entries, transcript_saved: Boolean(saved) });
});

// POST /api/switch/console/run-auto-stream
// Same body as run-auto, but streams each command's result as an SSE frame so
// the client can render one command at a time as it completes.
// Frames:
//   { type: 'plan',    total, commands:[{i,name,cmd}] }
//   { type: 'running', i, name, cmd, startedAt }
//   { type: 'entry',   i, entry }
//   { type: 'done',    total, transcript_saved }
//   { type: 'error',   error }
app.post('/api/switch/console/run-auto-stream', auth.requireAuth, async (req, res) => {
  const { host, sshPort, interface: iface, vendor,
          scanId, device_index, port } = req.body || {};
  if (!bodyRackAllowed(req, res, scanId)) return;
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    const blocked = switchRequestBlocker({ host, username, password, interface: iface }, { needIface: true });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  const autoCommands = loadConsoleCommandsForVendor(vendor || 'cisco-ios');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* socket gone */ }
  };
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 10000);
  // If the client closes early we just let the SSH run to completion; subsequent
  // res.write() calls fall through the try/catch in send() without crashing.

  // Pre-substitute {iface} so both the plan frame and the SSH shell use the
  // exact same command strings.
  const plannedCommands = autoCommands.map(c => ({ name: c.name, cmd: substIface(c.cmd, iface) }));

  try {
    send({
      type: 'plan',
      total: plannedCommands.length,
      commands: plannedCommands.map((c, i) => ({ i, name: c.name, cmd: c.cmd })),
    });

    const entries = [];
    // Announce which command is about to run just before it actually starts
    // on the shared shell.
    let nextAnnounceIdx = 0;
    const announce = (upTo) => {
      while (nextAnnounceIdx <= upTo && nextAnnounceIdx < plannedCommands.length) {
        const c = plannedCommands[nextAnnounceIdx];
        send({ type: 'running', i: nextAnnounceIdx, name: c.name, cmd: c.cmd, startedAt: new Date().toISOString() });
        nextAnnounceIdx++;
      }
    };
    // Announce the very first command immediately so the UI shows activity
    // while we're still negotiating SSH.
    announce(0);

    await runSwitchCommandsSequential({
      host, port: sshPort, username, password,
      commands: plannedCommands,
      pagingOff: vconf.paging_off,
      enable: vconf.enable,
      enablePassword,
      // Don't short-circuit on `cancelled` — earlier attempts did this and a
      // false-positive close signal on some Node versions aborted the loop
      // before ANY command ran, leaving the UI with an empty terminal.
      isCancelled: () => false,
      timeoutMsPerCmd: 20000,
      onEntry: (i, entry) => {
        entries.push(entry);
        send({ type: 'entry', i, entry });
        // Announce the NEXT command so the client shows the running indicator
        // the moment the previous one finished, not only when it starts writing.
        if (i + 1 < plannedCommands.length) announce(i + 1);
      },
    });

    const saved = saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries });
    audit.log({ req, action: 'console.run_auto_stream', status: 'ok',
                targetType: scanId ? 'rack' : null, targetId: scanId || null,
                payload: { host, interface: iface, vendor: vendor || 'cisco-ios', cmd_count: entries.length, transcript_saved: Boolean(saved) } });
    if (saved && scanId) scheduleCanonicalRefresh(scanId);
    send({ type: 'done', total: entries.length, transcript_saved: Boolean(saved) });
  } catch (err) {
    logger.error('[console stream] failed:', err && err.stack ? err.stack : err);
    audit.log({ req, action: 'console.run_auto_stream', status: 'fail',
                targetType: scanId ? 'rack' : null, targetId: scanId || null,
                error: (err && err.message) || String(err),
                payload: { host, interface: iface } });
    try { send({ type: 'error', error: (err && err.message) || String(err) || 'Stream error' }); } catch (_) {}
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/switch/console/run
// Body: { host, username, password, command, scanId?, device_index?, port?, interface? }
// Runs a single manual command and (optionally) appends to the persisted transcript.
app.post('/api/switch/console/run', auth.requireAuth, async (req, res) => {
  const { host, sshPort, command, vendor,
          scanId, device_index, port, interface: iface, timeoutMs: bodyTimeoutMs } = req.body || {};
  if (!bodyRackAllowed(req, res, scanId)) return;
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !command) {
    const blocked = switchRequestBlocker({ host, username, password, command }, { needCommand: true });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  // Substitute the {iface} placeholder if the caller passed an interface.
  // Intent-driven commands carry placeholders like
  // `show lldp neighbor-information interface gigabitEthernet {iface}` and
  // would otherwise be sent literally to the switch.
  const cmd = iface ? substIface(command, iface) : command;
  // Owners may run anything; everyone else is held to the commands the product
  // itself issues. See the allowlist note above isAllowedConsoleCommand().
  if (req.user?.role !== 'owner' && !isAllowedConsoleCommand(cmd)) {
    // 'fail', not 'deny': the audit schema CHECKs status IN ('ok','fail') and
    // audit.log() drops anything else, which would silently lose the one event
    // here most worth keeping.
    audit.log({ req, action: 'console.run_denied', status: 'fail',
                targetType: scanId ? 'rack' : null, targetId: scanId || null,
                error: 'command not allowlisted',
                payload: { host, interface: iface || null, command: cmd } });
    return res.status(403).json({
      error: 'That command is not available on this account. Use one of the listed checks.',
    });
  }
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  // Allow the client to extend the SSH/command timeout for slow commands
  // (e.g. `show interface status` on a 48-port TP-Link). Capped at 90s and
  // floored at 5s; falls back to runSwitchCommand's own default when omitted.
  let timeoutMs;
  if (bodyTimeoutMs != null) {
    const n = Number(bodyTimeoutMs);
    if (Number.isFinite(n)) timeoutMs = Math.max(5000, Math.min(90000, Math.floor(n)));
  }
  const startedAt = new Date().toISOString();
  let entry;
  try {
    const raw = await runSwitchCommand({ host, port: sshPort, username, password, command: cmd, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword, ...(timeoutMs ? { timeoutMs } : {}) });
    entry = { name: 'Manual', cmd, output: cleanShellOutput(raw, cmd), error: null, startedAt, source: 'manual' };
    writeLastHost(softAuthUserId(req), host);
  } catch (err) {
    entry = { name: 'Manual', cmd, output: '', error: err.message, startedAt, source: 'manual' };
  }

  // Append to persisted transcript if the scan context is known.
  if (scanId && device_index != null && port != null) {
    const rackDir = path.join(outputsDir, scanId);
    const existing = readConsoleTranscript(rackDir, device_index, port);
    const entries = existing?.entries ? [...existing.entries, entry] : [entry];
    saveConsoleTranscript({ scanId, device_index, port, interface: iface || existing?.interface, host, entries });
    scheduleCanonicalRefresh(scanId);
  }

  audit.log({ req, action: 'console.run_manual',
              status: entry.error ? 'fail' : 'ok',
              targetType: scanId ? 'rack' : null, targetId: scanId || null,
              error: entry.error || null,
              payload: { host, interface: iface || null, command: cmd } });
  res.json({ ok: true, entry });
});

// Extract first MAC address (and VLAN if on same line) from any vendor's MAC-table output.
// Accepts MACs in `aabb.ccdd.eeff`, `aa:bb:cc:dd:ee:ff`, or `aa-bb-cc-dd-ee-ff` formats.
function parseLooseMacTable(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const lines = text.split('\n');
  const macRe = /\b([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}|(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\b/;
  for (const line of lines) {
    const m = line.match(macRe);
    if (!m) continue;
    // Skip obviously-non-data lines
    if (/^---|={3,}|no mac/i.test(line.trim())) continue;
    const vlanM = line.match(/^\s*(\d+)\b/);
    return { found: true, mac: m[1].toLowerCase(), vlan: vlanM ? vlanM[1] : null };
  }
  return { found: false };
}

// Find a line containing the remote MAC (in any format) and extract an IP from it.
function parseLooseArp(raw, macNormalized) {
  const text = (raw || '').replace(/\r/g, '');
  const variants = macFormatVariants(macNormalized);
  for (const line of text.split('\n')) {
    const low = line.toLowerCase();
    if (variants.some(v => low.includes(v))) {
      const ip = line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\b/);
      if (ip) return { found: true, ip: ip[1], raw: line.trim() };
    }
  }
  return { found: false };
}

// Return every common textual representation of a MAC so parsers match regardless
// of separator style used by the vendor's ARP output.
function macFormatVariants(mac) {
  const hex = String(mac || '').replace(/[:.-]/g, '').toLowerCase();
  if (hex.length !== 12) return [String(mac || '').toLowerCase()];
  return [
    hex,
    `${hex.slice(0,4)}.${hex.slice(4,8)}.${hex.slice(8,12)}`,
    `${hex.slice(0,2)}:${hex.slice(2,4)}:${hex.slice(4,6)}:${hex.slice(6,8)}:${hex.slice(8,10)}:${hex.slice(10,12)}`,
    `${hex.slice(0,2)}-${hex.slice(2,4)}-${hex.slice(4,6)}-${hex.slice(6,8)}-${hex.slice(8,10)}-${hex.slice(10,12)}`,
  ];
}

async function reverseDnsLookup(ip) {
  return new Promise((resolve) => {
    require('dns').reverse(ip, (err, names) => {
      resolve(err ? null : (names && names[0]) || null);
    });
  });
}

// Runs the full fallback chain using the vendor's CLI and loose parsers, returning
// the first useful result along with a log of every method tried.
async function findNeighborChain({ host, port, username, password, enablePassword, iface, vendor = 'cisco-ios' }) {
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  const chain = [];
  const cred = { host, port, username, password, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword };
  const subst = (cmd, extra = {}) => {
    let s = String(cmd).replace(/\{iface\}/g, iface);
    for (const [k, v] of Object.entries(extra)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    return s;
  };

  // Truncate raw shell output so the response stays small but the UI can still diagnose.
  const tail = (s) => (s || '').slice(-1200);

  // 1. LLDP — supported by every major managed switch vendor
  if (vconf.commands.lldp) {
    try {
      const cmd = subst(vconf.commands.lldp);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      const parsed = parseLooseNeighbor(raw);
      chain.push({ method: 'lldp', command: cmd, found: parsed.found, data: parsed, raw_tail: tail(raw) });
      if (parsed.found) return { method: 'lldp', neighbor: parsed, chain };
    } catch (err) {
      chain.push({ method: 'lldp', error: err.message, found: false });
    }
  }

  // 2. CDP — Cisco only (vendor config has cdp=null for others)
  if (vconf.commands.cdp) {
    try {
      const cmd = subst(vconf.commands.cdp);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      const parsed = parseLooseNeighbor(raw);
      chain.push({ method: 'cdp', command: cmd, found: parsed.found, data: parsed, raw_tail: tail(raw) });
      if (parsed.found) return { method: 'cdp', neighbor: parsed, chain };
    } catch (err) {
      chain.push({ method: 'cdp', error: err.message, found: false });
    }
  }

  // 3. MAC address table — last resort, gives us the remote MAC
  let macResult = null;
  if (vconf.commands.mac_table) {
    try {
      const cmd = subst(vconf.commands.mac_table);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      macResult = parseLooseMacTable(raw);
      chain.push({ method: 'mac_table', command: cmd, found: macResult.found, data: macResult, raw_tail: tail(raw) });
    } catch (err) {
      chain.push({ method: 'mac_table', error: err.message, found: false });
    }
  }

  if (!macResult?.found) return { method: 'none', neighbor: { found: false }, chain };

  // 4. ARP lookup — MAC → IP
  let arpResult = null;
  if (vconf.commands.arp) {
    try {
      const cmd = subst(vconf.commands.arp, { mac: macResult.mac });
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      arpResult = parseLooseArp(raw, macResult.mac);
      chain.push({ method: 'arp', command: cmd, found: arpResult.found, data: arpResult, raw_tail: tail(raw) });
    } catch (err) {
      chain.push({ method: 'arp', error: err.message, found: false });
    }
  }

  // 5. Reverse DNS — IP → hostname (runs on the Node server, not the switch)
  let hostname = null;
  if (arpResult?.found && arpResult.ip) {
    hostname = await reverseDnsLookup(arpResult.ip);
    chain.push({ method: 'rdns', found: !!hostname, data: { hostname } });
  }

  const synth = {
    found: true,
    system_name:        hostname || null,
    port_id:            null,
    port_description:   null,
    chassis_id:         macResult.mac,
    system_description: null,
    management_address: arpResult?.ip || null,
    vlan_id:            macResult.vlan || null,
    capabilities:       null,
  };
  return { method: arpResult?.found ? 'mac_arp' : 'mac_only', neighbor: synth, chain };
}

/**
 * POST /api/switch/port-status
 * One-shot SSH snapshot of a specific port. Runs the LLDP-neighbor chain +
 * MAC-table query and returns a compact "is this port doing anything right
 * now" structure suitable for polling every few seconds from the client.
 *
 * Body: { host, sshPort?, interface, vendor?, username?, password?, enablePassword? }
 * Response: {
 *   ok: true,
 *   as_of: ISO timestamp,
 *   has_neighbor: bool,            // LLDP/CDP neighbor discovered
 *   neighbor: {...} | null,        // same shape as lldp-neighbor endpoint
 *   neighbor_method: "lldp"|...,
 *   mac_count: number,             // MACs learned on this port right now
 *   first_mac: string | null,
 *   link_active: bool,             // has_neighbor || mac_count > 0
 * }
 *
 * We reuse findNeighborChain() + the existing VENDORS.mac_table command —
 * no new vendor-specific parsers needed. One SSH roundtrip, ~1-3s per poll.
 */
app.post('/api/switch/port-status', auth.requireAuth, async (req, res) => {
  const { host, sshPort, interface: iface, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    const blocked = switchRequestBlocker({ host, username, password, interface: iface }, { needIface: true });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  const dialect = VENDORS[vendorKey];
  try {
    // LLDP / neighbor chain (also gets us MAC learning via chain.mac_table)
    let neighborOut = { method: 'none', neighbor: null, chain: null };
    try {
      neighborOut = await findNeighborChain({
        host, port: sshPort, username, password, enablePassword, iface, vendor: vendorKey,
      });
    } catch (e) {
      return res.json({
        ok: false,
        as_of: new Date().toISOString(),
        error: e.message,
        has_neighbor: false,
        link_active: false,
      });
    }

    // Extract MAC count from the chain output (findNeighborChain runs
    // mac_table as part of its normal probe and includes the raw text).
    let mac_count = 0;
    let first_mac = null;
    const chainText = (() => {
      if (!neighborOut.chain) return '';
      if (Array.isArray(neighborOut.chain)) {
        return neighborOut.chain.map(c => typeof c === 'string' ? c : (c?.output || c?.raw || JSON.stringify(c))).join('\n');
      }
      return String(neighborOut.chain);
    })();
    const macMatches = chainText.match(/[0-9a-fA-F]{2}[:\-.][0-9a-fA-F]{2,4}(?:[:\-.][0-9a-fA-F]{2,4}){1,4}/g) || [];
    const uniqMacs = [...new Set(macMatches.map(m => m.toLowerCase()))];
    mac_count = uniqMacs.length;
    first_mac = uniqMacs[0] || null;

    const has_neighbor = !!(neighborOut.neighbor && (neighborOut.neighbor.sysname || neighborOut.neighbor.chassis_id || neighborOut.neighbor.port_id));
    res.json({
      ok: true,
      as_of: new Date().toISOString(),
      host, interface: iface, vendor: vendorKey,
      has_neighbor,
      neighbor: neighborOut.neighbor || null,
      neighbor_method: neighborOut.method || 'none',
      mac_count,
      first_mac,
      link_active: has_neighbor || mac_count > 0,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/switch/lldp-neighbor', auth.requireAuth, async (req, res) => {
  const { host, sshPort, interface: iface, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    const blocked = switchRequestBlocker({ host, username, password, interface: iface }, { needIface: true });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  try {
    const { method, neighbor, chain } = await findNeighborChain({
      host, port: sshPort, username, password, enablePassword, iface, vendor: vendorKey,
    });
    writeLastHost(softAuthUserId(req), host);
    res.json({ ok: true, host, interface: iface, vendor: vendorKey, method, neighbor, chain });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Split all-ports LLDP output into per-interface blocks and parse each with
// parseLooseNeighbor (the same field extractor the per-port lookup uses).
// Returns { "<portKey>": {found, system_name, port_id, ...} } keyed by the
// interface's port number (e.g. "1/0/1"), so the client can join by port.
// CDP entries are delimited by a ----- rule and, unlike LLDP, put "Device ID:"
// BEFORE "Interface:". parseAllLldpNeighbors slices forward from the interface
// marker, so it hands each entry's Device ID to the PREVIOUS neighbour: against
// the lab switches that produced system=None for the last port and a
// right-only-by-coincidence value for the one before it. Parse whole delimited
// entries instead, which is CDP's actual structure.
//
// Several neighbours legitimately share ONE local port — every lab switch's
// e0/3 lands on the same pnet0 management bridge, and a desk phone sits on it
// too. A flat map silently kept whichever entry came last, so keep the first
// and count the rest instead of pretending there was only one.
function parseCdpNeighbors(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const out = {};
  for (const blk of text.split(/^-{10,}\s*$/m)) {
    const local = blk.match(/^[ \t]*Interface:\s*([^,\n]+)/mi);
    if (!local) continue;
    const key = local[1].trim().match(/(\d+\/\d+(?:\/\d+)?)\s*$/);
    if (!key) continue;
    const port = key[1];
    const pick = (re) => { const m = blk.match(re); return m ? m[1].trim() : null; };
    const device = pick(/^[ \t]*Device ID:\s*([^\n]+)/mi);
    const remote = pick(/Port ID\s*\([^)]*\):\s*([^\n]+)/i);
    if (!device && !remote) continue;
    const peer = {
      found:              true,
      system_name:        device,
      port_id:            remote,
      management_address: pick(/IP address:\s*((?:\d{1,3}\.){3}\d{1,3})/i),
      platform:           pick(/^[ \t]*Platform:\s*([^,\n]+)/mi),
      chassis_id:         null,
    };
    // Keep EVERY neighbour, not just a tally. The Ports table has one row per
    // port so it shows the first plus a count, but the LLDP tab lists them
    // individually — discarding the rest here made the other devices on a
    // shared port (a second switch, a desk phone) impossible to see anywhere.
    if (out[port]) {
      out[port].peers.push(peer);
      out[port].also = out[port].peers.length - 1;
      continue;
    }
    out[port] = { ...peer, peers: [peer], also: 0 };
  }
  return out;
}

function parseAllLldpNeighbors(raw) {
  const text = (raw || '')
    .replace(/\r/g, '')
    .replace(/\x00/g, '\n')
    // Strip pager prompts so "Press any key to continue" can't be captured as
    // a field value when it lands mid-record.
    .replace(/Press any key to continue(?:\s*\(Q to quit\))?[ \t]*/gi, '')
    .replace(/--More--[ \t]*/g, '')
    .replace(/<--- More --->[ \t]*/g, '');
  const out = {};
  // Boundary = a line that names an interface. Tolerant to TP-Link
  // ("Interface Name : gigabitEthernet 1/0/1") and Cisco-ish ("Gi1/0/1",
  // "GigabitEthernet1/0/1", "Local Intf: Gi1/0/1") layouts. The captured
  // group is the port number path (1/0/1, 0/1, etc.).
  // Longest-first: the alternation is first-match-wins, so "gigabitethernet"
  // must precede "ethernet" and "Eth" must precede "Et", or the shorter name
  // consumes the prefix and the digits fail to match. Plain "ethernet"/"Et"
  // were missing entirely, so Cisco IOL (Ethernet0/2, Et0/2 — the lab switches)
  // keyed nothing at all and the Neighbour column was always blank.
  const re = /(?:^|\n)[^\S\n]*(?:Interface(?:\s*Name)?|Local\s*(?:Intf|Port|Interface))?\s*[:=]?\s*(?:tengigabitethernet|gigabitethernet|fastethernet|ethernet|Gi|Te|Fa|Eth|Et)\s*[:=]?\s*(\d+\/\d+(?:\/\d+)?)/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ key: m[1], idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length;
    const parsed = parseLooseNeighbor(text.slice(start, end));
    if (parsed.found) out[marks[i].key] = parsed;
  }
  return out;
}

// Vendor commands that dump LLDP neighbors for ALL ports in one shot.
const LLDP_ALL_CMD = {
  // TP-Link JetStream: the bare command errors "Incomplete command"; it needs
  // the literal "interface" keyword (no port) to dump every port's neighbours.
  'tplink':    'show lldp neighbor-information interface',
  'cisco-ios': 'show lldp neighbors detail',
  'dlink':     'show lldp remote_ports',
};

// CDP is Cisco's native neighbour protocol. The IOL images the lab runs ship
// CDP but frequently NOT LLDP (ipbase especially), so `lldp run` succeeds
// quietly and `show lldp neighbors detail` returns nothing — which is why the
// Neighbour column read blank while the ports were plainly cabled. Ask for CDP
// too and merge. null for vendors that do not speak it, so they are skipped.
const CDP_ALL_CMD = {
  'tplink':    null,   // TP-Link does not speak CDP
  'cisco-ios': 'show cdp neighbors detail',
  'dlink':     null,   // D-Link does not speak CDP
};
// The forwarding (MAC) table — the logical layer: which MAC(s) are learned on
// each port, so even non-LLDP devices are identified and uplink ports (many
// MACs) are obvious.
const MAC_TABLE_CMD = {
  'tplink':    'show mac address-table',
  'cisco-ios': 'show mac address-table',
  'dlink':     'show fdb',
};

// Parse a MAC address-table into { portKey: { macs:[...], vlan, count } }.
// Handles rows like: "6c:3c:8c:23:24:0a  1  Gi1/0/4  dynamic  aging".
function parseMacTable(raw) {
  const text = (raw || '').replace(/\r/g, '').replace(/\x00/g, '\n');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\d+)\s+(?:gigabitethernet|tengigabitethernet|fastethernet|Gi|Te|Fa|Eth)?\s*(\d+\/\d+(?:\/\d+)?)\b/);
    if (!m) continue;
    const mac = m[1].toUpperCase(), vlan = m[2], port = m[3];
    if (!out[port]) out[port] = { macs: [], vlan };
    if (!out[port].macs.includes(mac)) out[port].macs.push(mac);
  }
  for (const k of Object.keys(out)) out[k].count = out[k].macs.length;
  return out;
}

// POST /api/switch/neighbors — LLDP neighbours + MAC table for every port, in
// ONE SSH session (respects the switch's ~1-session limit). Returns
// { neighbors: {portKey:{...}}, macs: {portKey:{macs,vlan,count}} }.
app.post('/api/switch/neighbors', auth.requireAuth, async (req, res) => {
  const { host, sshPort, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password) {
    const blocked = switchRequestBlocker({ host, username, password });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  const vconf = VENDORS[vendorKey];
  const lldpCmd = LLDP_ALL_CMD[vendorKey] || LLDP_ALL_CMD['cisco-ios'];
  const macCmd  = MAC_TABLE_CMD[vendorKey] || MAC_TABLE_CMD['cisco-ios'];
  const runOne = (command) => runSwitchCommand({
    host, port: sshPort, username, password,
    command, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword,
    timeoutMs: 30000,
  });
  try {
    // Two single-command runs (serialized per host by runSwitchCommand's lock).
    // The single-command path auto-advances the switch's pager, so long output
    // isn't truncated — unlike the sequential shell, which cut it off at page 1.
    const lldpRaw = await runOne(lldpCmd);
    const macRaw  = await runOne(macCmd);
    const neighbors = parseAllLldpNeighbors(lldpRaw || '');
    const macs = parseMacTable(macRaw || '');
    res.json({
      ok: true, host, vendor: vendorKey,
      neighborCount: Object.keys(neighbors).length,
      macPortCount: Object.keys(macs).length,
      neighbors, macs,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message, host, neighbors: {}, macs: {} });
  }
});

// ── Full single-switch audit ──────────────────────────────────
// Commands that fill the audit sheet (identity, port faceplate, PoE, VLAN),
// per vendor. TP-Link JetStream is the primary target; others degrade to a
// best-effort equivalent and any unsupported command just parses to empty.
const AUDIT_CMDS = {
  tplink: {
    sysinfo: 'show system-info',
    ifstatus: 'show interface status',
    ifconfig: 'show interface configuration',
    poe: 'show power inline information interface',
    vlan: 'show vlan',
  },
  'cisco-ios': {
    sysinfo: 'show version',
    ifstatus: 'show interfaces status',
    ifconfig: 'show interfaces description',
    poe: 'show power inline',
    vlan: 'show vlan brief',
  },
  dlink: {
    sysinfo: 'show switch',
    ifstatus: 'show ports',
    ifconfig: null,
    poe: null,
    vlan: 'show vlan',
  },
};

// Parse TP-Link/Cisco "Key - Value" or "Key : Value" system-info into fields.
function parseSystemInfo(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  return {
    description: get(/System Description\s*[-:]\s*(.+)/i),
    name:       get(/(?:Device Name|System Name|hostname)\s*[-:]\s*(.+)/i),
    location:   get(/(?:Device |System )?Location\s*[-:]\s*(.+)/i),
    hwVersion:  get(/Hardware Version\s*[-:]\s*(.+)/i),
    fwVersion:  get(/(?:Firmware|Software) Version\s*[-:]\s*(.+)/i),
    mac:        get(/Mac Address\s*[-:]\s*([0-9A-Fa-f:-]{11,17})/i),
    serial:     get(/Serial Number\s*[-:]\s*(.+)/i),
    uptime:     get(/(?:Running Time|Run Time|System Uptime|uptime is)\s*[-:]?\s*(.+)/i),
  };
}

// Longest-first: 'ethernet' must precede 'et', or "Ethernet0/0" matches 'et'
// and then fails on "hernet0/0". Cisco IOL (the EVE-NG lab switches) names its
// ports Et0/0..Et0/3 — without the ethernet|et alternatives every parser keyed
// off this regex silently returned zero rows for them.
const PORT_TOK = /^(?:gigabitethernet|tengigabitethernet|fastethernet|ethernet|gi|te|fa|et)(\d+\/\d+(?:\/\d+)?)$/i;

// Live vs admin state per port: { key: { up, statusRaw, speed, duplex, medium } }.
function parseInterfaceStatus(raw) {
  const out = {};
  for (const line of (raw || '').replace(/\r/g, '').replace(/\x00/g, '\n').split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 2) continue;
    const pm = t[0].match(PORT_TOK);
    if (!pm) continue;
    const status = t[1];
    const medium = t.find(x => /^(copper|fiber)$/i.test(x)) || null;
    out[pm[1]] = {
      up: /linkup|^up$|connected/i.test(status),
      statusRaw: status,
      speed:  (t[2] && t[2] !== 'N/A') ? t[2] : null,
      duplex: (t[3] && t[3] !== 'N/A') ? t[3] : null,
      medium: medium ? medium.toLowerCase() : null,
    };
  }
  return out;
}

// Admin intent + description: { key: { enabled, description } }.
function parseInterfaceConfig(raw) {
  const out = {};
  for (const line of (raw || '').replace(/\r/g, '').replace(/\x00/g, '\n').split('\n')) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    const pm = t[0].match(PORT_TOK);
    if (!pm) continue;
    out[pm[1]] = {
      enabled: /enable|up|connected/i.test(t[1] || ''),
      description: t.slice(5).join(' ') || null,
    };
  }
  return out;
}

// PoE: { ports:{key:{power,class,on}}, used, budget }. Budget is null when the
// firmware doesn't print a system summary line (used is summed from per-port).
function parsePoe(raw) {
  const text = (raw || '').replace(/\r/g, '').replace(/\x00/g, '\n');
  const ports = {};
  let summed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    const pm = t[0].match(PORT_TOK);
    if (!pm) continue;
    const power = parseFloat(t[1]) || 0;
    const cls = (line.match(/Class\s*\d+/i) || [])[0] || null;
    const on = /\bon\b/i.test(t[t.length - 1]);
    ports[pm[1]] = { power, class: cls, on };
    summed += power;
  }
  const bm = text.match(/System Power (?:Limit|Budget)\s*[:=]?\s*([\d.]+)/i);
  const cm = text.match(/System Power Consumption\s*[:=]?\s*([\d.]+)/i);
  return {
    ports,
    used: cm ? parseFloat(cm[1]) : Math.round(summed * 10) / 10,
    budget: bm ? parseFloat(bm[1]) : null,
  };
}

// VLAN membership: [{ id, name, status, ports:[{port,tagged}] }]. Handles
// TP-Link's wrapped continuation lines and Gi1/0/1-24 ranges.
function parseVlan(raw) {
  const out = [];
  let cur = null;
  const add = (s, v) => {
    const seen = new Map(v.ports.map(p => [p.port, p.tagged]));
    // ranges first: 1/0/1-24
    s.replace(/(\d+)\/(\d+)\/(\d+)\s*-\s*(\d+)/g, (_, a, b, c, d) => {
      for (let p = +c; p <= +d; p++) if (!seen.has(`${a}/${b}/${p}`)) seen.set(`${a}/${b}/${p}`, false);
      return ' ';
    });
    const re = /(\d+\/\d+\/\d+)(\((?:t|u)\))?/gi;
    let m;
    while ((m = re.exec(s))) {
      const tagged = /t/i.test(m[2] || '');
      seen.set(m[1], seen.get(m[1]) || tagged);
    }
    v.ports = [...seen.entries()].map(([port, tagged]) => ({ port, tagged }));
  };
  for (const line of (raw || '').replace(/\r/g, '').replace(/\x00/g, '\n').split('\n')) {
    const idm = line.match(/^\s*(\d+)\s+(\S+)\s+(active|inactive|\S+)\s+(.*)$/);
    if (idm && !/^VLAN$/i.test(idm[2])) {
      cur = { id: idm[1], name: idm[2], status: idm[3], ports: [] };
      out.push(cur);
      add(idm[4], cur);
    } else if (cur && /\d+\/\d+\/\d+/.test(line) && !/VLAN\s+Name/i.test(line)) {
      add(line, cur);
    }
  }
  return out;
}

// One full audit pass against a single host: identity, per-port
// status/admin/medium, PoE, VLANs, LLDP neighbours, MAC table.
//
// Extracted from the /api/switch/audit route so /api/lab/devices/:id/audit can
// run the SAME collection without the client ever sending (or seeing) a host or
// credentials — the lab path resolves both server-side from monitored_devices +
// the encrypted cred store. Behaviour is unchanged for the original route.
//
// Short outputs (identity, port status, admin config, PoE, VLAN) all fit one
// page, so they batch into a SINGLE SSH session. LLDP and the MAC table are
// long and paginate; the sequential shell truncates paginated output (we saw
// 2 of 6 neighbours, 0 MACs), so those two use the single-command runner, which
// auto-advances the pager. Net: one session + two reconnects — fast AND complete.
async function auditSwitchHost({ host, sshPort, vendorKey, username, password, enablePassword }) {
  const vconf   = VENDORS[vendorKey];
  const cmds    = AUDIT_CMDS[vendorKey] || AUDIT_CMDS['cisco-ios'];
  const lldpCmd = LLDP_ALL_CMD[vendorKey] || LLDP_ALL_CMD['cisco-ios'];
  const macCmd  = MAC_TABLE_CMD[vendorKey] || MAC_TABLE_CMD['cisco-ios'];
  const cdpCmd  = CDP_ALL_CMD[vendorKey];   // null for vendors without CDP
  const shortCmds = [
    cmds.sysinfo  && { name: 'sysinfo',  cmd: cmds.sysinfo },
    cmds.ifstatus && { name: 'ifstatus', cmd: cmds.ifstatus },
    cmds.ifconfig && { name: 'ifconfig', cmd: cmds.ifconfig },
    cmds.poe      && { name: 'poe',      cmd: cmds.poe },
    cmds.vlan     && { name: 'vlan',     cmd: cmds.vlan },
    // Neighbour/MAC reads run on this SAME shell. They used to go through
    // runSwitchCommand, which opens a FRESH SSH connection per call - and these
    // switches allow very few concurrent sessions and don't release them
    // promptly, so those extra connections came back empty. That, not parsing,
    // is why LLDP, MAC and CDP all read 0 while ports and VLANs populated.
    lldpCmd       && { name: 'lldp',     cmd: lldpCmd },
    macCmd        && { name: 'mac',      cmd: macCmd },
    cdpCmd        && { name: 'cdp',      cmd: cdpCmd },
  ].filter(Boolean);

  const out = {};
  await runSwitchCommandsSequential({
    host, port: sshPort, username, password,
    commands: shortCmds,
    pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword,
    timeoutMsPerCmd: 30000,   // neighbour + MAC dumps are longer than a port table
    onEntry: (i, entry) => { out[entry.name] = entry.output || ''; },
  });
  const lldpRaw = out.lldp || '';
  const macRaw  = out.mac  || '';
  const cdpRaw  = out.cdp  || '';

  // Merge LLDP + CDP. LLDP wins per port when it actually returned something:
  // it is the vendor-neutral protocol and carries richer fields. CDP fills the
  // rest, which on these Cisco IOL images is every port — they answer CDP and
  // return nothing for LLDP.
  const lldpN = parseAllLldpNeighbors(lldpRaw || '');
  const cdpN  = parseCdpNeighbors(cdpRaw || '');
  const neighbors = { ...cdpN, ...lldpN };
  return {
    identity:  parseIdentityFor(vendorKey, out.sysinfo || ''),
    ifstatus:  parseIfStatusFor(vendorKey, out.ifstatus || ''),
    ifconfig:  parseInterfaceConfig(out.ifconfig || ''),
    poe:       parsePoe(out.poe || ''),
    vlans:     parseVlan(out.vlan || ''),
    neighbors,
    macs:      parseMacTable(macRaw || ''),
  };
}

// parseSystemInfo() reads TP-Link's "System Name - value" shape. Cisco's
// `show version` looks nothing like that (the hostname only appears as
// "<name> uptime is ..."), so every identity field came back null for the lab
// switches. cisco_parser already handles that format and is exercised by the
// poller, so reuse it and map onto the same field names the UI expects.
function parseIdentityFor(vendorKey, raw) {
  if (vendorKey !== 'cisco-ios') return parseSystemInfo(raw);
  const m = require('./lib/cisco_parser').parseSystemInfo(raw);
  return {
    name:     m.system_name,
    model:    m.model,
    serial:   m.serial,
    mac:      m.mac,
    firmware: m.sw_version,
    hardware: m.hw_version,
    description: m.system_description,
  };
}

// parseInterfaceStatus() splits on whitespace and assumes token[1] is the
// status. That holds only while the Name column is empty: on a port WITH a
// description ("Et0/3  RACKTRACK-MGMT  connected"), token[1] is the
// description, so the port is reported down with statusRaw="RACKTRACK-MGMT".
// cisco_parser slices by the header's column offsets instead, so it reads
// described ports correctly — and it's already exercised by the poller.
//
// Keys are normalised to app.js's stripped form (Et0/0 -> 0/0) so ifstatus,
// ifconfig, poe, neighbors and macs all agree; the UI joins them by that key.
function parseIfStatusFor(vendorKey, raw) {
  if (vendorKey !== 'cisco-ios') return parseInterfaceStatus(raw);
  const rows = require('./lib/cisco_parser').parseInterfaceStatus(raw);
  const out = {};
  for (const [port, r] of rows) {
    const km = String(port).match(PORT_TOK);
    if (!km) continue;   // skip anything that isn't a physical port
    out[km[1]] = {
      up:        r.oper === 'up',
      statusRaw: r.oper,
      // IOL never negotiates a real link, so these are usually null — the
      // column shows "—" and that is the truth, not a parse failure.
      speed:     r.speed_mbps == null ? null : `${r.speed_mbps}M`,
      duplex:    r.duplex,
      medium:    r.medium ? r.medium.toLowerCase() : null,
    };
  }
  return out;
}

// POST /api/lab/devices/:id/audit — same full audit as /api/switch/audit, but
// addressed by monitored_devices id instead of a client-supplied host.
//
// Owner-only, and deliberately so: it returns the host it audited, and
// monitored_devices has no tenant_id, so any lower role could enumerate every
// tenant's switches. The client sends only an id — host, ssh_port, vendor and
// credentials are all resolved here, which is the whole point (the live Ports
// page resolves hosts client-side against a hardcoded IP; this doesn't).
app.post('/api/lab/devices/:id/audit', auth.requireRole('owner'), async (req, res) => {
  const portsDb  = require('./lib/port_history_db');
  const sshCreds = require('./lib/ssh-creds');
  const poller   = require('./lib/port_poller');

  const device = portsDb.getDevice(Number(req.params.id));
  if (!device) return res.status(404).json({ error: 'device not found' });

  // Fold the legacy 'cisco_ios' spelling the same way the poller does, then
  // fall back only if the vendor has no VENDORS entry at all.
  const vendor    = poller.normalizeVendor(device.vendor);
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';

  // Per-host creds win over per-vendor — same precedence the poller uses.
  const hostCreds = sshCreds.getForHost(device.host);
  const creds = hostCreds
    ? { ...(sshCreds.getForVendor(vendor) || {}), ...hostCreds }
    : sshCreds.getForVendor(vendor);
  if (!creds || !creds.username) {
    // No script name, no path. Setup belongs in the docs, not in an API response
    // that lands in screenshots and support tickets — see switchRequestBlocker.
    return res.status(409).json({
      error: `No sign-in saved for ${vendor} switches, so this one can’t be read yet.`,
    });
  }

  // Yield the host to this request: these switches allow ~1 SSH session, so a
  // background poll landing mid-audit makes the switch drop both.
  poller.noteManualProbe?.(device.host);

  try {
    const data = await auditSwitchHost({
      host: device.host,
      sshPort: device.ssh_port || 22,
      vendorKey,
      username: creds.username,
      password: creds.password,
      enablePassword: creds.enablePassword || creds.password,
    });
    // A completed audit IS a successful SSH pass — the same evidence the
    // poller records. Clear the failure state so the UI stops contradicting
    // itself: CoreSW sat at 'nothing is listening on SSH / ECONNREFUSED' while
    // simultaneously showing fresh audit data on the same screen, because a
    // manual audit never touched last_error. It also breaks the backoff ladder:
    // after 6 failures the next retry is far out, so a switch fixed in the lab
    // stayed 'Offline' long after it recovered.
    try { portsDb.recordPollSuccess(device.id); }
    catch (e) { logger?.warn?.({ event: 'lab_audit.clear_failed', err: e.message }); }
    const fresh = portsDb.getDevice(device.id) || device;
    res.json({ ok: true, device: portsDb.toClientView(fresh), host: device.host, vendor: vendorKey, ...data });
  } catch (err) {
    logger?.warn?.({ event: 'lab_audit.failed', host: device.host, err: err.message },
      'lab device audit failed');
    res.json({ ok: false, error: err.message, host: device.host, vendor: vendorKey });
  }
});

// POST /api/switch/audit — one pass over the switch for the full Ports-tab
// audit: identity, per-port status/admin/medium, PoE, VLANs, LLDP neighbours,
// and the MAC table. Runs each read-only command serialized on the host lock
// (the single-command path auto-advances the pager, so nothing truncates).
app.post('/api/switch/audit', auth.requireAuth, async (req, res) => {
  const { host, sshPort, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  const _dbg = (m) => { try { require('fs').appendFileSync('/tmp/rt-audit.log', `${new Date().toISOString()} ${m}\n`); } catch (_) {} };
  _dbg(`REQ host=${host} vendor=${vendor} hasUser=${!!username} hasPass=${!!password}`);
  const _t0 = Date.now();
  if (!host || !username || !password) {
    _dbg(`400 missing host/creds`);
    const blocked = switchRequestBlocker({ host, username, password });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  const gather = (h) => auditSwitchHost({
    host: h, sshPort, vendorKey, username, password, enablePassword,
  });

  // Only ever audit the host the caller asked for.
  //
  // This used to fall back to TPLINK_BENCH_HOST ("self-heal: a stale client IP
  // recovers without user action"), which quietly turned the route into a
  // disclosure primitive: post any junk host, the loop falls through to the
  // bench switch, and the response echoes back host:"192.168.1.33" along with
  // its serial, MAC table and LLDP neighbours — handing an attacker the exact
  // internal IP they need to then aim resolveSwitchCreds at it. The convenience
  // wasn't worth an endpoint that answers about a switch nobody asked about.
  //
  // The stale-IP case it existed for is now served properly: /api/lab/devices
  // resolves hosts server-side from monitored_devices.
  let lastErr = null;
  for (const h of [host]) {
    try {
      const data = await gather(h);
      _dbg(`OK ${Date.now() - _t0}ms host=${h} neighbors=${Object.keys(data.neighbors).length} macs=${Object.keys(data.macs).length} identity=${data.identity.name || '?'}`);
      return res.json({ ok: true, host: h, vendor: vendorKey, ...data });
    } catch (err) {
      lastErr = err;
      _dbg(`FAIL host=${h} ${err.message}`);
    }
  }
  _dbg(`ERR ${Date.now() - _t0}ms ${lastErr && lastErr.message}`);
  res.json({ ok: false, error: lastErr ? lastErr.message : 'audit failed', host });
});

// Vendor commands for reachability checks. TP-Link uses `tracert` (not
// `traceroute`, which errors "Bad command"); Cisco/D-Link use `traceroute`.
// TP-Link's `tracert` defaults to only 4 hops — append a max-hop count so it
// walks the full path and reaches the destination, like Cisco's 30-hop default.
const NET_CMD = {
  tplink:      { ping: 'ping {t}', traceroute: 'tracert {t} 30' },
  'cisco-ios': { ping: 'ping {t}', traceroute: 'traceroute {t}' },
  dlink:       { ping: 'ping {t}', traceroute: 'traceroute {t}' },
};

// POST /api/switch/trace — quick verification from the switch itself: run a
// ping or traceroute to a target and return the raw output. Rides the same SSH
// console plumbing as every other switch command.
// Owner-only, unlike the rest of /api/switch/*. This makes a switch INSIDE the
// office LAN emit traffic to a target the caller chooses. The target is
// validated as an IP/hostname and the command comes from a server-side template,
// so it is not arbitrary CLI — but on a public demo it would hand every visitor
// a probe originating on the far side of the tunnel, one host at a time. The
// Ping tab is hidden for non-owners to match (PortsPage.jsx).
app.post('/api/switch/trace', auth.requireRole('owner'), async (req, res) => {
  const { host, sshPort, vendor, target, kind } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password) {
    const blocked = switchRequestBlocker({ host, username, password });
    if (blocked) return res.status(400).json({ error: blocked });
  }
  const tgt = String(target || '').trim();
  // Injection guard: the target is spliced into a shell command on the switch,
  // so allow only an IP or hostname — letters, digits, dot, hyphen, colon.
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(tgt)) {
    return res.status(400).json({ error: 'Enter a valid IP address or hostname.' });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  const vconf = VENDORS[vendorKey];
  const k = kind === 'ping' ? 'ping' : 'traceroute';
  const tmpl = (NET_CMD[vendorKey] || NET_CMD['cisco-ios'])[k];
  const command = tmpl.replace('{t}', tgt);
  try {
    const raw = await runSwitchCommand({
      host, port: sshPort, username, password, command,
      pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword,
      timeoutMs: 45000,   // ping/traceroute can take a while to walk hops
    });
    res.json({ ok: true, host, target: tgt, kind: k, command, output: (raw || '').trim() });
  } catch (err) {
    res.json({ ok: false, error: err.message, host, target: tgt, kind: k });
  }
});

// GET /api/vendors — list supported switch vendors for the UI picker.
app.get('/api/vendors', (req, res) => {
  res.json({
    vendors: Object.entries(VENDORS).map(([key, v]) => ({ key, label: v.label })),
  });
});

// ── Spec sheet & firmware lookup ──────────────────────────────
// Spawns a python module under pipeline/ with --json. The module reads
// Switch_Vendors_Websites.xlsx, picks the vendor URL, searches the vendor
// site, and scrapes the relevant block (specs, release notes).
const { spawn: _spawnPyMod } = require('child_process');
const PY_MOD_TIMEOUT_MS = 90_000;

function runPipelineModule(moduleName, extraArgs) {
  return new Promise((resolve) => {
    const child = _spawnPyMod(pythonCmd, ['-u', '-m', moduleName, ...extraArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '', stderr = '', settled = false;
    const finish = (payload) => { if (settled) return; settled = true; resolve(payload); };

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      // Friendly user-facing string. The real module name + stderr are
      // kept on the result object for server-log debugging but never
      // surface to the UI directly.
      finish({
        ok: false,
        error: 'Lookup took too long. Try again in a moment.',
        _moduleName: moduleName,
        _stderr: stderr,
      });
    }, PY_MOD_TIMEOUT_MS);

    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      finish({ ok: false, error: 'Lookup failed to start. Try again.', _spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed = null;
      if (lastLine) { try { parsed = JSON.parse(lastLine); } catch (_) {} }
      if (parsed) return finish(parsed);
      finish({
        ok: false,
        error: 'Lookup didn’t return a usable result. Try again.',
        _exitCode: code,
        _stderr: stderr.trim().slice(-500),
      });
    });
  });
}

// GET /api/specs/vendors — vendor names from the Excel sheet.
app.get('/api/specs/vendors', auth.requireAuth, moduleLimit, async (req, res) => {
  const result = await runPipelineModule('pipeline.all_vendor', ['--list-vendors']);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

// Memo for the two lookup endpoints below — see server/lib/lookup_cache.js
// for why they need one. Shared by both: the keys are namespaced.
const { createLookupCache } = require('./lib/lookup_cache');
const _vendorLookups = createLookupCache();
const _lookupOnce = (key, produce) => _vendorLookups.once(key, produce);

// POST /api/specs  body: { vendor, model }
// → Switch Spec Agent (Agent_scrap): SQLite cache (~1ms) with free
//   multi-engine web fallback (~4s) for unknown models. The agent's record
//   is transformed into the UI's existing { vendor, model, productUrl, specs }
//   contract so callers don't have to change.
app.post('/api/specs', auth.requireAuth, moduleLimit, async (req, res) => {
  const vendor = String(req.body?.vendor || '').trim();
  const model  = String(req.body?.model  || '').trim();
  // fromOcr === true: data came from the OCR pipeline; run the 2-stage
  // OCR-correction probe (DB-only → suggestion retry → live fallback) so
  // garbled models like "C9300-46P" auto-correct to "C9300-48P". For
  // CMDB / manually-entered data we trust the input and skip the probe,
  // saving the extra Python spawn (~1-2s per request).
  const fromOcr = req.body?.fromOcr === true;
  if (!vendor || !model) {
    return res.status(400).json({ ok: false, error: 'vendor and model are required' });
  }
  const payload = await _lookupOnce(
    `specs::${vendor.toLowerCase()}::${model.toLowerCase()}::${fromOcr ? 'ocr' : 'exact'}`,
    async () => {
      let agentRes, matchedFrom = null, matchedTo = null;
      if (fromOcr) {
        ({ agentRes, matchedFrom, matchedTo } =
          await resolveAgentWithOcrCorrection(vendor, model));
      } else {
        agentRes = await runAgentCli([`${vendor} ${model}`]);
      }
      const p = specPayloadFromAgent(agentRes, vendor, model);
      if (matchedFrom) {
        p.matchedFrom = matchedFrom;
        p.matchedTo   = matchedTo;
      }
      return p;
    });
  res.status(payload.ok ? 200 : 404).json(payload);
});

// Score how similar two model strings are (0..1). Uses alphanumeric-only
// comparison + longest-common-subsequence-lite + a strong bonus for shared
// prefix, which matches how vendor SKUs work (the family stem is at the
// front: "CRS326-...", "C9300-...", "EX4400-...").
function _modelSimilarity(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  // Shared-prefix length (counted in chars; case-insensitive).
  let pre = 0;
  const minLen = Math.min(x.length, y.length);
  while (pre < minLen && x[pre] === y[pre]) pre++;
  // Common-chars-in-order over the longer string.
  let common = 0, i = 0;
  for (const ch of y) {
    const idx = x.indexOf(ch, i);
    if (idx >= 0) { common++; i = idx + 1; }
  }
  const longer = Math.max(x.length, y.length);
  const lcsScore = common / longer;
  const preScore = pre / minLen;
  return 0.6 * preScore + 0.4 * lcsScore;
}

function _bestSuggestion(suggestions, originalModel) {
  if (!Array.isArray(suggestions) || !suggestions.length) return null;
  let best = null, bestScore = -1;
  for (const s of suggestions) {
    const score = _modelSimilarity(s, originalModel);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // Threshold guards against picking a wildly different sibling (e.g.
  // returning "CRS305" for a query about a novel "C9300" model that
  // simply isn't in the DB). 0.5 lets "CRS326-246" → "CRS326-24G"
  // through while rejecting unrelated picks.
  return bestScore >= 0.5 ? best : null;
}

// Two-stage resolver: fast DB-only probe first, then live web fallback if
// the DB-only probe found neither a direct hit nor a high-similarity
// suggestion. This collapses the OCR-garbled case from ~16s
// (live-deadline + retry) to ~1-2s (Python-startup + 0ms cache hit on the
// retry), while still letting genuinely-novel models reach the live path.
async function resolveAgentWithOcrCorrection(vendor, model) {
  // Stage 1: DB-only probe. ~1-2s including py spawn.
  const probe = await runAgentCli(['--no-live', `${vendor} ${model}`]);
  if (probe.ok) {
    return { agentRes: probe, matchedFrom: null, matchedTo: null };
  }
  const suggestions = probe?.response?.suggestions || [];
  const best = _bestSuggestion(suggestions, model);
  if (best && best.toLowerCase() !== model.toLowerCase()) {
    const retry = await runAgentCli([`${vendor} ${best}`]);  // live=true here
    if (retry.ok) {
      return { agentRes: retry, matchedFrom: model, matchedTo: best };
    }
  }
  // Stage 2: fall through to live lookup of the ORIGINAL query — for
  // genuinely novel models the agent's multi-source web extractor may
  // succeed even without a DB seed.
  const live = await runAgentCli([`${vendor} ${model}`]);
  return { agentRes: live, matchedFrom: null, matchedTo: null };
}

// Maps Agent_scrap's `answer()` response onto the UI's existing
// /api/specs response contract: { ok, vendor, model, productUrl, specs }.
// SPEC_KEY_LABELS lives next to this so a future spec field added to the
// agent's DB shows up here without a code change on the React side.
const SPEC_KEY_LABELS = {
  family: 'Family', sku: 'SKU',
  port_count: 'Ports', port_config: 'Port config', uplink_config: 'Uplinks',
  port_speed_max_gbps: 'Max port speed (Gbps)',
  switching_capacity_gbps: 'Switching capacity (Gbps)',
  forwarding_rate_mpps: 'Forwarding rate (Mpps)',
  buffer_mb: 'Buffer (MB)', latency_ns: 'Latency (ns)',
  mac_table_size: 'MAC table',
  poe_standard: 'PoE', poe_budget_w: 'PoE budget (W)',
  power_typical_w: 'Power typical (W)', power_max_w: 'Power max (W)',
  layer: 'Layer', features: 'Features', rack_units: 'Rack units',
  nos: 'Network OS', status: 'Status', use_case: 'Typical use',
};

function specPayloadFromAgent(agentRes, reqVendor, reqModel) {
  if (!agentRes || !agentRes.ok) {
    return {
      ok: false,
      vendor: reqVendor,
      model:  reqModel,
      error: agentRes?.error
        || `No spec match for "${reqVendor} ${reqModel}". The agent's web fallback may need 'pip install -r requirements.txt' in Agent/Agent_scrap.`,
    };
  }
  const resp = agentRes.response || {};
  const rec  = resp.result || (resp.results && resp.results[0]) || {};
  const specs = {};
  for (const [key, label] of Object.entries(SPEC_KEY_LABELS)) {
    const v = rec[key];
    if (v == null || v === '') continue;
    specs[label] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  // Pass through the agent's free-form datasheet extras verbatim. The
  // structured columns above already give us the labeled fields; this
  // block surfaces everything else the agent extracted from the vendor
  // datasheet (switching capacity, buffer, MAC table, dimensions, part
  // numbers, standards, walls-of-text feature lists — all of it).
  const extras = rec.extra_specs && typeof rec.extra_specs === 'object'
    ? rec.extra_specs : null;
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v == null || v === '') continue;
      if (specs[k]) continue; // don't shadow structured labels
      specs[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return {
    ok: true,
    vendor:     rec.vendor || reqVendor,
    model:      rec.model  || reqModel,
    productUrl: rec.datasheet_url || rec.image_url || null,
    imageUrl:   rec.image_url || null,
    specs,
    source: agentRes.elapsed_ms != null
      ? `agent (${agentRes.elapsed_ms} ms)`
      : 'agent',
  };
}

// POST /api/sfp/analyze  body: { vendor, model, interfaces? }
// → dynamically determines SFP slot type by scraping vendor datasheets,
//   then searches the web for compatible transceiver modules.
//   No hardcoded switch database — everything is inferred from live data.
app.post('/api/sfp/analyze', auth.requireAuth, moduleLimit, async (req, res) => {
  const vendor     = String(req.body?.vendor || '').trim();
  const model      = String(req.body?.model  || '').trim();
  const interfaces = req.body?.interfaces || '';  // comma-separated iface names
  // Both make AND model are required — without them we can't identify the
  // switch, so there's nothing meaningful to advise.
  if (!vendor || !model) {
    return res.json({ ok: true, status: 'need_make_model',
      message: 'Add the switch make and model to get SFP advice.',
      vendor, model, modules: [], cables: [] });
  }
  const args = ['--json', '--vendor', vendor, '--model', model];
  if (interfaces) args.push('--interfaces', interfaces);
  const result = await runPipelineModule('pipeline.sfp_recommend', args);
  res.json(result);
});

// POST /api/firmware  body: { vendor, model, currentVersion }
// → firmware_lookup (vendored package). Reads the vendor's OWN real site for
//   the latest official firmware, and never fabricates a version. Returns the
//   latest version, whether an update is available, and the vendor page it
//   came from. When a vendor needs a login or blocks automation, that page is
//   handed to the user as a portal link to check for themselves — never a
//   dead end. Changelog / release-note bodies are intentionally not provided
//   (accuracy over coverage — see firmware_lookup/README.md).
app.post('/api/firmware', auth.requireAuth, moduleLimit, async (req, res) => {
  const vendor         = String(req.body?.vendor || '').trim();
  const model          = String(req.body?.model  || '').trim();
  const currentVersion = String(req.body?.currentVersion || '').trim();
  if (!vendor || !model || !currentVersion) {
    return res.status(400).json({
      ok: false,
      error: 'vendor, model, and currentVersion are required',
    });
  }

  const { lookup, payload } = await _lookupOnce(
    `fw::${vendor.toLowerCase()}::${model.toLowerCase()}::${currentVersion.toLowerCase()}`,
    async () => {
      const l = await runFirmwareLookup(vendor, model, currentVersion);
      const p = firmwarePayloadFromLookup(l, { vendor, model, currentVersion });
      // A runner failure is transient — don't let it occupy the slot for the
      // full TTL. `ok:false` gives it the short miss TTL instead.
      return { lookup: l, payload: p, ok: !(l && l._runnerError) };
    });
  // Always 200 when the lookup ran, even for auth-required / bot-walled /
  // unknown: those are not server errors — each carries a portal link the UI
  // shows the user. Only a genuine runner failure is non-200.
  res.status(lookup && lookup._runnerError ? 502 : 200).json(payload);
});

// Spawn the vendored firmware_lookup package for one (vendor, model, version).
// The CLI prints the full FirmwareResult as pretty JSON on stdout (logs go to
// stderr), so we parse the whole of stdout rather than a single line.
const FIRMWARE_TIMEOUT_MS = 90_000;   // live vendor sites + browser providers are slow
function runFirmwareLookup(vendor, model, currentVersion) {
  return new Promise((resolve) => {
    const child = _spawnPyMod(
      pythonCmd,
      ['-u', '-m', 'firmware_lookup', 'lookup', vendor, model, currentVersion, '--json', '--verbose'],
      { cwd: PROJECT_ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } },
    );
    let stdout = '', stderr = '', settled = false;
    const finish = (p) => { if (settled) return; settled = true; resolve(p); };
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ _runnerError: 'Firmware lookup took too long. Try again in a moment.', _stderr: stderr.slice(-500) });
    }, FIRMWARE_TIMEOUT_MS);
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(killer);
      finish({ _runnerError: 'Firmware lookup failed to start.', _spawnError: err.message });
    });
    child.on('close', () => {
      clearTimeout(killer);
      try { finish(JSON.parse(stdout.trim())); }
      catch { finish({ _runnerError: 'Firmware lookup returned no usable result.', _stderr: stderr.slice(-500) }); }
    });
  });
}

// Map a firmware_lookup FirmwareResult (to_full_dict) onto the UI contract:
// { ok, vendor, model, currentVersion, latestVersion, upToDate,
//   releaseNotesUrl, portalUrl, authRequired, statusValue, message,
//   confidence, changelog }. releaseNotesUrl keeps its name so the existing
// link renders; for this source it is the vendor page / portal, not a
// changelog. changelog is always empty — the package does not provide one.
function firmwarePayloadFromLookup(r, req) {
  if (!r || r._runnerError) {
    return {
      ok: false,
      vendor: req.vendor, model: req.model, currentVersion: req.currentVersion,
      error: (r && r._runnerError) || 'Firmware lookup failed.',
    };
  }
  const status = r.status || 'cannot_determine';
  const latest = r.latest_version || null;
  const portal = r.source_url || null;
  const isOk   = status === 'ok';
  let upToDate = null;
  if (isOk && typeof r.update_available === 'boolean') upToDate = (r.update_available === false);
  return {
    ok: isOk,
    vendor:         r.vendor || req.vendor,
    model:          r.model  || req.model,
    currentVersion: req.currentVersion,
    latestVersion:  latest,
    upToDate,
    releaseNotesUrl: portal,   // vendor page / portal (name kept for the UI)
    portalUrl:       portal,
    authRequired:    status === 'auth_required',
    statusValue:     status,
    message:         r.message || null,
    confidence:      r.confidence || null,
    changelog:       [],       // package provides no changelog, by design
  };
}

// Maps an Agent_scrap `--firmware` result onto the same UI contract that
// firmwarePayloadFromLookup produces from the Python firmware_lookup package.
// Both exist on purpose and are NOT interchangeable:
//   * /api/firmware (user-initiated) uses firmware_lookup — it hits live
//     vendor sites, which is slow but authoritative.
//   * the scan report uses the agent in --no-live mode — cache-only and
//     bounded, because the report regenerates on every open and must never
//     block on a vendor website.
// Kept in the shape the report's Selected Device section reads
// (ok / latestVersion / upToDate / currentVersion).
function firmwarePayloadFromAgent(agentRes, req) {
  if (!agentRes || !agentRes.ok) {
    return {
      ok: false,
      vendor: req.vendor,
      model:  req.model,
      currentVersion: req.currentVersion,
      error: agentRes?.error || 'Agent failed to return a firmware response.',
    };
  }
  const advice = agentRes.advice || {};
  const target = (advice.diff && advice.diff.target) || null;
  const agentLatest = (target && target.version) || null;

  let upToDate = null;
  if (agentLatest) {
    upToDate = String(agentLatest).trim() === String(req.currentVersion).trim();
  }

  // NOTE: the agent also returns advice.advisories[] (CVE rows from NVD).
  // They are deliberately NOT mapped through — CVE data was removed from the
  // product and must not reappear anywhere in the app. Do not reintroduce it
  // here just because the upstream payload happens to carry it.

  // Synthesize the changelog section from the target firmware's
  // structured release-note fields — no extra web scrape needed since the
  // agent's firmware DB already carries the diff breakdown.
  const changelog = [];
  if (target) {
    const v = target.version || '';
    const push = (label, list) => {
      if (Array.isArray(list) && list.length) {
        changelog.push({
          section: v ? `${label} in ${v}` : label,
          version: v || null,
          text: list.join('\n'),
        });
      }
    };
    push('Security fixes', target.security_fixes);
    push('Bug fixes',      target.bug_fixes);
    push('New features',   target.new_features);
    push('Known issues',   target.known_issues);
    push('Deprecations',   target.deprecations);
  }

  return {
    ok: true,
    vendor:         agentRes.vendor || advice.vendor || req.vendor,
    model:          agentRes.model  || req.model,
    currentVersion: req.currentVersion,
    latestVersion:  agentLatest,
    upToDate,
    releaseNotesUrl:   (target && target.release_notes_url) || null,
    releaseNotesError: (!target && advice.message) ? advice.message : null,
    releaseNotesGated: !!advice.release_notes_gated,
    advisoryMessage: advice.message || null,
    hasAdvisoryData: !!advice.has_data,
    nos: advice.nos || null,
    versionsFound: [],
    changelog,
    portalUrl: advice.portal_url || null,
    recommendedMinVersion: advice.recommended_min_version || null,
    latestSource: `agent (${agentRes.elapsed_ms ?? '?'} ms)`,
  };
}

// ── Switch Spec Agent (Agent_scrap) ───────────────────────────────────────
// Wraps the standalone agent at Agent/Agent_scrap (cloned separately).
// Cached DB hits return in ~1ms; unknown vendor/model falls back to a free
// multi-engine web fetch + extraction in ~4s. No LLM, no API keys.
const AGENT_DIR = path.join(PROJECT_ROOT, 'Agent', 'Agent_scrap');
// Wall-clock budget per agent CLI invocation. Sized for the worst legit
// case: Scan Results prefetches /api/specs for every unique (vendor, model)
// in parallel, each spawning a fresh Python process (~1-2s on Windows) +
// for unknown / OCR-garbled models the agent does a 4-9s live web fallback,
// and concurrent search-engine fetches can compound under load. 60s lets
// even pathological cases complete instead of surfacing as
// "Agent lookup took too long" in the UI.
const AGENT_TIMEOUT_MS = 60_000;

function runAgentCli(extraArgs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(AGENT_DIR, 'cli.py'))) {
      return resolve({ ok: false, error: 'agent not installed at Agent/Agent_scrap' });
    }
    const child = spawnChild(pythonCmd, ['-u', 'cli.py', '--json', ...extraArgs], {
      cwd: AGENT_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (payload) => { if (settled) return; settled = true; resolve(payload); };
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'Agent lookup took too long.', _stderr: stderr });
    }, AGENT_TIMEOUT_MS);
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(killer);
      finish({ ok: false, error: 'Agent failed to start.', _spawnError: err.message });
    });
    child.on('close', () => {
      clearTimeout(killer);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed = null;
      if (lastLine) { try { parsed = JSON.parse(lastLine); } catch (_) {} }
      if (parsed) return finish(parsed);
      finish({ ok: false, error: 'Agent returned no parsable JSON.',
               _stderr: stderr.trim().slice(-500) });
    });
  });
}

// POST /api/scan/:rackId/ocr-devices
// Runs pipeline.ocr_devices on a rack — per-device EasyOCR pass against
// each detected device's chassis crop, parsing make/model/firmware. Writes
// outputs/<rackId>/ocr_devices.json which servicenow/synth.py picks up on
// the next CMDB build to populate real (instead of synthesized) make/model.
// Slow path: EasyOCR on CPU can take 1-2 minutes for a full rack. We use
// a generous timeout (5 min) and run synchronously since the user is
// usually waiting on the result before triggering the CMDB push.
const OCR_DEVICES_TIMEOUT_MS = 5 * 60_000;
app.post('/api/scan/:rackId/ocr-devices', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ ok: false, error: `rack ${rackId} not found` });
  }
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.ocr_devices', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    send(504, { ok: false, error: 'OCR timed out', rackId });
  }, OCR_DEVICES_TIMEOUT_MS);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('error', err => {
    clearTimeout(killer);
    send(500, { ok: false, error: `spawn failed: ${err.message}` });
  });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let parsed = null;
    try { parsed = JSON.parse(lastLine); } catch (_) {}
    if (!parsed) {
      return send(500, { ok: false,
        error: stderr.slice(-400) || 'no JSON on stdout',
        rackId });
    }
    audit.log({ req, action: 'scan.ocr_devices',
                status: parsed.ok ? 'ok' : 'fail',
                targetType: 'rack', targetId: rackId,
                payload: { devices: (parsed.devices || []).length,
                           full: (parsed.devices || []).filter(d => d.source === 'ocr_full').length,
                           partial: (parsed.devices || []).filter(d => d.source === 'ocr_make_only').length } });
    send(parsed.ok ? 200 : 500, parsed);
  });
});

// GET /api/scan/:rackId/ocr-devices
// Returns the cached ocr_devices.json if it exists. No SSH, no scrape — just
// reads the file written by the POST endpoint above. Used by the Switch
// Information page to know whether OCR has been run for this rack.
app.get('/api/scan/:rackId/ocr-devices', (req, res) => {
  const { rackId } = req.params;
  res.setHeader('Cache-Control', 'no-store');
  const p = path.join(outputsDir, rackId, 'ocr_devices.json');
  if (!fs.existsSync(p)) {
    return res.status(404).json({ ok: false, error: 'OCR not yet run for this rack', rackId });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, rackId });
  }
});

// POST /api/scan/:rackId/side-labels
// Runs pipeline.side_labels — extracts identifier-shaped text from the
// LEFT and RIGHT margins of the rack photo (the green "SWHOME / SWFIBRA1"
// chips techs apply to rack rails). This is independent of the CV
// detector: even when YOLO misses a device with an unusual fascia, the
// side label is still readable. The client uses the result to surface
// recall gaps ("5 labels found, 3 switches identified — confirm the
// missing 2") instead of silently under-counting.
//
// Same spawn pattern as ocr-devices (synchronous, generous timeout —
// EasyOCR on CPU). Cheaper than the full-image pass because we only OCR
// ~24% of the pixels (12% on each margin).
const SIDE_LABELS_TIMEOUT_MS = 3 * 60_000;
app.post('/api/scan/:rackId/side-labels', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ ok: false, error: `rack ${rackId} not found` });
  }
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.side_labels', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    send(504, { ok: false, error: 'side-label OCR timed out', rackId });
  }, SIDE_LABELS_TIMEOUT_MS);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('error', err => {
    clearTimeout(killer);
    send(500, { ok: false, error: `spawn failed: ${err.message}` });
  });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let parsed = null;
    try { parsed = JSON.parse(lastLine); } catch (_) {}
    if (!parsed) {
      return send(500, { ok: false,
        error: stderr.slice(-400) || 'no JSON on stdout',
        rackId });
    }
    // Cache for cheap re-fetch from the GET endpoint.
    if (parsed.ok) {
      try {
        fs.writeFileSync(
          path.join(rackDir, 'side_labels.json'),
          JSON.stringify(parsed, null, 2),
        );
      } catch (e) {
        logger.warn(`[side_labels] cache write failed for ${rackId}: ${e.message}`);
      }
    }
    send(parsed.ok ? 200 : 500, parsed);
  });
});

// GET /api/scan/:rackId/side-labels
// Returns the cached side_labels.json if present, otherwise 404. The
// client falls back to triggering a POST when this 404s.
app.get('/api/scan/:rackId/side-labels', (req, res) => {
  const { rackId } = req.params;
  const p = path.join(outputsDir, rackId, 'side_labels.json');
  if (!fs.existsSync(p)) {
    return res.status(404).json({ ok: false, error: 'side labels not yet extracted', rackId });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, rackId });
  }
});

// POST /api/scan/:rackId/{slack,teams,outlook}
// Each regenerates the report as PDF (via headless Chromium) and spawns the
// matching Python sender (pipeline.slack_email / pipeline.teams_send /
// pipeline.outlook_send). The sender emits a single JSON line on stdout; we
// forward it to the client.
const { spawn: spawnChild } = require('child_process');

// No hardcoded recipient — the client must supply one (env vars below are an ops override).
const SHARE_PDF_TIMEOUT_MS = 120_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn a sender failure into something a technician can act on.
 *
 * These messages reach a user who is standing in front of a rack trying to send
 * a report. "Failed to find users with user principal name ..." plus a request
 * id tells them nothing; "that address isn't in your Microsoft organisation"
 * tells them exactly what to change.
 */
function friendlyShareError(channel, email, raw) {
  const t = String(raw || '');
  const where = channel === 'teams' ? 'Teams' : channel === 'outlook' ? 'Outlook' : 'Slack';
  if (/NotFound|Failed to find users|user principal name/i.test(t)) {
    return `${email} isn't a member of your ${where} organisation, so the report can't be sent there. `
         + `Use a work address from your own organisation, or share by email instead.`;
  }
  if (/Unauthorized|InvalidAuthenticationToken|401|invalid_grant|expired/i.test(t)) {
    return `The ${where} connection has expired. Reconnect it under Data Sources and try again.`;
  }
  if (/Forbidden|403|Authorization_RequestDenied/i.test(t)) {
    return `RackTrack does not have permission to post to ${where} for this organisation. `
         + `Your administrator needs to approve it.`;
  }
  if (/timed? ?out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network/i.test(t)) {
    return `Couldn't reach ${where}. Check the connection and try again.`;
  }
  if (/smtp|mail|sendmail|relay/i.test(t) && channel !== 'teams') {
    return `The email couldn't be sent to ${email}. Check the address and try again.`;
  }
  return `Couldn't send the report to ${where}. This has been logged — please try again, `
       + `or use a different sharing option.`;
}

async function runShareSender(req, res, { rackId, channel, pyModule, email, extraArgs }) {
  if (!email) {
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId, error: 'missing recipient' });
    return res.status(400).json({ ok: false, channel, error: 'Recipient email is required' });
  }
  if (!EMAIL_RE.test(email)) {
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId, error: 'invalid recipient', payload: { recipient: email } });
    return res.status(400).json({ ok: false, channel, error: 'Recipient email is not a valid address' });
  }

  let pdfPath;
  try {
    ({ pdfPath } = await buildScanReportPDF(rackId));
  } catch (err) {
    const code = /not.*found|ENOENT/i.test(String(err?.message)) ? 404 : 500;
    logger.error(`[share:${channel}] PDF build failed for ${rackId}:`, err);
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: `pdf build: ${err.message}`, payload: { recipient: email } });
    return res.status(code).json({ ok: false, channel, error: 'Could not generate the report. Please try again.' });
  }

  const args = ['-u', '-m', pyModule, '--email', email, '--file', pdfPath, ...extraArgs];
  const child = spawnChild(pythonCmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });

  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };

  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  }, SHARE_PDF_TIMEOUT_MS);

  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    let parsed = null;
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    if (lastLine) { try { parsed = JSON.parse(lastLine); } catch (_) {} }

    if (code === 0 && parsed?.ok) {
      audit.log({ req, action: `scan.share.${channel}`, status: 'ok', targetType: 'rack', targetId: rackId,
                  payload: { recipient: email } });
      return send(200, {
        ok: true,
        channel,
        rackId,
        recipient: email,
        reportPath: pdfPath,
        result: parsed,
      });
    }
    logger.error(`[share:${channel}] sender exited code=${code} for ${rackId}`, { stderr: stderr.slice(-500) });
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: parsed?.error || `exit ${code}`, payload: { recipient: email } });
    // The raw stderr used to go straight to the client, so a tester saw a
    // Microsoft Graph JSON blob — request ids, inner errors and all — printed
    // over the app. It says nothing they can act on and looks like a crash.
    // Translate the cases we know, keep the rest generic, and log the original.
    send(502, {
      ok: false,
      channel,
      error: friendlyShareError(channel, email, parsed?.error || stderr || ''),
      // stdout/stderr are deliberately NOT returned. They are in the server log.
    });
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    logger.error(`[share:${channel}] failed to spawn Python:`, err);
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: `spawn: ${err.message}`, payload: { recipient: email } });
    send(500, { ok: false, channel, error: `Could not start the ${channel} sender. This has been logged.` });
  });
}

app.post('/api/scan/:rackId/slack', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.SLACK_RECIPIENT_EMAIL || '').trim();
  const comment = (req.body?.comment || `Rack scan report for ${rackId}`).toString();
  await runShareSender(req, res, {
    rackId, channel: 'slack', pyModule: 'pipeline.slack_email', email,
    extraArgs: ['--comment', comment],
  });
});

app.post('/api/scan/:rackId/teams', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.TEAMS_RECIPIENT_EMAIL || '').trim();
  const message = (req.body?.message || `Rack scan report for ${rackId}`).toString();
  await runShareSender(req, res, {
    rackId, channel: 'teams', pyModule: 'pipeline.teams_send', email,
    extraArgs: ['--message', message],
  });
});

app.post('/api/scan/:rackId/outlook', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.OUTLOOK_RECIPIENT_EMAIL || '').trim();
  const subject = (req.body?.subject || `Rack scan report for ${rackId}`).toString();
  const extra = ['--subject', subject];
  if (req.body?.body) extra.push('--body', String(req.body.body));
  await runShareSender(req, res, {
    rackId, channel: 'outlook', pyModule: 'pipeline.outlook_send', email,
    extraArgs: extra,
  });
});

// Exported for in-process use (e.g. your Slack sender):
//   const { buildScanReport, buildScanReportData, renderHTMLReport,
//           renderJSONReport, renderCSVReport } = require('./app');
module.exports = module.exports || {};
module.exports.buildScanReport         = buildScanReport;
module.exports.buildScanReportPDF      = buildScanReportPDF;
module.exports.buildScanReportData     = buildScanReportData;
module.exports.writeCanonicalScanResult = writeCanonicalScanResult;
module.exports.renderHTMLReport        = renderHTMLReport;
module.exports.renderJSONReport        = renderJSONReport;
module.exports.renderCSVReport         = renderCSVReport;
module.exports.runSwitchCommandsSequential = runSwitchCommandsSequential;
module.exports.app                       = app;
// Test-only: lets tenant-isolation tests exercise the console path guard
// against the REAL function rather than a copy (a copy proves nothing about
// the shipped code — the mutation-testing lesson).
module.exports._internals = {
  consoleLogPath, saveConsoleTranscript, outputsDir,
  // Same reasoning for the console allowlist: the test must exercise the
  // function the route calls, not a reimplementation of it.
  isAllowedConsoleCommand, consoleCommandTemplates,
};

// ── User feedback on port identification ──────────────────────
const feedbackDir      = path.join(__dirname, 'feedback');
const feedbackWrongDir = path.join(feedbackDir, 'wrong');
const feedbackLogPath  = path.join(__dirname, 'feedback.jsonl');
[feedbackDir, feedbackWrongDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Right/wrong tally over feedback.jsonl, memoised on the file's size+mtime.
//
// The owner dashboard polls every 5 seconds and used to readFileSync + split +
// JSON.parse the entire log on every one of those polls, to produce two
// integers. Both readFileSync and better-sqlite3 are synchronous, so that work
// blocked the event loop — no other request was served while it ran, including
// scan uploads and the port poller's callbacks. The file is small today, but
// appendLineWithRotation only rotates at 50 MB, so the designed ceiling is a
// 50 MB linear scan several times a minute.
//
// Re-scanning only when the file actually changes reduces the steady-state
// cost to one statSync per poll. Keyed on size AND mtimeMs because an append
// within the same millisecond still moves the size.
let _fbTally = { key: null, right: 0, wrong: 0 };
function feedbackTally() {
  try {
    const st = fs.statSync(feedbackLogPath);
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === _fbTally.key) return _fbTally;

    let right = 0, wrong = 0;
    for (const line of fs.readFileSync(feedbackLogPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.is_correct === 'boolean') e.is_correct ? right++ : wrong++;
      } catch (_) { /* a torn final line is expected mid-append */ }
    }
    _fbTally = { key, right, wrong };
    return _fbTally;
  } catch (_) {
    // No log yet, or unreadable — report zeroes rather than failing the whole
    // dashboard for one statistic.
    return { key: null, right: 0, wrong: 0 };
  }
}

// ── Feedback override layer ──────────────────────────────────
// Reads server/feedback.jsonl for a given scan and overlays the user's
// `actual_*` corrections on top of the model's predictions in the scan
// result. Keeps a `_correction` audit trail so the original prediction
// is never lost.
//
// Applied during writeCanonicalScanResult, so the corrected values land
// in scan_result.json — every consumer (UI, exports, ServiceNow) sees
// the same overlaid view. Re-runs after every feedback POST because
// scheduleCanonicalRefresh fires after the audit.log success.
function _readFeedbackForScan(scanId) {
  if (!fs.existsSync(feedbackLogPath)) return [];
  let raw;
  try { raw = fs.readFileSync(feedbackLogPath, 'utf8'); }
  catch (err) {
    logger.warn(`[feedback_overlay] read failed for ${scanId}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.scanId === scanId && r.is_correct === false) out.push(r);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// A device's port-numbering offset from the user's LATEST renumber correction
// ONLY. Each correction SETS the offset (predicted_port is normalized to RAW
// model space at record time), so repeated corrections can't compound into a
// runaway shift the way summing every delta chronologically did. Returns the
// signed offset to add to a raw model port to get the user's number.
function _latestPortShift(rows, deviceIndex) {
  const pr = (rows || [])
    .filter(r => r.feedback_type === 'port'
      && Number(r.device_index) === Number(deviceIndex)
      && r.actual_port != null && r.predicted_port != null)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  if (!pr.length) return 0;
  const last = pr[pr.length - 1];
  return Number(last.actual_port) - Number(last.predicted_port);
}

// device_index -> { shift, ts } from the latest correction (for bulk report
// re-indexing). Iterating in timestamp order and overwriting means the last
// (most recent) correction wins — no summing.
function _latestPortShifts(rows) {
  const byDev = new Map();
  const pr = (rows || [])
    .filter(r => r.feedback_type === 'port' && r.actual_port != null && r.predicted_port != null)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  for (const r of pr) {
    byDev.set(Number(r.device_index), {
      shift: Number(r.actual_port) - Number(r.predicted_port),
      ts: r.timestamp,
    });
  }
  return byDev;
}

// Re-derive cable_type when the color changes. Heuristic: replace any
// known color word in the existing cable_type string. If we can't
// detect a color word, leave cable_type unchanged.
const _CABLE_COLOR_WORD = /\b(?:White|Black|Blue|Red|Green|Yellow|Grey|Gray|Brown|Orange|Purple|Pink)\b/i;
function _swapCableTypeColor(cableType, newColor) {
  if (!cableType || !newColor) return cableType;
  if (!_CABLE_COLOR_WORD.test(cableType)) return cableType;
  return cableType.replace(_CABLE_COLOR_WORD, newColor);
}

function applyFeedbackOverrides(scanId, payload) {
  if (!payload) return payload;
  const rows = _readFeedbackForScan(scanId);
  if (!rows.length) return payload;

  // Latest correction wins per (key). Keys differ by feedback_type:
  //  - port:       device_index + port_location signature
  //  - device:     device_index
  //  - port_count: device_index
  const latest = new Map();
  for (const r of rows) {
    const ft = r.feedback_type;
    let key = null;
    if (ft === 'port') key = `port:${r.device_index}:${(r.port_location || []).join(',')}`;
    else if (ft === 'device') key = `device:${r.device_index}`;
    else if (ft === 'port_count') key = `count:${r.device_index}`;
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || (r.timestamp || '') > (prev.timestamp || '')) latest.set(key, r);
  }

  // 1) selectedPort.port_info — the "Port Located" card the UI renders.
  const sp = payload.selectedPort;
  if (sp && sp.device_index != null && sp.port_info) {
    const pi = sp.port_info;
    const k = `port:${sp.device_index}:${(pi.location || []).join(',')}`;
    const fb = latest.get(k);
    if (fb) {
      const fields = [];
      const original = {};
      if (fb.actual_port != null && fb.actual_port !== pi.port_number) {
        original.port_number = pi.port_number;
        pi.port_number = fb.actual_port;
        fields.push('port_number');
      }
      if (fb.actual_cable_color && fb.actual_cable_color !== pi.cable_color) {
        original.cable_color = pi.cable_color;
        pi.cable_color = fb.actual_cable_color;
        fields.push('cable_color');
        const newType = _swapCableTypeColor(pi.cable_type, fb.actual_cable_color);
        if (newType && newType !== pi.cable_type) {
          original.cable_type = pi.cable_type;
          pi.cable_type = newType;
          fields.push('cable_type');
        }
      }
      if (fields.length) {
        pi._correction = { applied_at: fb.timestamp, source: 'user_feedback', fields, original };
      }
    }

    // selected_device.class_name from device-class feedback
    if (sp.selected_device) {
      const dfb = latest.get(`device:${sp.device_index}`);
      if (dfb && dfb.actual_device_class && dfb.actual_device_class !== sp.selected_device.class_name) {
        const original = { class_name: sp.selected_device.class_name };
        sp.selected_device.class_name = dfb.actual_device_class;
        sp.selected_device._correction = {
          applied_at: dfb.timestamp, source: 'user_feedback',
          fields: ['class_name'], original,
        };
      }
    }
  }

  // 2) devices[] — class_name (device feedback) + port_count (port-count feedback)
  for (const dev of payload.devices || []) {
    if (!dev || dev.index == null) continue;

    const dfb = latest.get(`device:${dev.index}`);
    if (dfb && dfb.actual_device_class && dfb.actual_device_class !== dev.class_name) {
      dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
      dev._correction.original.class_name = dev.class_name;
      dev._correction.fields.push('class_name');
      dev._correction.applied_at = dfb.timestamp;
      dev.class_name = dfb.actual_device_class;
    }

    const cfb = latest.get(`count:${dev.index}`);
    if (cfb && cfb.actual_port_count != null && cfb.actual_port_count !== dev.port_count) {
      dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
      dev._correction.original.port_count = dev.port_count;
      dev._correction.fields.push('port_count');
      dev._correction.applied_at = cfb.timestamp;
      dev.port_count = cfb.actual_port_count;
    }
  }

  // 3) Per-device port re-indexing from port-feedback corrections.
  //
  // When a user corrects a port number (e.g. "this is port 8, model said 2"),
  // they're anchoring one physical port at an absolute number. The same
  // shift applies to every other port the detector found on that device:
  // it just started counting at the wrong place.
  //
  //   shift = actual_port - predicted_port
  //
  // Positive shift  → model missed `shift` ports at the start of the row.
  //                   Every detection bumps up by `shift`. Device's
  //                   port_count grows by `shift` to make room.
  // Negative shift  → model emitted spurious detections before the actual
  //                   start of the port row. Drop the leading |shift|
  //                   detections; lower port_count by |shift|.
  //
  // The device's numbering offset comes from the user's LATEST renumber
  // correction only (predicted_port is stored raw, so each correction is an
  // absolute offset). This replaces the old chronological-sum, which let
  // repeated corrections compound into a runaway shift.
  const sortedPortRows = rows
    .filter(r => r.feedback_type === 'port' && r.actual_port != null && r.predicted_port != null)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const deviceShifts = _latestPortShifts(rows); // device_index -> { shift, ts }

  const idents = payload.port_identifications || [];
  const newIdents = [];
  for (const ident of idents) {
    if (!ident || ident.device_index == null) { newIdents.push(ident); continue; }
    const ds = deviceShifts.get(Number(ident.device_index));
    if (!ds || !ds.shift) { newIdents.push(ident); continue; }
    const newPort = ident.port + ds.shift;
    if (newPort <= 0) continue; // before actual start of port row — drop
    const fields = ['port'];
    const original = { port: ident.port };
    const shifted = { ...ident, port: newPort };

    // If the latest port-feedback row for this device matches THIS detection
    // (same original port number) and supplies a cable color, overlay it too.
    const matchingFb = sortedPortRows.findLast
      ? sortedPortRows.findLast(r => r.device_index === ident.device_index && r.predicted_port === ident.port)
      : [...sortedPortRows].reverse().find(r => r.device_index === ident.device_index && r.predicted_port === ident.port);
    if (matchingFb && matchingFb.actual_cable_color && matchingFb.actual_cable_color !== shifted.cable_color) {
      original.cable_color = shifted.cable_color;
      shifted.cable_color = matchingFb.actual_cable_color;
      fields.push('cable_color');
      const newType = _swapCableTypeColor(shifted.cable_type, matchingFb.actual_cable_color);
      if (newType && newType !== shifted.cable_type) {
        original.cable_type = shifted.cable_type;
        shifted.cable_type = newType;
        fields.push('cable_type');
      }
    }
    shifted._correction = {
      applied_at: ds.ts, source: 'user_feedback',
      fields, original, port_shift: ds.shift,
    };
    newIdents.push(shifted);
  }
  payload.port_identifications = newIdents;

  // Reflect the shift on each device's port_count so the picker / "port
  // 1-N" range reflects the corrected layout.
  for (const dev of payload.devices || []) {
    if (!dev || dev.index == null) continue;
    const ds = deviceShifts.get(Number(dev.index));
    if (!ds || !ds.shift) continue;
    if (typeof dev.port_count !== 'number') continue;
    const newCount = Math.max(0, dev.port_count + ds.shift);
    if (newCount === dev.port_count) continue;
    dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
    if (!('port_count' in (dev._correction.original || {}))) {
      dev._correction.original = dev._correction.original || {};
      dev._correction.original.port_count = dev.port_count;
    }
    if (!Array.isArray(dev._correction.fields)) dev._correction.fields = [];
    if (!dev._correction.fields.includes('port_count')) dev._correction.fields.push('port_count');
    dev._correction.applied_at = ds.ts;
    dev._correction.port_shift = ds.shift;
    dev.port_count = newCount;
  }

  return payload;
}

// ── Active-learning trigger ───────────────────────────────────
// Each feedback POST kicks off a fire-and-forget run_loop --once:
// ingest (cursor-tracked, idempotent) + threshold-check + retrain
// when ready. Deduped so a burst of feedback doesn't fan out into
// N concurrent subprocesses. The trainer itself runs in its own
// subprocess inside run_loop, so even a real retrain spike is
// isolated from the API server. Disable with ACTIVE_LEARNING_AUTOTRAIN=0.
let _activeLearningRunning = false;
let _activeLearningPending  = false;
function triggerActiveLearning(reason) {
  if (process.env.ACTIVE_LEARNING_AUTOTRAIN === '0') return;
  if (_activeLearningRunning) {
    // Coalesce: if a cycle is already running, mark that another
    // pass should kick off when the current one finishes. New rows
    // arriving mid-cycle aren't lost — they'll be picked up next.
    _activeLearningPending = true;
    return;
  }
  _activeLearningRunning = true;
  _activeLearningPending = false;
  const repoRoot = path.join(__dirname, '..');
  let child;
  try {
    child = require('child_process').spawn(
      pythonCmd,
      ['-m', 'retraining_learning.run_loop', '--once'],
      { cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true }
    );
  } catch (err) {
    _activeLearningRunning = false;
    logger.warn(`[active_learning] spawn threw: ${err.message}`);
    return;
  }
  logger.info(`[active_learning] cycle started (reason=${reason}, pid=${child.pid})`);
  child.on('exit', (code) => {
    _activeLearningRunning = false;
    logger.info(`[active_learning] cycle done (exit ${code})`);
    if (_activeLearningPending) {
      _activeLearningPending = false;
      setImmediate(() => triggerActiveLearning('coalesced'));
    }
  });
  child.on('error', (err) => {
    _activeLearningRunning = false;
    logger.warn(`[active_learning] failed to spawn: ${err.message}`);
  });
  child.unref();
}

async function cropBoxImage(rackId, box, destPath, padRatio = 0.25, minPad = 6) {
  if (!Array.isArray(box) || box.length !== 4) return false;
  const meta = readMeta(rackId);
  if (!meta?.imagePath || !fs.existsSync(meta.imagePath)) return false;

  const [x1, y1, x2, y2] = box.map(v => Math.round(Number(v)));
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return false;

  try {
    const image = sharp(meta.imagePath);
    const { width: imgW, height: imgH } = await image.metadata();
    const pad = Math.max(minPad, Math.round(Math.min(w, h) * padRatio));
    const left   = Math.max(0, x1 - pad);
    const top    = Math.max(0, y1 - pad);
    const right  = Math.min(imgW, x2 + pad);
    const bottom = Math.min(imgH, y2 + pad);
    await image
      .extract({ left, top, width: right - left, height: bottom - top })
      .png()
      .toFile(destPath);
    return true;
  } catch (err) {
    logger.error('cropBoxImage failed:', err.message);
    return false;
  }
}

app.post('/api/feedback', auth.requireAuth, async (req, res) => {
  const {
    scanId, device_index, predicted_port, is_correct,
    actual_port, actual_cable_color,
  } = req.body || {};

  if (!scanId || device_index == null || predicted_port == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, predicted_port, is_correct are required' });
  }
  if (!is_correct && actual_port == null && !actual_cable_color) {
    return res.status(400).json({
      error: 'When is_correct is false, supply at least one of actual_port, actual_cable_color',
    });
  }

  // Tenant guard: feedback endpoints take scanId in the BODY (not the path),
  // so the global app.param('rackId',...) doesn't fire here. Verify the
  // calling user's tenant owns this rack before letting them write feedback.
  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    logger.warn({ event: 'tenant.access_denied', tenantId: fbAuth?.tenantId ?? null,
      rackId: scanId, route: '/api/feedback' },
      `tenant ${fbAuth?.tenantId ?? 'anonymous'} blocked from feedback on rack ${scanId}`);
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir  = path.join(outputsDir, scanId);
  const infoPath = path.join(rackDir, 'selected_port_info.json');
  const fullData = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
  const portInfo = fullData.port_info || {};

  let deviceClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      deviceClass = dev?.class_name || null;
      deviceBox   = dev?.box || null;
    }
  } catch (_) {}

  const wrongFields = [];
  if (!is_correct) {
    if (actual_port != null)  wrongFields.push('port');
    if (actual_cable_color)   wrongFields.push('cable_color');
  }

  let portCropSavedAs = null;
  let deviceCropSavedAs = null;
  if (!is_correct) {
    const tag = wrongFields.length ? wrongFields.join('-') : 'unspecified';
    const base = `${scanId}_dev${device_index}_pred${predicted_port}_${tag}`;
    const portDest = path.join(feedbackWrongDir, `${base}_port.png`);
    if (await cropBoxImage(scanId, portInfo.location, portDest, 0.25, 6)) {
      portCropSavedAs = `${base}_port.png`;
    }
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  // Normalize the user-visible (already-shifted) predicted port back to RAW
  // model space, so this correction records an ABSOLUTE offset rather than
  // chaining onto the device's current shift. Then _latestPortShift can use
  // just the most recent correction and shifts can't compound.
  let predictedRaw = Number(predicted_port);
  if (!is_correct && actual_port != null) {
    try {
      const priorShift = _latestPortShift(_readFeedbackForScan(scanId), device_index);
      predictedRaw = Number(predicted_port) - priorShift;
    } catch (_) { /* fall back to raw = as-sent */ }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'port',
    scanId,
    device_index: Number(device_index),
    device_class: deviceClass,
    is_correct,
    wrong_fields: wrongFields,
    // Port index (RAW model space — see predictedRaw above)
    predicted_port: predictedRaw,
    actual_port: (is_correct || actual_port == null) ? null : Number(actual_port),
    // Cable color
    predicted_cable_color: portInfo.cable_color || null,
    actual_cable_color: is_correct ? null : (actual_cable_color || null),
    // Context
    port_status: portInfo.status || null,
    cable_color: portInfo.cable_color || null,
    cable_connector: portInfo.cable_connector || null,
    cable_type: portInfo.cable_type || null,
    port_location: portInfo.location || null,
    device_box: deviceBox,
    port_crop_image: portCropSavedAs,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'port' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'port', device_index: Number(device_index), is_correct } });
  scheduleCanonicalRefresh(scanId);
  triggerActiveLearning('port-feedback');

  // AL memory: persist pHash + ResNet18 embedding for the cable color so
  // future scans of similar cables auto-apply the corrected label.
  if (!is_correct && actual_cable_color && portCropSavedAs) {
    const cropPath = path.join(feedbackWrongDir, portCropSavedAs);
    fireMemoryCorrection('cable', cropPath,
      portInfo.cable_color || '', actual_cable_color,
      `${scanId}_dev${device_index}_port${predicted_port}`,
      softAuthPayload(req)?.organizationId || null);
  }

  res.json({ ok: true, port_crop_image: portCropSavedAs, device_crop_image: deviceCropSavedAs });
});

// POST /api/feedback/port-type
// Active-learning correction for a port's physical TYPE (RJ45 / SFP / QSFP /
// CONSOLE / AUX / MANAGEMENT_PORT / USB_A / USB_B / USB_C). Mirrors the cable
// path: crop the port, log to feedback.jsonl, and persist a pHash+embedding
// memory so future scans of the same port auto-apply the corrected type. The
// crop is filed under the corrected class so it also feeds retraining.
const PORT_TYPE_OPTIONS = [
  'RJ45', 'SFP', 'QSFP', 'CONSOLE', 'AUX', 'MANAGEMENT_PORT',
  'USB_A', 'USB_B', 'USB_C',
];
app.post('/api/feedback/port-type', auth.requireAuth, async (req, res) => {
  const {
    scanId, device_index, port,
    predicted_type = null, actual_type,
    port_location = null,
  } = req.body || {};

  if (!scanId || device_index == null) {
    return res.status(400).json({ error: 'scanId and device_index are required' });
  }

  // scanId is joined into an output path and into a written filename, and
  // path.join happily resolves "..". Validate the shape before it reaches the
  // filesystem — this holds even for callers canAccessRack still lets through.
  if (!/^RK-[A-Za-z0-9]{4,32}$/.test(String(scanId))) {
    return res.status(400).json({ error: 'Invalid scanId' });
  }

  // Ownership check, matching every sibling feedback route. This one was the
  // single /api/feedback/* endpoint that had none: it took scanId straight
  // from the body and joined it into an output path, so an unauthenticated
  // caller could probe for and write crops against any tenant's rack.
  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    return res.status(404).json({ error: `Rack ${scanId} not found` });
  }
  if (!actual_type || !PORT_TYPE_OPTIONS.includes(String(actual_type))) {
    return res.status(400).json({ error: `actual_type must be one of: ${PORT_TYPE_OPTIONS.join(', ')}` });
  }
  const rackDir = path.join(outputsDir, scanId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ error: `Rack ${scanId} not found` });
  }

  // Crop the port so the correction has an image to hash + file for retraining.
  let portCropSavedAs = null;
  if (Array.isArray(port_location) && port_location.length === 4) {
    const base = `${scanId}_dev${device_index}_port${port}_type-${actual_type}`;
    const dest = path.join(feedbackWrongDir, `${base}_port.png`);
    if (await cropBoxImage(scanId, port_location, dest, 0.25, 6)) {
      portCropSavedAs = `${base}_port.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'port_type',
    scanId,
    device_index: Number(device_index),
    port: port != null ? Number(port) : null,
    predicted_port_type: predicted_type || null,
    actual_port_type: String(actual_type),
    port_location: port_location || null,
    port_crop_image: portCropSavedAs,
  };
  try {
    appendLineWithRotation(feedbackLogPath, JSON.stringify(entry) + '\n');
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.error('port-type feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'port_type' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'port_type', device_index: Number(device_index), actual_type } });
  triggerActiveLearning('port-type-feedback');

  // AL memory: a re-scan of the same port will match this crop and apply
  // the corrected type. Org-scoped so it stays within the caller's org.
  if (portCropSavedAs) {
    const cropPath = path.join(feedbackWrongDir, portCropSavedAs);
    fireMemoryCorrection('port_type', cropPath,
      predicted_type || '', String(actual_type),
      `${scanId}_dev${device_index}_port${port}`,
      softAuthPayload(req)?.organizationId || null);
  }

  res.json({ ok: true, port_crop_image: portCropSavedAs, actual_type: String(actual_type) });
});

// POST /api/scan/:rackId/confirm-layout
// Mark a rack as CONFIRMED by the user. Registers the rack image's perceptual
// fingerprint → rackId so a later re-upload that matches serves this confirmed
// result instead of re-detecting it. "The user already fixed it — show that."
app.post('/api/scan/:rackId/confirm-layout', auth.requireAuth, async (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(path.join(rackDir, 'device_unit_map.json'))) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  // Prefer the original upload path (best fingerprint); fall back to the
  // stored original_image.* copy.
  let imagePath = null;
  try { imagePath = JSON.parse(fs.readFileSync(path.join(rackDir, 'scan_meta.json'), 'utf8'))?.imagePath; } catch (_) {}
  if (!imagePath || !fs.existsSync(imagePath)) {
    imagePath = ['original_image.jpg', 'original_image.png', 'original_image.jpeg']
      .map(f => path.join(rackDir, f)).find(f => fs.existsSync(f)) || null;
  }
  if (!imagePath) return res.status(400).json({ error: 'No source image to fingerprint' });

  try {
    const orgId = softAuthPayload(req)?.organizationId || null;
    const r = await runActiveLearningCli(
      { cmd: 'add_confirmed_rack', image_path: imagePath, rack_id: rackId, org_id: orgId }, 90000);
    audit.log({ req, action: 'scan.confirm_layout', status: 'ok', targetType: 'rack', targetId: rackId });
    logger.info({ event: 'scan.confirmed', rackId, phash: r?.confirmed?.phash }, `rack ${rackId} confirmed`);
    res.json({ ok: true, confirmed: r?.confirmed || null });
  } catch (err) {
    logger.error(`[confirm-layout] ${rackId}: ${err.message}`);
    audit.log({ req, action: 'scan.confirm_layout', status: 'fail', targetType: 'rack', targetId: rackId, error: err.message });
    res.status(500).json({ error: 'Failed to confirm layout' });
  }
});

// ── Device-only feedback ──────────────────────────────────────
// Independent of port/cable feedback. The user looks at a device's
// predicted class and either confirms it or supplies the actual class.
app.post('/api/feedback/device', auth.requireAuth, async (req, res) => {
  const { scanId, device_index, is_correct, actual_device_class } = req.body || {};

  if (!scanId || device_index == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, is_correct are required' });
  }
  if (!is_correct && !actual_device_class) {
    return res.status(400).json({ error: 'actual_device_class is required when is_correct is false' });
  }

  // Tenant guard (scanId is in body, not path)
  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir = path.join(outputsDir, scanId);

  let predictedClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      predictedClass = dev?.class_name || null;
      deviceBox      = dev?.box || null;
      // Persist the corrected class into device_unit_map.json so the picker
      // dropdown, Recent Scans and any re-open reflect it — not only the
      // result-overlay. Without this the change was purely cosmetic/session.
      if (dev && !is_correct && actual_device_class && actual_device_class !== dev.class_name) {
        if (!dev.class_name_original) dev.class_name_original = dev.class_name;
        dev.class_name = actual_device_class;
        dev.class_name_source = 'user_corrected';
        const tmp = mapPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
        fs.renameSync(tmp, mapPath);
      }
    }
  } catch (e) { logger.warn('device feedback: device_unit_map update failed: ' + e.message); }

  let deviceCropSavedAs = null;
  if (!is_correct) {
    const safeActual = String(actual_device_class).replace(/[^A-Za-z0-9_-]+/g, '_');
    const safePred   = String(predictedClass || 'Unknown').replace(/[^A-Za-z0-9_-]+/g, '_');
    const base = `${scanId}_dev${device_index}_devclass_${safePred}_to_${safeActual}`;
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'device',
    scanId,
    device_index: Number(device_index),
    is_correct,
    predicted_device_class: predictedClass,
    actual_device_class: is_correct ? null : actual_device_class,
    device_box: deviceBox,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('device feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'device' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'device', device_index: Number(device_index), is_correct } });
  scheduleCanonicalRefresh(scanId);
  triggerActiveLearning('device-feedback');

  // AL memory: persist pHash + ResNet18 embedding for the device class so
  // future scans of similar devices auto-apply the corrected label.
  if (!is_correct && actual_device_class && deviceCropSavedAs) {
    const cropPath = path.join(feedbackWrongDir, deviceCropSavedAs);
    fireMemoryCorrection('devices', cropPath,
      predictedClass || '', actual_device_class,
      `${scanId}_dev${device_index}`,
      softAuthPayload(req)?.organizationId || null);
  }

  res.json({ ok: true, device_crop_image: deviceCropSavedAs });
});

// ── Port-count feedback (main ports detected per device) ──────
// Independent of device-class and port/cable feedback. The user
// confirms how many main ports the model detected for the selected
// device, or supplies the actual count.
app.post('/api/feedback/port-count', auth.requireAuth, async (req, res) => {
  const { scanId, device_index, is_correct, actual_port_count } = req.body || {};

  if (!scanId || device_index == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, is_correct are required' });
  }
  const actualNum = actual_port_count == null ? null : Number(actual_port_count);
  if (!is_correct && (actualNum == null || isNaN(actualNum) || actualNum < 0)) {
    return res.status(400).json({ error: 'actual_port_count is required (>= 0) when is_correct is false' });
  }

  // Tenant guard (scanId is in body, not path)
  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir = path.join(outputsDir, scanId);
  let predictedCount = null;
  let deviceClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      predictedCount = typeof dev?.port_count === 'number' ? dev.port_count : null;
      deviceClass    = dev?.class_name || null;
      deviceBox      = dev?.box || null;
    }
  } catch (_) {}

  let deviceCropSavedAs = null;
  if (!is_correct) {
    const safePred = predictedCount == null ? 'na' : String(predictedCount);
    const base = `${scanId}_dev${device_index}_portcount_${safePred}_to_${actualNum}`;
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'port_count',
    scanId,
    device_index: Number(device_index),
    device_class: deviceClass,
    is_correct,
    predicted_port_count: predictedCount,
    actual_port_count: is_correct ? null : actualNum,
    device_box: deviceBox,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('port-count feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'port_count' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'port_count', device_index: Number(device_index), is_correct, actual_port_count: actualNum } });
  triggerActiveLearning('port-count-feedback');

  // If the user supplied an actual count, re-run port detection for this
  // device with that target so the device's port_count reflects ground truth.
  let relabel = null;
  if (!is_correct && actualNum != null) {
    try {
      const r = await runRelabelPortCount(rackDir, Number(device_index), actualNum);
      if (r?.ok) {
        relabel = {
          ok: true,
          device_index: r.device_index,
          new_port_count: r.port_count,
          device: r.device,
        };
      } else {
        relabel = { ok: false, error: r?.error || 'relabel failed' };
      }
    } catch (err) {
      logger.error('relabel_port_count failed:', err.message);
      relabel = { ok: false, error: err.message };
    }
  }

  // Refresh canonical scan_result.json after both the feedback append and any
  // port-count relabel mutation to device_unit_map.json.
  scheduleCanonicalRefresh(scanId);
  res.json({
    ok: true,
    device_crop_image: deviceCropSavedAs,
    relabel,
  });
});

// ════════════════════════════════════════════════════════════════════
// Active-learning memory layer (cable/device corrections + verified
// port store). Wraps pipeline/active_learning/cli.py via subprocess.
// Memory is additive: existing JSONL feedback still written; this
// extra write enables auto-apply on future scans and a model-bypass
// verified store for ports.
// ════════════════════════════════════════════════════════════════════
function runActiveLearningCli(payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pyBin = resolvePythonBin();
    const child = spawn(pyBin, ['-m', 'pipeline.active_learning.cli'], {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '', stderr = '';
    const t = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error(`AL CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(t); reject(err); });
    child.on('close', code => {
      clearTimeout(t);
      const lastLine = stdout.trim().split('\n').pop() || '';
      let parsed = null;
      try { parsed = JSON.parse(lastLine); } catch (_) {}
      if (!parsed) return reject(new Error(`AL CLI parse error (exit ${code}): ${stderr.slice(-400) || stdout.slice(-400)}`));
      if (parsed.ok === false) return reject(new Error(parsed.error || 'AL CLI failed'));
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Fire-and-forget memory write. Used by the existing feedback endpoints
// so they keep their fast user-visible response while AL embeds in the
// background. Logs failures but never throws.
function fireMemoryCorrection(model, imagePath, predLabel, finalLabel, sourceName, orgId = null) {
  if (!imagePath || !fs.existsSync(imagePath)) return;
  runActiveLearningCli({
    cmd: 'add_correction',
    model, image_path: imagePath,
    pred_label: predLabel || '',
    final_label: finalLabel,
    source_name: sourceName || path.basename(imagePath),
    org_id: orgId,   // org-scoped: correction saved into the org's AL partition
  }).then(r => {
    logger.info({ event: 'al.correction_saved', model, phash: r.record?.phash,
                  source: sourceName }, `AL memory saved (${model})`);
  }).catch(err => {
    logger.warn({ event: 'al.correction_failed', model, error: err.message }, 'AL memory write failed');
  });
}

// POST /api/feedback/port/verified
// Save a user-verified port layout. From this point on, any upload of
// the same (or visually-similar) image returns this layout and skips
// the YOLO port model entirely.
app.post('/api/feedback/port/verified', auth.requireAuth, async (req, res) => {
  const { scanId, ports, img_w, img_h, image_name } = req.body || {};
  if (!scanId || !Array.isArray(ports) || ports.length === 0) {
    return res.status(400).json({ error: 'scanId and ports[] are required' });
  }

  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir = path.join(outputsDir, scanId);
  const imgPath = path.join(rackDir, 'original_image.jpg');
  if (!fs.existsSync(imgPath)) {
    return res.status(400).json({ error: 'original_image.jpg missing for this scan' });
  }

  try {
    const r = await runActiveLearningCli({
      cmd: 'save_verified_ports',
      image_path: imgPath,
      image_name: image_name || `${scanId}.jpg`,
      ports,
      img_w: Number(img_w) || 0,
      img_h: Number(img_h) || 0,
    }, 120000);
    audit.log({ req, action: 'feedback.verified_ports', status: 'ok',
                targetType: 'rack', targetId: scanId,
                payload: { n_ports: ports.length, phash: r.saved?.phash } });
    res.json({ ok: true, ...r.saved });
  } catch (err) {
    logger.error({ event: 'al.save_verified_failed', scanId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/port/verified/check
// Look up whether the given scan's original image has a saved verified
// port layout. Used by PortsPage to show a VERIFIED badge.
app.post('/api/feedback/port/verified/check', auth.requireAuth, async (req, res) => {
  const { scanId } = req.body || {};
  if (!scanId) return res.status(400).json({ error: 'scanId required' });

  const fbAuth = softAuthPayload(req);
  if (!canAccessRack(fbAuth, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const rackDir = path.join(outputsDir, scanId);
  const imgPath = path.join(rackDir, 'original_image.jpg');
  if (!fs.existsSync(imgPath)) return res.json({ ok: true, verified: null });

  try {
    const r = await runActiveLearningCli({
      cmd: 'find_verified_ports', image_path: imgPath,
    }, 60000);
    res.json({ ok: true, verified: r.verified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/port-poller/reset
// Manual "unstick" for the SSH port-state poller. Clears backoff +
// failure counter for one device (body: { deviceId }) or every device
// (no body) and triggers an immediate poll cycle. Use this when the
// poller is parked in a 30-min backoff window because of a half-open
// SSH session and you don't want to wait for the next interval / a
// server restart / a switch reboot.
app.post('/api/port-poller/reset', auth.requireRole('owner', 'org_admin'), async (req, res) => {
  const deviceId = req.body?.deviceId != null ? Number(req.body.deviceId) : null;
  try {
    const portPoller = require('./lib/port_poller');
    const result = await portPoller.forceReset({ deviceId });
    audit.log({ req, action: 'port_poller.reset', status: 'ok',
                payload: { deviceId, cleared: result.cleared } });
    res.json({ ok: true, ...result, scope: deviceId != null ? 'device' : 'all' });
  } catch (err) {
    logger.error({ event: 'port_poller.reset_failed', err: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/feedback/memory/stats
// Aggregate counts across cable / device corrections + verified ports.
app.get('/api/feedback/memory/stats', auth.requireAuth, async (req, res) => {
  try {
    const r = await runActiveLearningCli({ cmd: 'stats' }, 60000);
    res.json({ ok: true, ...r.stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feedback/stats', auth.requireAuth, (req, res) => {
  if (!fs.existsSync(feedbackLogPath)) {
    return res.json({ total: 0, correct: 0, wrong: 0, accuracy: null, by_device_class: {} });
  }
  try {
    const lines = fs.readFileSync(feedbackLogPath, 'utf8').split('\n').filter(Boolean);
    const byCls = {};
    let total = 0, correct = 0;
    for (const ln of lines) {
      let e;
      try { e = JSON.parse(ln); } catch { continue; }
      total += 1;
      if (e.is_correct) correct += 1;
      const cls = e.device_class || 'Unknown';
      if (!byCls[cls]) byCls[cls] = { total: 0, correct: 0 };
      byCls[cls].total += 1;
      if (e.is_correct) byCls[cls].correct += 1;
    }
    res.json({
      total,
      correct,
      wrong: total - correct,
      accuracy: total ? correct / total : null,
      by_device_class: byCls,
    });
  } catch (err) {
    logger.warn({ event: 'feedback.scoreboard_failed', err: err.message });
    res.status(500).json({ error: 'scoreboard failed' });
  }
});

app.get(/^\/(?!api|uploads|outputs).*/, (req, res, next) => {
  // SPA fallback for client-side routes ONLY. A request that looks like a file
  // (has an extension, e.g. /assets/TopologyScene3D-abc.js) must NOT fall back
  // to index.html — express.static already served it if it exists, so reaching
  // here means it's MISSING (e.g. a stale hashed chunk after a rebuild). Return
  // 404 so the browser fails cleanly and can reload, instead of getting HTML
  // where it expects a JS module ("Load failed" on a dynamic import).
  if (path.extname(req.path)) return next();
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

// Global error handler — must be installed AFTER all routes/middleware so
// it catches anything that throws or calls next(err). Logs with full
// context (requestId, route, stack) and returns a sanitized JSON body.
app.use(o11y.errorHandler);

// Only bind the port when run directly (`node app.js` / `npm start`). Loading
// app.js as a module (tests, scripts, in-process tools like buildScanReportPDF)
// must not start a second listener.
if (require.main === module) {
  // Bind with retry-on-EADDRINUSE. The previous implementation created a fresh
  // server inside setTimeout without re-attaching the 'error' handler — a second
  // EADDRINUSE then crashed the process via an unhandled 'error' event. Wrap
  // listen() so every attempt has the same handler, and retry indefinitely
  // (a stale dev process usually clears within seconds).
  let server;
  let attempt = 0;
  const MAX_ATTEMPTS = 20;
  const tryListen = () => {
    attempt += 1;
    server = app.listen(PORT, () => {
      o11y.logBootBanner({ port: PORT, workers: WORKER_COUNT });
      logger.info({
        event: 'server.listening',
        attempt, outputsDir, workers: WORKER_COUNT,
      }, `listening on :${PORT}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
      // Loud on purpose. Serving invented network data as though it were
      // measured is the kind of thing that must never be discovered later.
      // Scope matters in this line: only the Netdisco seam is seeded. The Lab
      // page and the Live Network Switch page always talk to real switches over
      // SSH, in every mode.
      const demoData = require('./lib/demo_data');
      if (demoData.enabled) {
        logger.warn({ event: 'demo_data.enabled', devices: demoData.devices.length },
          'RACKTRACK_DEMO_DATA is ON — the Netdisco device inventory is ' +
          'answering from seeded fixtures, NOT from a real Netdisco. The Lab ' +
          'and live-switch screens are unaffected and still require real SSH');
      }
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
        logger.warn({
          event: 'server.eaddrinuse',
          port: PORT, attempt, maxAttempts: MAX_ATTEMPTS,
        }, `port ${PORT} in use, retrying in 3s`);
        setTimeout(tryListen, 3000);
        return;
      }
      logger.fatal({
        event: 'server.listen_failed',
        err: err.code || err.message,
      }, 'listen failed');
      process.exit(1);
    });
  };
  tryListen();

  // Start the port-state poller. Inject runSwitchCommandsSequential so
  // it can reuse the same persistent-SSH path the console feature uses;
  // it polls every monitored_devices row marked enabled=1, parses the
  // output, and writes snapshot + change events into auth.db.
  try {
    const portPoller = require('./lib/port_poller');
    const intervalMs = Number(process.env.PORT_POLL_INTERVAL_MS) || 3_600_000; // 1h — see port_poller DEFAULT_INTERVAL_MS
    portPoller.start({ intervalMs, sshRunner: runSwitchCommandsSequential });
  } catch (err) {
    logger.warn({ event: 'port_poller.start_failed', err: err.message },
      'port poller did not start');
  }

  const gracefulShutdown = async (signal) => {
    logger.info({ event: 'server.shutdown', signal },
      `${signal} received — stopping workers and HTTP server`);
    // Drain in-flight SSH polls so we don't leave half-open sessions
    // on the switch's side (which would otherwise refuse the next
    // connection until the switch is rebooted).
    try { await require('./lib/port_poller').stop({ drainTimeoutMs: 8000 }); }
    catch (_) {}
    if (server) {
      try { server.close(); } catch (_) {}
    }
    pool.shutdown().finally(() => {
      logger.info({ event: 'server.shutdown_done' }, 'workers stopped, exiting');
      process.exit(0);
    });
    // Hard ceiling so a wedged worker / open socket can't block forever.
    // Overridable via SHUTDOWN_TIMEOUT_MS; default 30s gives long pipelines
    // a fair chance to finish before SIGKILL.
    const _shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000;
    setTimeout(() => {
      logger.warn({ event: 'server.shutdown_forced', timeoutMs: _shutdownTimeoutMs },
        'graceful shutdown timeout — forcing exit');
      process.exit(1);
    }, _shutdownTimeoutMs).unref();
  };
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
