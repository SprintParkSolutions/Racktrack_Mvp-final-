/**
 * Persistent application-log sink for the logs dashboard.
 *
 * The server's pino logger streams to stdout (pretty in dev, JSON in prod) and
 * is otherwise ephemeral — restart the process and the history is gone, and
 * there is nothing for an admin to browse in the UI. This module adds a small,
 * self-pruning SQLite mirror of the log stream plus a query API the
 * `/api/logs` endpoint serves to the dashboard.
 *
 * Wiring (observability.js):
 *   const logStore = require('./log-store');
 *   const logger = pino(opts, pino.multistream([
 *     { stream: prettyOrStdout },
 *     { level: 'info', stream: logStore.stream },   // durable mirror
 *   ]));
 *
 * The stream receives the SAME already-serialized (and already-redacted) JSON
 * line pino writes everywhere else, so no secret that pino redacts can leak
 * into this table. Writes are best-effort: a bad line or a locked DB is
 * swallowed so logging can never take the server down.
 */

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const Database = require('better-sqlite3');

// Live beside the auth/audit DB but in its own file — log volume is high and
// we don't want prune churn touching the auth database's WAL.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.LOG_DB_PATH || path.join(DATA_DIR, 'logs.db');

// Retention: drop anything older than this many days, and hard-cap total rows
// so a log storm can't fill the disk. Whichever bites first wins.
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS, 10) || 7;
const MAX_ROWS = parseInt(process.env.LOG_MAX_ROWS, 10) || 200000;
const PRUNE_EVERY = 1000;   // run prune once per this many inserts

const LEVEL_LABELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LABEL_LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

let db = null;
let insertStmt = null;
let insertsSincePrune = 0;

function init() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,        -- ISO-8601, from the log line's own time
        level       INTEGER NOT NULL,        -- pino numeric level (30=info, 50=error…)
        level_label TEXT    NOT NULL,
        msg         TEXT,
        event       TEXT,                    -- log.event / log.kind, when present
        request_id  TEXT,                    -- correlate every line of one HTTP request
        method      TEXT,
        url         TEXT,
        status      INTEGER,                 -- res.statusCode for HTTP lines
        duration_ms REAL,
        err         TEXT,                    -- error message, when the line carries one
        meta        TEXT                     -- full redacted JSON line (truncated)
      );
      CREATE INDEX IF NOT EXISTS idx_app_logs_id_desc  ON app_logs(id DESC);
      CREATE INDEX IF NOT EXISTS idx_app_logs_level     ON app_logs(level, id DESC);
      CREATE INDEX IF NOT EXISTS idx_app_logs_ts        ON app_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_app_logs_request   ON app_logs(request_id);
    `);
    insertStmt = db.prepare(`
      INSERT INTO app_logs
        (ts, level, level_label, msg, event, request_id, method, url, status, duration_ms, err, meta)
      VALUES
        (@ts, @level, @level_label, @msg, @event, @request_id, @method, @url, @status, @duration_ms, @err, @meta)
    `);
    prune(); // clear anything stale left from a previous run
  } catch (err) {
    // Never let log persistence failure break the server — degrade to no-op.
     
    console.error('[log-store] init failed, log dashboard disabled:', err.message);
    db = null;
  }
  return db;
}

// Pull the columns we index/filter on out of a parsed pino line. Everything
// else is preserved verbatim in `meta`.
function rowFromLine(obj, raw) {
  const level = typeof obj.level === 'number' ? obj.level : 30;
  const req = obj.req || {};
  const res = obj.res || {};
  let err = null;
  if (typeof obj.err === 'string') err = obj.err;
  else if (obj.err && typeof obj.err === 'object') err = obj.err.message || null;
  else if (typeof obj.error === 'string') err = obj.error;
  const meta = raw.length > 8192 ? raw.slice(0, 8192) + '…' : raw;
  return {
    ts: obj.time || new Date().toISOString(),
    level,
    level_label: LEVEL_LABELS[level] || String(level),
    msg: obj.msg != null ? String(obj.msg) : null,
    event: obj.event || obj.kind || null,
    request_id: req.id || obj.reqId || obj.requestId || null,
    method: req.method || null,
    url: req.url || null,
    status: typeof res.statusCode === 'number' ? res.statusCode : null,
    duration_ms: typeof obj.durationMs === 'number' ? obj.durationMs
               : (typeof obj.responseTime === 'number' ? obj.responseTime : null),
    err,
    meta,
  };
}

function writeLine(raw) {
  if (!db && db !== null) init();
  if (!db) return;
  try {
    const obj = JSON.parse(raw);
    insertStmt.run(rowFromLine(obj, raw));
    if (++insertsSincePrune >= PRUNE_EVERY) { insertsSincePrune = 0; prune(); }
  } catch (_) {
    // Non-JSON line or transient DB error — drop it silently. Losing a log
    // row must never surface as an application error.
  }
}

function prune() {
  if (!db) return;
  try {
    db.prepare(
      `DELETE FROM app_logs WHERE ts < datetime('now', ?)`
    ).run(`-${RETENTION_DAYS} days`);
    // Row cap: if still over budget, drop the oldest surplus by id.
    const n = db.prepare('SELECT COUNT(*) c FROM app_logs').get().c;
    if (n > MAX_ROWS) {
      db.prepare(
        `DELETE FROM app_logs WHERE id IN (
           SELECT id FROM app_logs ORDER BY id ASC LIMIT ?
         )`
      ).run(n - MAX_ROWS);
    }
  } catch (_) { /* best-effort */ }
}

// Wipe every stored log line and reclaim the file space — "start fresh".
// Done through the live connection (rather than deleting logs.db on disk)
// so the running server keeps a valid handle and nothing is corrupted.
// Returns how many rows were removed.
function clearAll() {
  if (!db) return 0;
  const before = db.prepare('SELECT COUNT(*) c FROM app_logs').get().c;
  db.prepare('DELETE FROM app_logs').run();
  try { db.exec('VACUUM'); } catch (_) { /* not fatal — space just isn't reclaimed */ }
  return before;
}

// The pino multistream target. pino writes one newline-terminated JSON string
// per log; we persist each. objectMode:false → chunks arrive as Buffers.
const stream = new Writable({
  write(chunk, _enc, cb) {
    writeLine(chunk.toString('utf8').trim());
    cb();
  },
});

/**
 * Query recent log rows, newest first.
 * @param {object} f
 * @param {string} [f.level]      minimum level label (e.g. 'warn' → warn+error+fatal)
 * @param {string} [f.q]          case-insensitive substring across msg/url/event/err/meta
 * @param {string} [f.requestId]  exact request-id match
 * @param {string} [f.since]      ISO/SQLite datetime lower bound (inclusive)
 * @param {string} [f.until]      ISO/SQLite datetime upper bound (inclusive)
 * @param {number} [f.limit=200]  1..1000
 * @param {number} [f.offset=0]
 */
function queryLogs(f = {}) {
  if (!db) init();
  if (!db) return { rows: [], total: 0 };
  const where = [];
  const params = {};
  if (f.level && LABEL_LEVELS[f.level]) { where.push('level >= @minLevel'); params.minLevel = LABEL_LEVELS[f.level]; }
  if (f.requestId) { where.push('request_id = @requestId'); params.requestId = String(f.requestId); }
  if (f.since) { where.push('ts >= @since'); params.since = String(f.since); }
  if (f.until) { where.push('ts <= @until'); params.until = String(f.until); }
  if (f.q) {
    // ESCAPE binds to its own LIKE, so it must sit on each one. We backslash-
    // escape % and _ in the term so they match literally.
    const E = "ESCAPE '\\'";
    where.push(`(msg LIKE @q ${E} OR url LIKE @q ${E} OR event LIKE @q ${E} OR err LIKE @q ${E} OR meta LIKE @q ${E})`);
    params.q = `%${String(f.q).replace(/[%_]/g, m => '\\' + m)}%`;
  }
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  // Append ESCAPE once when a LIKE search is present so literal % / _ in the
  // query are matched literally (we backslash-escaped them above).
  const cleanClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT id, ts, level, level_label, msg, event, request_id, method, url, status, duration_ms, err
     FROM app_logs ${cleanClause}
     ORDER BY id DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) c FROM app_logs ${cleanClause}`).get(params).c;
  return { rows, total };
}

/** Full JSON line + parsed meta for one row (row detail / "expand"). */
function getLog(id) {
  if (!db) init();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM app_logs WHERE id = ?').get(id);
  if (!row) return null;
  try { row.metaParsed = JSON.parse(row.meta); } catch (_) { row.metaParsed = null; }
  return row;
}

/** Level histogram + totals for the stat tiles, optionally since a timestamp. */
function logStats(since) {
  if (!db) init();
  if (!db) return { total: 0, byLevel: {}, oldest: null, newest: null };
  const clause = since ? 'WHERE ts >= @since' : '';
  const params = since ? { since: String(since) } : {};
  const byLevelRows = db.prepare(
    `SELECT level_label, COUNT(*) c FROM app_logs ${clause} GROUP BY level_label`
  ).all(params);
  const byLevel = {};
  for (const r of byLevelRows) byLevel[r.level_label] = r.c;
  const total = byLevelRows.reduce((s, r) => s + r.c, 0);
  const bounds = db.prepare('SELECT MIN(ts) oldest, MAX(ts) newest FROM app_logs').get();
  return { total, byLevel, oldest: bounds.oldest, newest: bounds.newest, retentionDays: RETENTION_DAYS };
}

module.exports = { stream, queryLogs, getLog, logStats, prune, clearAll, init, _dbPath: DB_PATH };
