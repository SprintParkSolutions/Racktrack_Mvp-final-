// HTTP wrappers around /api/connections — saved per-user credentials for
// external data sources (ServiceNow, NetBox, SolarWinds Orion, etc.).
// All calls go through authFetch so the user's bearer token is attached.
import { apiUrl, authFetch } from './api';

// Data Sources belong to the organisation. The page used to save them per
// user while Export resolved them per organisation, so a NetBox added on the
// page was stored and never used. An account with an organisation reads and
// writes the organisation's set; an owner account with none keeps a set of
// its own, which the server also consults.
let orgScoped = false;
export function setConnectionsScope({ org }) { orgScoped = Boolean(org); }
export const connectionsAreOrgScoped = () => orgScoped;
const base = () => (orgScoped ? '/api/org-connections' : '/api/connections');

async function asJson(res) {
  let data = {};
  try { data = await res.json(); } catch { /* tolerate non-JSON body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function listConnections() {
  const res = await authFetch(apiUrl(base()));
  const data = await asJson(res);
  return {
    profiles: data.profiles || [],
    supportedTypes: data.supported_types || [],
  };
}

export async function getActiveConnection() {
  const res = await authFetch(apiUrl('/api/connections/active'));
  const data = await asJson(res);
  return data.active || null;
}

export async function createConnection({ name, type, secret, makeActive = true }) {
  const res = await authFetch(apiUrl(base()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, secret, make_active: makeActive }),
  });
  const data = await asJson(res);
  return data.profile;
}

export async function updateConnection(id, { name, secret } = {}) {
  const body = {};
  if (name !== undefined)   body.name = name;
  if (secret !== undefined) body.secret = secret;
  const res = await authFetch(apiUrl(`${base()}/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await asJson(res);
  return data.profile;
}

export async function activateConnection(id) {
  const res = await authFetch(apiUrl(`/api/connections/${id}/activate`), {
    method: 'POST',
  });
  const data = await asJson(res);
  return data.profile;
}

export async function deactivateConnections() {
  const res = await authFetch(apiUrl('/api/connections/deactivate'), {
    method: 'POST',
  });
  await asJson(res);
}

export async function deleteConnection(id) {
  const res = await authFetch(apiUrl(`${base()}/${id}`), {
    method: 'DELETE',
  });
  await asJson(res);
}

// Kicks off the ServiceNow inbox poll against the user's active profile
// and returns IMMEDIATELY — the poll itself can take up to a few minutes
// when a developer PDI is cold. Caller should poll getRefreshStatus()
// until state !== 'running'.
export async function refreshIncidents() {
  const res = await authFetch(apiUrl('/api/incidents/refresh'), {
    method: 'POST',
  });
  return await asJson(res);
}

// Returns the latest poll job state: { state, instance, startedAt,
// finishedAt, count, error }. state is one of 'idle' | 'running' |
// 'done' | 'failed'. Safe to call frequently — the server just reads
// an in-memory record.
export async function getRefreshStatus() {
  const res = await authFetch(apiUrl('/api/incidents/refresh/status'));
  return await asJson(res);
}

// ── Org-scoped connections (admin-set, org-wide, write-only) ──
// Managed by an org_admin; used by the whole org's pipeline. The server never
// returns the secret — list() gives metadata only. Create replaces any prior
// credential of the same type.
export async function listOrgConnections() {
  const res = await authFetch(apiUrl('/api/org-connections'));
  const data = await asJson(res);
  return { profiles: data.profiles || [], supportedTypes: data.supported_types || [] };
}

export async function createOrgConnection({ name, type, secret }) {
  const res = await authFetch(apiUrl('/api/org-connections'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, secret }),
  });
  const data = await asJson(res);
  return data.profile;
}

export async function deleteOrgConnection(id) {
  const res = await authFetch(apiUrl(`/api/org-connections/${id}`), { method: 'DELETE' });
  await asJson(res);
}

// Human labels + field schemas for each supported backend type. Used by
// the connection-picker UI to render the right form fields.
export const TYPE_INFO = {
  servicenow: {
    label: 'ServiceNow / CMDB',
    fields: [
      { key: 'instance', label: 'Instance ID',  placeholder: 'dev266363', required: true },
      { key: 'user',     label: 'Username',     placeholder: 'admin',     required: true },
      { key: 'password', label: 'Password',     type: 'password',         required: true },
    ],
    hint: 'Use just the instance ID - the part before .service-now.com',
  },
  netbox: {
    label: 'NetBox',
    fields: [
      { key: 'base_url', label: 'NetBox address', placeholder: 'https://netbox.example.com', required: true },
      { key: 'username', label: 'Username',       placeholder: 'your NetBox login',          required: true },
      { key: 'password', label: 'Password',       type: 'password',                          required: true },
    ],
    hint: 'RackTrack signs in to your NetBox once and keeps an API token from then on. Your password is stored encrypted and never shown.',
  },
  orion: {
    label: 'SolarWinds Orion',
    fields: [
      { key: 'host',     label: 'Host',     placeholder: 'orion.example.com', required: true },
      { key: 'user',     label: 'Username', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
    ],
    hint: 'SolarWinds Orion NPM / NCM server',
  },
  spectrum: {
    label: 'CA / DX Spectrum',
    fields: [
      { key: 'base_url', label: 'Base URL', placeholder: 'https://spectrum.example.com:8443', required: true },
      { key: 'user',     label: 'Username', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
    ],
    hint: 'Spectrum OneClick / REST endpoint',
  },
  generic_sql: {
    label: 'My own database (SQL)',
    fields: [
      { key: 'connection_string', label: 'Connection string',
        placeholder: 'postgresql://user:pass@host:5432/dbname', required: true },
    ],
    hint: 'PostgreSQL or MySQL connection string',
  },
  generic_rest: {
    label: 'My own database (REST)',
    fields: [
      { key: 'base_url', label: 'Base URL', placeholder: 'https://cmdb.example.com/api', required: true },
      { key: 'token',    label: 'API Token (optional)', type: 'password' },
    ],
    hint: 'Generic REST endpoint that returns device / interface JSON',
  },
};
