'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const entered = require('../../lib/netbox/entered');

function snapshotWith(devices) {
  return {
    manufacturers: [{ uid: 'mfr:unknown', name: 'Unknown' }],
    deviceTypes: [{ uid: 'dtype:unidentified-switch', manufacturerUid: 'mfr:unknown', model: 'Unidentified Switch', uHeight: 1 }],
    devices,
  };
}

function withOverrides(rackId, overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-entered-'));
  fs.mkdirSync(path.join(dir, rackId));
  fs.writeFileSync(path.join(dir, rackId, 'device_overrides.json'), JSON.stringify(overrides));
  return dir;
}

test('the typed make and model land on the device at that U', () => {
  const dir = withOverrides('RK-TEST0001', { U14: { make: 'TP-Link', model: 'TL-SG2428P', firmware: null } });
  const snap = snapshotWith([{ uid: 'd14', position: 14, deviceTypeUid: 'dtype:unidentified-switch' }]);
  entered.applyTo(snap, 'RK-TEST0001', { outputsDir: dir });
  const dev = snap.devices[0];
  const type = snap.deviceTypes.find((t) => t.uid === dev.deviceTypeUid);
  const mfr = snap.manufacturers.find((m) => m.uid === type.manufacturerUid);
  assert.equal(type.model, 'TL-SG2428P');
  assert.equal(mfr.name, 'TP-Link');
  assert.deepEqual(dev.provenance.entered, { make: 'TP-Link', model: 'TL-SG2428P' });
});

test('a make alone re-points the existing type at that maker', () => {
  const dir = withOverrides('RK-TEST0002', { U04: { make: 'D-Link' } });
  const snap = snapshotWith([{ uid: 'd4', position: 4, deviceTypeUid: 'dtype:unidentified-switch' }]);
  entered.applyTo(snap, 'RK-TEST0002', { outputsDir: dir });
  const type = snap.deviceTypes.find((t) => t.uid === snap.devices[0].deviceTypeUid);
  assert.equal(type.model, 'Unidentified Switch');
  assert.equal(snap.manufacturers.find((m) => m.uid === type.manufacturerUid).name, 'D-Link');
});

test('positions match however the key is written, and other devices are untouched', () => {
  const dir = withOverrides('RK-TEST0003', { u7: { model: 'DGS-1024C' } });
  const snap = snapshotWith([
    { uid: 'd7', position: 7, deviceTypeUid: 'dtype:unidentified-switch' },
    { uid: 'd8', position: 8, deviceTypeUid: 'dtype:unidentified-switch' },
  ]);
  entered.applyTo(snap, 'RK-TEST0003', { outputsDir: dir });
  assert.equal(snap.deviceTypes.find((t) => t.uid === snap.devices[0].deviceTypeUid).model, 'DGS-1024C');
  assert.equal(snap.devices[1].deviceTypeUid, 'dtype:unidentified-switch');
});

test('no file, an empty entry, or a bad rack id changes nothing', () => {
  const dir = withOverrides('RK-TEST0004', { U01: { make: '', model: null } });
  const snap = snapshotWith([{ uid: 'd1', position: 1, deviceTypeUid: 'dtype:unidentified-switch' }]);
  const before = JSON.stringify(snap);
  entered.applyTo(snap, 'RK-TEST0004', { outputsDir: dir });
  entered.applyTo(snap, 'RK-NOPE', { outputsDir: dir });
  entered.applyTo(snap, '../etc', { outputsDir: dir });
  assert.equal(JSON.stringify(snap), before);
});

test('unitOf reads every spelling of a U', () => {
  assert.equal(entered.unitOf('U04'), 4);
  assert.equal(entered.unitOf('u14'), 14);
  assert.equal(entered.unitOf(9), 9);
  assert.equal(entered.unitOf('SW04'), null);
});
