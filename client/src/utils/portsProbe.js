// Singleton SSH probe of the user's network switch.
//
// Triggered at scan-start (parallel to CV) and the result is cached in
// localStorage so subsequent visits to the Available Ports page show the
// last-known state instantly without re-probing. Re-fires only when:
//   - a new scan starts (ScanPage calls triggerBackgroundProbe)
//   - the user clicks Retry (force: true)
//
// Independent of the LLDP "find the other end of this cable" feature —
// different consumer, same encrypted credentials path on the server.
import { apiUrl, authFetch } from './api';
import { getItem, setItem, removeItem } from './safeStorage';

const STORAGE_KEY = 'racktrack:portsProbe';

function loadFromStorage() {
  try {
    const raw = getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.status === 'ok' && Array.isArray(data.ports)) return data;
    return null;
  } catch (_) { return null; }
}
function saveToStorage(s) {
  try {
    if (s?.status === 'ok') setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (_) { /* quota / disabled */ }
}

const cached = loadFromStorage();
const state = cached || {
  status: 'idle',     // 'idle' | 'running' | 'ok' | 'error'
  ports: null,        // [{ iface, status, description }]
  error: null,
  host: null,
  startedAt: null,
  finishedAt: null,
};
const subs = new Set();

function notify() { for (const fn of subs) { try { fn({ ...state }); } catch (_) {} } }
function setState(patch) { Object.assign(state, patch); saveToStorage(state); notify(); }

export function getProbeState() { return { ...state }; }
export function subscribeProbe(fn) {
  subs.add(fn);
  try { fn({ ...state }); } catch (_) {}
  return () => subs.delete(fn);
}
export function resetProbe() {
  try { removeItem(STORAGE_KEY); } catch (_) {}
  setState({ status: 'idle', ports: null, error: null, host: null, startedAt: null, finishedAt: null });
}

// Parse `show interface status` rows. Tolerant to TP-Link / Cisco-ish layouts.
function parseInterfaceStatusTable(text) {
  if (!text) return [];
  // Strip null bytes and paging prompts that remain after --More-- auto-advance.
  // TP-Link emits: "Press any key to continue (Q to quit)\0<spaces><next line>".
  // Convert \0 to \n so the data after the prompt becomes its own row, then
  // strip ONLY the prompt text (plus trailing tabs/spaces) — never eat to the
  // next \n, or we lose the port row that sits on the same line as the prompt
  // (the "27 of 28" bug: Gi1/0/23 vanished because the server-side cleanup
  // missed an edge case and this regex devoured the row).
  const cleaned = text
    .replace(/\x00/g, '\n')
    .replace(/Press any key to continue(?:\s*\(Q to quit\))?[ \t]*/gi, '')
    .replace(/--More--[ \t]*/g, '')
    .replace(/<--- More --->[ \t]*/g, '');
  const out = [];
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    if (/^port\b/i.test(line)) continue;
    if (/^-+\s*$/.test(line)) continue;
    if (/^\s*Total/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.*))?$/);
    if (!m) continue;
    const iface = m[1];
    if (!/^([A-Za-z]{1,4}\d+(\/\d+){0,3}|Eth\d+(\/\d+)?)$/i.test(iface)) continue;
    out.push({
      iface,
      status: (m[2] || '').toLowerCase(),
      medium: (m[6] || '').trim().toLowerCase(),   // 'copper' | 'fiber' | ''
      description: (m[7] || '').trim(),
    });
  }
  return out;
}
export { parseInterfaceStatusTable };

// Translate raw ssh2 / network error strings into something a technician can
// act on. The switch-side SSH stack surfaces terse messages ("Not connected")
// that read as a bug when they're really "the switch dropped the session" —
// which a Retry usually clears now that the server does a full reconnect.
function friendlyProbeError(msg) {
  const m = (msg || '').toLowerCase();
  if (/closed by the switch|session closed/.test(m))
    return 'The switch accepted the login but closed the session - the saved switch account may not have CLI access. Check the switch credentials.';
  if (/not connected|econnreset|epipe|unable to open shell|channel open failure/.test(m))
    return 'Lost the SSH session to the switch - it may limit simultaneous connections. Try again in a moment.';
  if (/timed out|etimedout|ehostunreach|enetunreach/.test(m))
    return 'The switch didn’t respond. Check you’re on the same network as the switch, then try again.';
  if (/auth|denied|permission|all configured authentication/.test(m))
    return 'The switch rejected the saved credentials.';
  if (/econnrefused/.test(m))
    return 'The switch refused the connection - is SSH enabled on it?';
  return msg;
}
export { friendlyProbeError };

export function logicalVerdict(row) {
  const s = (row.status || '').toLowerCase();
  const hasDesc = !!(row.description && row.description.trim());
  if (/(linkup|connected|^up$)/i.test(s)) return 'used';
  if (/(err|disable|shutdown|admin)/i.test(s)) return 'reserved';
  return hasDesc ? 'reserved' : 'available';
}

let inflight = false;

// Idempotent: if a probe is already running or finished successfully, this
// returns immediately. Pass `force: true` to re-probe (e.g. user-pressed Retry).
export async function triggerBackgroundProbe({ force = false } = {}) {
  if (!force) {
    if (state.status === 'ok' || state.status === 'running') return;
  }
  if (inflight) return;
  inflight = true;
  setState({ status: 'running', error: null, startedAt: Date.now(), finishedAt: null });

  // Watchdog: the request itself has no built-in timeout, and the server
  // serializes SSH per host — so a busy switch (or a live poller holding the
  // host lock) can leave this request open indefinitely, hanging the loader
  // forever. Abort after a hard ceiling so the UI always resolves to an
  // actionable error + Retry instead of spinning. Ceiling is set above the
  // server-side command timeout so a normal failure surfaces its real reason
  // first, and the watchdog only catches a genuine stall.
  const SERVER_TIMEOUT_MS = 30000;
  const WATCHDOG_MS = 38000;
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);

  try {
    // Resolve the switch host as an ORDERED candidate list so a stale/changed
    // IP self-heals with NO user action. The bench switch DHCP-flaps between
    // .14 and .33; if the last-used address is dead we automatically try the
    // server-remembered host and the configured default before giving up.
    // NEVER the gateway — that's not the switch.
    //
    // This used to be the literal '192.168.1.33'. Baked into every build, that
    // meant a deployment with no route to the office — the public demo — spent
    // its first probe dialling an address that could not exist there, and then
    // printed that private IP on screen as the switch's "Mgmt IP". Configure it
    // per deployment; unset simply drops the candidate.
    const FALLBACK_SWITCH_HOST = import.meta.env.VITE_FALLBACK_SWITCH_HOST || null;
    let resolved = null;
    try {
      const hr = await authFetch(apiUrl('/api/switch/default-host'));
      const hj = hr.ok ? await hr.json() : null;
      // last_host (this user has probed it before) → registered_host (an
      // operator registered it in monitored_devices, scoped to Sites this user
      // can see). Still NEVER `suggested`, which can fall through to the
      // gateway, and never the gateway itself — a router is not a switch.
      resolved = hj?.last_host || hj?.registered_host || null;
    } catch (_) { /* ignore — fall through to defaults */ }
    const candidates = [...new Set([
      force ? null : state.host,   // host that worked earlier this session
      resolved,                    // server-remembered last_host
      FALLBACK_SWITCH_HOST,        // in-office default
    ].filter(Boolean))];

    // Per-attempt timeout kept short so a dead address fails fast and the next
    // candidate is tried well within the watchdog ceiling.
    const PER_TRY_MS = 10000;
    let lastErr = null;
    for (const host of candidates) {
      try {
        const r = await authFetch(apiUrl('/api/switch/console/run'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            host,
            command: 'show interface status',
            vendor: 'tplink',
            timeoutMs: PER_TRY_MS,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        const entry = data.entry || {};
        if (entry.error) throw new Error(entry.error);
        const parsed = parseInterfaceStatusTable(entry.output || '');
        if (parsed.length === 0) throw new Error('Probe returned no port rows.');
        setState({ status: 'ok', ports: parsed, host, finishedAt: Date.now() });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;   // watchdog fired — stop
        lastErr = err;                               // dead host — try the next
      }
    }
    throw (lastErr || new Error('No network switch host configured.'));
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    setState({
      status: 'error',
      host: null,   // drop the cached host so the next probe re-resolves cleanly
      error: aborted
        ? 'The switch didn’t respond in time. Check you’re on the same network as it, then try again.'
        : friendlyProbeError(err.message || String(err)),
      finishedAt: Date.now(),
    });
  } finally {
    clearTimeout(watchdog);
    inflight = false;
  }
}
