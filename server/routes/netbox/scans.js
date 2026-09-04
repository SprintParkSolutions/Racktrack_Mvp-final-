/**
 * Capture and Detect: upload a rack photo, run the CV engine, store the result.
 */
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

const cfg = require('../../lib/netbox/config');
const reader = require('../../lib/netbox/reader');
const cv = require('../../lib/netbox/cv');
const store = require('../../lib/netbox/store');
const switches = require('../../lib/netbox/switches');
const reconcile = require('../../lib/netbox/reconcile');
const report = require('../../lib/netbox/report');

const router = express.Router();

store.init();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype);
    cb(ok ? null : new Error(`unsupported file type: ${file.mimetype}`), ok);
  },
});

/** Is the CV engine installed and are all its weights present? */
router.get('/engine', (req, res) => res.json(cv.engineStatus()));

router.get('/', (req, res) => res.json(store.listScans()));

/**
 * The scan history for one rack, newest first, with a plain summary of what
 * changed between each scan and the one before it. This is how a rack accrues a
 * record over time rather than a pile of unrelated scans.
 */
router.get('/:id/report', (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const doc = report.build(scan);
  if (!doc) return res.status(409).json({ error: 'this scan has no detection result yet' });
  res.json(doc);
});

router.get('/rack/:rackId/history', (req, res) => {
  const scans = store.scansForRack(req.params.rackId)
    .filter((s) => s.stages && s.stages.detect && s.stages.detect.status === 'ok')
    .map((s) => {
      const full = store.getScan(s.id);
      return { id: s.id, createdAt: s.createdAt, rackName: s.rackName || s.rackId,
               snapshot: full && full.payload ? full.payload.snapshot : null };
    });
  const history = scans.map((s, i) => {
    const older = scans[i + 1];   // the index is already newest-first
    const sum = s.snapshot ? summarise(s.snapshot) : { devices: 0, ports: 0 };
    return {
      id: s.id, createdAt: s.createdAt, rackName: s.rackName,
      devices: sum.devices, ports: sum.ports,
      change: older && older.snapshot && s.snapshot
        ? changeSummary(older.snapshot, s.snapshot) : null,
    };
  });
  res.json({ rackId: req.params.rackId, scans: history });
});

/**
 * Upload a photo and run detection on it.
 *
 * Synchronous on purpose for now: one rack takes under a minute and a job
 * queue would be machinery without a problem to solve yet. When video or
 * multi-rack lands, this becomes a queued job and the UI polls.
 */
router.post('/', upload.single('image'), async (req, res) => {
  const engine = cv.engineStatus();
  if (!engine.ready) {
    return res.status(503).json({
      stage: 'detect',
      error: 'The CV engine is not ready.',
      detail: engine.pythonPresent
        ? `Models missing: ${engine.modelsPresent}/${engine.modelsTotal} present.`
        : `No Python environment at ${engine.python}.`,
      engine,
    });
  }
  if (!req.file) return res.status(400).json({ error: 'no image uploaded (field name: image)' });

  const siteName = (req.body.siteName || cfg.SITE_NAME || '').trim();
  if (!siteName) {
    return res.status(400).json({
      error: 'siteName is required. You name your own site: '
           + 'send siteName with the upload, or set RT_SITE_NAME.',
    });
  }
  const rackId = (req.body.rackId || `RK-${Date.now().toString(36).toUpperCase()}`).trim();
  const rackName = (req.body.rackName || cfg.RACK_NAME || rackId).trim();

  // Rack height is not asked for and not guessed. The camera cannot see it,
  // the operator was being made to type a number they often do not know, and
  // NetBox has a sensible default of its own. Left null, the exporter omits
  // the field entirely rather than sending a height nobody stated. Set
  // RT_U_HEIGHT if a site genuinely needs one pinned.
  const rawU = cfg.U_HEIGHT;
  const parsedU = rawU === null || rawU === undefined || rawU === '' ? null : Number(rawU);
  const uHeight = Number.isInteger(parsedU) && parsedU >= 1 && parsedU <= 100 ? parsedU : null;

  // Fingerprint the photo before running the models. If it closely matches a
  // rack already scanned, the minute of vision work is worth pausing to ask the
  // operator whether anything actually changed.
  const imageHash = await cv.imageHash(req.file.path).catch(() => null);
  const force = String(req.body.force || '') === 'true';
  const SAME_RACK = 0.90;

  if (imageHash && !force) {
    const match = store.findSimilarScan(imageHash);
    if (match && match.similarity >= SAME_RACK) {
      // Keep the photo and file the scan, but hold off on detection until the
      // operator decides. Nothing is analysed and nothing is thrown away.
      const rec = store.addScan({
        rackId, source: 'capture', imagePath: req.file.path, imageHash, rackName, siteName,
        payload: { siteName, rackName, uHeight, imageHash, pending: true },
      });
      store.recordStage(rec.id, 'capture', 'ok', path.basename(req.file.path));
      return res.json({
        scanId: rec.id,
        pending: true,
        duplicate: {
          matchScanId: match.id,
          rackId: match.rackId,
          rackName: match.rackName || match.rackId,
          scannedAt: match.createdAt,
          similarity: Math.round(match.similarity * 100),
        },
      });
    }
  }

  const rec = store.addScan({
    rackId, source: 'capture', imagePath: req.file.path, imageHash, rackName, siteName, payload: {},
  });
  const outputDir = path.join(store.SCANS_DIR, `${rec.id}-cv`);

  try {
    const { map, stderr } = await cv.runDetect(req.file.path, outputDir);
    const snapshot = cv.toSnapshot(map, {
      rackId, siteName, rackName, uHeight, scannedAt: rec.createdAt,
    });
    store.setPayload(rec.id, { map, snapshot, siteName, rackName, uHeight, imageHash });
    store.recordStage(rec.id, 'capture', 'ok', path.basename(req.file.path));
    store.recordStage(rec.id, 'detect', 'ok',
      `${snapshot.devices.length} devices · ${snapshot.interfaces.length} ports`
      + (snapshot.conflicts.length ? ` · ${snapshot.conflicts.length} conflict(s)` : ''));
    res.json({ scanId: rec.id, rackId, summary: summarise(snapshot), warnings: tail(stderr) });
  } catch (err) {
    store.recordStage(rec.id, 'detect', 'failed', String(err.message).slice(0, 500));
    res.status(500).json({ stage: 'detect', scanId: rec.id, error: String(err.message) });
  }
});

/**
 * Run detection again on a scan that already has its photograph.
 *
 * Detection used to happen exactly once, inside the upload, so a scan that was
 * taken while the engine was half-installed — or before a model was retrained
 * — could only be fixed by photographing the rack a second time. The picture
 * was never the problem. This re-reads the stored image and replaces the
 * result; the scan keeps its id, its rack and its place in the history.
 */
router.post('/:id/detect', async (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  if (!scan.imagePath || !fs.existsSync(scan.imagePath)) {
    return res.status(409).json({
      stage: 'detect',
      error: 'This scan has no stored photograph to analyse again.',
    });
  }

  const engine = cv.engineStatus();
  if (!engine.ready) {
    return res.status(503).json({
      stage: 'detect',
      error: 'The CV engine is not ready.',
      detail: engine.pythonPresent
        ? `Models missing: ${engine.modelsPresent}/${engine.modelsTotal} present.`
        : `No Python environment at ${engine.python}.`,
      engine,
    });
  }

  // Whatever the scan was filed under stays what it is filed under. Detection
  // reads a photograph; it does not get to rename a rack or move a site.
  const siteName = scan.payload.siteName || cfg.SITE_NAME || '';
  const rackName = scan.payload.rackName || scan.rackId;
  const uHeight = scan.payload.uHeight ?? null;
  const outputDir = path.join(store.SCANS_DIR, `${scan.id}-cv`);

  try {
    const { map, stderr } = await cv.runDetect(scan.imagePath, outputDir);
    const snapshot = cv.toSnapshot(map, {
      rackId: scan.rackId, siteName, rackName, uHeight, scannedAt: scan.createdAt,
    });
    // The operator's note on what changed since the last scan, kept with the
    // scan so the rack's history reads as a record, not just a pile of scans.
    const changeNote = String((req.body && req.body.note) || '').trim().slice(0, 500) || null;
    store.setPayload(scan.id, {
      map, snapshot, siteName, rackName, uHeight,
      imageHash: scan.payload.imageHash || null,
      changeNote,
    });
    store.recordStage(scan.id, 'detect', 'ok',
      `${snapshot.devices.length} devices \u00b7 ${snapshot.interfaces.length} ports`
      + (snapshot.conflicts.length ? ` \u00b7 ${snapshot.conflicts.length} conflict(s)` : ''));
    res.json({ scanId: scan.id, rackId: scan.rackId, summary: summarise(snapshot), warnings: tail(stderr) });
  } catch (err) {
    store.recordStage(scan.id, 'detect', 'failed', String(err.message).slice(0, 500));
    res.status(500).json({ stage: 'detect', scanId: scan.id, error: String(err.message) });
  }
});

router.get('/:id', (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const snapshot = scan.payload.snapshot;
  res.json({
    id: scan.id, rackId: scan.rackId, source: scan.source, createdAt: scan.createdAt,
    siteName: scan.payload.siteName, rackName: scan.payload.rackName,
    uHeight: scan.payload.uHeight ?? null,
    stages: scan.stages,
    detections: scan.payload.map ? detectionsView(scan.payload.map) : null,
    summary: snapshot ? summarise(snapshot) : null,
    devices: snapshot ? devicesView(snapshot) : [],
    conflicts: snapshot ? snapshot.conflicts : [],
    hasImage: Boolean(scan.imagePath && fs.existsSync(scan.imagePath)),
  });
});

/**
 * Delete a scan.
 *
 * Irreversible, and it takes the photograph with it — there is no trash and no
 * undo, because the thing being deleted is an image of a customer's
 * infrastructure and keeping a copy the operator believes is gone would be
 * worse than losing it. The UI asks before calling this.
 */
router.delete('/:id', (req, res) => {
  const rec = store.deleteScan(req.params.id);
  if (!rec) return res.status(404).json({ error: 'no such scan' });
  res.json({ deleted: rec.id, rackId: rec.rackId });
});

/** The uploaded photo, for the UI to show beside what was detected. */
router.get('/:id/image', (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan || !scan.imagePath || !fs.existsSync(scan.imagePath)) {
    return res.status(404).json({ error: 'no image for this scan' });
  }
  res.sendFile(path.resolve(scan.imagePath));
});

/**
 * The engine's own annotated renders.
 *
 * These live in <id>-cv/images/ under the engine's numbered names. This route
 * used to look for a device_unit_annotation.png that the engine has never
 * written, so it 404'd every time and the UI quietly fell back to the
 * unannotated photo -- "Show detections" showed no detections.
 */
const ANNOTATED_VIEWS = {
  units: '1_units_only.png',
  devices: '2_devices_only.png',
  both: '3_units_and_devices.png',
  ports: '7_rack_all_ports.png',
};

router.get('/:id/annotated', (req, res) => {
  const dir = path.join(store.SCANS_DIR, `${Number(req.params.id)}-cv`, 'images');
  const wanted = ANNOTATED_VIEWS[req.query.view] || ANNOTATED_VIEWS.both;
  const order = [wanted, ...Object.values(ANNOTATED_VIEWS).filter((f) => f !== wanted)];
  const found = order.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!found) {
    return res.status(404).json({
      error: 'no annotated image', detail: `nothing under ${dir}`,
    });
  }
  res.sendFile(path.resolve(found));
});

// ── shaping for the UI ──────────────────────────────────────────────────────

/**
 * What changed between two scans of the same rack. Devices are keyed by their U
 * slot (or name when unplaced), and compared on model, port count and serial.
 * Deliberately coarse: this is a human-readable "what moved", not a NetBox diff.
 */
function deviceMap(snap) {
  const typeOf = (uid) => (snap.deviceTypes || []).find((t) => t.uid === uid);
  const m = new Map();
  for (const d of (snap.devices || [])) {
    const k = d.position != null ? `U${d.position}` : d.name;
    m.set(k, {
      name: d.name,
      model: typeOf(d.deviceTypeUid)?.model || '',
      ports: (snap.interfaces || []).filter((i) => i.deviceUid === d.uid).length,
      serial: d.serial || '',
    });
  }
  return m;
}

function changeSummary(prev, curr) {
  const P = deviceMap(prev);
  const C = deviceMap(curr);
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of C.keys()) if (!P.has(k)) added.push(k);
  for (const k of P.keys()) if (!C.has(k)) removed.push(k);
  for (const [k, d] of C) {
    const p = P.get(k);
    if (!p) continue;
    const fields = [];
    if (p.model !== d.model) fields.push('model');
    if (p.ports !== d.ports) fields.push('ports');
    if (p.serial !== d.serial) fields.push('serial');
    if (fields.length) changed.push({ slot: k, fields });
  }
  return {
    added, removed, changed,
    unchanged: C.size - added.length - changed.length,
    same: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

function summarise(snap) {
  const devices = snap.devices || [];
  const identified = devices.filter((d) => {
    const t = (snap.deviceTypes || []).find((x) => x.uid === d.deviceTypeUid);
    return t && !t.model.startsWith('Unidentified');
  }).length;
  return {
    devices: devices.length,
    placed: devices.filter((d) => d.position !== null).length,
    unplaced: devices.filter((d) => d.position === null).length,
    identified,
    ports: (snap.interfaces || []).length,
    withSerial: devices.filter((d) => d.serial).length,
    withAssetTag: devices.filter((d) => d.assetTag).length,
    cables: (snap.cables || []).length,
    conflicts: (snap.conflicts || []).length,
  };
}

/**
 * Raw detection geometry, for drawing boxes over the photograph.
 *
 * Two coordinate spaces come out of the engine and they are NOT the same:
 * device boxes are absolute image pixels, port boxes are relative to their
 * own device's box. Ports are translated to absolute here, once, so no
 * caller has to remember -- getting this wrong draws every port in the
 * top-left corner of the image.
 */
/**
 * The boxes, in the photograph's own pixel space.
 *
 * The engine keeps a device's ports in FOUR arrays — `ports` (RJ45), plus
 * `sfp_ports`, `console_ports` and `other_ports` — and this used to read only
 * the first. The snapshot counts all of them, so the table said a switch had
 * 28 ports and the picture drew 24: the four SFP cages were counted, exported
 * and never shown. They are all read now and each carries its category, so
 * the drawing can tell an SFP cage from an RJ45 socket instead of pretending
 * one of them does not exist.
 *
 * `portCount` is the engine's own number for a device, kept beside the boxes
 * rather than replaced by them. Where the two disagree the UI says so — an
 * engine that counts 24 and emits 22 boxes is a fact about the detection, and
 * hiding it behind whichever number is more convenient would be inventing
 * confidence we do not have.
 */
const PORT_ARRAYS = [
  ['ports', 'main'],
  ['sfp_ports', 'sfp'],
  ['console_ports', 'console'],
  ['other_ports', 'other'],
];

const NOT_DRAWN = new Set(['Empty', 'Unidentified']);

function detectionsView(map) {
  const devices = (map.devices || [])
    // Do not box a blank slot or a detection the classifier could not name.
    .filter((d) => !NOT_DRAWN.has(d.class_name || 'Unidentified'))
    .map((d, i) => {
      const [dx, dy] = d.box || [0, 0];
    // Same canonical, de-duplicated port list the snapshot's interfaces use, so
    // the boxes drawn and the table's count are always the same number.
    const ports = cv.extractPorts(d).map((p) => ({
      box: [p.box[0] + dx, p.box[1] + dy, p.box[2] + dx, p.box[3] + dy],
      status: p.status,
      cls: p.cls,
      index: p.index,
      category: p.category,
      // The engine marks ports it filled in to complete a row it could only
      // partly see. Drawn differently: this one was reasoned, not observed.
      synthesized: p.synthesized,
      confidence: p.confidence,
    }));
    const counted = ports.length;
    return {
      i,
      box: d.box,
      label: d.class_name || 'device',
      confidence: d.confidence ?? null,
      units: d.units || [],
      source: d.source || '',
      portCount: counted,
      ports,
    };
  });
  return {
    rackBounds: map.rack_bounds || null,
    unitSource: map.unit_source || '',
    unitsDetected: (map.units_detected || []).length,
    devices,
    ports: devices.reduce((n, d) => n + d.ports.length, 0),
    portsCounted: devices.reduce((n, d) => n + d.portCount, 0),
    portsSynthesized: devices.reduce(
      (n, d) => n + d.ports.filter((p) => p.synthesized).length, 0),
  };
}

function devicesView(snap) {
  const typeOf = (uid) => (snap.deviceTypes || []).find((t) => t.uid === uid);
  const roleOf = (uid) => (snap.deviceRoles || []).find((r) => r.uid === uid);
  return (snap.devices || [])
    .map((d) => ({
      uid: d.uid,
      name: d.name,
      position: d.position,
      role: roleOf(d.roleUid)?.name || '',
      model: typeOf(d.deviceTypeUid)?.model || '',
      identified: !(typeOf(d.deviceTypeUid)?.model || '').startsWith('Unidentified'),
      ports: (snap.interfaces || []).filter((i) => i.deviceUid === d.uid).length,
      serial: d.serial,
      assetTag: d.assetTag,
      evidence: d.evidence,
      connectedPorts: d.provenance?.connectedPorts ?? null,
    }))
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1));
}

const tail = (s, n = 6) =>
  String(s || '').trim().split('\n').filter(Boolean).slice(-n);

/**
 * Collect: ask every managed switch registered against this scan's rack about
 * itself.
 *
 * This is the same read the Network screen runs per switch, done for the whole
 * rack and stamped onto the scan. A scan is a moment in time, so what the
 * switches said today is evidence about today's photograph, and it belongs
 * with it rather than only on the switch record.
 *
 * A switch that fails does not fail the stage. Three switches that answered
 * are three switches' worth of evidence, and the fourth's error is reported
 * beside them rather than thrown over the top of them.
 */
router.post('/:id/collect', async (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });

  const targets = switches.list(scan.rackId);
  if (targets.length === 0) {
    store.recordStage(scan.id, 'collect', 'blocked', 'no switches registered for this rack');
    return res.status(428).json({
      error: 'No switches are registered for this rack.',
      hint: 'Add the management address and login of each managed switch in the '
          + 'rack on this screen, then collect.',
      rackId: scan.rackId,
    });
  }

  const results = [];
  for (const sw of targets) {
    const r = await reader.readSwitch(sw.id);
    results.push(r.ok
      ? {
        id: sw.id, label: sw.label, host: sw.host, ok: true,
        sysName: r.data.system.sysName, vendor: r.data.system.vendor,
        model: r.data.identity.model, serial: r.data.identity.serial,
        counts: r.data.counts, gaps: r.data.gaps,
      }
      : {
        id: sw.id, label: sw.label, host: sw.host, ok: false,
        error: r.error, hint: r.hint || '',
      });
  }

  const answered = results.filter((r) => r.ok);
  store.setPayload(scan.id, {
    ...scan.payload,
    network: {
      collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      switches: results,
    },
  });
  store.recordStage(scan.id, 'collect', answered.length ? 'ok' : 'failed',
    `${answered.length} of ${results.length} switches answered`);

  res.status(answered.length ? 200 : 502).json({
    collected: answered.length,
    total: results.length,
    switches: results,
  });
});

/**
 * Reconcile: join the camera scan with the switch readings.
 *
 * GET returns the current picture (camera devices, switches, and a proposed or
 * saved matching) so Review can show it. POST takes the human-confirmed
 * matches, merges, and stores the reconciled snapshot that Export then uses.
 */
router.get('/:id/reconcile', (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const base = scan.payload && scan.payload.snapshot;
  if (!base) return res.status(409).json({ error: 'this scan has no detection result yet' });
  res.json(reconcile.view(base, scan.rackId, scan.payload.matches || null));
});

router.post('/:id/reconcile', (req, res) => {
  const scan = store.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'no such scan' });
  const base = scan.payload && scan.payload.snapshot;
  if (!base) return res.status(409).json({ error: 'this scan has no detection result yet' });

  const matches = (req.body && req.body.matches) || {};
  const sws = reconcile.gatherSwitches(scan.rackId);
  const { snapshot, summary } = reconcile.reconcile(base, sws, matches);

  store.setPayload(scan.id, { ...scan.payload, matches, reconciled: snapshot });
  store.recordStage(scan.id, 'reconcile', 'ok',
    `${summary.matched} matched, ${summary.serials} serials, ${summary.cables} cables`);
  res.json({ ok: true, summary });
});

module.exports = router;
