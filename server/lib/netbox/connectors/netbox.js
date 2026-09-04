/**
 * NetBox connector — the reference implementation.
 *
 * Every connector is the same shape: a field list the UI can render, a
 * validate, a test, and an export that plans (dry run) or pushes. NetBox was
 * here first, so this is a thin wrapper over the existing writer and client
 * rather than anything new. The point is that NetBox is now one target among
 * several, reached through the same door as the rest.
 */
const { NetBox } = require('../netbox');
const writer = require('../writer');

module.exports = {
  type: 'netbox',
  label: 'NetBox',
  fields: [
    { key: 'url', label: 'NetBox URL', required: true, placeholder: 'https://netbox.example' },
    { key: 'token', label: 'API token', required: true, secret: true },
  ],

  validate(cfg) {
    if (!cfg.url) return { ok: false, error: 'A NetBox URL is required.' };
    if (!cfg.token) return { ok: false, error: 'An API token is required.' };
    return { ok: true };
  },

  async test(cfg) {
    const nb = new NetBox(cfg.url, cfg.token);
    try {
      const s = await nb.status();
      return { ok: true, message: `Reachable. NetBox ${s['netbox-version'] || ''}`.trim() };
    } catch (e) {
      return { ok: false, message: `Could not reach or authenticate: ${e.message || e}` };
    }
  },

  async export(snapshot, cfg, { apply }) {
    const nb = new NetBox(cfg.url, cfg.token);
    const report = apply
      ? await writer.push(snapshot, nb)
      : await writer.plan(snapshot, nb, { ensureField: false });
    return {
      ok: true, dryRun: !apply, type: 'netbox', target: cfg.url,
      counts: report.counts, changes: report.changes,
      warnings: report.warnings, orphans: report.orphans,
    };
  },
};
