"""Device-model lookup — pure regex matching over OCR text.

match_model() is the safety net for the visual port counter: when it fires, its
port count OVERRIDES what the detector saw, so a wrong match is worse than no
match. These tests pin both directions — the models we claim to know, and the
noise we must not match.
"""

import pytest

from pipeline import device_db
from pipeline.device_db import DEVICE_MODELS, match_model, ocr_text, read_device_model


@pytest.mark.parametrize(
    "text,canonical,ports,sfp",
    [
        ("TL-SG2428P", "TL-SG2428P", 24, 4),
        ("DGS-1016D", "DGS-1016D", 16, 0),
        ("DGS-1210-48", "DGS-1210-48", 48, 4),
        ("Catalyst 2960X-24TS", "Catalyst 2960X-24", 24, 0),
        ("TL-SG108E", "TL-SG108", 8, 0),
    ],
)
def test_known_models_return_their_datasheet_counts(text, canonical, ports, sfp):
    spec = match_model(text)
    assert spec is not None
    assert (spec.canonical, spec.port_count, spec.sfp_ports) == (canonical, ports, sfp)


@pytest.mark.parametrize(
    "text",
    [
        "tl-sg2428p",  # OCR often returns lower case
        "TL SG2428P",  # dash read as a space
        "TLSG2428P",  # separator dropped entirely
    ],
)
def test_matching_tolerates_ocr_case_and_separator_noise(text):
    # Every pattern is compiled re.I with [-\s]? separators precisely because
    # OCR is unreliable about case and punctuation on a printed faceplate.
    spec = match_model(text)
    assert spec is not None and spec.canonical == "TL-SG2428P"


def test_model_found_inside_surrounding_ocr_noise():
    # Real OCR output is the whole faceplate, not a bare model string.
    spec = match_model("PoE+  Model: DGS-1210-48  rev A2  100-240V")
    assert spec is not None and spec.port_count == 48


@pytest.mark.parametrize("text", ["", None, "   ", "no model here", "SG", "1024"])
def test_no_match_returns_none_for_empty_or_unknown_text(text):
    # Bare "1024" must NOT match DGS-1024: the \bDGS prefix is what stops a
    # serial number or a voltage rating from being read as a port count.
    assert match_model(text) is None


@pytest.mark.parametrize(
    "text,ports",
    [
        ("CAT.6 1-48", 48),
        ("CAT6-24", 24),
        ("PATCH PANEL 48", 48),
    ],
)
def test_patch_panel_format_clues(text, ports):
    spec = match_model(text)
    assert spec is not None and spec.port_count == ports


def test_patch_panel_count_must_follow_the_keyword():
    """Known limitation, pinned deliberately.

    Every panel pattern is `<keyword>.{0,N}<count>`, so a faceplate that OCRs
    as "24 PORT PATCH PANEL" (count first) does NOT match and the visual count
    is used instead. That's the safe direction — it degrades to the detector
    rather than asserting a wrong count — but if someone later adds a
    count-first pattern this test should be updated, not deleted silently.
    """
    assert match_model("24 PORT PATCH PANEL") is None


def test_first_match_wins_when_text_contains_two_models():
    # DEVICE_MODELS is scanned in order, so a crop that OCRs two labels (a
    # switch above a panel, say) resolves to whichever appears first in the
    # table — pinned so a reordering of the list is a deliberate decision.
    spec = match_model("TL-SG1016 and DGS-1024")
    assert spec.canonical == "TL-SG1016"


def test_every_table_entry_is_self_consistent():
    # Guards new rows added by hand: a typo'd 0-port or negative entry would
    # silently zero out the port count for that device.
    assert DEVICE_MODELS, "device table must not be empty"
    for spec in DEVICE_MODELS:
        assert spec.port_count > 0, spec.canonical
        assert spec.sfp_ports >= 0, spec.canonical
        assert spec.canonical, "every spec needs a canonical name for the UI"
        # A real model name must re-match its own pattern, otherwise a
        # round-trip (store canonical → re-read it) would lose the model. The
        # generic panel rows are exempt: their canonical is a human
        # description ("48-port patch panel"), not a printed model string.
        if "patch panel" not in spec.canonical.lower():
            assert spec.pattern.search(spec.canonical) is not None, spec.canonical


def test_read_device_model_returns_nones_when_ocr_is_unavailable(monkeypatch):
    # No OCR backend in CI — the caller must get a clean (None, None, None) and
    # fall back to the visual count instead of raising.
    monkeypatch.setattr(device_db, "ocr_text", lambda img: "")
    assert read_device_model(object()) == (None, None, None)


def test_read_device_model_returns_nones_when_text_matches_nothing(monkeypatch):
    monkeypatch.setattr(device_db, "ocr_text", lambda img: "SOME UNKNOWN BOX")
    assert read_device_model(object()) == (None, None, None)


def test_read_device_model_maps_ocr_text_to_the_spec(monkeypatch):
    monkeypatch.setattr(device_db, "ocr_text", lambda img: "tl-sg2428p poe")
    assert read_device_model(object()) == ("TL-SG2428P", 24, 4)


def test_ocr_text_returns_empty_string_with_no_backend(monkeypatch):
    # _init_ocr caches its answer in a module global; force the "none" branch
    # so this never tries to download EasyOCR weights in CI.
    monkeypatch.setattr(device_db, "_init_ocr", lambda: None)
    assert ocr_text(object()) == ""
