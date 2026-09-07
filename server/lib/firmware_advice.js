'use strict';

// Firmware advice for one switch: what /api/firmware tells the client.
//
// Two sources feed it, neither of which is allowed to invent a version:
//
//   * the firmware update advisor (Agent/Agent_scrap, `--firmware`), a local
//     SQLite of vendor releases. Fast and cache-only in --no-live mode, but
//     its "live-discovered" rows were scraped from arbitrary pages and some
//     are junk ("16.429l-6-5" for TP-Link, "802.3af" for Aruba). It also
//     falls back to a *different* model of the same vendor when the requested
//     one is unknown (DGS-1100-16 for a DGS-1210-52).
//   * the firmware_lookup package, which asks the vendor's own site. It never
//     fabricates: when the portal needs a login or a vendor has no provider it
//     says so, with the portal link, as a determinate status.
//
// The old endpoint answered from the lookup alone and flagged everything that
// was not status 'ok' as an error, so a TP-Link switch whose firmware was read
// live over SNMP showed "Couldn't check for updates right now" even though
// the lookup had a perfectly good answer: "the vendor portal needs a login,
// here is the link". These functions turn every determinate outcome into an
// ok:true payload with a `status` the UI can render, use the agent only when
// it is provably talking about the requested model with a believable version,
// and reserve ok:false for a runner failure (the Python did not run).
//
// Pure functions, no I/O, so they are unit-tested in test/firmware_advice.test.js.

const LOOKUP_STATUSES = new Set([
  'ok',
  'auth_required',
  'cannot_determine',
  'model_not_found',
  'ambiguous_model',
  'not_implemented',
]);

// "17.9.4a", "5.20.27", "6.30.016": dot-separated numeric groups, optional
// single trailing letter (Cisco rebuilds). Anything else (letters inside a
// group, dashes, parentheses) is a different family and must be proven
// against the current version's shape before it is believed.
const CLEAN_VERSION   = /^\d+(?:\.\d+)+[a-z]?$/i;
const NUMERIC_VERSION = /^\d+(?:\.\d+)+$/;

function normText(v) {
  return String(v ?? '').trim();
}

// Number of dot-separated groups for a clean version; null when it is not
// one (so it can never accidentally equal a real count).
function dotGroups(v) {
  return CLEAN_VERSION.test(v) ? v.split('.').length : null;
}

// Shape signature: every run of digits becomes N, a single trailing letter is
// dropped. "16.429l-6-5" -> "n.nl-n-n", "15.2(7)E8" -> "n.n(n)en",
// "17.9.4a" -> "n.n.n". Two versions of the same family share a signature.
function shapeSig(v) {
  return String(v).toLowerCase().replace(/\d+/g, 'N').replace(/N[a-z]$/, 'N');
}

// Same family as the current version: identical group count for clean dotted
// versions, identical shape signature otherwise. Stricter than
// plausibleVersion; used for rows the agent scraped from the open web.
function sameFamily(candidate, currentVersion) {
  const c = normText(candidate), cur = normText(currentVersion);
  if (!c || !cur) return false;
  const gc = dotGroups(c), gcur = dotGroups(cur);
  if (gc !== null && gcur !== null) return gc === gcur;
  return shapeSig(c) === shapeSig(cur);
}

// True only when `candidate` reads as a firmware version of the same family
// as `currentVersion`:
//   * digits and dots only ("16.2", "6.30.016"): always a version shape.
//   * dotted with one trailing letter ("17.9.4a"): only alongside a current
//     version with the same number of groups.
//   * anything else ("16.429l-6-5", "25.6196C16", "15.2(7)E8"): only when the
//     current version has the very same shape.
// With no current version to compare against, only the clean shapes pass.
function plausibleVersion(candidate, currentVersion) {
  const c = normText(candidate);
  if (!c || c.length > 40) return false;
  if (!/^\d/.test(c) || !/\d\.\d/.test(c)) return false;
  const cur = normText(currentVersion);
  if (CLEAN_VERSION.test(c)) {
    if (NUMERIC_VERSION.test(c)) return true;
    if (!cur) return true;
    return dotGroups(c) === dotGroups(cur);
  }
  return !!cur && shapeSig(c) === shapeSig(cur);
}

// Numeric comparison of two clean dotted versions: -1, 0, 1, or null when
// either is not clean (then callers fall back to string equality).
function compareVersions(a, b) {
  const x = normText(a), y = normText(b);
  if (!CLEAN_VERSION.test(x) || !CLEAN_VERSION.test(y)) return null;
  const split = (v) => {
    const m = v.match(/^(.*?)([a-z])?$/i);
    return { nums: m[1].split('.').map(Number), letter: (m[2] || '').toLowerCase() };
  };
  const p = split(x), q = split(y);
  const n = Math.max(p.nums.length, q.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (p.nums[i] || 0) - (q.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (p.letter === q.letter) return 0;
  return p.letter < q.letter ? -1 : 1;
}

// Vendor, model and version strings arrive with mixed case and dashes
// ("TL-SG2428P" vs "tl sg2428p"); compare them on letters and digits only.
function normKey(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The agent echoes the model it actually answered for: the canonical model
// from its spec table, or the raw query when nothing matched. Both are fine;
// a *different* model of the same vendor is not.
function agentMatchedModel(agentRes, req) {
  const got = normKey(agentRes.model);
  if (!got) return false;
  return got === normKey(req.model) || got === normKey(`${req.vendor} ${req.model}`);
}

// Only a URL that really is release notes earns the "Release notes" label;
// a download page or support portal is a portal.
function looksLikeReleaseNotes(url) {
  return !!url && /release[-_]?notes|releasenotes|changelog|release[-_]?history|whats[-_]?new/i.test(url);
}

// Maps an Agent_scrap `--firmware` result onto the UI contract, or returns
// null when the agent has nothing trustworthy: it did not run, answered for a
// different model, has no data, or its target version does not look like a
// version of the family the switch is actually running.
function fromAgent(agentRes, req) {
  if (!agentRes || !agentRes.ok) return null;
  if (!agentMatchedModel(agentRes, req)) return null;
  const advice = agentRes.advice || {};
  if (advice.has_data !== true) return null;
  const target = (advice.diff && advice.diff.target) || null;
  const agentLatest = target && target.version ? String(target.version).trim() : null;
  if (!agentLatest) return null;
  if (!plausibleVersion(agentLatest, req.currentVersion)) return null;
  // Rows scraped from the open web carry the train 'live-discovered'. They
  // are believed only when they are unmistakably the same family as the
  // version the switch reports.
  if (String(target.train || '').toLowerCase() === 'live-discovered'
      && !sameFamily(agentLatest, req.currentVersion)) return null;

  const cmp = compareVersions(req.currentVersion, agentLatest);
  const upToDate = cmp !== null
    ? cmp >= 0
    : agentLatest === normText(req.currentVersion);

  // NOTE: the agent also returns advice.advisories[] (CVE rows from NVD).
  // They are deliberately NOT mapped through. CVE data was removed from the
  // product and must not reappear anywhere in the app. Do not reintroduce it
  // here just because the upstream payload happens to carry it.

  // Synthesize the changelog section from the target firmware's
  // structured release-note fields: no extra web scrape needed since the
  // agent's firmware DB already carries the diff breakdown.
  const changelog = [];
  const push = (label, list) => {
    if (Array.isArray(list) && list.length) {
      changelog.push({
        section: `${label} in ${agentLatest}`,
        version: agentLatest,
        text: list.join('\n'),
      });
    }
  };
  push('Security fixes', target.security_fixes);
  push('Bug fixes',      target.bug_fixes);
  push('New features',   target.new_features);
  push('Known issues',   target.known_issues);
  push('Deprecations',   target.deprecations);

  const releaseNotesUrl = target.release_notes_url || null;
  return {
    ok: true,
    source: 'agent',
    status: 'ok',
    vendor:         agentRes.vendor || advice.vendor || req.vendor,
    model:          req.model,
    currentVersion: req.currentVersion,
    latestVersion:  agentLatest,
    upToDate,
    releaseNotesUrl,
    portalUrl:      advice.portal_url || null,
    message:        advice.message || null,
    // Kept for the current client and the scan report.
    releaseNotesError: null,
    releaseNotesGated: !!advice.release_notes_gated,
    advisoryMessage: advice.message || null,
    hasAdvisoryData: true,
    nos: advice.nos || null,
    versionsFound: [],
    changelog,
    recommendedMinVersion: advice.recommended_min_version || null,
    latestSource: `agent (${agentRes.elapsed_ms ?? '?'} ms)`,
  };
}

// Maps a firmware_lookup FirmwareResult (to_full_dict) onto the UI contract.
// Every determinate status is ok:true: "the portal needs a login" is an
// answer, not an error. ok:false is reserved for the runner not producing a
// result at all.
function fromLookup(r, req) {
  const base = {
    vendor: req.vendor,
    model: req.model,
    currentVersion: req.currentVersion,
  };
  if (!r || r._runnerError) {
    return {
      ok: false,
      source: 'lookup',
      status: null,
      ...base,
      latestVersion: null,
      upToDate: null,
      portalUrl: null,
      releaseNotesUrl: null,
      message: null,
      error: (r && r._runnerError) || 'Firmware lookup failed.',
    };
  }
  const status = LOOKUP_STATUSES.has(r.status) ? r.status : 'cannot_determine';
  const isOk   = status === 'ok';
  const latest = isOk && r.latest_version ? String(r.latest_version).trim() : null;
  const portal = r.source_url || null;

  let upToDate = null;
  if (latest) {
    if (typeof r.update_available === 'boolean') upToDate = (r.update_available === false);
    else {
      const cmp = compareVersions(req.currentVersion, latest);
      upToDate = cmp !== null ? cmp >= 0 : latest === normText(req.currentVersion);
    }
  }

  const message = r.message ? String(r.message).replace(/\s*\n\s*/g, ' ').trim() : null;
  return {
    ok: true,
    source: 'lookup',
    status,
    vendor: r.vendor || req.vendor,
    model:  r.model  || req.model,
    currentVersion: req.currentVersion,
    latestVersion: latest,
    upToDate,
    portalUrl: portal,
    releaseNotesUrl: looksLikeReleaseNotes(portal) ? portal : null,
    message,
    confidence: r.confidence || null,
    checkedAt: r.last_checked || null,
    // Kept for the current client.
    authRequired: status === 'auth_required',
    statusValue: status,
    changelog: [],
  };
}

// The endpoint's answer: the agent when it has something trustworthy, the
// vendor lookup otherwise. currentVersion is always the caller's, unchanged.
function combine({ agentRes, lookupRes, req }) {
  const viaAgent = fromAgent(agentRes, req);
  if (viaAgent) return { ...viaAgent, currentVersion: req.currentVersion };
  return { ...fromLookup(lookupRes, req), currentVersion: req.currentVersion };
}

module.exports = { plausibleVersion, fromAgent, fromLookup, combine };
