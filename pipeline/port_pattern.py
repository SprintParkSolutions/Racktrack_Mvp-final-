import statistics

"""Port detection wrapper — typed-model + status-model flow.

This module replaces the old pattern-based classifier. The model topology is
now:

  ports_typed (ports_9.pt) → port TYPE only
    Classes: RJ45, SFP, QSFP, CONSOLE, AUX, MANAGEMENT_PORT,
             USB_A, USB_B, USB_C
    Carries no connected/empty signal.

  ports_status (port_count.pt) → STATUS only
    Classes: Connected_port, Empty_port
    Carries no type signal.

Per crop we run both models, NMS each within itself, then IoU-match each
status box onto the typed box with the highest overlap. A typed port with
no overlapping status box stays "unknown".

Public surface kept stable for runner.py + worker.py:

  classify_ports_by_pattern(crop, type_model, conf=..., status_model=...)
  classify_ports_with_target_count(crop, type_model, target, conf=..., status_model=...)
  detect_patch_panel_ports(crop, status_model, conf=...)

Return shape (preserved for server/app.js consumers):

  {'main_ports':    [port_dict, ...],
   'sfp_ports':     [...],
   'console_ports': [...],
   'other_ports':   [...],   # USB ports land here
   'all_boxes':     [...],
   'pattern_info':  {...}}

Each port_dict carries:
  box[xyxy] in CROP coordinates · center[cx,cy] · status · class_name ·
  confidence · port_category · index
"""

from pipeline.port import (  # re-export so existing imports keep working
    CONF,
)

# ports_9 class name → category bucket used by the JSON contract.
_TYPE_TO_CATEGORY = {
    "RJ45": "main",
    "SFP": "sfp",
    "QSFP": "sfp",
    "CONSOLE": "console",
    "AUX": "console",
    "MANAGEMENT_PORT": "console",
    "USB_A": "other",
    "USB_B": "other",
    "USB_C": "other",
}


def _nms(detections, iou_thresh=0.5, containment_thresh=0.75):
    """Greedy NMS: highest-conf first, drop later boxes that either overlap
    (IoU > iou_thresh) OR sit mostly inside an already-kept box
    (containment > containment_thresh).

    The containment check catches nested/duplicate boxes of very different
    sizes firing on the same physical port — those have low IoU but high
    containment, so an IoU-only pass would keep both and number the same
    port twice. (Adopted from the new ports.py reference.)
    """
    if not detections:
        return []
    dets = sorted(detections, key=lambda d: d.get("confidence", 0.0), reverse=True)
    keep = []
    for d in dets:
        x1, y1, x2, y2 = d["bbox"]
        ai = max(1, (x2 - x1) * (y2 - y1))
        drop = False
        for k in keep:
            kx1, ky1, kx2, ky2 = k["bbox"]
            ix1, iy1 = max(x1, kx1), max(y1, ky1)
            ix2, iy2 = min(x2, kx2), min(y2, ky2)
            if ix2 <= ix1 or iy2 <= iy1:
                continue
            inter = (ix2 - ix1) * (iy2 - iy1)
            ak = max(1, (kx2 - kx1) * (ky2 - ky1))
            iou = inter / (ai + ak - inter)
            # Drop if THIS box is mostly inside the kept box, OR mostly encloses
            # it (large low-conf box over an already-kept small high-conf one).
            containment = max(inter / ai, inter / ak)
            if iou > iou_thresh or containment > containment_thresh:
                drop = True
                break
        if not drop:
            keep.append(d)
    return keep


def _detections_from(model, img, conf):
    """Run a YOLO model on `img` and return a list of {bbox, class_name,
    confidence} dicts. NMS not applied here — callers run _nms with their
    own thresholds.
    """
    res = model.predict(img, conf=conf, verbose=False)
    if not res or res[0].boxes is None or len(res[0].boxes) == 0:
        return []
    names = getattr(model, "names", {})
    out = []
    for b in res[0].boxes:
        cid = int(b.cls[0].item())
        cf = float(b.conf[0].item())
        x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
        out.append(
            {
                "class_name": str(names.get(cid, cid)),
                "confidence": cf,
                "bbox": [x1, y1, x2, y2],
            }
        )
    return out


def _box_iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    aa = max(1, (a[2] - a[0]) * (a[3] - a[1]))
    bb = max(1, (b[2] - b[0]) * (b[3] - b[1]))
    return inter / (aa + bb - inter)


def _status_from_name(cn):
    cn = (cn or "").strip().lower()
    if "connect" in cn:
        return "connected"
    if "empty" in cn:
        return "empty"
    return "unknown"


def _bind_status(typed, status_dets, iou_thresh=0.3):
    """For each typed port, pick the status box with the largest IoU (>= thresh)
    and copy its status onto the typed port. No match → 'unknown'.
    """
    for tp in typed:
        best_iou = 0.0
        best = None
        for s in status_dets:
            i = _box_iou(tp["bbox"], s["bbox"])
            if i > best_iou:
                best_iou, best = i, s
        tp["status"] = (
            _status_from_name(best["class_name"])
            if best is not None and best_iou >= iou_thresh
            else "unknown"
        )


def _to_port_dict(d, category):
    x1, y1, x2, y2 = d["bbox"]
    return {
        "box": [int(x1), int(y1), int(x2), int(y2)],
        "center": [(int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2],
        "status": d.get("status", "unknown"),
        "class_name": d["class_name"],
        "confidence": float(d["confidence"]),
        "port_category": category,
    }


# Row/column clustering thresholds (from the new ports.py reference).
#   COLUMN_GROUP_GAP_FACTOR — top/bottom ports within this × the average port
#                            width of each other count as the same column.
#   ROW_SPLIT_PAIR_FRACTION — primary two-row signal: if at least this fraction
#                            of a class's ports fall into clean top+bottom
#                            x-column pairs, treat it as a 2-row grid. Immune
#                            to perspective skew (see _split_into_rows).
#   ROW_SPLIT_GAP_FACTOR   — fallback signal: a vertical gap must exceed this ×
#                            the average port height before we call a class two
#                            rows (only used when x-pairing finds no grid).
COLUMN_GROUP_GAP_FACTOR = 0.6
ROW_SPLIT_PAIR_FRACTION = 0.6
ROW_SPLIT_GAP_FACTOR = 0.6


def _port_cx(p):
    x1, _, x2, _ = p["box"]
    return (x1 + x2) / 2.0


def _split_into_rows(plist):
    """Decide whether a set of same-category ports forms one row or two, and
    return [row] or [top, bottom].

    PRIMARY signal — paired x-columns: a real 2-row port grid has a top and a
    bottom port stacked at (almost) the same x in most columns. We check this
    FIRST, independently of any y-gap, because it's immune to perspective skew:
    real device photos often have the whole row's y drifting steadily left→right
    (the rack tilts slightly toward/away from the camera), which smears the gap
    between the two rows across many small steps instead of one clean jump — the
    very thing that breaks a "biggest y-gap" test. Two ports stacked at the same
    x stay paired regardless of that drift.

    FALLBACK signal — a single dominant y-gap: covers genuinely 2-row layouts
    that AREN'T column-aligned (a sparser bottom row on a different pitch), where
    x-pairing finds no matches but the rows are still well separated vertically.
    """
    if len(plist) <= 1:
        return [plist]

    enriched = []
    for p in plist:
        x1, y1, x2, y2 = p["box"]
        enriched.append(
            {"cx": (x1 + x2) / 2.0, "cy": (y1 + y2) / 2.0, "h": (y2 - y1), "w": (x2 - x1), "p": p}
        )

    heights = [e["h"] for e in enriched]
    avg_h = max(sum(heights) / len(heights) if heights else 1, 1)

    # ---- Primary: paired x-columns ------------------------------------
    by_cx = sorted(enriched, key=lambda e: e["cx"])
    widths = [e["w"] for e in by_cx]
    avg_w = max(sum(widths) / len(widths) if widths else 1, 1)
    x_cluster_gap = max(avg_w * COLUMN_GROUP_GAP_FACTOR, 1.0)

    x_clusters = []
    cur = [by_cx[0]]
    for e in by_cx[1:]:
        if e["cx"] - cur[-1]["cx"] <= x_cluster_gap:
            cur.append(e)
        else:
            x_clusters.append(cur)
            cur = [e]
    x_clusters.append(cur)

    paired_clusters = [c for c in x_clusters if len(c) == 2]
    paired_count = sum(len(c) for c in paired_clusters)

    if paired_count / len(enriched) >= ROW_SPLIT_PAIR_FRACTION:
        top_group = [min(c, key=lambda e: e["cy"])["p"] for c in paired_clusters]
        bottom_group = [max(c, key=lambda e: e["cy"])["p"] for c in paired_clusters]
        top_cy_mean = statistics.mean(min(c, key=lambda e: e["cy"])["cy"] for c in paired_clusters)
        bottom_cy_mean = statistics.mean(
            max(c, key=lambda e: e["cy"])["cy"] for c in paired_clusters
        )

        # An x-cluster that ISN'T a clean pair (a port with no match on the
        # other row — e.g. a couple of extra uplink ports) still has to land
        # in top or bottom: assign by whichever row's mean cy it's nearer.
        for c in x_clusters:
            if len(c) == 2:
                continue
            for e in c:
                if abs(e["cy"] - top_cy_mean) <= abs(e["cy"] - bottom_cy_mean):
                    top_group.append(e["p"])
                else:
                    bottom_group.append(e["p"])

        if top_group and bottom_group:
            return [top_group, bottom_group]

    # ---- Fallback: a single dominant y-gap ----------------------------
    enriched.sort(key=lambda e: e["cy"])
    cys = [e["cy"] for e in enriched]
    gaps = [cys[i] - cys[i - 1] for i in range(1, len(cys))]
    max_gap = max(gaps)
    split_idx = gaps.index(max_gap) + 1

    if max_gap > avg_h * ROW_SPLIT_GAP_FACTOR:
        top = [e["p"] for e in enriched[:split_idx]]
        bottom = [e["p"] for e in enriched[split_idx:]]
        if top and bottom:
            return [top, bottom]

    return [[e["p"] for e in enriched]]


def _group_into_columns(top_row, bottom_row):
    """Interleave two rows into column-major reading order: pair top and bottom
    ports into shared columns by x, then emit top-then-bottom within each
    column, left to right (→ 1,3,5… top / 2,4,6… bottom).

    Pairing is nearest-neighbor (each top matched to at most one bottom, and
    vice versa, closest pair first) rather than left-to-right chaining. Chaining
    let 3+ ports that were each individually within the cluster gap of their
    neighbor collapse into a single column, silently dropping every top/bottom
    in that chain except the last one seen — a real bug on rows where the bottom
    ports are offset half a pitch from the top ports (very common), since then
    EVERY port in the row is "close" to the next one.
    """
    if not top_row and not bottom_row:
        return []
    if not top_row:
        return sorted(bottom_row, key=lambda p: (_port_cx(p), p["box"][1]))
    if not bottom_row:
        return sorted(top_row, key=lambda p: (_port_cx(p), p["box"][1]))

    top_sorted = sorted(top_row, key=_port_cx)
    bottom_sorted = sorted(bottom_row, key=_port_cx)

    widths = [(p["box"][2] - p["box"][0]) for p in top_sorted + bottom_sorted]
    avg_w = max(sum(widths) / len(widths) if widths else 1, 1)
    cluster_gap = max(avg_w * COLUMN_GROUP_GAP_FACTOR, 1.0)

    # Every candidate (top, bottom) pair within cluster_gap, closest first.
    candidate_pairs = []
    for ti, t in enumerate(top_sorted):
        tx = _port_cx(t)
        for bi, b in enumerate(bottom_sorted):
            dist = abs(_port_cx(b) - tx)
            if dist <= cluster_gap:
                candidate_pairs.append((dist, ti, bi))
    candidate_pairs.sort(key=lambda pr: pr[0])

    # Greedily match closest pairs first; each top/bottom used at most once.
    matched_bottom_for_top = {}
    used_tops, used_bottoms = set(), set()
    for dist, ti, bi in candidate_pairs:
        if ti in used_tops or bi in used_bottoms:
            continue
        used_tops.add(ti)
        used_bottoms.add(bi)
        matched_bottom_for_top[ti] = bi

    # One column per top (with its matched bottom, if any)…
    columns = []
    for ti, t in enumerate(top_sorted):
        bi = matched_bottom_for_top.get(ti)
        b = bottom_sorted[bi] if bi is not None else None
        columns.append({"x": _port_cx(t), "top": t, "bottom": b})
    # …plus any bottom that didn't get matched to a top as its own column.
    for bi, b in enumerate(bottom_sorted):
        if bi not in used_bottoms:
            columns.append({"x": _port_cx(b), "top": None, "bottom": b})

    columns.sort(key=lambda c: c["x"])

    ordered = []
    for col in columns:
        if col["top"] is not None:
            ordered.append(col["top"])
        if col["bottom"] is not None:
            ordered.append(col["bottom"])
    return ordered


def _ordered_ports(plist):
    """Reading order for a single category bucket: a lone row goes strictly
    left→right; a two-row block is interleaved column-major.
    """
    if not plist:
        return []
    rows = _split_into_rows(plist)
    if len(rows) == 1:
        return sorted(rows[0], key=_port_cx)
    top, bottom = rows
    return _group_into_columns(sorted(top, key=_port_cx), sorted(bottom, key=_port_cx))


def _index_in_place(plist):
    """Number ports 1..N in row-aware column-major order AND reorder the list so
    list position == assigned index. Detections arrive in confidence order from
    _nms, but callers select ports by list position (cat_list[port_number-1]),
    so the list must be re-sorted to spatial order or the wrong port is picked.
    """
    ordered = _ordered_ports(plist)
    for i, p in enumerate(ordered, 1):
        p["index"] = i
    plist[:] = ordered


def _index_left_to_right(plist):
    """Number ports 1..N strictly left→right by x-center — a single sequence
    (P01, P02, …). Used for patch panels and PDU outlets, which are one row of
    identical jacks, so the column-major/two-row logic doesn't apply. Reorders
    the list in place so list position == index (callers select by position).
    """
    ordered = sorted(plist, key=lambda q: q["center"][0])
    for i, p in enumerate(ordered, 1):
        p["index"] = i
    plist[:] = ordered


def _bucket_and_index(typed_with_status):
    """Partition typed-with-status detections into the four buckets the
    JSON contract uses, and assign per-bucket 1..N column-major indexes.
    """
    buckets = {"main": [], "sfp": [], "console": [], "other": []}
    for d in typed_with_status:
        cat = _TYPE_TO_CATEGORY.get(d["class_name"], "main")
        buckets[cat].append(_to_port_dict(d, cat))
    for plist in buckets.values():
        _index_in_place(plist)
    return buckets


def _empty_result():
    return {
        "console_ports": [],
        "main_ports": [],
        "sfp_ports": [],
        "other_ports": [],
        "all_boxes": [],
        "pattern_info": {"main_cluster_size": 0, "num_clusters": 0, "cluster_sizes": []},
    }


# ────────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────────


def status_detections(status_model, img, conf=CONF):
    """Run the status model (port_count.pt) and return its connected/empty
    boxes. Exposed so a caller can run it ONCE and reuse the detections for
    both model-detected ports and code-drawn (synthesized) ones.
    """
    if status_model is None:
        return []
    return _nms(_detections_from(status_model, img, conf=conf), iou_thresh=0.5)


def classify_ports_by_pattern(
    img, model, conf=CONF, skip_first_n_ports=0, status_model=None, status_dets=None
):
    """Detect typed ports + bind a status to each, return the legacy bucket
    shape. `model` is ports_9.pt; `status_model` is port_count.pt.

    `status_dets` lets a caller pass in already-computed status detections so
    the status model isn't run twice.

    `skip_first_n_ports` is accepted for API compatibility but ignored —
    the typed model handles SFP/console placement directly, so the old
    leading-SFP skip is no longer meaningful.
    """
    typed = _nms(_detections_from(model, img, conf=conf), iou_thresh=0.5)
    if status_dets is None:
        status_dets = status_detections(status_model, img, conf=conf)
    if status_dets:
        _bind_status(typed, status_dets, iou_thresh=0.3)
    else:
        for tp in typed:
            tp["status"] = "unknown"

    if not typed:
        return _empty_result()

    buckets = _bucket_and_index(typed)
    return {
        "main_ports": buckets["main"],
        "sfp_ports": buckets["sfp"],
        "console_ports": buckets["console"],
        "other_ports": buckets["other"],
        "all_boxes": [p["box"] for plist in buckets.values() for p in plist],
        "pattern_info": {
            "main_cluster_size": len(buckets["main"]),
            "num_clusters": sum(1 for k in ("main", "sfp", "console") if buckets[k]),
            "cluster_sizes": [len(buckets[k]) for k in ("main", "sfp", "console")],
        },
    }


def grid_ports(img, target_count, existing=None, status_dets=None):
    """Lay out exactly `target_count` main ports as a clean grid across the crop
    — two rows when the count is even and the face is short & wide (a typical
    switch), else a single row — numbered column-major. Shared by the relabel
    handler and the select path so both agree on the layout.

    These cells are drawn by CODE, not detected by the type model, so they get
    their connected/empty status the same way a real port does — by matching
    against the STATUS model (port_count.pt) detections. Order of preference:

      1. the status model box that overlaps this cell  ← the real signal
      2. the nearest real typed detection (if the status model saw nothing here)
      3. 'unknown'

    Previously only (2) existed, so a code-drawn port with no detected neighbour
    was left 'unknown' even when the status model clearly saw connected/empty
    right there.
    """
    h, w = img.shape[:2]
    real = list(existing or [])
    sdets = list(status_dets or [])
    rows = 2 if (target_count % 2 == 0 and w > h * 2.5) else 1
    per_row = max(1, target_count // rows)
    cell_w = w / per_row
    cell_h = h / rows
    tol2 = (cell_w * 0.75) ** 2

    def _status_near(cx, cy):
        best, bd = None, tol2
        for p in real:
            pc = p.get("center", [0, 0])
            d = (pc[0] - cx) ** 2 + (pc[1] - cy) ** 2
            if d < bd:
                bd, best = d, p
        return best.get("status", "unknown") if best else "unknown"

    def _status_from_model(box, cx, cy):
        """Bind this synthesized cell to the status model's connected/empty
        boxes — the same signal real ports get, matched geometrically.
        """
        if not sdets:
            return None
        best, best_iou = None, 0.0
        for s in sdets:
            i = _box_iou(box, s["bbox"])
            if i > best_iou:
                best_iou, best = i, s
        # A synthesized cell is a geometric approximation of the real port, so
        # accept a looser overlap than the 0.3 used for model-detected boxes.
        if best is not None and best_iou >= 0.20:
            return _status_from_name(best["class_name"])
        # Fallback: this cell's centre sits inside a status box.
        for s in sdets:
            sx1, sy1, sx2, sy2 = s["bbox"]
            if sx1 <= cx <= sx2 and sy1 <= cy <= sy2:
                return _status_from_name(s["class_name"])
        return None

    grid, idx = [], 1
    for c in range(per_row):
        cx = int(cell_w * (c + 0.5))
        px1, px2 = max(0, int(cx - cell_w * 0.4)), min(w, int(cx + cell_w * 0.4))
        for r in range(rows):
            cy = int(cell_h * (r + 0.5))
            py1, py2 = max(0, int(cy - cell_h * 0.34)), min(h, int(cy + cell_h * 0.34))
            box = [px1, py1, px2, py2]
            status = _status_from_model(box, cx, cy)
            if status in (None, "unknown"):
                status = _status_near(cx, cy)
            grid.append(
                {
                    "index": idx,
                    "box": box,
                    "center": [cx, cy],
                    "status": status,
                    "class_name": "RJ45",
                    "confidence": 0.0,
                    "port_category": "main",
                    "synthesized": True,
                }
            )
            idx += 1
    return grid


def classify_ports_with_target_count(img, model, target_count, conf=CONF, status_model=None):
    """Run the standard classifier, then make `main_ports` EXACTLY the operator's
    target: trim to the first N when the model over-counts, or lay out a clean
    N-port grid when it under-counts. Used by BOTH the relabel handler and the
    select path so the numbering the user confirmed is the numbering they get
    when they later pick a port (port 24 = the 24th position, not the 20th).
    """
    # Run the status model ONCE and reuse its detections for both the real
    # ports and any code-drawn grid cells — so a synthesized port gets a real
    # connected/empty status instead of falling through to 'unknown'.
    sdets = status_detections(status_model, img, conf=conf)

    classified = classify_ports_by_pattern(
        img, model, conf=conf, status_model=status_model, status_dets=sdets
    )
    main = classified.get("main_ports", [])

    if not target_count or target_count <= 0 or len(main) == target_count:
        return classified

    if len(main) > target_count:
        # Keep the FIRST target_count ports in physical reading order (1..N).
        _index_in_place(main)
        main = main[:target_count]
        _index_in_place(main)
    else:
        # Fewer detected than target → lay out exactly target_count as a grid,
        # each cell statused from the port_count model (not just a neighbour).
        main = grid_ports(img, target_count, existing=main, status_dets=sdets)

    classified["main_ports"] = main
    classified["pattern_info"]["main_cluster_size"] = len(main)
    return classified


def detect_pdu_ports(img, model, conf=CONF):
    """PDU power outlets. The model (pdu_ports_v1_det_best.pt) has two classes:
    `power_port_connected` and `power_port_empty`. We count both to get the
    total outlet count, and treat any connected outlet as "rack has power".

    Returns:
      {'power_ports':      [port_dict, ...],   # all outlets, numbered L→R
       'power_total':      int,                # connected + empty
       'power_connected':  int,                # outlets with a plug in
       'power_empty':      int,                # free outlets
       'powered':          bool}               # connected_count > 0
    """
    dets = _nms(_detections_from(model, img, conf=conf), iou_thresh=0.5)
    ports = []
    n_connected = 0
    for d in dets:
        x1, y1, x2, y2 = d["bbox"]
        status = "connected" if "connect" in (d["class_name"] or "").lower() else "empty"
        if status == "connected":
            n_connected += 1
        ports.append(
            {
                "box": [int(x1), int(y1), int(x2), int(y2)],
                "center": [(int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2],
                "status": status,
                "class_name": "Power",
                "confidence": float(d["confidence"]),
                "port_category": "power",
            }
        )
    _index_left_to_right(ports)  # outlets are one row → number left→right
    return {
        "power_ports": ports,
        "power_total": len(ports),
        "power_connected": n_connected,
        "power_empty": len(ports) - n_connected,
        "powered": n_connected > 0,
    }


# ── Patch-panel count reconciliation (24 / 48) ───────────────────
# Patch panels are always a standard size. The status model can over- or
# under-detect, so we snap the COMBINED (connected + empty) count to the
# nearest standard, then reconcile the boxes: drop lowest-confidence extras,
# or synthesise missing slots (fill interior gaps first, then extend row ends
# round-robin) from the size/spacing of the ports we did detect.
PATCHPANEL_STANDARD_COUNTS = (24, 48)

# Every port count real switch hardware actually ships with. A detected count
# that is not in here did not come off a faceplate — it came from the detector
# miscounting, and publishing it makes the app assert something impossible.
# Testers put it plainly: "there is no switch contains 53 there must be 52".
# Live scans currently hold 46, 49, 28, 25, 18 and 9; of those only 28, 18 and 9
# are real, and the other three are miscounts.
#
# The list is the whole rule, so keep it comprehensive rather than tidy — a count
# missing from here gets rounded away, and rounding a genuine 18-port switch up
# to 24 is a worse error than leaving 49 alone. Add sizes as hardware turns up.
# 26 and 44 are deliberately absent even though such hardware exists. Including a
# RARE size lets it capture a miscount of a COMMON one: with 26 present a 24-port
# switch reading 25 snapped to 26 rather than 24, and with 44 present a 48-port
# switch reading 46 was pulled down instead of up. A size only earns a place here
# once it is common enough that landing on it is more often right than wrong.
# main_ports excludes SFP (those are their own bucket), so these are RJ45 counts.
SWITCH_PORT_COUNTS = (4, 5, 8, 9, 10, 12, 16, 18, 20, 24, 28, 32, 36, 40, 48, 52)


def snap_switch_port_count(n):
    """Snap a detected main-port count to the nearest count real hardware has.

    Weighted the same direction as the patch-panel snap and for the same reason:
    port detectors UNDER-count far more than they over-count (glare, dark jacks,
    a cable hiding the socket), so discarding a real detection is riskier than
    synthesising a missing one. Overshoot costs 1 per slot, undershoot 2. On a
    tie the larger count wins — synthesise rather than throw a real port away.

    That weighting is what makes the observed miscounts land correctly:
    53 -> 52, 49 -> 48, 46 -> 48, 25 -> 24, while 28, 18 and 9 are already
    valid and pass through untouched. Returns n unchanged for non-positive
    input so a zero-port device stays zero.
    """
    if not n or n <= 0:
        return n
    if n in SWITCH_PORT_COUNTS:
        return n

    DROP_PENALTY = 2.0

    def cost(c):
        return (c - n) if n <= c else (n - c) * DROP_PENALTY

    return min(sorted(SWITCH_PORT_COUNTS, reverse=True), key=cost)


def _pp_closest_standard(n):
    """Snap a detected port count to the nearest standard patch-panel size.
    We only support 24 and 48 (there is deliberately no 12 option), so any
    small count rounds up to 24.

    Patch-panel port models UNDER-detect far more than they over-count — dark,
    occluded or dust-capped jacks get missed — so dropping a genuinely detected
    port is much riskier than synthesising a missing one. We weight the two
    directions asymmetrically: overshoot (n <= c, synthesise) costs 1 per slot,
    undershoot (n > c, discard a real detection) costs 3 per slot. On a tie we
    keep the LARGER standard (synthesise rather than throw away real ports).

    So a 24-port panel that reads 18 snaps up to 24 (synthesise 6) rather than
    down, and a low count like 10 also rounds up to 24.
    """
    DROP_PENALTY = 3.0

    def cost(c):
        return (c - n) if n <= c else (n - c) * DROP_PENALTY

    # Largest→smallest so a cost tie resolves to the larger standard.
    return min(sorted(PATCHPANEL_STANDARD_COUNTS, reverse=True), key=cost)


def _pp_median_gap(centers):
    gaps = [
        centers[i] - centers[i - 1]
        for i in range(1, len(centers))
        if centers[i] - centers[i - 1] > 0
    ]
    return statistics.median(gaps) if gaps else None


def _pp_synth_port(cx, y1, y2, w):
    x1, x2 = int(cx - w / 2), int(cx + w / 2)
    return {
        "box": [x1, int(y1), x2, int(y2)],
        "center": [int(cx), int((y1 + y2) // 2)],
        "status": "empty",
        "class_name": "RJ45",
        "confidence": 0.0,
        "port_category": "main",
        "synthesized": True,
    }


def _pp_fill_row_gaps(row, needed):
    """Insert synthetic ports where the spacing between two real detections is a
    multiple of the row's typical pitch (a missed port). Adds at most `needed`.
    """
    if needed <= 0 or len(row) < 2:
        return row, needed
    avg_w = statistics.mean([p["box"][2] - p["box"][0] for p in row])
    y1_avg = statistics.mean([p["box"][1] for p in row])
    y2_avg = statistics.mean([p["box"][3] for p in row])
    centers = [_port_cx(p) for p in row]
    typical = _pp_median_gap(centers) or avg_w
    out = [row[0]]
    for i in range(1, len(row)):
        gap = centers[i] - centers[i - 1]
        missing = min(max(round(gap / typical) - 1, 0), needed)
        for m in range(1, missing + 1):
            cx = centers[i - 1] + (m / (missing + 1)) * gap
            out.append(_pp_synth_port(cx, y1_avg, y2_avg, avg_w))
            needed -= 1
        out.append(row[i])
    out.sort(key=_port_cx)
    return out, needed


def _pp_extend_row(row, side="right"):
    if not row:
        return row
    avg_w = statistics.mean([p["box"][2] - p["box"][0] for p in row])
    y1_avg = statistics.mean([p["box"][1] for p in row])
    y2_avg = statistics.mean([p["box"][3] for p in row])
    centers = sorted(_port_cx(p) for p in row)
    typical = _pp_median_gap(centers) or avg_w
    if side == "right":
        return row + [_pp_synth_port(centers[-1] + typical, y1_avg, y2_avg, avg_w)]
    return [_pp_synth_port(centers[0] - typical, y1_avg, y2_avg, avg_w)] + row


def _reconcile_patchpanel(ports):
    """Snap the combined port count to the nearest standard patch-panel size
    (24 / 48): drop lowest-confidence extras, or synthesise the missing
    slots (interior gaps first, then extend row ends round-robin).
    """
    if not ports:
        return ports
    target = _pp_closest_standard(len(ports))
    if len(ports) == target:
        return ports
    if len(ports) > target:  # too many → keep the highest-confidence
        return sorted(ports, key=lambda p: p.get("confidence", 0.0), reverse=True)[:target]
    needed = target - len(ports)  # too few → synthesise
    rows = [sorted(r, key=_port_cx) for r in _split_into_rows(ports)]
    for i, row in enumerate(rows):
        rows[i], needed = _pp_fill_row_gaps(row, needed)
    ri = 0
    while needed > 0 and rows:
        rows[ri % len(rows)] = _pp_extend_row(rows[ri % len(rows)], "right")
        needed -= 1
        ri += 1
    out = []
    for row in rows:
        out.extend(row)
    return out


def detect_patch_panel_ports(img, model, conf=CONF):
    """Patch panels are pure RJ-45 grids — the status model's Connected_port /
    Empty_port are two states of the SAME physical port. We collapse an
    overlapping connected+empty pair to one port, snap the combined count to
    the nearest standard patch-panel size (24 / 48), then number the grid
    as one sequence — left→right for a single row, column-wise (top then bottom
    of each column) for two rows.

    `model` here is the status model (port_count.pt).
    """
    # Looser NMS: a connected+empty pair on one physical port can differ in
    # size, so use lower IoU / containment to collapse them to one box.
    dets = _nms(_detections_from(model, img, conf=conf), iou_thresh=0.3, containment_thresh=0.5)
    if not dets:
        return _empty_result()

    ports = []
    for d in dets:
        x1, y1, x2, y2 = d["bbox"]
        ports.append(
            {
                "box": [int(x1), int(y1), int(x2), int(y2)],
                "center": [(int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2],
                "status": _status_from_name(d["class_name"]),
                "class_name": "RJ45",
                "confidence": float(d["confidence"]),
                "port_category": "main",
            }
        )

    # Snap the combined (connected + empty) count to 24 / 48.
    ports = _reconcile_patchpanel(ports)

    # Number the whole grid as one sequence. Single row → left→right;
    # two rows → column-wise (top then bottom within each column).
    rows = _split_into_rows(ports)
    if len(rows) >= 2:
        rows = sorted(rows, key=lambda r: min((p["box"][1] + p["box"][3]) / 2 for p in r))
        top = sorted(rows[0], key=_port_cx)
        bottom = sorted(rows[1], key=_port_cx)
        main = _group_into_columns(top, bottom)
    else:
        main = sorted(rows[0], key=_port_cx) if rows else []

    for i, p in enumerate(main, 1):
        p["index"] = i

    return {
        "main_ports": main,
        "sfp_ports": [],
        "console_ports": [],
        "other_ports": [],
        "all_boxes": [p["box"] for p in main],
        "pattern_info": {
            "main_cluster_size": len(main),
            "num_clusters": 1 if main else 0,
            "cluster_sizes": [len(main)],
        },
    }
