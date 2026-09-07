/**
 * Turn a NetBox login into a NetBox API token.
 *
 * People know their NetBox username and password; almost nobody knows, or
 * wants to go and make, an API token. NetBox will mint one from a login —
 * POST /api/users/tokens/provision/ — so the Data Source form asks for the
 * login, this asks NetBox for the token, and the token is what gets stored
 * and sent from then on. NetBox 4.3+ issues v2 tokens whose credential is
 * "nbt_<key>.<secret>" (the response carries the two halves separately);
 * older NetBox returns one 40-character key. Both are handled here so the
 * caller never has to know which NetBox it is talking to.
 */

/** A base URL with the scheme kept and the trailing slash dropped. */
function cleanBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * @returns {Promise<{ token: string, version: number, description: string }>}
 * @throws  Error with a message a person can act on
 */
async function provisionToken(baseUrl, username, password, { description = 'RackTrack', timeoutMs = 15000 } = {}) {
  const base = cleanBase(baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new Error('The NetBox address must start with http:// or https://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/api/users/tokens/provision/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password, description, write_enabled: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? `NetBox at ${base} did not answer in ${Math.round(timeoutMs / 1000)}s.`
      : `Could not reach NetBox at ${base}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let body = {};
  try { body = await res.json(); } catch { /* a non-JSON answer is handled by status below */ }
  if (res.status === 401 || res.status === 403) {
    throw new Error('NetBox did not accept that username and password.');
  }
  if (!res.ok) {
    const detail = body.detail || body.non_field_errors || JSON.stringify(body).slice(0, 160);
    throw new Error(`NetBox refused to issue a token (HTTP ${res.status}): ${detail}`);
  }
  const version = Number(body.version || 1);
  const token = version >= 2
    ? `nbt_${body.key}.${body.token}`
    : String(body.token || body.key || '');
  if (!token || token === 'nbt_undefined.undefined') {
    throw new Error('NetBox answered without a token in the response.');
  }
  return { token, version, description };
}

module.exports = { provisionToken, cleanBase };
