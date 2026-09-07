"""The unit segment of a label survives OCR's letter-for-digit swaps."""

import pytest

from pipeline.ocr_labels import fix_unit_confusables


@pytest.mark.parametrize(
    ("read", "want"),
    [
        ("SP-RI-UIS-SW04", "SP-RI-U15-SW04"),  # the office label that came back wrong
        ("SW-UIO", "SW-U10"),
        ("SW-U1O", "SW-U10"),
        ("PP-UOS", "PP-U05"),
        ("SP-RI-U15-SW04", "SP-RI-U15-SW04"),  # already right
        ("UIS-SW04", "U15-SW04"),  # a hyphen after is enough
        ("U1S", "U15"),  # a digit already in the segment is enough
    ],
)
def test_unit_segment_is_repaired(read, want):
    assert fix_unit_confusables(read) == want


@pytest.mark.parametrize("text", ["USB", "UPS", "UIS", "UBIQUITI", "HUB-01", "SW04", "GS-U", "U-1"])
def test_words_that_merely_start_with_u_are_left_alone(text):
    assert fix_unit_confusables(text) == text
