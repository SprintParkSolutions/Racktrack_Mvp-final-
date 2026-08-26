/**
 * Microsoft Graph email sender.
 *
 * Sends mail FROM the RackTrack Microsoft 365 mailboxes instead of an
 * individual employee's Gmail:
 *   • 'racktrack' → racktrackteam@sprintpark.com  (verification codes, invites)
 *   • 'support'   → support@racktrack.ai          (contact form / support bot)
 *
 * Token acquisition, in order:
 *   1. CLIENT CREDENTIALS (app-only) — CLIENT_ID + CLIENT_SECRET + TENANT_ID.
 *      This is the "once admin consent is granted, it just works" path: the
 *      app requests its own token and auto-refreshes it. Needs the Mail.Send
 *      APPLICATION permission consented by a tenant admin, and the sender
 *      mailboxes in that tenant.
 *   2. A cached per-mailbox access token written to token/<name>_outlook_cache
 *      .json ({access_token, expires_at}) — used for local testing before the
 *      secret/consent are in place. Short-lived; not for production.
 *
 * If no token can be obtained, sendGraphMail returns false and the caller
 * falls back to SMTP (see auth.js) — so mail delivery never hard-fails here.
 *
 * Config (env overrides the file so production needn't ship token/):
 *   MS_CLIENT_ID, MS_TENANT_ID   (else parsed from token/mailid.md)
 *   MS_CLIENT_SECRET             (enables the client-credentials path)
 *   MAIL_FROM_RACKTRACK, MAIL_FROM_SUPPORT   (override the sender addresses)
 */
const fs = require('fs');
const path = require('path');

let _logger;
function logger() {
  if (_logger) return _logger;
  try { _logger = require('./observability').logger; }
  catch { _logger = console; }
  return _logger;
}

const TOKEN_DIR = path.resolve(__dirname, '..', '..', 'token');

function readIds() {
  let clientId = process.env.MS_CLIENT_ID;
  let tenantId = process.env.MS_TENANT_ID;
  if (!clientId || !tenantId) {
    try {
      const md = fs.readFileSync(path.join(TOKEN_DIR, 'mailid.md'), 'utf8');
      clientId = clientId || (md.match(/CLIENT_ID\s*=\s*"?([0-9a-f-]{36})"?/i) || [])[1];
      tenantId = tenantId || (md.match(/TENANT_ID\s*=\s*"?([0-9a-f-]{36})"?/i) || [])[1];
    } catch { /* no file — env only */ }
  }
  return { clientId, tenantId };
}

const SENDERS = {
  racktrack: {
    address: process.env.MAIL_FROM_RACKTRACK || 'racktrackteam@sprintpark.com',
    cache: 'racktrack_outlook_cache.json',
    // Shared with pipeline/teams_send.py and pipeline/outlook_send.py rather
    // than copied here. One file, one signed-in account, so the Node and Python
    // paths can never drift about which mailbox reports come from — and only one
    // place has to be re-seeded.
    msalCache: path.resolve(__dirname, '..', '..', 'pipeline', 'racktrack_teams_cache.json'),
  },
  support: {
    address: process.env.MAIL_FROM_SUPPORT || 'support@racktrack.ai',
    cache: 'support_outlook_cache.json',
    msalCache: path.join(TOKEN_DIR, 'support_msal_cache.json'),
  },
};

// ── Per-mailbox tokens from an MSAL cache ────────────────────────────────────
// The flat {access_token, expires_at} files cachedToken() reads hold a token
// that dies an hour after somebody pasted it in, with no way to renew. Both
// were found expired by 24 days — which is why the contact form fell through to
// SMTP and, with no SMTP configured, answered "Could not send right now".
//
// An MSAL cache carries a REFRESH token instead, so a fresh access token can be
// minted on demand and the mailbox keeps working unused for months.
function readMsalRefresh(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rt = Object.values(j.RefreshToken || {})[0];
    if (!rt || !rt.secret) return null;
    // Take the client id from the cache entry, NOT from mailid.md. The two
    // mailboxes are registered as different Azure apps, and a refresh token is
    // only redeemable by the client that issued it — a single global CLIENT_ID
    // would authenticate one mailbox and silently fail the other.
    return { secret: rt.secret, clientId: rt.client_id };
  } catch {
    return null;
  }
}

const _msalTokens = new Map(); // senderKey -> { token, exp }

async function msalToken(senderKey) {
  const s = SENDERS[senderKey];
  if (!s || !s.msalCache) return null;

  const now = Date.now() / 1000;
  const hit = _msalTokens.get(senderKey);
  if (hit && hit.exp - 60 > now) return hit.token;

  const rt = readMsalRefresh(s.msalCache);
  const { tenantId } = readIds();
  if (!rt || !rt.clientId || !tenantId) return null;

  try {
    const body = new URLSearchParams({
      client_id: rt.clientId,
      refresh_token: rt.secret,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    });
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      logger().error(`[graphMail] refresh-token grant failed for ${senderKey}: ${r.status} ${await r.text().catch(() => '')}`);
      return null;
    }
    const j = await r.json();
    if (!j.access_token) return null;
    // The rotated refresh token Entra hands back is deliberately NOT written to
    // the cache file. For the racktrack mailbox that file is also read and
    // rewritten by the Python senders, and two processes each persisting their
    // own rotation would take turns invalidating the other's. A public-client
    // refresh token stays redeemable, so reading it without writing is safe;
    // the Python path keeps the file current on its own.
    _msalTokens.set(senderKey, { token: j.access_token, exp: now + (j.expires_in || 3600) });
    logger().info(`[graphMail] minted a ${senderKey} token from its refresh token`);
    return j.access_token;
  } catch (err) {
    logger().error(`[graphMail] refresh-token request error for ${senderKey}: ${err.message}`);
    return null;
  }
}

// App-only token via client credentials, cached in memory until ~1 min before
// expiry so we refresh proactively.
let _appToken = { token: null, exp: 0 };
async function appToken() {
  const now = Date.now() / 1000;
  if (_appToken.token && _appToken.exp - 60 > now) return _appToken.token;

  const { clientId, tenantId } = readIds();
  const secret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !tenantId || !secret) return null;

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) {
      logger().error(`[graphMail] client-credentials token failed: ${r.status} ${await r.text().catch(() => '')}`);
      return null;
    }
    const j = await r.json();
    _appToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
    return _appToken.token;
  } catch (err) {
    logger().error(`[graphMail] token request error: ${err.message}`);
    return null;
  }
}

// Fallback: a cached per-mailbox access token (local testing only).
function cachedToken(cacheFile) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, cacheFile), 'utf8'));
    const notExpired = !j.expires_at || Number(j.expires_at) > Date.now() / 1000 + 30;
    if (j.access_token && notExpired) return j.access_token;
  } catch { /* no cache */ }
  return null;
}

// Order matters: app-only first (one token serves every mailbox), then the
// mailbox's own refresh token, then the legacy pasted-in access token. The
// refresh path sits ABOVE the flat cache because the flat one silently stops
// working an hour after it was written and gives no signal that it has.
async function tokenFor(senderKey) {
  const app = await appToken();
  if (app) return app;
  const msal = await msalToken(senderKey);
  if (msal) return msal;
  const s = SENDERS[senderKey];
  return s ? cachedToken(s.cache) : null;
}

// True when at least one path could produce a token — lets callers decide
// whether to even attempt Graph before falling back to SMTP.
function isConfigured() {
  const { clientId, tenantId } = readIds();
  if (clientId && tenantId && process.env.MS_CLIENT_SECRET) return true;
  // A refresh token counts as configured: unlike the flat caches below it does
  // not go stale on the shelf. Checked before them so an expired flat file no
  // longer makes a perfectly good mailbox look unconfigured.
  if (tenantId && Object.keys(SENDERS).some(k => SENDERS[k].msalCache && readMsalRefresh(SENDERS[k].msalCache))) {
    return true;
  }
  return !!(cachedToken(SENDERS.racktrack.cache) || cachedToken(SENDERS.support.cache));
}

// Graph rejects a sendMail whose whole serialised message exceeds 4 MB; larger
// payloads need a draft plus an upload session, which is a lot of machinery for
// the one case that needs it. Attachments are base64 in the JSON body, so the
// wire cost is ~4/3 of the raw bytes — the ceiling below is on the ENCODED size
// and leaves room for the body and headers. Past it we return false, and the
// caller falls back to SMTP, which carries the larger message happily.
const GRAPH_MAX_ENCODED_BYTES = 3.5 * 1024 * 1024;

/**
 * Send an email FROM one of the configured mailboxes via Microsoft Graph.
 * Returns true on delivery (HTTP 202), false if not configured, too large for
 * a single sendMail, or on failure — the caller then falls back to SMTP.
 *
 * `attachments` is the nodemailer shape — { filename, content: Buffer,
 * contentType } — so one array serves both transports and callers do not have
 * to know which one will carry the message.
 */
async function sendGraphMail({ sender = 'racktrack', to, subject, html, text, replyTo, attachments }) {
  const s = SENDERS[sender];
  if (!s) throw new Error(`graphMail: unknown sender "${sender}"`);

  const token = await tokenFor(sender);
  if (!token) return false;

  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  if (!recipients.length) throw new Error('graphMail: no recipients');

  const files = (attachments || []).filter((a) => a && a.content);
  const graphAttachments = files.map((a) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename || 'attachment',
    contentType: a.contentType || 'application/octet-stream',
    contentBytes: Buffer.isBuffer(a.content)
      ? a.content.toString('base64')
      : Buffer.from(a.content).toString('base64'),
  }));

  const encodedBytes = graphAttachments.reduce((n, a) => n + a.contentBytes.length, 0);
  if (encodedBytes > GRAPH_MAX_ENCODED_BYTES) {
    logger().warn(
      `[graphMail] ${Math.round(encodedBytes / 1024)}KB of attachments exceeds the single-request ` +
      `sendMail limit — deferring to SMTP`,
    );
    return false;
  }

  const message = {
    subject: subject || '',
    body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
    toRecipients: recipients,
    ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
    ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
  };

  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s.address)}/sendMail`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }),
      },
    );
    if (r.status === 202) {
      logger().info(`[graphMail] sent from ${s.address} to ${recipients.map((x) => x.emailAddress.address).join(', ')}`);
      return true;
    }
    logger().error(`[graphMail] sendMail from ${s.address} failed: ${r.status} ${await r.text().catch(() => '')}`);
    return false;
  } catch (err) {
    logger().error(`[graphMail] sendMail from ${s.address} error: ${err.message}`);
    return false;
  }
}

module.exports = { sendGraphMail, isConfigured, SENDERS };
