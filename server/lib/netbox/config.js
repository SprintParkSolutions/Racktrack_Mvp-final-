/**
 * Configuration. Everything overridable by environment variable, nothing
 * secret committed.
 *
 * SITE_NAME and RACK_NAME are empty by default on purpose. You name your own
 * site and rack: a human looking and typing is MANUAL evidence. The export
 * refuses rather than inventing a plausible site name.
 */
const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT || 8200),
  // Bind to loopback by default: this holds photographs of customer
  // infrastructure and must not be reachable from the office network unless
  // someone deliberately changes it.
  HOST: process.env.HOST || '127.0.0.1',

  NETBOX_URL: process.env.NETBOX_URL || 'http://localhost:8000',
  NETBOX_TOKEN: process.env.NETBOX_TOKEN || '',
  // Where a person can open NetBox in a browser, when it is exposed somewhere
  // (the demo serves it under https://demo.racktrack.ai/netbox). Empty = none.
  NETBOX_PUBLIC_URL: (process.env.NETBOX_PUBLIC_URL || '').replace(/\/+$/, ''),

  SITE_NAME: process.env.RT_SITE_NAME || '',
  RACK_NAME: process.env.RT_RACK_NAME || '',
  // No default, and no longer asked for in the UI. A rack's U height cannot be
  // seen in a photograph and is not a constant of the world: 42U is common in
  // data centres, but wall boxes and comms cabinets run 6, 9, 12, 18 and 24,
  // and tall racks run 45, 47 and 48. Assuming 42 wrote a wrong number into
  // NetBox for every rack that is not one. Unset means "not stated", and the
  // exporter omits the field so NetBox applies its own default.
  U_HEIGHT: process.env.RT_U_HEIGHT ? Number(process.env.RT_U_HEIGHT) : null,

  CLIENT_DIST: process.env.RT_CLIENT_DIST
    || path.join(__dirname, '..', '..', 'client', 'dist'),

  /**
   * The pipeline, in order, with its honest build state. The UI reads this so
   * a stage that does not exist yet cannot look finished.
   */
  STAGES: [
    { key: 'capture',   name: 'Capture',   desc: 'Photograph the rack',                     built: true },
    { key: 'detect',    name: 'Detect',    desc: 'Find devices, U positions and ports',     built: true },
    { key: 'collect',   name: 'Collect',   desc: 'Ask the switches: model, serial, ports, neighbours', built: true },
    { key: 'reconcile', name: 'Reconcile', desc: 'Join camera and network, score every fact', built: true },
    { key: 'review',    name: 'Review',    desc: 'A human settles conflicts and gaps',      built: true },
    { key: 'preview',   name: 'Preview',   desc: 'Dry-run diff against NetBox',             built: true },
    { key: 'export',    name: 'Export',    desc: 'Write to NetBox',                         built: true },
  ],

  /** Why a stage is not built. Shown instead of a fake success. */
  BLOCKED: {
  },
};
