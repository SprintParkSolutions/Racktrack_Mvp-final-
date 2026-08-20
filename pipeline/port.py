"""
Low-level port-model wrapper.

This module owns the YOLO call and a few primitives shared with
port_pattern.py. The category/cleanup logic lives in port_pattern.py;
this file stays thin on purpose.

Public surface used by callers:
  - load_port_model          (worker.py, redetect_ports.py)
  - draw_classified          (runner.py)
  - get_port_detections      (port_pattern.py)
  - find_rows / get_dx       (port_pattern.detect_patch_panel_ports)
  - infer_port_status        (port_pattern.py)
  - verify_boxes_with_edges  (port_pattern.detect_patch_panel_ports)
  - BOX_W / BOX_H / CONF
"""

import cv2
import numpy as np
from ultralytics import YOLO

MODEL_PATH = r"Models/ports_9.pt"
CONF = 0.23
BOX_W = 30
BOX_H = 35

# Minimum confidence required to call a port 'connected' or 'empty'. Below
# this we return 'unknown' — the downstream cable / port-type classifiers
# only run on high-confidence calls, which cuts false positives on blurry
# or ambiguous ports.
PORT_STATUS_CONF_MIN = 0.35


def verify_boxes_with_edges(img, boxes, min_edge_pct=0.04):
    """Drop boxes whose image region has too few edges (blank panel area).

    Real ports have connector outlines, cables, labels → high edge density.
    Blank panel / empty space has almost no edges.
    """
    if not boxes or img is None:
        return boxes
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    h_img, w_img = gray.shape[:2]
    verified = []
    for b in boxes:
        x1 = max(0, int(b[0]))
        y1 = max(0, int(b[1]))
        x2 = min(w_img, int(b[2]))
        y2 = min(h_img, int(b[3]))
        if x2 <= x1 or y2 <= y1:
            continue
        crop = gray[y1:y2, x1:x2]
        edges = cv2.Canny(crop, 50, 150)
        area = edges.shape[0] * edges.shape[1]
        if area == 0:
            continue
        edge_pct = np.count_nonzero(edges) / area
        if edge_pct >= min_edge_pct:
            verified.append(b)
    return verified


def load_port_model(model_path: str = MODEL_PATH):
    return YOLO(model_path)


def infer_port_status(class_name: str, confidence: float = None):
    if confidence is not None and confidence < PORT_STATUS_CONF_MIN:
        return "unknown"
    if not class_name:
        return "unknown"
    key = class_name.strip().lower()
    if any(
        term in key
        for term in (
            "connect",
            "connected",
            "plug",
            "occupied",
            "cable",
            "linked",
            "live",
            "active",
        )
    ):
        return "connected"
    if any(term in key for term in ("empty", "vacant", "free", "none", "unused", "unconnected")):
        return "empty"
    return "unknown"


def get_port_detections(img, model, conf: float = CONF):
    """Run YOLO and return a list of detection dicts.

    Uses per-class NMS at iou=0.45. Cross-category overlap (e.g. an SFP
    detection and a main detection firing on the same physical jack)
    is intentionally NOT suppressed here — port_pattern.classify_ports_by_pattern
    handles that with category-priority rules (SFP > console > main).

    Each detection carries its bbox so the classifier can build port
    boxes from the actual YOLO output instead of synthesizing them
    from centers + BOX_W/BOX_H.
    """
    results = model(img, conf=conf, iou=0.45, agnostic_nms=False)
    if not results or results[0].boxes is None:
        return []

    xyxy = results[0].boxes.xyxy.cpu().numpy()
    cls_ids = results[0].boxes.cls.cpu().numpy().astype(int)
    scores = results[0].boxes.conf.cpu().numpy()
    names = getattr(model, "names", {})

    detections = []
    for i, (x1, y1, x2, y2) in enumerate(xyxy):
        cx = int(round((x1 + x2) / 2))
        cy = int(round((y1 + y2) / 2))
        class_id = int(cls_ids[i])
        class_name = str(names.get(class_id, class_id))
        detections.append(
            {
                "center": (cx, cy),
                "bbox": (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))),
                "class_id": class_id,
                "class_name": class_name,
                "confidence": float(scores[i]),
            }
        )

    return sorted(detections, key=lambda item: (item["center"][0], item["center"][1]))


def find_rows(ports, H):
    """Cluster port centers into top/bottom rows.

    Handles cable-occluded 2-row devices: when only one band is visible
    in the upper or lower third, mirrors it across the device midline
    to recover the hidden row.
    """
    mid = H // 2
    top = [(x, y) for x, y in ports if y < mid]
    bot = [(x, y) for x, y in ports if y >= mid]

    if top and bot:
        r1, r2 = np.mean([y for _, y in top]), np.mean([y for _, y in bot])
        for _ in range(10):
            nt = [(x, y) for x, y in ports if abs(y - r1) <= abs(y - r2)]
            nb = [(x, y) for x, y in ports if abs(y - r1) > abs(y - r2)]
            r1n = np.mean([y for _, y in nt]) if nt else r1
            r2n = np.mean([y for _, y in nb]) if nb else r2
            if abs(r1n - r1) < 0.1 and abs(r2n - r2) < 0.1:
                break
            r1, r2 = r1n, r2n
        return nt, nb, int(r1), int(r2)

    if not top and not bot:
        return [], [], None, None

    pts = top or bot
    ys = [y for _, y in pts]
    y_mean = float(np.mean(ys))

    if y_mean < H / 3:
        r1 = int(y_mean)
        r2 = int(H - y_mean)
        return pts, [], r1, r2
    if y_mean > 2 * H / 3:
        r2 = int(y_mean)
        r1 = int(H - y_mean)
        return [], pts, r1, r2

    return top, bot, (int(y_mean) if top else None), (int(y_mean) if bot else None)


def get_dx(ports):
    if len(ports) < 2:
        return BOX_W
    xs = sorted(set(x for x, _ in ports))
    dx = np.diff(xs)
    dx = dx[dx > 5]
    return float(np.median(dx)) if len(dx) else BOX_W


def draw_classified(img, classified, highlight_idx=None, highlight_category="main", index_offset=0):
    """Mark EVERY classified port with a dot at its centre plus its index. When
    highlight_idx is set, that port (1-based within highlight_category) gets a
    larger green dot so the selected port stands out among all the others.

    highlight_category selects which list (main_ports / sfp_ports / console_ports)
    the highlight_idx refers to.

    index_offset is the user's port-number shift for the MAIN row: it's added to
    each main port's drawn index so the labels read in the user's corrected
    numbering (a port the model numbered N is labelled N+offset). Positions that
    fall before the user's port 1 (index+offset < 1) get a dot but no number.
    """
    out = img.copy()
    CLR_C = (255, 255, 0)  # cyan   - console
    CLR_M = (0, 0, 255)  # red    - main
    CLR_S = (0, 255, 255)  # yellow - sfp
    CLR_H = (0, 255, 0)  # green  - highlighted
    CLR_OT = (0, 165, 255)  # orange - other

    def _dot(p, color, prefix="", big=False, place="above", offset=0):
        # Scale the dot + label to the port's own size so a small / dense
        # device crop gets small marks (instead of huge dots and overlapping
        # numbers that bury the image), while big devices stay clearly legible.
        # `place` puts the index above the port (top row) or below it (bottom
        # row) so a two-row device reads cleanly.
        x1, y1, x2, y2 = [int(v) for v in p["box"]]
        cx, cy = int(p["center"][0]), int(p["center"][1])
        base = max(6, min(x2 - x1, y2 - y1))
        r = max(2, min(int(base * (0.22 if big else 0.11)), 11 if big else 6))
        cv2.circle(out, (cx, cy), r + 1, (0, 0, 0), -1, cv2.LINE_AA)  # dark halo for contrast
        cv2.circle(out, (cx, cy), r, color, -1, cv2.LINE_AA)  # the dot
        raw = p.get("index", "")
        if isinstance(raw, int):
            disp = raw + offset  # apply the user's numbering shift
            idx = "" if disp < 1 else f"{prefix}{disp}"
        else:
            idx = f"{prefix}{raw}" if raw != "" else ""
        if idx:
            fs = max(0.28, min(base / 120.0, 0.50))
            th = 2 if fs >= 0.48 else 1
            (tw, thg), _ = cv2.getTextSize(idx, cv2.FONT_HERSHEY_SIMPLEX, fs, th)
            if place == "below":
                ty = min(out.shape[0] - 2, y2 + thg + 3)  # under the port
            else:
                ty = max(y1 - 3, thg + 2)  # above the port
            org = (int(cx - tw / 2), ty)
            cv2.putText(out, idx, org, cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), th + 2, cv2.LINE_AA)
            cv2.putText(
                out, idx, org, cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), th, cv2.LINE_AA
            )

    # Decide label placement for the main ports: if they span two rows, the
    # top row labels go above and the bottom row labels go below, so the rows
    # don't collide in the middle. Single row → all above.
    main = classified.get("main_ports", [])
    place_of = {}
    if main:
        ys = [int(p["center"][1]) for p in main]
        hs = [max(1, int(p["box"][3]) - int(p["box"][1])) for p in main]
        avg_h = sum(hs) / len(hs)
        y_lo, y_hi = min(ys), max(ys)
        if (y_hi - y_lo) > avg_h * 0.7:  # two distinct rows
            mid = (y_lo + y_hi) / 2.0
            for p in main:
                place_of[id(p)] = "above" if int(p["center"][1]) < mid else "below"

    # ── A dot + index for every port ── (the numbering shift applies to the
    # MAIN row only; console/sfp/other keep their own C/S/O sequences).
    # Only drawn when NO port is selected — the browse view shows all ports and
    # their numbers so the user can pick one. Once a port is located
    # (highlight_idx set), we show ONLY that port and skip every other marker.
    if highlight_idx is None:
        for p in classified.get("console_ports", []):
            _dot(p, CLR_C, "C")
        for p in main:
            _dot(p, CLR_M, place=place_of.get(id(p), "above"), offset=index_offset)
        for p in classified.get("sfp_ports", []):
            _dot(p, CLR_S, "S")
        for p in classified.get("other_ports", []):
            _dot(p, CLR_OT, "O")

    # ── Larger green dot on the selected port ──
    if highlight_idx is not None:
        cat_key = {
            "main": "main_ports",
            "sfp": "sfp_ports",
            "console": "console_ports",
            "other": "other_ports",
        }.get(highlight_category, "main_ports")
        target_list = classified.get(cat_key, [])
        if 1 <= highlight_idx <= len(target_list):
            tp = target_list[highlight_idx - 1]
            _dot(
                tp,
                CLR_H,
                big=True,
                place=place_of.get(id(tp), "above"),
                offset=(index_offset if highlight_category == "main" else 0),
            )

    return out
