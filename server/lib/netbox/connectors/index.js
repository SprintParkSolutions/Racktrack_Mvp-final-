/**
 * The connector registry.
 *
 * One place that knows every target we can export to. A new CMDB is a new file
 * here and one line in ALL; nothing else in the app changes. Each module is the
 * same shape: { type, label, fields, validate, test, export }.
 */
const netbox = require('./netbox');
const rest = require('./rest');
const servicenow = require('./servicenow');

const ALL = [netbox, rest, servicenow];
const byType = Object.fromEntries(ALL.map((c) => [c.type, c]));

/** The catalogue the UI renders: what targets exist and what each needs. */
const types = () => ALL.map((c) => ({ type: c.type, label: c.label, fields: c.fields }));

const get = (type) => byType[type] || null;

module.exports = { ALL, byType, types, get };
