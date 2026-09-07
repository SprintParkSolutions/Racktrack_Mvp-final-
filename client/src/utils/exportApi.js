import { Capacitor } from '@capacitor/core';
import { apiUrl, authFetch } from './api';

/**
 * The NetBox end of the chain, without a page of its own.
 *
 * Export used to be a screen you navigated to after the report — a second
 * place to be, for three buttons that all say "the report you are already
 * looking at, somewhere else". These are the pieces that screen was made of,
 * so the report can offer them where the report is.
 */

/**
 * One round trip to the NetBox side of the server.
 *
 * Never throws, and a failed request keeps the server's body: the 409s, 428s
 * and 502s carry the reason a step could not run, and that reason is the
 * thing the engineer needs to read.
 */
export async function nb(path, opts = {}) {
  let res;
  try {
    res = await authFetch(apiUrl(path), opts);
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: {
        error: timedOut
          ? 'The server took too long to answer. Check your connection and try again.'
          : 'Could not reach the server. Check your connection and try again.',
      },
    };
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body };
}

/** NetBox's own error detail is often an object, not a sentence. */
export function errText(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e, null, 2); } catch { return String(e); }
}

/** The server's reason, plus what to do about it where the status tells us. */
export function explain(r, fallback) {
  const raw = errText(r.body && r.body.error).trim() || fallback || '';
  const msg = raw ? raw[0].toUpperCase() + raw.slice(1) : fallback;
  if (r.status === 403) return 'Only the account owner can use the NetBox tools for now. Ask them to sign in and export this rack.';
  if (r.status === 409) return `${msg.replace(/\.$/, '')}. Analyse the rack photo first, then come back here.`;
  // Every :rackId and :id on the NetBox routes goes through the ownership
  // guard, which answers 404 for a rack the caller cannot see — so 404 here
  // is "not yours", not a missing route.
  if (r.status === 404) return 'This rack is not available to your account.';
  return msg;
}

/**
 * What the health check means, in the words on the sheet.
 *
 * Never the raw one. NetBox's own failures arrive as things like
 * `NetBox HTTP 0 on /api/status/: "unreachable: fetch failed"` — true, and
 * addressed to whoever wrote the fetch. A person holding a phone in front of
 * a rack needs to know which of three things is wrong and who fixes it.
 */
export function healthView(h) {
  if (!h) return null;
  if (h.configured === false) {
    return {
      tone: 'none',
      title: 'No NetBox connected',
      text: 'Nobody has set up a NetBox for this organisation yet. An admin adds one under Data Sources — its address and an API token — once, for everyone.',
      blocked: true,
    };
  }
  if (!h.reachable) {
    return {
      tone: 'bad',
      title: 'NetBox is not answering',
      text: h.url
        ? `The server could not reach ${h.url}. Nothing has been changed.`
        : 'The server could not reach NetBox. Nothing has been changed.',
      hint: 'Either NetBox is down or this server cannot see it from where it runs. An admin can check the address under Data Sources.',
      blocked: true,
    };
  }
  if (!h.authenticated) {
    return {
      tone: 'warn',
      title: 'NetBox would not accept the login',
      text: `${h.url || 'NetBox'} answered, but refused the API token.`,
      hint: 'An admin can replace the token under Data Sources. Nothing has been changed.',
      blocked: true,
    };
  }
  return {
    tone: 'good',
    title: 'Connected to NetBox',
    text: `${h.url}${h.netboxVersion ? ` · version ${h.netboxVersion}` : ''}`,
  };
}

/**
 * Put a file the server just sent into the engineer's hands.
 *
 * Returns the note to show, or null when the person dismissed the share sheet
 * themselves (that is not an error and should not read as one).
 */
export async function saveBlob(blob, name, kind) {
  const native = Capacitor.isNativePlatform();

  if (!native) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { tone: 'good', text: `Saved ${name}.` };
  }

  // Packaged app: hand the file to the share sheet when the WebView has one.
  // The WebView ignores blob: URLs and <a download> entirely.
  try {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (typeof navigator.share === 'function' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return { tone: 'good', text: `${name} is on the share sheet — save it to Files or send it on.` };
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
      }
    }
  } catch { /* File or share unavailable — fall through */ }

  if (kind === 'json') {
    try {
      await navigator.clipboard.writeText(await blob.text());
      return { tone: 'good', text: 'This phone cannot save files from inside the app, so the JSON was copied to your clipboard instead.' };
    } catch { /* clipboard refused too */ }
  }
  return {
    tone: 'bad',
    text: 'This phone cannot save files from inside the app. Open RackTrack in a browser on a computer and download it from there — the same button is there.',
  };
}

/** Ask the server for one of the export files and hand it over. */
export async function downloadExport(scanId, rackId, kind) {
  const ext = kind === 'csv' ? 'csv' : 'json';
  const fallbackName = kind === 'csv'
    ? `${String(rackId).replace(/[^A-Za-z0-9_-]/g, '_')}-netbox-csv.zip`
    : `${String(rackId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
  let res;
  try {
    res = await authFetch(apiUrl(`/api/nb/netbox/${scanId}/export.${ext}`));
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
    throw new Error(explain({ ok: false, status: res.status, body }, 'The file could not be made.'));
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return saveBlob(blob, m ? m[1] : fallbackName, kind);
}
