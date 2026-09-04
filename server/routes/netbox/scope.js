/**
 * Tenant scoping for the NetBox routers.
 *
 * The standalone build had one user and no login, so its store has no notion
 * of who owns what. Inside RackTrack every one of its records — a scan, a
 * switch, an unmanaged device — is keyed by a rack id, and RackTrack already
 * knows exactly which organisation and site own each rack. So nothing is
 * copied into the NetBox store: access to a record IS access to its rack,
 * decided by the same canAccessRack() every other rack route uses. One source
 * of truth, no second table to drift.
 *
 * Owner sees everything. An org admin sees their organisation's racks. Anyone
 * else sees their own site's. A miss is a 404, not a 403, so nobody learns
 * that a rack exists in another tenant.
 */
const tenant = require('../../lib/tenant');
const { canAccessRack, isValidRackId } = require('../../lib/rack_access');

const allowed = (req, rackId) => canAccessRack(req.user, rackId, tenant);

/**
 * Middleware: resolve the rack this request is about, then check the caller
 * may touch it. `resolve(req)` returns the rack id, `null` when the record it
 * would come from does not exist (→ 404), or undefined when the request did
 * not name one (→ 400). The resolved id is left on req.rackId for the handler.
 */
function requireRack(resolve) {
  return (req, res, next) => {
    let rackId;
    try { rackId = resolve(req); } catch { rackId = undefined; }
    if (rackId === null) return res.status(404).json({ error: 'Not found.' });
    if (!isValidRackId(rackId)) return res.status(400).json({ error: 'A valid rack id is required.' });
    if (!allowed(req, rackId)) return res.status(404).json({ error: 'Rack not found.' });
    req.rackId = rackId;
    return next();
  };
}

/** Filter rack-keyed records down to the ones the caller may see. */
function visible(req, records, rackOf = (r) => r.rackId) {
  if (req.user?.role === 'owner') return records;
  return records.filter((r) => {
    const id = rackOf(r);
    return isValidRackId(id) && allowed(req, id);
  });
}

module.exports = { requireRack, visible, allowed };
