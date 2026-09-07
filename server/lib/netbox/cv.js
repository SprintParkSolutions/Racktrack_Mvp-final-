/**
 * Bridge to the Python CV engine.
 *
 * The engine is run as a subprocess, exactly as v1 runs it. Two reasons:
 * a crash in a 14k-line vision pipeline cannot take the web server down with
 * it, and the engine keeps its own Python environment instead of being
 * imported into ours.
 *
 * IMPORTANT: the working directory must be the engine root. pipeline/port.py
 * resolves its model with a RELATIVE path (Models/ports_9.pt), so running it
 * from anywhere else silently fails to find the weights.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  Evidence, emptySnapshot, observed,
  Site, Rack, Manufacturer, DeviceType, DeviceRole, Device, Interface, Conflict,
} = require('./model');

const ENGINE_DIR = process.env.RT_ENGINE_DIR || path.join(__dirname, '..', '..', 'engine');
const PYTHON = process.env.RT_PYTHON || path.join(ENGINE_DIR, '.venv', 'bin', 'python');

/**
 * Used when CV saw a box but nothing has told us what it is. Deliberately
 * unmistakable: a human reading NetBox must see "we do not know" at a glance,
 * never a plausible-looking model number. SNMP ENTITY-MIB replaces this later.
 */
const UNKNOWN_MAKE = 'Unknown';

/**
 * The engine emits a record per rack unit, including ones it found nothing in.
 * An empty slot is not a device. Creating one would be inventing hardware,
 * which is the single thing this application exists not to do.
 */
// 'Empty' is a blank slot. 'Unidentified' is a box the classifier could not
// name: it carries no model, role or ports, so it is noise in the inventory
// rather than a device. Neither is created, placed, boxed or exported.
const NOT_A_DEVICE = new Set(['Empty', 'Unidentified']);
// Fewer than this many ports and a network box is a router. Kept in step with
// ROUTER_PORT_CEILING in pipeline/runner.py and server/app.js.
const ROUTER_PORT_CEILING = 10;

const slug = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The engine writes the U as a string — "U16", "U09". NetBox wants a number.
 * Returns null rather than a guess when it does not parse; the device is then
 * exported unplaced, which is honest, rather than landing in the wrong slot.
 */
function uPosition(raw) {
  if (typeof raw === 'number') return raw;
  const m = String(raw ?? '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * The engine reports a device's rack position as a `units` array of strings
 * ("u07", "u08"), because a device can span several U. Turn it into the sorted
 * list of U numbers. Falls back to a single `position` for older maps.
 */
function unitNums(d) {
  const raw = Array.isArray(d.units) ? d.units
    : (d.position !== undefined && d.position !== null ? [d.position] : []);
  return raw
    .map((u) => { const m = String(u).match(/\d+/); return m ? Number(m[0]) : null; })
    .filter((n) => n !== null)
    .sort((a, b) => a - b);
}

/** Is the engine present and runnable? Checked before offering to scan. */
function engineStatus() {
  const cfg = path.join(ENGINE_DIR, 'config.json');
  const present = fs.existsSync(ENGINE_DIR) && fs.existsSync(cfg);
  let models = {};
  if (present) {
    try {
      const conf = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      models = Object.fromEntries(Object.entries(conf.models || {}).map(
        ([k, rel]) => [k, fs.existsSync(path.join(ENGINE_DIR, rel))]));
    } catch { /* config unreadable — reported as not ready below */ }
  }
  const total = Object.keys(models).length;
  const ready = total > 0 && Object.values(models).every(Boolean) && fs.existsSync(PYTHON);
  return {
    engineDir: ENGINE_DIR,
    python: PYTHON,
    pythonPresent: fs.existsSync(PYTHON),
    models,
    modelsPresent: Object.values(models).filter(Boolean).length,
    modelsTotal: total,
    ready,
  };
}

/**
 * A perceptual fingerprint of an image (a 64-bit dHash, as 16 hex chars).
 *
 * dHash compares each pixel to its neighbour on a tiny greyscale copy, so it is
 * stable across resizing, compression and small lighting changes, and two
 * photos of the same rack land close together. It is used to notice "this is
 * the rack you scanned before" before spending a minute on the vision models.
 */
function imageHash(imagePath, { timeoutMs = 20000 } = {}) {
  const script = 'import sys\n'
    + 'from PIL import Image\n'
    + "im = Image.open(sys.argv[1]).convert('L').resize((9, 8))\n"
    + 'p = list(im.getdata())\n'
    + 'b = 0\n'
    + 'for r in range(8):\n'
    + '    for c in range(8):\n'
    + '        b = (b << 1) | (1 if p[r*9+c] < p[r*9+c+1] else 0)\n'
    + "print('%016x' % b)\n";
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-c', script, imagePath]);
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('hash timed out')); }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      const h = out.trim();
      if (/^[0-9a-f]{16}$/.test(h)) resolve(h);
      else reject(new Error(`could not hash image: ${err.trim() || 'no output'}`));
    });
  });
}

/** Bits that differ between two 16-hex-char hashes (0 = identical, 64 = opposite). */
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** 0..1, where 1 is an identical fingerprint. */
const similarity = (a, b) => 1 - hamming(a, b) / 64;

/**
 * Run detection on one image. Resolves with the parsed device_unit_map.json.
 * Rejects with the engine's own stderr, which names what actually went wrong.
 */
function runDetect(imagePath, outputDir, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const args = ['-m', 'pipeline.runner', '--image', path.resolve(imagePath),
                  '--detect_only', '--output_dir', path.resolve(outputDir)];
    const proc = spawn(PYTHON, args, { cwd: ENGINE_DIR });

    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CV engine timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start the CV engine (${PYTHON}): ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const mapFile = path.join(outputDir, 'device_unit_map.json');
      if (code !== 0 && !fs.existsSync(mapFile)) {
        return reject(new Error(stderr.trim().split('\n').slice(-15).join('\n')
          || `CV engine exited ${code}`));
      }
      if (!fs.existsSync(mapFile)) {
        return reject(new Error('CV engine produced no device_unit_map.json'));
      }
      try {
        resolve({ map: JSON.parse(fs.readFileSync(mapFile, 'utf8')), stdout, stderr, outputDir });
      } catch (err) {
        reject(new Error(`could not parse the engine output: ${err.message}`));
      }
    });
  });
}

/**
 * Pull apart any port boxes that overlap, so no two touch. For each overlapping
 * pair, the boxes are trimmed back to the midline of their overlap along the
 * shorter overlap axis (ports sit in rows, so that is usually the horizontal
 * gap between neighbours), leaving a 1px gap. Every port is kept; only its
 * drawn extent is tidied. A few passes settle any chains of touching boxes.
 */
function separate(ports) {
  const GAP = 1;
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    for (let i = 0; i < ports.length; i += 1) {
      for (let j = i + 1; j < ports.length; j += 1) {
        const a = ports[i].box; const b = ports[j].box;
        const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (ox <= 0 || oy <= 0) continue; // no overlap
        if (ox <= oy) {
          const mid = (Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2;
          const [l, r] = a[0] <= b[0] ? [a, b] : [b, a];
          l[2] = Math.min(l[2], mid - GAP);
          r[0] = Math.max(r[0], mid + GAP);
        } else {
          const mid = (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2;
          const [t, d] = a[1] <= b[1] ? [a, b] : [b, a];
          t[3] = Math.min(t[3], mid - GAP);
          d[1] = Math.max(d[1], mid + GAP);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return ports;
}

/** Fraction of box `a` that lies inside box `b` (0..1). */
function contained(a, b) {
  const ix1 = Math.max(a[0], b[0]); const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]); const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? inter / area : 0;
}

/** Intersection-over-union of two [x1,y1,x2,y2] boxes. */
function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]); const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]); const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1); const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

// Each port array the engine emits, with the NetBox interface type it maps to.
const PORT_KINDS = [
  ['ports', 'main', '1000base-t'],
  ['sfp_ports', 'sfp', '1000base-x-sfp'],
  ['console_ports', 'console', 'other'],
  ['other_ports', 'other', 'other'],
];

/**
 * The one canonical port list for a device, used by BOTH the snapshot's
 * interfaces and the overlay boxes so the two can never disagree on the count.
 * Overlapping detections are collapsed (the engine sometimes reports the same
 * physical port as both a main and an SFP port), keeping the higher-confidence
 * box. Boxes stay device-relative; callers translate to absolute if needed.
 */
function extractPorts(d) {
  const raw = [];
  for (const [key, category, type] of PORT_KINDS) {
    for (const port of (d[key] || [])) {
      if (!Array.isArray(port.box)) continue;
      raw.push({
        box: [...port.box], category, type,
        status: port.status || '',
        index: port.index ?? null,
        synthesized: Boolean(port.synthesized),
        confidence: port.confidence ?? null,
        cls: port.class_name || '',
      });
    }
  }
  raw.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept = [];
  for (const port of raw) {
    // First remove genuine double detections: a box that heavily overlaps a
    // stronger one already kept, or is mostly swallowed by it, is the same port
    // found twice, not a second port.
    const dup = kept.some((k) => iou(k.box, port.box) > 0.45 || contained(port.box, k.box) > 0.7);
    if (dup) continue;
    kept.push(port);
  }
  // SFP cages come in pairs, so an odd SFP count is almost always one spurious
  // detection sitting next to the real ones (a 4-SFP switch read as 5). Drop
  // the weakest extra to make the count even. A genuine lone uplink (1) is left
  // alone; this only trims 3, 5, 7...
  const sfp = kept.filter((p) => p.category === 'sfp');
  if (sfp.length >= 3 && sfp.length % 2 === 1) {
    let weakest = sfp[0];
    for (const p of sfp) if ((p.confidence ?? 0) < (weakest.confidence ?? 0)) weakest = p;
    const i = kept.indexOf(weakest);
    if (i >= 0) kept.splice(i, 1);
  }
  // Left-to-right, top-to-bottom, so port numbering is stable and readable.
  kept.sort((a, b) => (a.box[1] - b.box[1] > 20 ? a.box[1] - b.box[1] : a.box[0] - b.box[0]));
  // Then separate any boxes that still touch, so no two ports overlap at all.
  return separate(kept);
}

/**
 * Detection output -> NetBox-shaped snapshot.
 *
 * `siteName` and `rackName` are the operator's to state. A human looking at a
 * rack and typing its name is MANUAL evidence, not synthetic — the rule is
 * that every value has a named source, not that every value is automatic.
 *
 * Device uids key on the U position, because with camera-only data the slot is
 * the only stable identity available. The consequence is deliberate: move a
 * device to a different U and it reads as an orphan plus a create, which is a
 * change a human should look at. Once SNMP lands, the serial from ENTITY-MIB
 * becomes the key and a moved device becomes a simple update.
 */
function toSnapshot(map, { rackId, siteName, rackName, uHeight = null, scannedAt = '' }) {
  const snap = emptySnapshot(`rack:${rackId}`, scannedAt);

  const siteUid = `site:${slug(siteName)}`;
  snap.sites.push(Site(observed(siteUid, Evidence.MANUAL), { name: siteName, slug: slug(siteName) }));

  const rackUid = `rack:${rackId}`;
  snap.racks.push(Rack(observed(rackUid, Evidence.MANUAL, { image: map.image || '' }),
    { name: rackName || rackId, siteUid, uHeight }));

  const seenMfr = new Map();
  const seenType = new Map();
  const seenRole = new Map();
  const takenU = new Map();
  const usedUids = new Set();
  let unplacedN = 0;

  for (const d of map.devices || []) {
    // A network box with fewer than ten ports is a router, not a switch.
    // The same rule as pipeline/runner.py and server/app.js; it has to hold
    // here too, because this snapshot is what the report and NetBox read,
    // and a map written before the rule existed still says "Switch".
    const ports0 = Number(d.port_count || 0);
    const cls = (d.class_name === 'Switch' && Number.isInteger(ports0) && ports0 > 0 && ports0 < ROUTER_PORT_CEILING)
      ? 'Router'
      : (d.class_name || 'Unidentified');
    if (NOT_A_DEVICE.has(cls)) continue;

    // Position and height come from the units array, not a single number, so a
    // patch panel across u07-u08 is placed at U7 and two units tall.
    const units = unitNums(d);
    let pos = units.length ? units[0] : null;
    const span = units.length ? (units[units.length - 1] - units[0] + 1) : 1;
    const ports = Number(d.port_count || 0);
    // sfp/console/other ports come back as arrays of detected ports, not counts.
    const sfps = Array.isArray(d.sfp_ports) ? d.sfp_ports.length : Number(d.sfp_ports || 0);

    // A device name must be unique per site in NetBox. A placed device is named
    // by its U, which is already unique; an unplaced one gets a running number
    // so two "Unidentified" boxes cannot collide on write.
    let label;
    if (pos !== null) label = d.label || `${cls} U${pos}`;
    else { unplacedN += 1; label = d.label ? `${d.label} (${unplacedN})` : `${cls} (unplaced ${unplacedN})`; }

    // One U holds one device per face. If the engine's spans overlap it is a
    // detection artefact: the first keeps the slot, the second is exported
    // unplaced with the disagreement recorded rather than rejected by NetBox.
    const clash = units.find((u) => takenU.has(u));
    if (pos !== null && clash !== undefined) {
      snap.conflicts.push(Conflict({
        subjectUid: `dev:${rackId}:${slug(label)}`, field: 'position',
        cvSays: `U${pos}`,
        note: `CV placed both "${takenU.get(clash)}" and "${label}" at U${clash}. `
            + 'One U holds one device per face. Exported unplaced pending review.',
      }));
      pos = null;
    } else if (pos !== null) {
      for (const u of units) takenU.set(u, label);
    }

    const make = d.ocr_make || d.make || UNKNOWN_MAKE;
    // The engine writes the OCR-read model as `ocr_model`. Prefer it; keep
    // `model` as a fallback for any other map shape.
    const observedModel = d.ocr_model || d.model || null;
    let model;
    let evIdent;
    if (observedModel) {
      model = observedModel;
      evIdent = Evidence.CV_OCR;          // OCR read it off the bezel
    } else {
      const noun = cls === 'Unidentified' ? 'Device' : cls;
      model = `Unidentified ${noun}${ports ? ` (${ports}-port)` : ''}`;
      evIdent = Evidence.CV_ONLY;
    }

    if (!seenMfr.has(make)) {
      const uid = `mfr:${slug(make)}`;
      seenMfr.set(make, uid);
      snap.manufacturers.push(Manufacturer(observed(uid, evIdent), { name: make, slug: slug(make) }));
    }
    if (!seenType.has(model)) {
      const uid = `dtype:${slug(model)}`;
      seenType.set(model, uid);
      snap.deviceTypes.push(DeviceType(observed(uid, evIdent), {
        manufacturerUid: seenMfr.get(make), model, slug: slug(model), uHeight: span }));
    }
    if (!seenRole.has(cls)) {
      const uid = `role:${slug(cls)}`;
      seenRole.set(cls, uid);
      snap.deviceRoles.push(DeviceRole(observed(uid, Evidence.CV_ONLY), { name: cls, slug: slug(cls) }));
    }

    let devUid = pos !== null ? `dev:${rackId}:u${pos}` : `dev:${rackId}:${slug(label)}`;
    if (usedUids.has(devUid)) devUid = `${devUid}:${slug(label)}`;
    usedUids.add(devUid);

    snap.devices.push(Device(
      observed(devUid, Evidence.CV_ONLY, {
        cvClass: cls, cvLabel: label, cvUnits: d.units ?? null,
        connectedPorts: d.connected_ports ?? null,
        // Where on the photo the camera saw it, in the image's own pixels.
        // Carried so a person can point at the box on the picture instead of
        // reading a dropdown of names the camera invented.
        box: Array.isArray(d.box) && d.box.length === 4 ? d.box.map(Number) : null,
      }),
      {
        name: label, deviceTypeUid: seenType.get(model), roleUid: seenRole.get(cls),
        siteUid, rackUid, position: pos, face: 'front',
        // Left null on purpose. The camera extracts neither, and a patch panel
        // has no queryable serial at all. An empty field is a fact.
        serial: null, assetTag: null,
      }));

    // Interfaces come from the actual detected port boxes, de-duplicated, so
    // the device table and the overlay always show the same count.
    extractPorts(d).forEach((port, idx) => {
      snap.interfaces.push(Interface(
        observed(`if:${devUid}:${idx + 1}`, Evidence.CV_ONLY,
          { category: port.category, status: port.status, synthesized: port.synthesized }),
        { deviceUid: devUid,
          name: port.index != null ? String(port.index) : String(idx + 1),
          type: port.type }));
    });
  }

  // No cables. The camera cannot yet follow a cable through a bundle, and
  // nothing else has observed one. Cables arrive with LLDP — earned, not assumed.
  return snap;
}

module.exports = {
  extractPorts, iou, engineStatus, runDetect, toSnapshot, uPosition, slug,
  imageHash, hamming, similarity, ENGINE_DIR, PYTHON };
