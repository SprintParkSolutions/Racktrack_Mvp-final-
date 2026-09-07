// Port-state poller.
//
// On a fixed interval (default 1h), SSHes into every enabled row in
// monitored_devices that's not in a backoff window, runs the vendor's
// "hot" commands, parses the output, and feeds each per-port row to
// port_history_db.writePoll — which handles diff vs the prior snapshot
// and atomic write of snapshot + change events. Drives the
// "what changed when" timeline.
//
// Concurrency is bounded (default 4) so scaling to dozens of devices
// doesn't open dozens of simultaneous SSH sessions. Each device also has
// a per-process busy guard preventing overlapping polls (slow one device
// won't drop ticks for another), and an SQLite-backed exponential-backoff
// window so a permanently-dead host retries on a sane cadence rather
// than every interval.
//
// A retention sweep runs alongside polling (default every hour) to keep
// the SQLite file from growing unbounded.
//
// Public API: start({intervalMs, sshRunner}) → stop()

const { logger } = require('./observability');
const sshCreds   = require('./ssh-creds');
const portsDb    = require('./port_history_db');
const tplink     = require('./tplink_parser');
const cisco      = require('./cisco_parser');

// Hourly, NOT every 60s. The Ports page reads stored snapshots, so it does not
// need a live SSH pass to render — it shows the last known state either way.
// Only drift detection and the Lab view actually care about fresh polls, and
// hourly granularity is enough for both.
//
// The 60s default was actively harmful: these switches (TP-Link JetStream, IOL)
// allow ONE SSH session, and they don't free it when the TCP connection drops —
// only on idle timeout. Polling every minute meant the poller was holding that
// single session most of the time, so a user's manual probe or an audit had to
// fight it for access, and a burst of retries could saturate the switch until
// it was rebooted. An hour between passes leaves the session free for the
// interactive paths that need it. Override with PORT_POLL_INTERVAL_MS.
const DEFAULT_INTERVAL_MS    = 3_600_000;
const DEFAULT_CONCURRENCY    = 4;
const DEFAULT_RETENTION_MS   = 60 * 60_000;  // sweep every hour
const DEFAULT_EVENT_DAYS     = 30;
const DEFAULT_SNAPSHOT_DAYS  = 90;

// Per-vendor recipe: the SSH command runner needs (enable, paging_off,
// commands list) and the parser turns raw outputs → per-port rows + a
// device-meta blob (from `show system-info`). Keep this self-contained
// so adding new vendors is a copy-paste — drop a new entry here, no
// other file needs to change.
const VENDOR_RECIPES = {
  tplink: {
    enable:    'enable',
    pagingOff: 'disable pager',
    commands: [
      { key: 'sysinfo', cmd: 'show system-info' },
      { key: 'status',  cmd: 'show interface status' },
      { key: 'config',  cmd: 'show interface configuration' },
      // All-port LLDP in one shot — much cheaper than 28 per-port calls.
      // A neighbor change here lets the diff path emit drift events on
      // lldp_chassis / lldp_port / lldp_system (catches cable reroutes
      // that don't affect oper/speed).
      { key: 'lldp',    cmd: 'show lldp neighbor-information' },
    ],
    parse(outputs) {
      const status = tplink.parseInterfaceStatus(outputs.status || '');
      const config = tplink.parseInterfaceConfiguration(outputs.config || '');
      const lldp   = tplink.parseLldpNeighbors(outputs.lldp || '');
      const meta   = tplink.parseSystemInfo(outputs.sysinfo || '');
      return { rows: tplink.mergePortRows(status, config, lldp), meta };
    },
  },
  // Key matches the 'cisco-ios' spelling app.js already uses for VENDORS
  // and AUDIT_CMDS — see normalizeVendor() for the legacy underscore form.
  'cisco-ios': {
    enable:    'enable',
    pagingOff: 'terminal length 0',
    commands: [
      { key: 'sysinfo', cmd: 'show version' },
      { key: 'status',  cmd: 'show interfaces status' },
      { key: 'config',  cmd: 'show running-config | section interface' },
      // LLDP is off by default on IOS (`lldp run`) and the IOL l2-ipbase
      // image may not support it at all — CDP is the Cisco default. The
      // parser returns an empty map for unsupported/absent output rather
      // than throwing, so a switch without LLDP still polls fine; it just
      // never emits lldp_* drift events.
      { key: 'lldp',    cmd: 'show lldp neighbors detail' },
    ],
    parse(outputs) {
      const status = cisco.parseInterfaceStatus(outputs.status || '');
      const config = cisco.parseInterfaceConfiguration(outputs.config || '');
      const lldp   = cisco.parseLldpNeighbors(outputs.lldp || '');
      const meta   = cisco.parseSystemInfo(outputs.sysinfo || '');
      return { rows: cisco.mergePortRows(status, config, lldp), meta };
    },
  },
};

// The DB's vendor column is free text and predates the recipe table, so a
// row may carry the older 'cisco_ios' spelling. Fold it onto the canonical
// hyphenated key rather than keeping two entries in sync.
// Fold legacy and matrix spellings onto the canonical key of the exact recipe,
// so a device stored as 'cisco-systems' (the matrix's name) resolves to the
// hand-written 'cisco-ios' parser rather than the generic fallback.
const VENDOR_ALIASES = {
  cisco_ios: 'cisco-ios',
  'cisco-systems': 'cisco-ios',
  'tp-link': 'tplink',
};
function normalizeVendor(v) {
  const key = String(v || '').trim();
  return VENDOR_ALIASES[key] || key;
}

// A hand-written recipe (exact port parsing) always wins. For the ~50 other
// vendors in the verified Switch_CLI matrix, fall back to a generic recipe:
// their real commands run and identity is parsed, but no port rows are guessed.
// See generic_recipe.js.
const genericRecipes = require('./generic_recipe');
function resolveRecipe(vendor) {
  return VENDOR_RECIPES[vendor] || genericRecipes.buildGenericRecipe(vendor) || null;
}

// Every vendor the poller can drive: exact ones first, then matrix vendors.
// A matrix vendor whose spelling folds onto an exact recipe (cisco-systems →
// cisco-ios) is skipped so it does not appear twice.
const EXACT_LABELS = { 'cisco-ios': 'Cisco IOS', tplink: 'TP-Link' };
function supportedVendors() {
  const seen = new Map();
  for (const key of Object.keys(VENDOR_RECIPES)) {
    seen.set(key, { key, label: EXACT_LABELS[key] || VENDOR_RECIPES[key].label || key, parser: 'exact' });
  }
  for (const { key, label } of genericRecipes.matrixVendors()) {
    if (seen.has(key)) continue;
    if (VENDOR_RECIPES[normalizeVendor(key)]) continue;   // folds onto an exact recipe
    seen.set(key, { key, label, parser: 'generic' });
  }
  return [...seen.values()];
}

let _timer = null;
let _retentionTimer = null;
let _runSwitchCommandsSequential = null;
let _busy = new Set();   // device-ids currently mid-poll, prevents overlap

// Hosts a user is actively probing by hand. Small managed switches (TP-Link
// JetStream, etc.) allow only ONE SSH session, so a manual probe and this
// background poller fighting over it makes the switch close sessions. When a
// manual probe runs, it calls noteManualProbe(host); the poller then yields
// that host for a cooldown window so the user's session gets the switch alone.
const _manualProbeUntil = new Map();  // host -> epoch ms until which to yield
const MANUAL_PROBE_YIELD_MS = 60_000;
function noteManualProbe(host, ms = MANUAL_PROBE_YIELD_MS) {
  if (!host) return;
  _manualProbeUntil.set(String(host), Date.now() + ms);
}
function isManualProbeActive(host) {
  const until = _manualProbeUntil.get(String(host));
  return !!until && Date.now() < until;
}

// app.js owns the SSH runner — inject it on start() to avoid a require
// cycle (app.js itself loads this module indirectly via the router).
function setSshRunner(fn) { _runSwitchCommandsSequential = fn; }

function isBusy(deviceId) { return _busy.has(deviceId); }

async function _pollSnmpDevice(device) {
  // Resolved here rather than at the top of the file: these pull in the
  // NetBox side (switch store, reader, collector), which the SSH poller has
  // no other reason to load.
  const switches = require('./netbox/switches');
  const { readSwitch } = require('./netbox/reader');
  const { feedDrift } = require('./netbox/drift_feed');

  const rec = switches.list().find((s) => s.host === device.host);
  if (!rec) {
    logger?.warn?.(`[port_poller] ${device.host} is filed by SNMP but has no switch record — skipping`);
    portsDb.touchPolled(device.id);
    return;
  }
  const r = await readSwitch(rec.id);
  if (!r.ok) {
    // Not reachable from here is the ordinary case for this server, not a
    // fault in the switch: the phone standing next to the rack reads it.
    const { failures, backoffUntil } = portsDb.recordPollFailure(device.id, r.error);
    logger?.info?.(`[port_poller] SNMP read of ${device.host} failed (failures=${failures}, backoff until ${backoffUntil}): ${r.error}`);
    return;
  }
  feedDrift(rec, r.data, { tenantId: device.tenant_id ?? null });
  portsDb.recordPollSuccess(device.id);
  // This server CAN reach it. Let the background sweep keep it fresh from
  // now on; a later failure enters the same backoff ladder as any device.
  if (!device.enabled) portsDb.setEnabled(device.id, 1);
}

async function pollDevice(device) {
  if (_busy.has(device.id)) return; // previous poll still in flight
  // Yield the switch to an in-progress manual probe — don't fight for its
  // single SSH session. We'll pick it up on the next cycle.
  if (isManualProbeActive(device.host)) return;
  _busy.add(device.id);
  try {
    return await _pollDeviceInner(device);
  } finally {
    _busy.delete(device.id);
  }
}

async function _pollDeviceInner(device) {
  const vendor = normalizeVendor(device.vendor);

  // A switch filed by SNMP has no SSH recipe and never will. Poll it the way it
  // was read: over SNMP, with the credentials the Network step stored for it.
  // This works exactly when the server can reach the switch — a local install
  // on the customer's network — and fails honestly when it cannot, which is
  // the demo server's position and the reason the phone reads them at all.
  if (vendor === 'snmp') return _pollSnmpDevice(device);

  const recipe = resolveRecipe(vendor);
  if (!recipe) {
    logger?.warn?.(`[port_poller] no recipe for vendor=${device.vendor}, skipping ${device.host}`);
    portsDb.touchPolled(device.id);
    return;
  }
  if (!_runSwitchCommandsSequential) {
    logger?.warn?.(`[port_poller] SSH runner not injected — skipping ${device.host}`);
    return;
  }
  // Per-host creds win over per-vendor, so same-vendor switches with different
  // passwords each get their own. Merge so a host entry lacking enablePassword
  // still inherits the vendor's.
  const hostCreds = sshCreds.getForHost(device.host);
  const creds = hostCreds
    ? { ...(sshCreds.getForVendor(vendor) || {}), ...hostCreds }
    : sshCreds.getForVendor(vendor);
  if (!creds || !creds.username) {
    logger?.warn?.(`[port_poller] no SSH creds for vendor=${device.vendor}, skipping ${device.host}`);
    // No creds isn't a transient SSH failure — don't enter the backoff
    // ladder for this; just stamp last_polled_at so the UI shows we tried.
    portsDb.touchPolled(device.id);
    return;
  }

  const outputs = {};
  const cmdList = recipe.commands.map((c) => ({ name: c.key, cmd: c.cmd }));
  try {
    await _runSwitchCommandsSequential({
      _fromPoller: true,   // don't let the yield logic treat this as a manual probe
      host:     device.host,
      port:     device.ssh_port || 22,
      username: creds.username,
      password: creds.password,
      enable:          recipe.enable,
      enablePassword:  creds.enablePassword || creds.password,
      pagingOff:       recipe.pagingOff,
      commands: cmdList,
      timeoutMsPerCmd: 15_000,
      onEntry: (_i, entry) => {
        if (entry && entry.name && !entry.error) outputs[entry.name] = entry.output || '';
      },
    });
  } catch (err) {
    const { failures, backoffUntil } = portsDb.recordPollFailure(device.id, err.message);
    logger?.warn?.(`[port_poller] SSH failed for ${device.host} (failures=${failures}, backoff until ${backoffUntil}): ${err.message}`);
    return;
  }

  let parsed;
  try {
    parsed = recipe.parse(outputs);
  } catch (err) {
    portsDb.recordPollFailure(device.id, `parse: ${err.message}`);
    logger?.error?.(`[port_poller] parse failed for ${device.host}: ${err.message}`);
    return;
  }
  const { rows, meta } = parsed;

  if (meta && Object.values(meta).some((v) => v != null && v !== '')) {
    try { portsDb.updateDeviceMetadata(device.id, meta); }
    catch (err) { logger?.warn?.(`[port_poller] meta update failed: ${err.message}`); }
  }

  const ts = new Date().toISOString();
  let totalChanges = 0;
  for (const row of rows) {
    try {
      const changes = portsDb.writePoll(device.id, row, ts);
      totalChanges += changes.length;
    } catch (err) {
      // Per-row write failures are logged but shouldn't abort the loop —
      // one malformed row shouldn't lose the other 27 ports' state.
      logger?.warn?.(`[port_poller] writePoll failed for ${device.host}/${row.port}: ${err.message}`);
    }
  }
  // Success path — clears failure counter, stamps last_polled_at / last_seen.
  portsDb.recordPollSuccess(device.id);

  if (totalChanges > 0) {
    logger?.info?.(`[port_poller] ${device.host}: ${rows.length} ports polled, ${totalChanges} drift event(s)`);
  }
}

// Bounded-concurrency worker pool. Avoids `Promise.all` over potentially
// dozens of devices opening that many simultaneous SSH sessions.
async function runWithConcurrency(items, n, fn) {
  const queue = items.slice();
  const work = async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); }
      catch (e) { logger?.error?.(`[port_poller] uncaught for ${item?.host}: ${e?.message || e}`); }
    }
  };
  const workers = [];
  const width = Math.max(1, Math.min(n, items.length));
  for (let i = 0; i < width; i++) workers.push(work());
  await Promise.all(workers);
}

async function pollAll() {
  // dueDevices() filters by backoff_until — so a dead host doesn't
  // re-trigger SSH every interval. The first failure backs it off
  // BASE_BACKOFF_MS; subsequent failures double up to MAX_BACKOFF_MS.
  const devices = portsDb.dueDevices();
  if (devices.length === 0) return;
  const concurrency = Math.max(1, Number(process.env.PORT_POLL_CONCURRENCY) || DEFAULT_CONCURRENCY);
  await runWithConcurrency(devices, concurrency, pollDevice);
}

// Retention sweep: prunes events older than EVENT_DAYS and snapshots
// older than SNAPSHOT_DAYS (preserving the latest per port). Runs every
// RETENTION_MS, plus once at startup. Errors are swallowed (logged) so a
// transient SQLite hiccup doesn't kill the poller process.
function _retentionTick() {
  try {
    const eventDays    = Math.max(1, Number(process.env.PORT_DRIFT_EVENT_DAYS)    || DEFAULT_EVENT_DAYS);
    const snapshotDays = Math.max(1, Number(process.env.PORT_DRIFT_SNAPSHOT_DAYS) || DEFAULT_SNAPSHOT_DAYS);
    const e = portsDb.pruneOldEvents(eventDays);
    const s = portsDb.pruneOldSnapshots(snapshotDays);
    if (e || s) {
      logger?.info?.(`[port_poller] retention: pruned ${e} event(s), ${s} snapshot(s)`);
    }
  } catch (err) {
    logger?.warn?.(`[port_poller] retention sweep failed: ${err.message}`);
  }
}

function start({ intervalMs = DEFAULT_INTERVAL_MS, sshRunner, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if (_timer) return;
  if (sshRunner) setSshRunner(sshRunner);

  // Wipe any stale backoff inherited from the previous process. If the
  // server was killed mid-SSH-session, the switch's session table may
  // hold a half-open socket — the next poll attempt fails, the device
  // gets exponentially backed off (up to 30 min), and the only thing
  // that previously cleared the wedge was rebooting the switch. By
  // clearing backoff on every boot we guarantee polling always restarts
  // immediately and gets a clean attempt against each device.
  try {
    const cleared = portsDb.clearAllBackoff();
    if (cleared > 0) {
      logger?.info?.(`[port_poller] cleared stale backoff on ${cleared} device(s) at startup`);
    }
  } catch (err) {
    logger?.warn?.(`[port_poller] clearAllBackoff at startup failed: ${err.message}`);
  }

  // Kick off an immediate poll so the first snapshot lands without
  // waiting a full interval. Errors are swallowed (logged inside).
  pollAll().catch((e) => logger?.error?.(`[port_poller] initial poll failed: ${e.message}`));
  _timer = setInterval(() => {
    pollAll().catch((e) => logger?.error?.(`[port_poller] tick failed: ${e.message}`));
  }, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref(); // don't block exit

  // Retention runs on its own cadence so a slow poll doesn't starve it
  // and vice versa. Initial sweep at startup + every retentionMs after.
  _retentionTick();
  _retentionTimer = setInterval(_retentionTick, retentionMs);
  if (typeof _retentionTimer.unref === 'function') _retentionTimer.unref();

  logger?.info?.(`[port_poller] started, interval=${intervalMs}ms, retention=${retentionMs}ms`);
}

// Drain in-flight polls before tearing down. Waits up to `timeoutMs`
// for the _busy set to clear so the SSH sessions on the switch's side
// close gracefully (the previous "fire and forget" stop left
// half-open sockets behind, which on some switches refuses the next
// connection until the switch is rebooted).
async function stop({ drainTimeoutMs = 10_000 } = {}) {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_retentionTimer) { clearInterval(_retentionTimer); _retentionTimer = null; }
  if (_busy.size === 0) return;
  const deadline = Date.now() + drainTimeoutMs;
  while (_busy.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (_busy.size > 0) {
    logger?.warn?.(`[port_poller] stop: ${_busy.size} poll(s) still in flight after ${drainTimeoutMs}ms, forcing exit`);
  }
}

// Manual "unstick" — clears backoff for one device (or all) and triggers
// an immediate poll cycle. Lets an operator recover from a wedged state
// without restarting the server or rebooting a switch.
async function forceReset({ deviceId } = {}) {
  let cleared = 0;
  if (deviceId != null) cleared = portsDb.clearBackoff(deviceId);
  else cleared = portsDb.clearAllBackoff();
  logger?.info?.(`[port_poller] force-reset: cleared backoff on ${cleared} device(s)`);
  // Don't await — let the operator's request return quickly while the
  // poll runs in the background. Errors are logged inside pollAll.
  pollAll().catch((e) => logger?.error?.(`[port_poller] force-reset poll failed: ${e.message}`));
  return { cleared };
}

module.exports = {
  start, stop, setSshRunner, pollAll, pollDevice,
  isBusy, VENDOR_RECIPES, forceReset, normalizeVendor,
  resolveRecipe, supportedVendors,
  noteManualProbe, isManualProbeActive,
};
