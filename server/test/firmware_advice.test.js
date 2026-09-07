'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { plausibleVersion, fromAgent, fromLookup, combine } = require('../lib/firmware_advice');

// ── Fixtures: the real shapes the two Python CLIs print ────────────────────

// firmware_lookup for the lab's TP-Link switch, firmware read live over SNMP.
const tplinkReq = { vendor: 'TP-Link', model: 'TL-SG2428P', currentVersion: '5.20.27' };
const tplinkLookup = {
  vendor: 'TP-Link', model: 'TL-SG2428P', current_version: '5.20.27',
  latest_version: null, update_available: null,
  source_url: 'https://www.tp-link.com/us/support',
  confidence: null, retrieval_method: 'login_required',
  last_checked: '2026-09-07T12:09:50.551395+00:00',
  status: 'auth_required',
  message: 'Firmware version cannot be determined automatically.\nVendor authentication or support entitlement required. You can check the current version yourself using the link below.',
};
// The advisor, --no-live, for the same switch: nothing.
const tplinkAgentEmpty = {
  ok: true, mode: 'firmware', vendor: 'TP-Link', model: 'TL-SG2428P', current_version: '5.20.27',
  advice: { vendor: 'TP-Link', nos: 'Omada SDN', current_version: '5.20.27', has_data: false,
    message: 'No firmware data available for TP-Link.', diff: null, portal_url: null,
    advisories: [], recommended_min_version: null, release_notes_gated: false },
  elapsed_ms: 7331,
};
// The advisor when its junk 'live-discovered' row leaks through as the latest.
const tplinkAgentJunk = {
  ok: true, mode: 'firmware', vendor: 'TP-Link', model: 'TL-SG2428P', current_version: '5.20.27',
  advice: { vendor: 'TP-Link', nos: 'TP-Link', current_version: '5.20.27', has_data: true,
    message: 'Latest firmware for TP-Link: v16.429l-6-5.',
    diff: { current: { vendor: 'TP-Link', nos: 'TP-Link', version: '5.20.27' },
      target: { vendor: 'TP-Link', nos: 'TP-Link', version: '16.429l-6-5', train: 'live-discovered',
        release_notes_url: 'https://support.omadanetworks.com/en/document/2098',
        new_features: [], security_fixes: [], bug_fixes: [], known_issues: [], deprecations: [] },
      releases_behind: 0, intermediate_versions: [] },
    portal_url: null, advisories: [], recommended_min_version: null, release_notes_gated: false },
  elapsed_ms: 12,
};

// The other lab switch: the advisor answers for a DIFFERENT D-Link model.
const dlinkReq = { vendor: 'D-Link', model: 'DGS-1210-52', currentVersion: '6.30.016' };
const dlinkAgentWrongModel = {
  ok: true, mode: 'firmware', vendor: 'D-Link', model: 'DGS-1100-16', current_version: '6.30.016',
  advice: { vendor: 'D-Link', nos: 'D-Link', current_version: '6.30.016', has_data: true,
    message: 'Latest cached firmware for D-Link: v1.00.',
    diff: { current: { vendor: 'D-Link', nos: 'D-Link', version: '6.30.016' },
      target: { vendor: 'D-Link', nos: 'D-Link', version: '6.31.000', train: 'stable',
        release_notes_url: null, new_features: [], security_fixes: [], bug_fixes: [], known_issues: [], deprecations: [] },
      releases_behind: 1, intermediate_versions: [] },
    portal_url: null, advisories: [], recommended_min_version: null, release_notes_gated: false },
  elapsed_ms: 10,
};
const dlinkLookup = {
  vendor: 'D-Link', model: 'DGS-1210-52', current_version: '6.30.016',
  latest_version: null, update_available: null,
  source_url: 'https://www.dlink.com/en/support',
  confidence: null, retrieval_method: 'not_implemented',
  last_checked: '2026-09-07T12:10:01.005151+00:00',
  status: 'not_implemented',
  message: 'Provider not implemented -- no extraction logic has been built for this vendor yet, but its site is reachable right now. You can check the current version yourself using the link below.',
};

// A good advisor row: Cisco IOS-XE with a real release-notes link.
const ciscoReq = { vendor: 'Cisco', model: 'C9300-48P', currentVersion: '17.6.5' };
const ciscoAgentGood = {
  ok: true, mode: 'firmware', vendor: 'Cisco', model: 'C9300-48P', current_version: '17.6.5',
  advice: { vendor: 'Cisco', nos: 'IOS-XE', current_version: '17.6.5', has_data: true,
    message: 'Upgrade available.',
    diff: { current: { vendor: 'Cisco', nos: 'IOS-XE', version: '17.6.5' },
      target: { vendor: 'Cisco', nos: 'IOS-XE', version: '17.9.4a', train: 'stable', is_recommended: true,
        release_notes_url: 'https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-9/release_notes/ol-17-9-9300.html',
        new_features: ['Feature A'], security_fixes: ['Fix B'], bug_fixes: [], known_issues: [], deprecations: [] },
      releases_behind: 3, intermediate_versions: [] },
    portal_url: 'https://software.cisco.com/download/home',
    advisories: [{ cve_id: 'CVE-2024-0001' }],   // must never reach the payload
    recommended_min_version: '17.6.6', release_notes_gated: false },
  elapsed_ms: 9,
};

const runnerFailure = { _runnerError: 'Firmware lookup took too long. Try again in a moment.' };
const agentFailure  = { ok: false, error: 'Agent lookup took too long.' };

// ── plausibleVersion ───────────────────────────────────────────────────────

test('plausibleVersion accepts a version of the same family', () => {
  assert.equal(plausibleVersion('17.9.4a', '17.6.5'), true);
  assert.equal(plausibleVersion('5.20.30', '5.20.27'), true);
  assert.equal(plausibleVersion('6.31.000', '6.30.016'), true);
  assert.equal(plausibleVersion('16.2', '17.6.5'), true);            // digits and dots only
  assert.equal(plausibleVersion('16.430l-7-1', '16.429l-6-5'), true); // same odd shape on both sides
  assert.equal(plausibleVersion('15.2(7)E9', '15.2(7)E8'), true);
});

test('plausibleVersion rejects letters mid-number and other families', () => {
  assert.equal(plausibleVersion('16.429l-6-5', '5.20.27'), false);
  assert.equal(plausibleVersion('802.3af', '16.10.0021'), false);
  assert.equal(plausibleVersion('25.6196C16', '7.16.1'), false);
  assert.equal(plausibleVersion('382.5z', '5.20.27'), false);       // trailing letter, group count differs
  assert.equal(plausibleVersion('15.2(7)E9', '17.6.5'), false);
  assert.equal(plausibleVersion('', '5.20.27'), false);
  assert.equal(plausibleVersion(null, '5.20.27'), false);
  assert.equal(plausibleVersion('latest', '5.20.27'), false);
  assert.equal(plausibleVersion('v5.20.30', '5.20.27'), false);     // must start with a digit
});

// ── fromLookup ─────────────────────────────────────────────────────────────

test('TP-Link auth_required is an answer: ok, status, portal, no latest', () => {
  const p = fromLookup(tplinkLookup, tplinkReq);
  assert.equal(p.ok, true);
  assert.equal(p.source, 'lookup');
  assert.equal(p.status, 'auth_required');
  assert.equal(p.portalUrl, 'https://www.tp-link.com/us/support');
  assert.equal(p.releaseNotesUrl, null, 'a support portal is not release notes');
  assert.equal(p.latestVersion, null);
  assert.equal(p.upToDate, null);
  assert.equal(p.currentVersion, '5.20.27');
  assert.equal(p.authRequired, true);
  assert.equal(p.statusValue, 'auth_required');
  assert.ok(!p.message.includes('\n'), 'message is one line');
  assert.equal(p.error, undefined);
});

test('a lookup status ok carries latest, upToDate and a release-notes link only when it is one', () => {
  const okRes = { ...tplinkLookup, status: 'ok', latest_version: '5.20.30', update_available: true,
    source_url: 'https://www.tp-link.com/us/support/download/tl-sg2428p/v4/#Firmware', confidence: 'High' };
  const p = fromLookup(okRes, tplinkReq);
  assert.equal(p.ok, true);
  assert.equal(p.status, 'ok');
  assert.equal(p.latestVersion, '5.20.30');
  assert.equal(p.upToDate, false);
  assert.equal(p.portalUrl, okRes.source_url);
  assert.equal(p.releaseNotesUrl, null);
  const notes = fromLookup({ ...okRes, source_url: 'https://example.com/docs/release-notes/5.20.30' }, tplinkReq);
  assert.equal(notes.releaseNotesUrl, 'https://example.com/docs/release-notes/5.20.30');
});

test('an unknown lookup status is reported as cannot_determine, never as an error', () => {
  const p = fromLookup({ ...tplinkLookup, status: 'something_new', latest_version: '9.9.9' }, tplinkReq);
  assert.equal(p.ok, true);
  assert.equal(p.status, 'cannot_determine');
  assert.equal(p.latestVersion, null, 'latest is only ever set for status ok');
});

test('a lookup runner failure is the only ok:false', () => {
  const p = fromLookup(runnerFailure, tplinkReq);
  assert.equal(p.ok, false);
  assert.equal(p.status, null);
  assert.equal(p.error, 'Firmware lookup took too long. Try again in a moment.');
  assert.equal(p.currentVersion, '5.20.27');
  assert.equal(fromLookup(undefined, tplinkReq).ok, false);
});

// ── fromAgent ──────────────────────────────────────────────────────────────

test('agent with no data has nothing trustworthy', () => {
  assert.equal(fromAgent(tplinkAgentEmpty, tplinkReq), null);
  assert.equal(fromAgent(agentFailure, tplinkReq), null);
  assert.equal(fromAgent(null, tplinkReq), null);
});

test('agent junk "16.429l-6-5" is rejected so the lookup wins', () => {
  assert.equal(fromAgent(tplinkAgentJunk, tplinkReq), null);
  const p = combine({ agentRes: tplinkAgentJunk, lookupRes: tplinkLookup, req: tplinkReq });
  assert.equal(p.source, 'lookup');
  assert.equal(p.ok, true);
  assert.equal(p.status, 'auth_required');
  assert.equal(p.latestVersion, null);
  assert.equal(p.portalUrl, 'https://www.tp-link.com/us/support');
});

test('agent answering for a different model is rejected so the lookup wins', () => {
  assert.equal(fromAgent(dlinkAgentWrongModel, dlinkReq), null);
  const p = combine({ agentRes: dlinkAgentWrongModel, lookupRes: dlinkLookup, req: dlinkReq });
  assert.equal(p.source, 'lookup');
  assert.equal(p.ok, true);
  assert.equal(p.status, 'not_implemented');
  assert.equal(p.latestVersion, null);
  assert.equal(p.portalUrl, 'https://www.dlink.com/en/support');
  assert.equal(p.currentVersion, '6.30.016');
});

test('a live-discovered row must be of the same family, even when plausible on its own', () => {
  const liveTwoGroups = JSON.parse(JSON.stringify(ciscoAgentGood));
  liveTwoGroups.advice.diff.target.version = '16.2';   // scraped from a Nexus support page
  liveTwoGroups.advice.diff.target.train = 'live-discovered';
  assert.equal(fromAgent(liveTwoGroups, ciscoReq), null);
  const liveSameFamily = JSON.parse(JSON.stringify(ciscoAgentGood));
  liveSameFamily.advice.diff.target.version = '17.12.4';
  liveSameFamily.advice.diff.target.train = 'live-discovered';
  assert.equal(fromAgent(liveSameFamily, ciscoReq)?.latestVersion, '17.12.4');
});

test('agent good row (Cisco 17.9.4a vs 17.6.5) wins: ok, status ok, latest, behind', () => {
  const p = combine({ agentRes: ciscoAgentGood, lookupRes: runnerFailure, req: ciscoReq });
  assert.equal(p.ok, true);
  assert.equal(p.source, 'agent');
  assert.equal(p.status, 'ok');
  assert.equal(p.latestVersion, '17.9.4a');
  assert.equal(p.upToDate, false);
  assert.equal(p.currentVersion, '17.6.5');
  assert.equal(p.model, 'C9300-48P');
  assert.equal(p.releaseNotesUrl, ciscoAgentGood.advice.diff.target.release_notes_url);
  assert.equal(p.portalUrl, 'https://software.cisco.com/download/home');
  assert.equal(p.recommendedMinVersion, '17.6.6');
  assert.deepEqual(p.changelog.map(c => c.section), ['Security fixes in 17.9.4a', 'New features in 17.9.4a']);
  assert.equal('advisories' in p, false, 'CVE rows never reach the payload');
  assert.equal(JSON.stringify(p).includes('CVE-'), false);
});

test('the agent model match is case and dash insensitive, and the raw query echo counts', () => {
  const lower = { ...ciscoAgentGood, model: 'c9300 48p' };
  assert.equal(fromAgent(lower, ciscoReq)?.latestVersion, '17.9.4a');
  const echo = { ...ciscoAgentGood, model: 'Cisco C9300-48P' };
  assert.equal(fromAgent(echo, ciscoReq)?.latestVersion, '17.9.4a');
  const other = { ...ciscoAgentGood, model: 'C9300-24P' };
  assert.equal(fromAgent(other, ciscoReq), null);
});

test('running the latest, or newer than it, is up to date', () => {
  const same = JSON.parse(JSON.stringify(ciscoAgentGood));
  same.advice.diff.target.version = '17.6.5';
  assert.equal(fromAgent(same, ciscoReq).upToDate, true);
  const newer = JSON.parse(JSON.stringify(ciscoAgentGood));
  newer.advice.diff.target.version = '17.6.4';
  assert.equal(fromAgent(newer, ciscoReq).upToDate, true);
});

// ── combine ────────────────────────────────────────────────────────────────

test('runner failure on both is ok:false with an error, current version intact', () => {
  const p = combine({ agentRes: agentFailure, lookupRes: runnerFailure, req: tplinkReq });
  assert.equal(p.ok, false);
  assert.equal(p.status, null);
  assert.equal(p.error, 'Firmware lookup took too long. Try again in a moment.');
  assert.equal(p.currentVersion, '5.20.27');
  assert.equal(p.latestVersion, null);
});

test('lookup runner failure with an advisor that ran but has no data is still ok:false', () => {
  // The endpoint sends 502 exactly when ok is false, so this combination must
  // not slip through as a 200 with an error body.
  const p = combine({ agentRes: tplinkAgentEmpty, lookupRes: runnerFailure, req: tplinkReq });
  assert.equal(p.ok, false);
  assert.equal(p.status, null);
  assert.equal(p.latestVersion, null);
  assert.equal(p.error, 'Firmware lookup took too long. Try again in a moment.');
  assert.equal(p.currentVersion, '5.20.27');
});

test('the lookup answers when the agent runner failed', () => {
  const p = combine({ agentRes: agentFailure, lookupRes: tplinkLookup, req: tplinkReq });
  assert.equal(p.ok, true);
  assert.equal(p.status, 'auth_required');
});

test('combine always carries the caller\'s currentVersion through unchanged', () => {
  const req = { vendor: 'TP-Link', model: 'TL-SG2428P', currentVersion: '5.20.27 ' };
  const p = combine({ agentRes: tplinkAgentEmpty, lookupRes: { ...tplinkLookup, current_version: '5.20' }, req });
  assert.equal(p.currentVersion, '5.20.27 ');
});
