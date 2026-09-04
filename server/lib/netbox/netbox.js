/**
 * NetBox REST client.
 *
 * Uses the fetch built into Node 18+, so there is no HTTP dependency to install
 * or keep patched. Everything here is GET, POST or PATCH.
 *
 * There is deliberately NO delete method on this class. See writer.js rule 3.
 */

/**
 * The custom field that makes re-scanning safe. NetBox has no upsert, so
 * without a stable id of our own, pushing the same rack twice creates a
 * second copy of every object in it.
 */
const UID_FIELD = 'racktrack_uid';

class NetBoxError extends Error {
  constructor(status, detail, path = '') {
    super(`NetBox HTTP ${status} on ${path}: ${JSON.stringify(detail)}`);
    this.name = 'NetBoxError';
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

class NetBox {
  constructor(url, token, timeoutMs = 15000) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
  }

  headers() {
    const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
    // Tolerate a token pasted with its scheme already on it ("Bearer nbt_...").
    const raw = String(this.token || '').replace(/^\s*(Bearer|Token)\s+/i, '').trim();
    if (raw) {
      // Newer NetBox issues nbt_ tokens and authenticates them with the Bearer
      // scheme; older NetBox uses the DRF "Token" scheme. Sending the wrong one
      // is a 403 even when the token is perfectly valid, so pick by prefix.
      const scheme = raw.startsWith('nbt_') ? 'Bearer' : 'Token';
      h.Authorization = `${scheme} ${raw}`;
    }
    return h;
  }

  async request(method, path, body = null, params = null) {
    let url = `${this.url}${path}`;
    if (params && Object.keys(params).length) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new NetBoxError(0, `unreachable: ${err.message}`, path);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text.slice(0, 500); }
    // NetBox's own error bodies are specific and name the offending field —
    // pass them through untouched rather than flattening to a status code.
    if (!res.ok) throw new NetBoxError(res.status, parsed, path);
    return parsed;
  }

  get(path, params)        { return this.request('GET', path, null, params); }
  post(path, body)         { return this.request('POST', path, body); }
  patch(path, id, body)    { return this.request('PATCH', `${path}${id}/`, body); }

  /** Walk every page. NetBox caps page size, so a full rack needs this. */
  async paginate(path, params = {}) {
    const out = [];
    let page = await this.request('GET', path, null, { ...params, limit: 200 });
    out.push(...(page.results || []));
    while (page.next) {
      const rel = page.next.startsWith(this.url) ? page.next.slice(this.url.length) : page.next;
      page = await this.request('GET', rel);
      out.push(...(page.results || []));
    }
    return out;
  }

  status() { return this.get('/api/status/'); }

  /**
   * The whole idempotency story. Returns the existing object, or null.
   * Filtering on a custom field uses NetBox's `cf_<name>` query parameter.
   *
   * The server's match is not trusted: a text custom field whose filter
   * logic is "loose" (NetBox's default) matches by substring, so a lookup
   * for if:R1:SW01:1 would also return :10 through :19. Only rows whose uid
   * is exactly the one asked for count.
   */
  async findByUid(endpoint, uid) {
    const res = await this.get(endpoint, { [`cf_${UID_FIELD}`]: uid });
    const hits = (res.results || []).filter((h) => (h.custom_fields || {})[UID_FIELD] === uid);
    if (hits.length > 1) {
      throw new NetBoxError(409,
        `${hits.length} objects share ${UID_FIELD}=${uid}, so this refuses to guess which to update`,
        endpoint);
    }
    return hits[0] || null;
  }

  async customField() {
    const res = await this.get('/api/extras/custom-fields/', { name: UID_FIELD });
    return (res.results || [])[0] || null;
  }

  /**
   * Create or widen the racktrack_uid custom field.
   *
   * Must run before any push. If the field does not exist, every lookup
   * silently matches nothing and every push creates duplicates — the exact
   * failure this field exists to prevent. So it is never skipped quietly.
   */
  async ensureCustomField(objectTypes) {
    const existing = await this.customField();
    if (!existing) {
      const created = await this.post('/api/extras/custom-fields/', {
        object_types: [...objectTypes].sort(),
        type: 'text',
        name: UID_FIELD,
        label: 'RackTrack UID',
        description: 'Stable RackTrack id. Used to update rather than duplicate '
                   + 'on re-scan. Do not edit by hand.',
        required: false,
        // Loose (the default) filters text by substring, which makes a
        // lookup for port 1 also return ports 10 to 19. Uids are ids.
        filter_logic: 'exact',
      });
      return { action: 'created', field: created };
    }
    // The field exists but may not cover every type this snapshot touches,
    // and one created by hand or by an older version may still filter loosely.
    const have = new Set(existing.object_types || []);
    const missing = [...objectTypes].filter((t) => !have.has(t));
    const logic = existing.filter_logic && typeof existing.filter_logic === 'object'
      ? existing.filter_logic.value : existing.filter_logic;
    const body = {};
    if (missing.length) body.object_types = [...new Set([...have, ...objectTypes])].sort();
    if (logic !== 'exact') body.filter_logic = 'exact';
    if (Object.keys(body).length) {
      const widened = await this.patch('/api/extras/custom-fields/', existing.id, body);
      return { action: 'widened', added: missing.sort(), field: widened };
    }
    return { action: 'present', field: existing };
  }
}

module.exports = { NetBox, NetBoxError, UID_FIELD };
