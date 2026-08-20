"""Coverage for the two pipeline correctness fixes in runner.py.

HIGH  — the cable classifier has 14 outputs, all cable COLOURS and NO empty /
        no-cable class, so its confidence must never be thresholded to decide
        port occupancy. An untagged port is UNKNOWN, not a guessed connected/
        empty.
MEDIUM — a port-detection crash must be distinguishable in the output from a
        device that genuinely has no ports, even though both demote to
        "Unidentified".

These exercise the pure helpers the fixes introduced; no model weights and no
inference on real images are involved.
"""

import numpy as np
import torch
import torch.nn as nn

from pipeline.cable import FALLBACK_CABLE_CLASSES, classify_cable, parse_cable_type_color
from pipeline.runner import (
    _OCCUPANCY_STATES,
    _clear_port_fields,
    demote_if_no_ports,
    mark_port_detection_failed,
    resolve_port_occupancy,
)

# ── HIGH: occupancy is measured, never guessed from colour confidence ────────


def test_resolve_keeps_real_occupancy_states():
    assert resolve_port_occupancy("connected") == "connected"
    assert resolve_port_occupancy("empty") == "empty"


def test_resolve_maps_everything_else_to_unknown():
    # "unknown" is the whole point, but None / "invalid" / stray strings that
    # could reach here from a partial status dict must NOT become empty.
    for value in ("unknown", "invalid", None, "", "connectd", "occupied", 0):
        assert resolve_port_occupancy(value) == "unknown", value


def test_unknown_is_distinct_from_empty_in_the_output_shape():
    # The finding requires downstream consumers to tell unknown from empty.
    assert "empty" in _OCCUPANCY_STATES
    assert "unknown" not in _OCCUPANCY_STATES


class _FixedLogitsModel(nn.Module):
    """Stand-in for the cable classifier that returns fixed 14-way logits
    regardless of the crop — lets us prove the confidence contract without the
    real weights or any real image."""

    def __init__(self, logits):
        super().__init__()
        self._out = torch.tensor([logits], dtype=torch.float32)
        self._cable_classes = FALLBACK_CABLE_CLASSES

    def forward(self, _x):
        return self._out


def test_cable_confidence_is_high_even_on_a_crop_with_no_cable():
    """Root cause: softmax over 14 colours sums to 1, so the top-class
    confidence is high whenever ONE colour dominates — even for a blank crop
    that holds no cable. The old code thresholded exactly this number at 0.55
    and called the port 'connected'. This documents why that was invalid."""
    blank = np.zeros((16, 16, 3), dtype=np.uint8)  # a crop with no cable in it
    logits = [0.0] * 14
    logits[3] = 6.0  # model is very sure it's RJ_45 Blue (index 3)
    model = _FixedLogitsModel(logits)

    label, conf = classify_cable(blank, model)
    assert label == FALLBACK_CABLE_CLASSES[3] == "RJ_45 Blue"
    # Confidence clears the retired 0.55 gate despite there being no cable.
    assert conf > 0.55


def test_softmax_reserves_no_mass_for_absence_of_a_cable():
    # Every one of the 14 outputs is a colour; probabilities sum to 1 across
    # them, so there is literally no "no-cable" bucket to threshold against.
    logits = torch.tensor([[0.0] * 14])
    probs = torch.softmax(logits, dim=1)
    assert probs.shape[1] == len(FALLBACK_CABLE_CLASSES) == 14
    assert abs(float(probs.sum()) - 1.0) < 1e-6


def test_occupancy_decision_ignores_the_cable_classifier_entirely():
    """The fix in one line: however confident the colour classifier is, an
    untagged port stays unknown."""
    blank = np.zeros((16, 16, 3), dtype=np.uint8)
    logits = [0.0] * 14
    logits[9] = 8.0  # extremely confident colour
    _, conf = classify_cable(blank, _FixedLogitsModel(logits))
    assert conf > 0.55  # the old fabrication trigger
    assert resolve_port_occupancy("unknown") == "unknown"  # but occupancy holds


# ── MEDIUM: a detection crash is distinguishable from a real zero-port device ─


def _port_bearing_dev(**extra):
    dev = {
        "class_name": "Switch",
        "box": [10, 20, 110, 60],
        "units": ["U05"],
        "ports": [],
        "console_ports": [],
        "sfp_ports": [],
        "other_ports": [],
    }
    dev.update(extra)
    return dev


def test_crash_is_marked_and_still_demotes_to_unidentified():
    dev = _port_bearing_dev()
    mark_port_detection_failed(dev, RuntimeError("CUDA blew up"))
    demote_if_no_ports(dev)

    assert dev["class_name"] == "Unidentified"
    assert dev["port_detection_failed"] is True
    assert "RuntimeError" in dev["port_detection_error"]
    assert dev["port_count"] == 0 and dev["ports"] == []


def test_genuine_zero_port_device_demotes_without_a_failure_marker():
    dev = _port_bearing_dev()  # no crash: detection ran and simply saw no ports
    demote_if_no_ports(dev)

    assert dev["class_name"] == "Unidentified"
    assert "port_detection_failed" not in dev
    assert "port_detection_error" not in dev


def test_crash_and_genuine_zero_are_distinguishable():
    crashed = _port_bearing_dev()
    mark_port_detection_failed(crashed, ValueError("bad crop"))
    demote_if_no_ports(crashed)

    genuine = _port_bearing_dev()
    demote_if_no_ports(genuine)

    # Same class_name, but the marker is the discriminator the finding demands.
    assert crashed["class_name"] == genuine["class_name"] == "Unidentified"
    assert crashed.get("port_detection_failed") is True
    assert genuine.get("port_detection_failed") is None


def test_clear_port_fields_preserves_the_failure_marker():
    # Regression guard for the exact defect: zeroing ports during demotion must
    # not wipe the crash marker set moments earlier.
    dev = _port_bearing_dev()
    mark_port_detection_failed(dev, KeyError("main_ports"))
    _clear_port_fields(dev)
    assert dev["port_detection_failed"] is True
    assert dev["port_count"] == 0


def test_device_with_ports_is_not_demoted():
    dev = _port_bearing_dev(ports=[{"box": [1, 2, 3, 4], "status": "unknown"}])
    demote_if_no_ports(dev)
    assert dev["class_name"] == "Switch"
    assert "port_detection_failed" not in dev


# ── cable.py pure companion the fix relies on ────────────────────────────────


def test_fallback_cable_classes_match_the_weight_count():
    # The whole HIGH argument rests on there being 14 colour classes and no
    # empty class; pin the label list to that count so a future edit that adds
    # a real 'no-cable' class trips this and forces the occupancy logic review.
    assert len(FALLBACK_CABLE_CLASSES) == 14
    assert not any("empty" in c.lower() or "none" in c.lower() for c in FALLBACK_CABLE_CLASSES)


def test_parse_cable_type_color_round_trips_connector_and_colour():
    assert parse_cable_type_color("RJ_45 Black") == ("RJ-45", "Black")
    assert parse_cable_type_color("LC_Aqua") == ("LC", "Aqua")
    assert parse_cable_type_color("RJ-45 Violet") == ("RJ-45", "Violet")
    assert parse_cable_type_color(None) == (None, None)
