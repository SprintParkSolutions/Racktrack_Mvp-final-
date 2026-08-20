import argparse
import json
import logging
import os
import sys

import cv2

logger = logging.getLogger(__name__)

# Ensure the project root is on sys.path when this script is run directly
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from pipeline.annotation import (
    annotate_devices_only,
    annotate_full_rack,
    annotate_image,
    annotate_units_only,
    save_json,
)
from pipeline.cable import (
    classify_cable,
    classify_port_type,
    crop_box,
    load_cable_model,
    load_port_identify_model,
    parse_cable_type_color,
)
from pipeline.config_loader import ensure_dir, load_json_config
from pipeline.detection import (
    FALLBACK_DEVICE_CLASS_NAMES,
    assign_devices_to_units,
    build_contiguous_unit_grid,
    build_device_mapping,
    derive_unit_height,
    detect_devices_dual,
    detect_devices_seg,
    detect_rack_bounds,
    ensure_every_unit_has_device,
    load_model,
    normalize_device_stack,
    print_model_classes,
    remove_overlapping_devices,
    shift_boxes,
    validate_device_stack,
)
from pipeline.port import draw_classified
from pipeline.port_pattern import (
    classify_ports_by_pattern,
    classify_ports_with_target_count,
    detect_patch_panel_ports,
    detect_pdu_ports,
    snap_switch_port_count,
)
from pipeline.selection import crop_device_with_origin, select_device

# Step 06: Pipeline runner

# ── Occupancy honesty ────────────────────────────────────────────────────────
# The cable classifier (Models/cable_eff_best) has FOURTEEN outputs and every
# one of them is a cable COLOUR (LC_Aqua … SC_Yellow) — verified at the weights
# level, classifier.1.weight is (14, 1280). There is NO empty / no-cable class,
# so its softmax always sums to 1 across colours: its top-class confidence
# answers "which colour" and can be arbitrarily high on a crop that holds no
# cable at all. It therefore MUST NOT be thresholded to decide occupancy — doing
# so fabricated connected/empty that then fed topology and the CMDB. Occupancy
# comes only from the status sweep; a port the sweep didn't tag is genuinely
# UNKNOWN, and we say so rather than guess.
_OCCUPANCY_STATES = ("connected", "empty")


def resolve_port_occupancy(sweep_status):
    """Return a port's occupancy honestly from the status-sweep tag alone.

    `sweep_status` is whatever the status model tagged the port with. That is
    the only signal that measures presence, so anything other than a real
    occupancy state ("connected" / "empty") — including "unknown", "invalid",
    None or a stray string — resolves to "unknown". We never synthesize
    connected/empty from the cable-colour classifier's confidence.
    """
    return sweep_status if sweep_status in _OCCUPANCY_STATES else "unknown"


def _clear_port_fields(dev):
    """Zero every port field on a device dict in place.

    Used both as the crash fallback and by the demotion path. Deliberately does
    NOT touch port_detection_failed / port_detection_error, so a failure marker
    set by mark_port_detection_failed survives a subsequent demotion.
    """
    dev["port_count"] = 0
    dev["ports"] = []
    dev["console_ports"] = []
    dev["sfp_ports"] = []
    dev["other_ports"] = []
    dev["connected_ports"] = []
    return dev


def mark_port_detection_failed(dev, exc):
    """Record that port detection CRASHED on this device.

    A crash previously zeroed the port fields silently, which made the device
    indistinguishable in device_unit_map.json from one that genuinely has no
    ports (both then demote to "Unidentified"). Marking the failure keeps the
    two apart for downstream consumers.
    """
    _clear_port_fields(dev)
    dev["port_detection_failed"] = True
    dev["port_detection_error"] = f"{type(exc).__name__}: {exc}"
    return dev


def demote_if_no_ports(dev):
    """Demote a port-bearing device with zero detected ports to "Unidentified".

    When the detector finds no ports on a port-bearing class the YOLO class is
    almost certainly wrong, so we demote. A detection that CRASHED is marked
    with port_detection_failed BEFORE this runs; _clear_port_fields preserves
    that marker, so a genuine zero-port device (no marker) stays distinguishable
    from a detection failure even after both land on "Unidentified".
    """
    detected = (
        list(dev.get("ports") or [])
        + list(dev.get("console_ports") or [])
        + list(dev.get("sfp_ports") or [])
        + list(dev.get("other_ports") or [])
    )
    if not detected:
        dev["class_name"] = "Unidentified"
        _clear_port_fields(dev)
    return dev


def unit_label_to_index(label):
    return int(label.strip().lower().lstrip("u"))


def format_unit_range(unit_labels):
    indices = sorted(unit_label_to_index(label) for label in unit_labels)
    ranges = []
    start = prev = indices[0]
    for idx in indices[1:]:
        if idx == prev + 1:
            prev = idx
        else:
            ranges.append((start, prev))
            start = prev = idx
    ranges.append((start, prev))
    return ranges


def build_unit_device_lines(units, devices):
    assigned_units = set()
    lines = []

    for device in devices:
        unit_labels = device.get("units") or []
        if not unit_labels:
            continue
        assigned_units.update(unit_labels)
        ranges = format_unit_range(unit_labels)
        for start, end in ranges:
            if start == end:
                line = f"U{start:02d} {device['class_name']}"
            else:
                count = end - start + 1
                line = f"U{start:02d}-U{end:02d} {device['class_name']} - {count} spaces occupied"
            lines.append((start, line))

    for unit in units:
        if unit["label"] not in assigned_units:
            idx = unit_label_to_index(unit["label"])
            # Never claim "Empty" for an unclaimed row — we don't know
            # what's there. Racks almost always have a device in every
            # slot; reserve "Empty" for what the model actually classified.
            lines.append((idx, f"U{idx} Unidentified"))

    lines.sort(key=lambda item: item[0])
    return [line for _, line in lines]


def save_unit_device_report(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        f.write("U#\tDevice Type\n")
        for line in lines:
            f.write(line + "\n")


def _analysed_map_devices(json_path):
    """The device list from an existing device_unit_map.json that has already
    been through the port-analysis pass, or None.

    "Analysed" means at least one port-bearing device carries a port_count —
    the field only the --detect_only branch writes. Used by the select path to
    tell an analysed map (must be preserved and indexed against) from a bare or
    absent one (safe to overwrite).
    """
    try:
        if not os.path.exists(json_path):
            return None
        with open(json_path, encoding="utf-8") as f:
            payload = json.load(f)
        devices = payload.get("devices")
        if not isinstance(devices, list) or not devices:
            return None
        if any(
            isinstance(d, dict) and isinstance(d.get("port_count"), int) and d.get("port_count") > 0
            for d in devices
        ):
            return devices
        # Every device has a box but none has ports — a map written by a
        # previous select, or a rack with genuinely no port-bearing devices.
        # Still preserve it for indexing if the boxes are there.
        if all(isinstance(d, dict) and d.get("box") for d in devices):
            return devices
        return None
    except Exception as exc:
        print(f"[select] could not read existing device map ({exc}); treating as absent")
        return None


def enrich_cables_on_map(img, output_dir, cable_model_path):
    """Classify the cable on every CONNECTED port of an already-analyzed rack
    and write cable_type / cable_connector / cable_color / cable_confidence
    back into device_unit_map.json.

    Reuses the same recipe the single-port /api/select path uses: crop the
    port box enlarged to ~4× (connector + a chunk of cable body) out of the
    device crop, run the cable classifier, parse into connector + colour.
    Idempotent — re-running just recomputes the same fields.
    """
    json_path = os.path.join(output_dir, "device_unit_map.json")
    if not os.path.exists(json_path):
        print(f"[enrich_cables] no device_unit_map.json at {json_path}; nothing to do")
        return
    if not cable_model_path:
        print("[enrich_cables] no cable_classifier configured; skipping")
        return

    with open(json_path, encoding="utf-8") as f:
        payload = json.load(f)

    cable_model = load_cable_model(cable_model_path, device="cpu")
    devices = payload.get("devices") or []

    def _classify_port(dev_crop, port):
        box = port.get("box")
        if not box or len(box) != 4:
            return False
        bx1, by1, bx2, by2 = [int(v) for v in box]
        box_w = max(1, bx2 - bx1)
        box_h = max(1, by2 - by1)
        crop = crop_box(
            dev_crop, [bx1, by1, bx2, by2], pad_x=(box_w * 3) // 2, pad_y=(box_h * 3) // 2
        )
        if crop is None or crop.size == 0:
            return False
        # Each port dict carries the bucket it was classified into, so the
        # whole-rack enrichment gets the same physical constraint the
        # single-port path does: fibre connectors on SFP cages, copper on RJ-45.
        cable_class, cable_conf = classify_cable(
            crop, cable_model, port_category=port.get("port_category")
        )
        connector, color = parse_cable_type_color(cable_class)
        port["cable_type"] = cable_class
        port["cable_connector"] = connector
        port["cable_color"] = color
        port["cable_confidence"] = float(cable_conf)
        return True

    enriched = 0
    for dev in devices:
        # Any occupied port can carry a cable — RJ45 on main, fiber (LC/SC) on
        # SFP. Console/other rarely, but classify whatever reads 'connected'.
        port_lists = ["ports", "sfp_ports", "other_ports"]
        has_connected = any(
            p.get("status") == "connected" for lst in port_lists for p in (dev.get(lst) or [])
        )
        if not has_connected:
            continue
        try:
            dev_crop, _ = crop_device_with_origin(img, dev["box"])
        except Exception:
            continue
        for lst in port_lists:
            for port in dev.get(lst) or []:
                if port.get("status") == "connected":
                    if _classify_port(dev_crop, port):
                        enriched += 1
        # connected_ports is a snapshot list — rebuild it so it carries the
        # freshly-attached cable_* fields too.
        dev["connected_ports"] = [
            p for p in (dev.get("ports") or []) if p.get("status") == "connected"
        ]

    payload["cables_enriched"] = True
    save_json(json_path, payload)
    print(
        f"[enrich_cables] classified cable on {enriched} connected port(s) "
        f"across {len(devices)} device(s); saved {json_path}"
    )


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run rack unit and device detection, then highlight ports."
    )
    parser.add_argument("--image", required=True, help="Input rack image path.")
    parser.add_argument("--config", default="config.json", help="Path to pipeline config file.")
    parser.add_argument("--device_index", type=int, help="Select device index without prompt.")
    parser.add_argument(
        "--port", type=int, help="Port number to highlight in the selected device image."
    )
    parser.add_argument(
        "--port_category",
        choices=["main", "sfp", "console", "other"],
        default="main",
        help="Which port category the --port number refers to (default: main = RJ45; other = USB).",
    )
    parser.add_argument(
        "--list_device_classes", action="store_true", help="Print device model classes and exit."
    )
    parser.add_argument("--output_dir", help="Override output directory from config.")
    parser.add_argument(
        "--devices_conf", type=float, help="Confidence threshold for general device model."
    )
    parser.add_argument("--server_conf", type=float, help="Confidence threshold for server model.")
    parser.add_argument("--ports_conf", type=float, help="Confidence threshold for port detection.")
    parser.add_argument(
        "--detect_only",
        action="store_true",
        help="Run detection and annotation only; skip device and port selection.",
    )
    parser.add_argument(
        "--enrich_cables",
        action="store_true",
        help="Post-analyze pass: classify the cable (type + colour) on every "
        "connected port in an existing device_unit_map.json and write the "
        "cable_* fields back. Runs no detection; meant to be scheduled in "
        "the background right after analyze.",
    )
    parser.add_argument(
        "--org_id",
        default=None,
        help="Organization id for org-scoped active-learning (cable) lookups.",
    )
    parser.add_argument(
        "--target_count",
        type=int,
        default=0,
        help="User-confirmed main-port count for the selected device; "
        "forces the port layout to exactly this many so port N "
        "on select matches the numbering the user confirmed.",
    )
    parser.add_argument(
        "--index_offset",
        type=int,
        default=0,
        help="User's port-number shift; added to every drawn port index "
        "so the labels match the user's corrected numbering.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    config = load_json_config(args.config)

    output_dir = args.output_dir or config.get("paths", {}).get("output_dir", "outputs")
    ensure_dir(output_dir)

    # Device-detection mode is selectable. Both checkpoint sets stay
    # registered in config.json — flipping config.detection.device_detect_mode
    # ("dual" or "seg") is the whole switch.
    #   dual: detect_devices_dual(server, general)  → best 33.pt + best 32.pt
    #   seg : detect_devices_seg(seg_model)         → seg_devices.pt
    # Port + cable models are mode-independent.
    detect_cfg = config.get("detection", {}) or {}
    device_detect_mode = detect_cfg.get("device_detect_mode", "dual")

    if device_detect_mode == "dual":
        device_general_path = config["models"].get("devices_general")
        device_server_path = config["models"].get("devices_server")
        device_seg_path = None
        if not device_general_path or not device_server_path:
            raise RuntimeError(
                "device_detect_mode='dual' requires 'devices_general' and "
                "'devices_server' in config.json models (removed for seg-only "
                "mode). Set mode to 'seg' or restore the dual model paths."
            )
    else:
        device_general_path = None
        device_server_path = None
        device_seg_path = config["models"]["devices_seg"]

    port_typed_path = config["models"]["ports_typed"]
    port_status_path = config["models"]["ports_status"]
    cable_model_path = config["models"].get("cable_classifier")
    port_identify_model_path = config["models"].get("port_identify")
    pdu_ports_model_path = config["models"].get("pdu_ports")

    devices_conf = (
        args.devices_conf if args.devices_conf is not None else detect_cfg.get("devices_conf", 0.20)
    )
    server_conf = (
        args.server_conf if args.server_conf is not None else detect_cfg.get("server_conf", 0.25)
    )
    iou_dedup = detect_cfg.get("iou_dedup", 0.5)
    ports_conf = (
        args.ports_conf if args.ports_conf is not None else detect_cfg.get("ports_conf", 0.23)
    )
    # PDU power outlets use a higher confidence (matches the standalone pdu code).
    pdu_conf = detect_cfg.get("pdu_conf", 0.40)

    if device_detect_mode == "dual":
        device_general_model = load_model(device_general_path)
        device_server_model = load_model(device_server_path)
        device_seg_model = None
    else:
        device_general_model = None
        device_server_model = None
        device_seg_model = load_model(device_seg_path)

    if args.list_device_classes:
        if device_detect_mode == "dual":
            print_model_classes(device_general_model, "devices (general)")
            print_model_classes(device_server_model, "devices (server)")
        else:
            print_model_classes(device_seg_model, "devices (seg)")
        return

    img = cv2.imread(args.image)
    if img is None:
        raise FileNotFoundError(f"Unable to open input image: {args.image}")

    # ── Background cable-enrichment mode ─────────────────────────────
    # Classify the cable (connector + colour) on every CONNECTED port of an
    # already-analyzed rack and write the cable_* fields back into
    # device_unit_map.json. No detection runs here — this reuses the exact
    # same crop recipe + classifier the per-port /api/select path uses, just
    # applied to every connected port instead of one. Scheduled in the
    # background so the initial analyze stays fast.
    if args.enrich_cables:
        enrich_cables_on_map(img, output_dir, cable_model_path)
        return

    img_h, img_w = img.shape[:2]

    # --- Rack bounding box (Hough lines). Fall back to the full image if
    #     no rack-like structure is found so the pipeline still runs. ---
    rack_box = detect_rack_bounds(img)
    if rack_box is None:
        rack_box = (0, 0, img_w, img_h)
        print("[rack] Hough lines found no rack — using full image as rack bounds.")
    else:
        print(f"[rack] bounds: {rack_box}")
    rx1, ry1, rx2, ry2 = rack_box
    rack_crop = img[ry1:ry2, rx1:rx2]

    # --- Device detection on the rack crop ---
    # Mode is read from config above. Dual = best33 (Server-only) + best32
    # (everything else), IoU-dedup'd. Seg = single seg_devices.pt model.
    # Both return the same dict shape, so all downstream stages are mode-
    # agnostic.
    if device_detect_mode == "dual":
        devices = detect_devices_dual(
            rack_crop,
            device_server_model,
            device_general_model,
            conf_server=server_conf,
            conf_general=devices_conf,
            iou_thresh=iou_dedup,
        )
        print(f"[devices] dual mode → {len(devices)} devices")
    else:
        devices = detect_devices_seg(
            rack_crop,
            device_seg_model,
            conf=devices_conf,
            iou_thresh=iou_dedup,
        )
        print(f"[devices] seg mode → {len(devices)} devices")

    # Translate boxes back to full-image coordinates for every downstream stage.
    shift_boxes(devices, rx1, ry1)

    devices.sort(key=lambda d: d["box"][1])
    devices = remove_overlapping_devices(devices, max_overlap_ratio=0.3)
    # Physical-rack cleanup: uniform width + snap small overlaps/gaps between
    # adjacent devices to a shared edge (real blank-U gaps are preserved).
    devices = normalize_device_stack(devices)
    validate_device_stack(devices)

    # --- Device-class active learning (cross-scan) ---
    # A technician can correct a mis-detected device type in the app; that
    # correction is stored (pHash + embedding) in the org's learning memory.
    # Here, on every later scan, we match each freshly-detected device against
    # that memory and, on a hit, override the model's class with the corrected
    # one — the device equivalent of the cable-colour carry-over. Applied BEFORE
    # unit derivation and port detection so the corrected class also drives the
    # right port strategy (e.g. Patch Panel vs Switch). Best-effort: any failure
    # leaves the model's original prediction untouched.
    _org = getattr(args, "org_id", None)
    if _org and devices:
        try:
            import tempfile

            from pipeline.active_learning import store as _al

            _al.set_org(_org)
            # Skip the (per-device) embedding cost entirely unless this org has
            # actually stored device corrections — the common case is none.
            _have_corr = bool(_al.load_corrections("devices"))
            _n_corrected = 0
            for _dev in devices if _have_corr else []:
                _box = _dev.get("box")
                if not _box or len(_box) != 4:
                    continue
                _bw = max(1, int(_box[2]) - int(_box[0]))
                _bh = max(1, int(_box[3]) - int(_box[1]))
                _pad = max(4, int(min(_bw, _bh) * 0.05))  # match server crop
                _crop = crop_box(img, _box, pad=_pad)
                if _crop is None or getattr(_crop, "size", 0) == 0:
                    continue
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as _tf:
                    _dp = _tf.name
                cv2.imwrite(_dp, _crop)
                try:
                    _m = _al.find_match("devices", _dp)
                finally:
                    try:
                        os.unlink(_dp)
                    except OSError:
                        pass
                _new = (_m or {}).get("label")
                if _new and _new != _dev.get("class_name"):
                    _dev["class_name_original"] = _dev.get("class_name")
                    _dev["class_name"] = _new
                    _dev["class_name_corrected"] = True
                    _n_corrected += 1
            if _n_corrected:
                # Re-sort/renormalise so downstream (unit_h from Switch/Patch
                # Panel, picker protection) sees the corrected classes.
                print(
                    f"[devices] active learning: corrected {_n_corrected} "
                    f"device class(es) from org memory"
                )
        except Exception as _e:
            print(f"[devices] (device learning lookup skipped: {_e})")

    # --- Build the unit grid: strict uniform contiguous tiling ---
    # Physical rack rules enforced here:
    #   * every unit exactly `unit_h` tall
    #   * units are back-to-back, no gaps
    #   * grid starts at the first detected device's top edge (below the
    #     top rail), never above it
    #   * grid ends at the last detected device's bottom edge
    unit_h = derive_unit_height(devices)
    if unit_h:
        units = build_contiguous_unit_grid(
            devices,
            unit_h,
            rack_bounds=rack_box,
            img_shape=img.shape,
        )
        unit_source = "device_tiling"
        print(
            f"[units] contiguous grid: {len(units)} rows "
            f"(unit_h={unit_h}px, top={units[0]['box'][1]}px, "
            f"bot={units[-1]['box'][3]}px)"
        )
    else:
        units = []
        unit_source = "none"
        print("[units] no Switch / Patch Panel detected — cannot derive unit_h.")

    # --- Assign each device its top-N grid units (N = round(dev_h / unit_h)) ---
    devices = assign_devices_to_units(devices, units)
    # Port-bearing classes (Switch, Patch Panel, Firewall, Gateway) MUST
    # survive even when their unit assignment came back empty — the picker
    # needs to list every one the user can inspect. Only non-port-bearing
    # devices that got zero units are dropped.
    _PICKER_PROTECTED = {"Switch", "Patch Panel", "Firewall", "Gateway", "Router"}
    devices = [d for d in devices if d.get("units") or d.get("class_name") in _PICKER_PROTECTED]
    # Every unit must map to exactly one device. Units left unclaimed by
    # any real detection — even after the low-conf retry — get a synthetic
    # 'Unidentified' placeholder. We deliberately don't call these 'Empty':
    # a rack row almost always contains *something*, and claiming 'Empty'
    # with no visual evidence would be a false certainty.
    devices = ensure_every_unit_has_device(devices, units)

    device_mapping = build_device_mapping(devices)
    json_payload = {
        "image": args.image,
        "rack_bounds": list(rack_box),
        "unit_source": unit_source,
        "units_detected": [unit["label"] for unit in units],
        "device_mapping": device_mapping,
        "devices": devices,
    }

    # Pipeline images live in their own subfolder so the rack root stays
    # readable. JSON/text artifacts stay at the root.
    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    units_only_path = os.path.join(images_dir, "1_units_only.png")
    devices_only_path = os.path.join(images_dir, "2_devices_only.png")
    combined_annotation_path = os.path.join(images_dir, "3_units_and_devices.png")
    json_path = os.path.join(output_dir, "device_unit_map.json")
    report_path = os.path.join(output_dir, "device_unit_report.txt")
    selected_device_path = os.path.join(images_dir, "4_selected_device.png")
    selected_device_port_path = os.path.join(images_dir, "5_selected_device_with_port.png")
    full_rack_output_path = os.path.join(images_dir, "6_full_rack_selected_port.png")
    rack_all_ports_path = os.path.join(images_dir, "7_rack_all_ports.png")

    report_lines = build_unit_device_lines(units, devices)
    save_unit_device_report(report_path, report_lines)

    cv2.imwrite(units_only_path, annotate_units_only(img, units))
    cv2.imwrite(devices_only_path, annotate_devices_only(img, devices))
    cv2.imwrite(combined_annotation_path, annotate_image(img, units, devices))

    print(f"Saved unit-only annotation to: {units_only_path}")
    print(f"Saved device-only annotation to: {devices_only_path}")
    print(f"Saved combined annotation to: {combined_annotation_path}")
    print(f"Saved unit/device report to: {report_path}")
    print("\nUnit report:")
    for line in report_lines:
        print(line)

    # --- Full rack with all devices' port boxes ---
    # `port_model_inst`  = typed model (ports_9.pt) — used on Switch/Router/
    #                       Firewall/Gateway.
    # `status_model_inst` = status model (port_count.pt) — IoU-bound to typed
    #                       ports to produce connected/empty; also used as
    #                       the standalone detector for patch panels.
    port_model_inst = load_model(port_typed_path)
    status_model_inst = load_model(port_status_path)
    pdu_model_inst = (
        load_model(pdu_ports_model_path)
        if pdu_ports_model_path and os.path.exists(pdu_ports_model_path)
        else None
    )
    rack_ports_img = img.copy()
    CLR_DEV = (0, 255, 0)
    CLR_CONSOLE = (255, 255, 0)  # cyan
    CLR_MAIN = (0, 0, 255)  # red
    CLR_SFP = (0, 255, 255)  # yellow
    MAIN_PORTS_ONLY = {"Patch Panel"}
    # Only run port detection on classes that actually have ports on the
    # visible face. Skipping the rest avoids hallucinated port boxes on
    # servers, storage chassis, PSUs, PDUs, etc.
    PORT_BEARING_CLASSES = {"Switch", "Patch Panel", "Firewall", "Gateway", "Router"}
    # Placeholder rack-slot fillers (empty slots, blank/closed units, and rows
    # with no confident class) get detected as full-width boxes that read like
    # rack-UNIT boundaries and clutter the overview hero. The client hides these
    # in its overlay (HIDDEN_DEVICE_TYPES); match it here so 7_rack_all_ports.png
    # shows only real devices and their ports — no unit-like boundaries.
    HIDDEN_DEVICE_TYPES = {"Empty", "Closed Unit", "Unidentified"}
    for dev in devices:
        if dev.get("class_name") in HIDDEN_DEVICE_TYPES:
            continue
        dx1, dy1, dx2, dy2 = dev["box"]
        cv2.rectangle(rack_ports_img, (dx1, dy1), (dx2, dy2), CLR_DEV, 2)
        # PDU = power outlets (own model): green connected, red empty.
        if dev["class_name"] == "PDU" and pdu_model_inst is not None:
            try:
                dev_crop, (ox, oy) = crop_device_with_origin(img, dev["box"])
                pdu = detect_pdu_ports(dev_crop, pdu_model_inst, conf=pdu_conf)
                for port in pdu["power_ports"]:
                    px1, py1, px2, py2 = port["box"]
                    clr = CLR_DEV if port["status"] == "connected" else CLR_MAIN
                    cv2.rectangle(
                        rack_ports_img, (px1 + ox, py1 + oy), (px2 + ox, py2 + oy), clr, 1
                    )
            except Exception:
                pass
            continue
        if dev["class_name"] not in PORT_BEARING_CLASSES:
            continue
        try:
            dev_crop, (ox, oy) = crop_device_with_origin(img, dev["box"])

            if dev["class_name"] in MAIN_PORTS_ONLY:
                classified = detect_patch_panel_ports(dev_crop, status_model_inst, conf=ports_conf)
            else:
                classified = classify_ports_by_pattern(
                    dev_crop,
                    port_model_inst,
                    conf=ports_conf,
                    status_model=status_model_inst,
                )
            for p, clr in (
                (classified.get("console_ports", []), CLR_CONSOLE),
                (classified.get("main_ports", []), CLR_MAIN),
                (classified.get("sfp_ports", []), CLR_SFP),
            ):
                for port in p:
                    px1, py1, px2, py2 = port["box"]
                    cv2.rectangle(
                        rack_ports_img, (px1 + ox, py1 + oy), (px2 + ox, py2 + oy), clr, 1
                    )
        except Exception:
            pass
    cv2.imwrite(rack_all_ports_path, rack_ports_img)
    print(f"Saved rack with all ports to: {rack_all_ports_path}")

    if args.detect_only:
        # Detect and classify ports only for port-bearing device classes.
        for dev in devices:
            # PDU power outlets: count connected/empty and flag whether the
            # rack is receiving power (any outlet plugged in).
            if dev["class_name"] == "PDU" and pdu_model_inst is not None:
                try:
                    dev_crop, _ = crop_device_with_origin(img, dev["box"])
                    pdu = detect_pdu_ports(dev_crop, pdu_model_inst, conf=pdu_conf)
                    dev["power_total"] = pdu["power_total"]
                    dev["power_connected"] = pdu["power_connected"]
                    dev["power_empty"] = pdu["power_empty"]
                    dev["powered"] = pdu["powered"]
                    dev["power_ports"] = pdu["power_ports"]
                except Exception:
                    dev["power_total"] = 0
                    dev["power_connected"] = 0
                    dev["power_empty"] = 0
                    dev["powered"] = False
                    dev["power_ports"] = []
                # PDUs carry power outlets, not network ports.
                dev["port_count"] = 0
                dev["ports"] = []
                dev["console_ports"] = []
                dev["sfp_ports"] = []
                dev["other_ports"] = []
                dev["connected_ports"] = []
                continue
            if dev["class_name"] not in PORT_BEARING_CLASSES:
                dev["port_count"] = 0
                dev["ports"] = []
                dev["console_ports"] = []
                dev["sfp_ports"] = []
                dev["other_ports"] = []
                dev["connected_ports"] = []
                continue
            try:
                dev_crop, _ = crop_device_with_origin(img, dev["box"])
                if dev["class_name"] in MAIN_PORTS_ONLY:
                    classified = detect_patch_panel_ports(
                        dev_crop, status_model_inst, conf=ports_conf
                    )
                else:
                    classified = classify_ports_by_pattern(
                        dev_crop,
                        port_model_inst,
                        conf=ports_conf,
                        status_model=status_model_inst,
                    )

                # Phase B grounding — if OCR can read the model name from
                # the faceplate, annotate the device with the canonical
                # port count from device_db. Visual under-count by >25%
                # of expected => trust the OCR count instead. (When OCR
                # backend is missing, read_device_model returns None and
                # this is a no-op.)
                try:
                    from pipeline.device_db import read_device_model

                    ocr_name, ocr_total, ocr_sfp = read_device_model(dev_crop)
                except Exception:
                    ocr_name = ocr_total = ocr_sfp = None

                visual_main = len(classified["main_ports"])
                # Snap the DETECTED count to a size real hardware ships with, so
                # the app never asserts an impossible switch ("no switch contains
                # 53 there must be 52"). Applied only to the visual count: an OCR
                # count comes from the faceplate model via device_db and is
                # catalogue truth, so it is published as-is. The raw number is
                # kept on port_count_visual for auditing — without it a snapped
                # count is indistinguishable from a correctly detected one.
                snapped_main = snap_switch_port_count(visual_main)
                if snapped_main != visual_main:
                    print(
                        f"  Port count snapped: {visual_main} -> {snapped_main} "
                        f"({dev['class_name']} @ {dev.get('units')})"
                    )
                if ocr_name and ocr_total:
                    expected_main = max(0, ocr_total - (ocr_sfp or 0))
                    if visual_main < expected_main * 0.75:
                        dev["port_count"] = expected_main
                        dev["port_count_source"] = f"ocr:{ocr_name}"
                    else:
                        dev["port_count"] = snapped_main
                        if snapped_main != visual_main:
                            dev["port_count_source"] = "snapped"
                    dev["ocr_model"] = ocr_name
                    dev["ocr_expected_ports"] = expected_main
                    dev["ocr_expected_sfp"] = ocr_sfp or 0
                else:
                    dev["port_count"] = snapped_main
                    if snapped_main != visual_main:
                        dev["port_count_source"] = "snapped"
                dev["port_count_visual"] = visual_main

                dev["ports"] = classified["main_ports"]
                dev["console_ports"] = classified["console_ports"]
                dev["sfp_ports"] = classified["sfp_ports"]
                dev["other_ports"] = classified.get("other_ports", [])
                dev["connected_ports"] = [
                    p for p in classified["main_ports"] if p.get("status") == "connected"
                ]
            except Exception as exc:
                # A port-detection CRASH must not masquerade as a device that
                # genuinely has no ports. Log it with context, then MARK the
                # failure so device_unit_map.json keeps a crash apart from a
                # real zero-port device — both still demote to "Unidentified"
                # below, but only the crash carries port_detection_failed.
                logger.exception(
                    "port detection failed for device class=%r units=%s box=%s",
                    dev.get("class_name"),
                    dev.get("units"),
                    dev.get("box"),
                )
                print(
                    f"[ports] detection FAILED on {dev.get('class_name')!r} "
                    f"box={dev.get('box')}: {type(exc).__name__}: {exc}"
                )
                mark_port_detection_failed(dev, exc)

            # If the port detector found no ports at all on a port-bearing
            # device, the YOLO class is almost certainly wrong — demote to
            # Unidentified. Status ('connected' vs 'empty') is no longer
            # required: the class-aware port_best.pt labels port *category*
            # (main/sfp/console) but doesn't infer occupancy, so legitimate
            # ports come back with status='unknown'. A crashed detection was
            # marked above; demote_if_no_ports preserves that marker.
            demote_if_no_ports(dev)

        # Rebuild the class→units mapping since reclassification above may
        # have moved devices out of their original class bucket.
        json_payload["device_mapping"] = build_device_mapping(devices)
        save_json(json_path, json_payload)
        print(f"Saved unit/device mapping JSON to: {json_path}")
        print("[detect_only] Detection and port analysis complete.")
        return

    # ── Don't publish this re-detection over an already-analysed map ──────
    # Reaching here means a SELECT ("show me port N on device D"), not an
    # analyze: the --detect_only branch above returns before this line. Only
    # that branch computes per-device port_count / ports / sfp_ports /
    # console_ports, so json_payload here carries devices with NO port data —
    # and saving it stripped those fields off every device in the rack.
    #
    # That is what broke the second port lookup. The first lookup read a good
    # map, worked, and wiped it on the way out. The next one found port_count
    # gone, so the server had no target count to pin the layout to and the UI
    # was told the device has 0 ports — "We couldn't read how many ports this
    # device has. Set the port count below, then pick a port." Rebuilding the
    # canonical scan_result.json from the stripped map spread it to the ports
    # dropdown and the report too. (server/app.js grew ensurePortCounts() to
    # heal this after the fact; better not to break it in the first place.)
    #
    # The analysed map is authoritative — keep it, and only write when there
    # is nothing there to protect.
    _analysed_devices = _analysed_map_devices(json_path)
    if _analysed_devices is None:
        save_json(json_path, json_payload)
        print(f"Saved unit/device mapping JSON to: {json_path}")
    else:
        print(
            f"[select] preserving analysed device_unit_map.json "
            f"({len(_analysed_devices)} devices with port data) — not overwriting"
        )

    if not devices:
        raise RuntimeError("No devices detected. Cannot continue to port detection.")

    # Index into the ANALYSED device list whenever we have one. device_index is
    # defined BY that list — the client numbered the devices it was shown, which
    # came from the analyze pass — so the analysed map is authoritative here by
    # construction, and the fresh re-detection above is not.
    #
    # This matters because the two genuinely disagree. On a real scan
    # (RK-2BD4D8B8) the analysed map holds 6 devices while re-detection finds
    # 5: device 6 falls off the end entirely and devices 3-5 name different
    # hardware than the user is pointing at. Indexing the fresh list is how
    # "find port 5" came back with a port on the wrong device, or with nothing.
    #
    # Only fall back to the fresh list when there is no analysed map at all
    # (a single-shot CLI run that goes straight to select without analyzing).
    _index_source = _analysed_devices if _analysed_devices else devices
    if _analysed_devices and len(_analysed_devices) != len(devices):
        print(
            f"[select] re-detection found {len(devices)} devices but the analysed map "
            f"has {len(_analysed_devices)}; indexing the analysed map (authoritative)"
        )

    if args.device_index is not None:
        if not 1 <= args.device_index <= len(_index_source):
            raise ValueError("device_index is out of range.")
        selected = _index_source[args.device_index - 1]
    else:
        selected = select_device(_index_source, fallback_class_names=FALLBACK_DEVICE_CLASS_NAMES)

    device_crop, crop_origin = crop_device_with_origin(img, selected["box"])
    cv2.imwrite(selected_device_path, device_crop)
    print(f"Saved selected device crop to: {selected_device_path}")

    # port_model_inst and status_model_inst were already loaded above for the
    # full-rack pass; reuse them here instead of re-loading.
    cable_model = load_cable_model(cable_model_path, device="cpu") if cable_model_path else None
    port_id_model = (
        load_port_identify_model(port_identify_model_path, device="cpu")
        if port_identify_model_path
        else None
    )

    _target = getattr(args, "target_count", 0) or 0
    if selected["class_name"] in MAIN_PORTS_ONLY:
        classified = detect_patch_panel_ports(device_crop, status_model_inst, conf=ports_conf)
    elif _target > 0:
        # Honour the user-confirmed port count so port N here is the same N the
        # user numbered when they corrected the count (24 = the 24th position).
        classified = classify_ports_with_target_count(
            device_crop,
            port_model_inst,
            _target,
            conf=ports_conf,
            status_model=status_model_inst,
        )
    else:
        classified = classify_ports_by_pattern(
            device_crop,
            port_model_inst,
            conf=ports_conf,
            status_model=status_model_inst,
        )

    n_console = len(classified.get("console_ports", []))
    n_main = len(classified["main_ports"])
    n_sfp = len(classified.get("sfp_ports", []))
    n_other = len(classified.get("other_ports", []))

    pat = classified.get("pattern_info", {})
    cluster_sizes = pat.get("cluster_sizes", [])
    num_clusters = pat.get("num_clusters", 0)
    main_cluster_size = pat.get("main_cluster_size", 0)

    print(f"\nPort pattern: {num_clusters} cluster(s) — sizes {cluster_sizes}")
    print(f"  Main pattern: {main_cluster_size} ports/cluster")
    if n_console:
        print(f"  Console: {n_console} port(s)")
    if n_main:
        print(f"  Main:    {n_main} port(s)")
    if n_sfp:
        print(f"  SFP:     {n_sfp} port(s)")

    port_category = getattr(args, "port_category", "main") or "main"
    cat_key = {
        "main": "main_ports",
        "sfp": "sfp_ports",
        "console": "console_ports",
        "other": "other_ports",
    }.get(port_category, "main_ports")
    cat_list = classified.get(cat_key, [])
    cat_count = len(cat_list)

    port_number = args.port
    if port_number is None:
        prompt_max = cat_count if cat_count else n_main
        port_number = int(input(f"Enter {port_category} port number to select (1-{prompt_max}): "))

    annotated_device = draw_classified(
        device_crop,
        classified,
        highlight_idx=port_number,
        highlight_category=port_category,
        index_offset=getattr(args, "index_offset", 0) or 0,
    )
    cv2.imwrite(selected_device_port_path, annotated_device)

    selected_port_info = {
        "port_number": port_number,
        "port_category": port_category,
        "status": "unknown",
        "occupancy_source": None,
        "class_name": None,
        "confidence": None,
        "location": None,
        "cable_type": None,
        "cable_connector": None,
        "cable_color": None,
        "cable_confidence": None,
        "port_type": None,
        "port_type_confidence": None,
    }

    selected_port_box = None
    if 1 <= port_number <= cat_count:
        selected_port = cat_list[port_number - 1]
        selected_port_info["status"] = selected_port.get("status", "unknown")
        selected_port_info["class_name"] = selected_port.get("class_name")
        selected_port_info["confidence"] = selected_port.get("confidence")

        box = selected_port["box"]
        ox, oy = crop_origin
        selected_port_box = [box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy]
        selected_port_info["location"] = selected_port_box

        # Occupancy comes ONLY from the status sweep. When it couldn't tag the
        # selected port (e.g. patch-panel-trained port_count.pt didn't match
        # this switch's port box), the honest answer is "unknown" — we do NOT
        # fall back to the cable classifier's confidence. That model has no
        # 'no-cable' class (all 14 outputs are colours), so its softmax measures
        # WHICH colour, never WHETHER a cable is present; thresholding it here
        # fabricated connected/empty that then fed topology and the CMDB.
        # occupancy_source makes the distinction explicit in the output so a
        # downstream consumer can tell a measured empty from an unknown.
        selected_port_info["status"] = resolve_port_occupancy(selected_port_info["status"])
        selected_port_info["occupancy_source"] = (
            "status_model" if selected_port_info["status"] in _OCCUPANCY_STATES else "unknown"
        )

        if selected_port_info["status"] == "connected" and cable_model is not None:
            # Quadruple the port box size before handing it to the cable
            # classifier: the connector alone is a too-tight crop for the
            # model — it needs the connector PLUS a chunk of the cable body
            # (color, sheath texture) to nail RJ-45 vs LC vs SC and the
            # specific color reliably. pad_x = 1.5 * box_w → crop width =
            # box_w + 2*1.5*box_w = 4*box_w. The displayed bbox in the UI
            # remains the original `selected_port_box`; this enlargement is
            # internal to the classifier call only.
            bx1, by1, bx2, by2 = selected_port_box
            box_w = max(1, bx2 - bx1)
            box_h = max(1, by2 - by1)
            port_crop = crop_box(
                img,
                selected_port_box,
                pad_x=(box_w * 3) // 2,
                pad_y=(box_h * 3) // 2,
            )
            # Constrained by the port we are actually looking at, so an SFP
            # cage cannot come back described as an RJ-45 cable.
            cable_class, cable_conf = classify_cable(
                port_crop, cable_model, port_category=port_category
            )
            connector, color = parse_cable_type_color(cable_class)
            selected_port_info["cable_type"] = cable_class
            selected_port_info["cable_connector"] = connector
            selected_port_info["cable_color"] = color
            selected_port_info["cable_confidence"] = cable_conf

            # Cross-scan carry-over: match this cable's appearance against prior
            # technician colour corrections in this org's learning memory and,
            # if found, apply the corrected colour — so a fix made on one scan
            # sticks even when the same rack is re-scanned (a different photo /
            # rack id). The lookup uses a tight crop matching the one saved at
            # feedback time so the perceptual hashes line up.
            try:
                _org = getattr(args, "org_id", None)
                if _org:
                    import tempfile

                    from pipeline.active_learning import store as _al

                    _al.set_org(_org)
                    _lc = crop_box(
                        img,
                        selected_port_box,
                        pad_x=max(2, box_w // 4),
                        pad_y=max(2, box_h // 4),
                    )
                    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as _tf:
                        _cp = _tf.name
                    cv2.imwrite(_cp, _lc)
                    _match = _al.find_match("cable", _cp)
                    try:
                        os.unlink(_cp)
                    except OSError:
                        pass
                    if _match and _match.get("label") and _match["label"] != color:
                        _old = color
                        color = _match["label"]
                        selected_port_info["cable_color"] = color
                        selected_port_info["cable_color_corrected"] = True
                        if connector:
                            selected_port_info["cable_type"] = f"{connector} {color}"
                        print(f"  Cable colour corrected '{_old}' -> '{color}' (learned)")
            except Exception as _e:
                print(f"  (cable learning lookup skipped: {_e})")
        elif selected_port_info["status"] == "empty" and port_id_model is not None:
            port_crop = crop_box(img, selected_port_box, pad=10)
            port_type, port_type_conf = classify_port_type(port_crop, port_id_model)
            selected_port_info["port_type"] = port_type
            selected_port_info["port_type_confidence"] = port_type_conf

        # Learned port-TYPE correction: if this port's crop matches a prior
        # user type-tag in the org's active-learning memory, apply it. Mirrors
        # the cable-colour learned lookup above; best-effort, any status.
        try:
            _org2 = getattr(args, "org_id", None)
            if _org2 and selected_port_box is not None:
                import tempfile as _tf2mod

                from pipeline.active_learning import store as _al2

                _al2.set_org(_org2)
                _tbx1, _tby1, _tbx2, _tby2 = selected_port_box
                _tbw = max(1, _tbx2 - _tbx1)
                _tbh = max(1, _tby2 - _tby1)
                _tcrop = crop_box(
                    img, selected_port_box, pad_x=max(2, _tbw // 4), pad_y=max(2, _tbh // 4)
                )
                with _tf2mod.NamedTemporaryFile(suffix=".jpg", delete=False) as _ttf:
                    _tpath = _ttf.name
                cv2.imwrite(_tpath, _tcrop)
                _tmatch = _al2.find_match("port_type", _tpath)
                try:
                    os.unlink(_tpath)
                except OSError:
                    pass
                if _tmatch and _tmatch.get("label"):
                    selected_port_info["port_type"] = _tmatch["label"]
                    selected_port_info["port_type_corrected"] = True
                    print(f"  Port type set to '{_tmatch['label']}' (learned)")
        except Exception as _e:
            print(f"  (port-type learning lookup skipped: {_e})")
    else:
        selected_port_info["status"] = "invalid"

    cv2.imwrite(full_rack_output_path, annotate_full_rack(img, selected["box"], selected_port_box))

    selected_port_info_path = os.path.join(output_dir, "selected_port_info.json")
    with open(selected_port_info_path, "w", encoding="utf-8") as info_file:
        json.dump(
            {
                "scan_image": args.image,
                "device_index": args.device_index,
                "selected_device": selected,
                "port_classification": {
                    "console": n_console,
                    "main": n_main,
                    "sfp": n_sfp,
                },
                "port_info": selected_port_info,
            },
            info_file,
            indent=2,
        )

    print(f"Saved selected device with port annotation to: {selected_device_port_path}")
    print(f"Saved full rack selected-port annotation to: {full_rack_output_path}")
    print(f"Saved selected port info to: {selected_port_info_path}")
    print(f"Device '{selected['class_name']}' assigned to units {selected.get('units', [])}.")

    status = selected_port_info["status"]
    print(f"\nPort {port_number} ({port_category}): {status}")
    if selected_port_info["location"]:
        bx1, by1, bx2, by2 = selected_port_info["location"]
        print(f"  Location: x={bx1}, y={by1}, w={bx2 - bx1}, h={by2 - by1}")
    if status == "connected":
        connector = selected_port_info.get("cable_connector")
        color = selected_port_info.get("cable_color")
        if connector and color:
            print(f"  Cable Type: {connector}")
            print(f"  Cable Color: {color}")
        elif selected_port_info.get("cable_type"):
            print(f"  Cable: {selected_port_info['cable_type']}")
    elif status == "empty":
        port_type = selected_port_info.get("port_type")
        if port_type:
            print(f"  Port Type: {port_type}")


if __name__ == "__main__":
    main()
