/**
 * Generic REST connector — one target that fits any system with an HTTP API.
 *
 * The escape hatch. When a customer's CMDB is not one we wrote a dedicated
 * connector for, this posts the same structured snapshot to a URL they name,
 * with whatever auth their endpoint expects. Two shapes: the whole snapshot in
 * one POST (bulk), or one POST per object with its type (per-object), which is
 * what most import endpoints want.
 */
const { EXPORT_ORDER } = require('../model');
const { toJson } = require('../files');

const AUTHS = ['none', 'bearer', 'basic', 'header'];
const MODES = ['bulk', 'per-object'];
const METHODS = ['POST', 'PUT'];

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.auth === 'bearer' && cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  else if (cfg.auth === 'basic' && cfg.username) {
    h.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  } else if (cfg.auth === 'header' && cfg.headerName) {
    h[cfg.headerName] = cfg.headerValue || '';
  }
  return h;
}

/** Every observed object, tagged with its NetBox-style type, in export order. */
function flatten(snapshot) {
  const out = [];
  for (const field of EXPORT_ORDER) {
    for (const obj of snapshot[field] || []) out.push({ object_type: field, object: obj });
  }
  return out;
}

async function send(url, method, headers, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  type: 'rest',
  label: 'Generic REST',
  fields: [
    { key: 'url', label: 'Endpoint URL', required: true, placeholder: 'https://cmdb.example/api/import' },
    { key: 'method', label: 'HTTP method', type: 'select', options: METHODS, default: 'POST' },
    { key: 'mode', label: 'Send as', type: 'select', options: MODES, default: 'bulk',
      help: 'bulk = the whole snapshot in one request; per-object = one request each' },
    { key: 'auth', label: 'Auth', type: 'select', options: AUTHS, default: 'none' },
    { key: 'token', label: 'Bearer token', secret: true, when: { auth: 'bearer' } },
    { key: 'username', label: 'Username', when: { auth: 'basic' } },
    { key: 'password', label: 'Password', secret: true, when: { auth: 'basic' } },
    { key: 'headerName', label: 'Header name', when: { auth: 'header' }, placeholder: 'X-API-Key' },
    { key: 'headerValue', label: 'Header value', secret: true, when: { auth: 'header' } },
  ],

  validate(cfg) {
    if (!cfg.url || !/^https?:\/\//i.test(cfg.url)) {
      return { ok: false, error: 'A full http(s) endpoint URL is required.' };
    }
    if (cfg.auth && !AUTHS.includes(cfg.auth)) return { ok: false, error: 'Unknown auth type.' };
    if (cfg.mode && !MODES.includes(cfg.mode)) return { ok: false, error: 'Unknown send mode.' };
    return { ok: true };
  },

  async test(cfg) {
    try {
      // Non-mutating reachability check. Many import endpoints reject GET, so a
      // 4xx here still means the host answered; only a network error is fatal.
      const res = await send(cfg.url, 'GET', authHeaders(cfg), undefined);
      return { ok: true, message: `Host answered ${res.status}. (A POST is what export uses.)` };
    } catch (e) {
      return { ok: false, message: `Could not reach it: ${e.message || e}` };
    }
  },

  async export(snapshot, cfg, { apply }) {
    const items = flatten(snapshot);
    const counts = {};
    for (const it of items) counts[it.object_type] = (counts[it.object_type] || 0) + 1;
    const changes = items.map((it) => ({
      type: it.object_type, name: it.object.name || it.object.model || it.object.label || it.object.uid,
      action: 'create',
    }));

    if (!apply) {
      return { ok: true, dryRun: true, type: 'rest', target: cfg.url,
               counts: { create: items.length }, changes, warnings: [] };
    }

    const method = METHODS.includes(cfg.method) ? cfg.method : 'POST';
    const headers = authHeaders(cfg);
    const warnings = [];
    let sent = 0;

    if ((cfg.mode || 'bulk') === 'bulk') {
      const res = await send(cfg.url, method, headers, JSON.parse(toJson(snapshot)));
      if (!res.ok) warnings.push(`Endpoint replied ${res.status}: ${res.body}`);
      else sent = items.length;
    } else {
      for (const it of items) {
        const res = await send(cfg.url, method, headers, it);
        if (res.ok) sent += 1;
        else { warnings.push(`${it.object_type} ${changes.find((c) => c)?.name || ''}: ${res.status}`); break; }
      }
    }
    return { ok: warnings.length === 0, dryRun: false, type: 'rest', target: cfg.url,
             counts: { create: sent }, changes, warnings };
  },

  // exported for tests
  _flatten: flatten,
  _authHeaders: authHeaders,
};
