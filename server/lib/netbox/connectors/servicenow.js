/**
 * ServiceNow CMDB connector.
 *
 * ServiceNow keeps configuration items in CMDB tables (cmdb_ci_ip_switch and
 * friends). This maps each device we found to a CI row and writes it through
 * the Table API, matching on a correlation id so a re-scan updates the same CI
 * rather than making a second one. Racks and cables are out of scope for this
 * first pass; devices are the value.
 *
 * The row shaping is a pure function so it can be tested without an instance.
 * The HTTP path uses the same fetch as every other connector.
 */
const norm = (s) => String(s || '').trim();

/** A device -> a ServiceNow CI row, with the fields the CMDB actually uses. */
function toCiRow(device, typeByUid, mfrByUid) {
  const type = typeByUid.get(device.deviceTypeUid);
  const model = type?.model || '';
  const mfr = type ? (mfrByUid.get(type.manufacturerUid) || '') : '';
  return {
    // correlation_id is ServiceNow's own field for "this came from another
    // system"; keying on it is what makes the write idempotent.
    correlation_id: device.uid,
    name: device.name,
    serial_number: norm(device.serial),
    asset_tag: norm(device.assetTag),
    model_id: norm(model),
    manufacturer: norm(mfr),
    u_height: type?.uHeight || 1,
    short_description: [mfr, model].filter(Boolean).join(' '),
    ip_address: norm(device.customFields && device.customFields.managementIp),
  };
}

function rowsFrom(snapshot) {
  const typeByUid = new Map((snapshot.deviceTypes || []).map((t) => [t.uid, t]));
  const mfrByUid = new Map((snapshot.manufacturers || []).map((m) => [m.uid, m.name]));
  return (snapshot.devices || []).map((d) => toCiRow(d, typeByUid, mfrByUid));
}

function auth(cfg) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64'),
  };
}

async function req(url, method, headers, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text.slice(0, 300); }
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  type: 'servicenow',
  label: 'ServiceNow CMDB',
  fields: [
    { key: 'instanceUrl', label: 'Instance URL', required: true, placeholder: 'https://acme.service-now.com' },
    { key: 'username', label: 'Username', required: true },
    { key: 'password', label: 'Password', required: true, secret: true },
    { key: 'table', label: 'CI table', default: 'cmdb_ci_ip_switch',
      help: 'The CMDB table devices are written to' },
  ],

  validate(cfg) {
    if (!cfg.instanceUrl || !/^https?:\/\//i.test(cfg.instanceUrl)) {
      return { ok: false, error: 'A full https instance URL is required.' };
    }
    if (!cfg.username || !cfg.password) return { ok: false, error: 'A username and password are required.' };
    return { ok: true };
  },

  async test(cfg) {
    const table = cfg.table || 'cmdb_ci_ip_switch';
    const url = `${cfg.instanceUrl.replace(/\/+$/, '')}/api/now/table/${table}?sysparm_limit=1`;
    try {
      const res = await req(url, 'GET', auth(cfg));
      if (res.ok) return { ok: true, message: `Reachable, and the ${table} table answered.` };
      return { ok: false, message: `ServiceNow replied ${res.status}. Check the URL, login, and table name.` };
    } catch (e) {
      return { ok: false, message: `Could not reach it: ${e.message || e}` };
    }
  },

  async export(snapshot, cfg, { apply }) {
    const rows = rowsFrom(snapshot);
    const changes = rows.map((r) => ({ type: 'CI', name: r.name, action: 'create' }));
    if (!apply) {
      return { ok: true, dryRun: true, type: 'servicenow', target: cfg.instanceUrl,
               counts: { create: rows.length }, changes, warnings: [] };
    }

    const base = `${cfg.instanceUrl.replace(/\/+$/, '')}/api/now/table/${cfg.table || 'cmdb_ci_ip_switch'}`;
    const headers = auth(cfg);
    const warnings = [];
    let created = 0; let updated = 0;

    for (const row of rows) {
      // Idempotent: find an existing CI by correlation_id, then PATCH or POST.
      let existing = null;
      try {
        const q = await req(`${base}?sysparm_query=correlation_id=${encodeURIComponent(row.correlation_id)}&sysparm_limit=1`, 'GET', headers);
        existing = q.ok && q.body && q.body.result && q.body.result[0];
      } catch (e) { warnings.push(`lookup failed for ${row.name}: ${e.message}`); break; }

      try {
        if (existing && existing.sys_id) {
          const r = await req(`${base}/${existing.sys_id}`, 'PATCH', headers, row);
          if (r.ok) updated += 1; else warnings.push(`${row.name}: update ${r.status}`);
        } else {
          const r = await req(base, 'POST', headers, row);
          if (r.ok) created += 1; else warnings.push(`${row.name}: create ${r.status}`);
        }
      } catch (e) { warnings.push(`${row.name}: ${e.message}`); break; }
    }

    return { ok: warnings.length === 0, dryRun: false, type: 'servicenow', target: cfg.instanceUrl,
             counts: { create: created, update: updated }, changes, warnings };
  },

  // exported for tests
  _rowsFrom: rowsFrom,
  _toCiRow: toCiRow,
};
