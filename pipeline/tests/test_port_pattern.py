"""Port geometry, numbering and patch-panel reconciliation.

Everything here is the pure half of port_pattern.py — box maths, row/column
clustering and index assignment. No model weights: the detector output is
hand-built, which is exactly the point, because the numbering bugs this module
has had (a port re-numbered, or dropped from a column) are geometry bugs, not
detection bugs. A wrong index means the operator patches the wrong port.
"""

import numpy as np
import pytest

from pipeline.port_pattern import (
    _bind_status,
    _box_iou,
    _bucket_and_index,
    _group_into_columns,
    _index_in_place,
    _index_left_to_right,
    _nms,
    _ordered_ports,
    _pp_closest_standard,
    _pp_median_gap,
    _reconcile_patchpanel,
    _split_into_rows,
    _status_from_name,
    _to_port_dict,
    grid_ports,
)


def port(x1, y1, x2, y2, **kw):
    """A port dict in the shape _to_port_dict produces."""
    p = {
        "box": [x1, y1, x2, y2],
        "center": [(x1 + x2) // 2, (y1 + y2) // 2],
        "status": "unknown",
        "class_name": "RJ45",
        "confidence": 0.9,
        "port_category": "main",
    }
    p.update(kw)
    return p


def row_of(n, y=0, x0=0, pitch=20, w=16, h=16, **kw):
    return [port(x0 + i * pitch, y, x0 + i * pitch + w, y + h, **kw) for i in range(n)]


def centers(ports):
    return [p["center"][0] for p in ports]


# ── box maths ────────────────────────────────────────────────────────────


def test_box_iou_identical_disjoint_and_partial():
    assert _box_iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert _box_iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    # Edge-touching boxes share zero area — must be 0, not a divide-by-zero.
    assert _box_iou([0, 0, 10, 10], [10, 0, 20, 10]) == 0.0
    assert _box_iou([0, 0, 10, 10], [5, 0, 15, 10]) == pytest.approx(1 / 3)


def test_box_iou_zero_area_box_does_not_raise():
    # Degenerate boxes do come out of the models on a bad frame; the max(1, …)
    # guard exists for this, so pin it.
    assert _box_iou([5, 5, 5, 5], [0, 0, 10, 10]) == 0.0


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Connected_port", "connected"),
        ("Empty_port", "empty"),
        ("  EMPTY_PORT ", "empty"),
        ("", "unknown"),
        (None, "unknown"),
        ("Something_else", "unknown"),
    ],
)
def test_status_from_name(name, expected):
    assert _status_from_name(name) == expected


# ── NMS ──────────────────────────────────────────────────────────────────


def det(x1, y1, x2, y2, conf=0.9, cls="RJ45"):
    return {"bbox": [x1, y1, x2, y2], "confidence": conf, "class_name": cls}


def test_nms_on_empty_input():
    assert _nms([]) == []


def test_nms_keeps_highest_confidence_of_an_overlapping_pair():
    kept = _nms([det(0, 0, 10, 10, conf=0.4), det(1, 0, 11, 10, conf=0.9)])
    assert len(kept) == 1 and kept[0]["confidence"] == 0.9


def test_nms_drops_a_nested_box_that_iou_alone_would_keep():
    """The containment rule is the whole reason _nms isn't plain IoU NMS.

    A small box wholly inside a much larger one has a LOW IoU (asserted below),
    so an IoU-only pass keeps both and the same physical port gets detected —
    and numbered — twice. Containment is what catches it.
    """
    inner = det(40, 40, 50, 50, conf=0.4)
    outer = det(0, 0, 100, 100, conf=0.9)
    assert _box_iou(inner["bbox"], outer["bbox"]) < 0.5  # IoU alone keeps both
    assert len(_nms([outer, inner])) == 1


def test_nms_drops_a_large_low_conf_box_enclosing_a_kept_small_one():
    # Same rule, other direction: the big box arrives second (lower conf).
    kept = _nms([det(40, 40, 50, 50, conf=0.9), det(0, 0, 100, 100, conf=0.4)])
    assert len(kept) == 1 and kept[0]["bbox"] == [40, 40, 50, 50]


def test_nms_keeps_genuinely_separate_ports():
    # Side-by-side ports touch but don't overlap — NMS must keep all 8.
    dets = [det(i * 20, 0, i * 20 + 16, 16) for i in range(8)]
    assert len(_nms(dets)) == 8


# ── status binding ───────────────────────────────────────────────────────


def test_bind_status_copies_the_best_overlapping_status_box():
    typed = [{"bbox": [0, 0, 10, 10]}, {"bbox": [100, 100, 110, 110]}]
    _bind_status(typed, [det(0, 0, 10, 10, cls="Connected_port")])
    assert [t["status"] for t in typed] == ["connected", "unknown"]


def test_bind_status_ignores_a_match_below_the_iou_threshold():
    # A status box that barely clips the port is a neighbouring port's box;
    # accepting it would paint the wrong port green.
    typed = [{"bbox": [0, 0, 10, 10]}]
    _bind_status(typed, [det(8, 8, 18, 18, cls="Empty_port")], iou_thresh=0.3)
    assert typed[0]["status"] == "unknown"


def test_bind_status_with_no_status_detections_marks_everything_unknown():
    typed = [{"bbox": [0, 0, 10, 10]}, {"bbox": [20, 0, 30, 10]}]
    _bind_status(typed, [])
    assert all(t["status"] == "unknown" for t in typed)


def test_bind_status_prefers_the_higher_overlap_when_two_boxes_compete():
    typed = [{"bbox": [0, 0, 10, 10]}]
    _bind_status(
        typed, [det(0, 0, 10, 10, cls="Connected_port"), det(2, 0, 12, 10, cls="Empty_port")]
    )
    assert typed[0]["status"] == "connected"


def test_to_port_dict_centres_and_casts():
    d = {
        "bbox": [10.6, 20.2, 30.9, 40.4],
        "class_name": "SFP",
        "confidence": 0.5,
        "status": "empty",
    }
    p = _to_port_dict(d, "sfp")
    assert p["box"] == [10, 20, 30, 40]
    assert p["center"] == [20, 30]
    assert p["port_category"] == "sfp" and p["status"] == "empty"


# ── row splitting ────────────────────────────────────────────────────────


def test_single_row_is_not_split():
    assert len(_split_into_rows(row_of(8))) == 1


def test_a_lone_port_is_one_row():
    assert _split_into_rows([port(0, 0, 16, 16)]) == [[port(0, 0, 16, 16)]]


def test_aligned_two_row_grid_splits_into_top_and_bottom():
    rows = _split_into_rows(row_of(6, y=0) + row_of(6, y=20))
    assert len(rows) == 2
    assert sorted(len(r) for r in rows) == [6, 6]


def test_two_rows_split_despite_perspective_skew():
    """The x-pairing branch exists for exactly this input.

    A rack photographed slightly off-axis makes each successive port's y drift,
    smearing the gap between the rows so a "biggest y-gap" test picks a split
    inside a row. The columns stay paired, so the split must still be 6/6.
    """
    top = [port(i * 20, i * 3, i * 20 + 16, i * 3 + 16) for i in range(6)]
    bottom = [port(i * 20, 22 + i * 3, i * 20 + 16, 38 + i * 3) for i in range(6)]
    rows = _split_into_rows(top + bottom)
    assert len(rows) == 2
    assert sorted(len(r) for r in rows) == [6, 6]


def test_unpaired_uplink_port_is_assigned_to_the_nearer_row():
    # Four clean columns plus one extra port on the top row only — it must land
    # in top (5) not be dropped or shunted to bottom (4).
    ports = row_of(4, y=0) + row_of(4, y=20) + [port(100, 0, 116, 16)]
    rows = _split_into_rows(ports)
    assert sorted(len(r) for r in rows) == [4, 5]
    assert sum(len(r) for r in rows) == 9  # nothing lost


def test_rows_on_different_pitches_split_via_the_y_gap_fallback():
    # No x-pairing possible (bottom row is offset and sparser), but the rows are
    # well separated vertically — the fallback must still find two rows.
    top = row_of(6, y=0, pitch=20)
    bottom = row_of(2, y=60, x0=7, pitch=50)
    rows = _split_into_rows(top + bottom)
    assert len(rows) == 2
    assert sorted(len(r) for r in rows) == [2, 6]


# ── column interleaving / numbering ──────────────────────────────────────


def test_two_row_numbering_is_column_major():
    ports = row_of(4, y=0) + row_of(4, y=20)
    _index_in_place(ports)
    # 1,3,5,7 on top; 2,4,6,8 underneath — the numbering printed on a switch.
    assert [(p["index"], p["center"][1]) for p in ports] == [
        (1, 8),
        (2, 28),
        (3, 8),
        (4, 28),
        (5, 8),
        (6, 28),
        (7, 8),
        (8, 28),
    ]
    # List order must equal index order: callers select by cat_list[n-1].
    assert [p["index"] for p in ports] == list(range(1, 9))


def test_single_row_numbering_is_left_to_right_regardless_of_input_order():
    ports = [port(40, 0, 56, 16), port(0, 0, 16, 16), port(20, 0, 36, 16)]
    _index_in_place(ports)
    assert centers(ports) == [8, 28, 48]
    assert [p["index"] for p in ports] == [1, 2, 3]


def test_group_into_columns_keeps_every_port_when_rows_are_half_pitch_offset():
    """Regression guard for the chained-clustering bug called out in the
    docstring: with the bottom row offset half a pitch, left-to-right chaining
    collapsed the whole row into one column and dropped all but the last port.
    """
    top = row_of(4, y=0, pitch=20)
    bottom = row_of(4, y=20, x0=10, pitch=20)
    out = _group_into_columns(top, bottom)
    assert len(out) == 8
    assert centers(out) == [8, 18, 28, 38, 48, 58, 68, 78]


def test_group_into_columns_with_one_empty_row():
    top = row_of(3, y=0)
    assert centers(_group_into_columns(top, [])) == [8, 28, 48]
    assert centers(_group_into_columns([], top)) == [8, 28, 48]
    assert _group_into_columns([], []) == []


def test_group_into_columns_emits_an_unmatched_bottom_port_as_its_own_column():
    top = row_of(2, y=0, pitch=20)
    bottom = row_of(2, y=20, pitch=20) + [port(200, 20, 216, 36)]
    out = _group_into_columns(top, bottom)
    assert len(out) == 5
    assert out[-1]["center"] == [208, 28]


def test_ordered_ports_on_empty_input():
    assert _ordered_ports([]) == []


def test_index_left_to_right_reorders_the_list_in_place():
    ports = [port(50, 0, 60, 10), port(0, 0, 10, 10), port(25, 0, 35, 10)]
    _index_left_to_right(ports)
    assert [(p["index"], p["center"][0]) for p in ports] == [(1, 5), (2, 30), (3, 55)]


# ── bucketing ────────────────────────────────────────────────────────────


def test_bucket_and_index_splits_categories_and_numbers_each_from_one():
    typed = [
        {"bbox": [100, 0, 116, 16], "class_name": "RJ45", "confidence": 0.9, "status": "connected"},
        {"bbox": [0, 0, 16, 16], "class_name": "RJ45", "confidence": 0.8, "status": "empty"},
        {"bbox": [200, 0, 216, 16], "class_name": "SFP", "confidence": 0.7, "status": "connected"},
        {"bbox": [220, 0, 236, 16], "class_name": "QSFP", "confidence": 0.7, "status": "empty"},
        {
            "bbox": [300, 0, 316, 16],
            "class_name": "CONSOLE",
            "confidence": 0.6,
            "status": "unknown",
        },
        {"bbox": [320, 0, 336, 16], "class_name": "USB_A", "confidence": 0.6, "status": "unknown"},
    ]
    b = _bucket_and_index(typed)
    assert [p["index"] for p in b["main"]] == [1, 2]
    # Detections arrive confidence-ordered; main must come back x-ordered.
    assert centers(b["main"]) == [8, 108]
    assert len(b["sfp"]) == 2 and len(b["console"]) == 1 and len(b["other"]) == 1
    assert [p["index"] for p in b["sfp"]] == [1, 2]


def test_unknown_class_name_falls_back_to_main():
    # A future model class must not vanish from the JSON contract.
    b = _bucket_and_index(
        [{"bbox": [0, 0, 16, 16], "class_name": "NEW_TYPE", "confidence": 0.5, "status": "unknown"}]
    )
    assert len(b["main"]) == 1 and b["main"][0]["port_category"] == "main"


# ── patch-panel count reconciliation ─────────────────────────────────────


@pytest.mark.parametrize(
    "detected,expected",
    [
        (0, 24),
        (1, 24),
        (10, 24),  # anything small rounds UP to 24 (no 12 option)
        (18, 24),
        (24, 24),
        (30, 48),  # cost tie → keep the LARGER standard
        (36, 48),
        (48, 48),
        (60, 48),
    ],
)
def test_closest_standard_is_biased_against_discarding_real_ports(detected, expected):
    assert _pp_closest_standard(detected) == expected


def test_closest_standard_asymmetry_is_real():
    # 30 is 6 above 24 and 18 below 48, yet snaps to 48: discarding 6 detected
    # ports costs 3× per port, so synthesising 18 is cheaper. If this ever
    # flips, panels start losing real ports.
    assert _pp_closest_standard(30) == 48


def test_median_gap_ignores_zero_and_negative_steps():
    assert _pp_median_gap([0, 10, 20, 35]) == 10
    assert _pp_median_gap([5, 5, 5]) is None  # all-identical centres → no pitch
    assert _pp_median_gap([]) is None
    assert _pp_median_gap([42]) is None


def test_reconcile_on_empty_input_returns_empty():
    assert _reconcile_patchpanel([]) == []


def test_reconcile_synthesises_up_to_the_standard_count():
    ports = row_of(20)
    out = _reconcile_patchpanel(list(ports))
    assert len(out) == 24
    assert sum(1 for p in out if p.get("synthesized")) == 4
    # Synthetic slots default to 'empty' — never claim an unseen port is patched.
    assert all(p["status"] == "empty" for p in out if p.get("synthesized"))


def test_reconcile_fills_interior_gaps_before_extending_the_row():
    # 20 ports with two missing in the middle: the two holes must be filled at
    # the missing pitch positions, not tacked onto the right-hand end.
    ports = [p for i, p in enumerate(row_of(22)) if i not in (5, 6)]
    out = _reconcile_patchpanel(list(ports))
    assert len(out) == 24
    synth_centers = [p["center"][0] for p in out if p.get("synthesized")]
    assert 108 in synth_centers and 128 in synth_centers


def test_reconcile_drops_the_lowest_confidence_extras_when_over_detected():
    ports = row_of(55)
    for i, p in enumerate(ports):
        p["confidence"] = i / 100.0
    out = _reconcile_patchpanel(list(ports))
    assert len(out) == 48
    # The 7 weakest detections are the ones discarded.
    assert min(p["confidence"] for p in out) == pytest.approx(0.07)


def test_reconcile_leaves_an_exact_standard_count_untouched():
    ports = row_of(24)
    out = _reconcile_patchpanel(list(ports))
    assert len(out) == 24
    assert not any(p.get("synthesized") for p in out)


# ── synthesized grid layout ──────────────────────────────────────────────


def test_grid_ports_lays_out_two_rows_on_a_short_wide_face():
    img = np.zeros((50, 600, 3), dtype=np.uint8)
    grid = grid_ports(img, 24)
    assert len(grid) == 24
    assert [p["index"] for p in grid] == list(range(1, 25))
    assert all(p["synthesized"] and p["port_category"] == "main" for p in grid)
    # Column-major: port 1 above port 2 in the same column.
    assert grid[0]["center"][0] == grid[1]["center"][0]
    assert grid[0]["center"][1] < grid[1]["center"][1]


def test_grid_ports_uses_one_row_when_the_face_is_not_wide_enough():
    img = np.zeros((200, 300, 3), dtype=np.uint8)
    grid = grid_ports(img, 8)
    assert len(grid) == 8
    ys = {p["center"][1] for p in grid}
    assert len(ys) == 1  # all on one row
    assert centers(grid) == sorted(centers(grid))


def test_grid_ports_uses_one_row_for_an_odd_count():
    img = np.zeros((50, 600, 3), dtype=np.uint8)
    grid = grid_ports(img, 9)
    assert len(grid) == 9
    assert len({p["center"][1] for p in grid}) == 1


def test_grid_ports_boxes_stay_inside_the_crop():
    img = np.zeros((60, 400, 3), dtype=np.uint8)
    for p in grid_ports(img, 16):
        x1, y1, x2, y2 = p["box"]
        assert 0 <= x1 < x2 <= 400
        assert 0 <= y1 < y2 <= 60


def test_grid_ports_takes_status_from_the_status_model_boxes():
    # A code-drawn cell must inherit connected/empty from the status model —
    # the whole point of passing status_dets in.
    img = np.zeros((50, 400, 3), dtype=np.uint8)
    grid = grid_ports(
        img,
        2,
        status_dets=[{"bbox": [0, 0, 200, 50], "class_name": "Connected_port", "confidence": 0.9}],
    )
    assert grid[0]["status"] == "connected"


def test_grid_ports_falls_back_to_a_nearby_real_port_then_to_unknown():
    img = np.zeros((50, 400, 3), dtype=np.uint8)
    near = port(0, 0, 200, 50, status="empty")
    grid = grid_ports(img, 2, existing=[near])
    assert grid[0]["status"] == "empty"
    assert grid_ports(img, 2)[0]["status"] == "unknown"
