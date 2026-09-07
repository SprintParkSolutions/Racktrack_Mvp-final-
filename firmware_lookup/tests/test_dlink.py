"""D-Link provider tests -- fixtures are the real ftp.dlink.ru listings.

Recorded 2026-09-07. dlink_dgs-1210-52_firmware_2024-02.html is the same
folder trimmed to what it held in February 2024 (every FX row newer than
6.30.016 removed), so "current is the latest" can be exercised with the
lab switch's real version. No test touches the network: every HTTP call
goes through the per-instance get_text mock from conftest.
"""

# ruff: noqa: S101  -- pytest tests assert.
from __future__ import annotations

import pytest

from firmware_lookup.normalize import normalize_vendor
from firmware_lookup.orchestrator import PROVIDERS, get_latest_firmware
from firmware_lookup.providers import dlink
from firmware_lookup.providers.dlink import MIRRORS, SUPPORT_URL, DLinkProvider
from firmware_lookup.tests.conftest import sample_html

RU = "https://ftp.dlink.ru/pub/Switch/"
F52 = RU + "DGS-1210-52/Firmware/"
F52_ME = RU + "DGS-1210-52_ME/Firmware/"
F52P_C1A = RU + "DGS-1210-52P_C1A/Firmware/"
F28 = RU + "DGS-1210-28/Firmware/"
F1024C = RU + "DGS-1024C/Firmware/"
FDES = RU + "DES-1210-28/Firmware/"
F1510 = RU + "DGS-1510-28/Firmware/"
FXPRO = RU + "DES-1008FxPRO/Firmware/"


@pytest.fixture
def provider():
    return DLinkProvider()


def test_vendor_aliases_resolve_to_the_provider():
    for raw in ("D-Link", "DLink", "D-Link Corporation", "D-Link International", "dlink"):
        assert normalize_vendor(raw) == "D-Link", raw
    assert isinstance(PROVIDERS["D-Link"], DLinkProvider)


def test_current_is_latest_fx(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware_2024-02.html")})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.latest_version == "6.30.016"
    assert r.update_available is False
    assert r.source_url == F52
    assert r.confidence.value == "High"
    assert "last modified 2024-02-20 on ftp.dlink.ru" in r.message
    assert r.retrieval_method == "vendor_ftp_directory_listing"


def test_update_available_for_f3_hardware(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.latest_version == "6.33.B005"
    assert r.update_available is True
    assert "DGS-1210-FX-6-33-B005.con" in r.message
    assert "2026-04-28" in r.message


def test_hardware_c1_gets_the_4_10_line(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "4.10.B044", hardware_version="C1")
    assert r.status.value == "ok"
    assert r.latest_version == "4.10.B049"
    assert r.update_available is True
    assert r.confidence.value == "High"


@pytest.mark.parametrize(
    "model", ["DGS-1210-52/C1", "DGS-1210-52 C1", "DGS-1210-52 rev. C1", "DGS-1210-52 (C1)"]
)
def test_hardware_revision_read_from_the_model_name(provider, mock_get_text, model):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup(model, "4.10.B049")
    assert r.status.value == "ok"
    assert r.latest_version == "4.10.B049"
    assert r.update_available is False
    assert "from the model name" in r.message


def test_hardware_argument_wins_over_model_suffix(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52/C1", "4.10.B049", hardware_version="F3")
    assert r.latest_version == "6.33.B005"


@pytest.mark.parametrize(
    ("current", "latest", "confidence"),
    [
        ("4.10.B044", "4.10.B049", "Medium"),  # 4.10 line -> C1 only
        ("3.12.B056", "3.12.B056", "Medium"),  # 3.12 line -> B1 only
        ("6.11.B032", "6.33.B005", "Medium"),  # 6.11 line -> F1, which FX also covers
        ("6.30.016", "6.33.B005", "Medium"),  # 6.30 line -> FX
    ],
)
def test_hardware_inferred_from_current_version_line(
    provider, mock_get_text, current, latest, confidence
):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", current)
    assert r.status.value == "ok"
    assert r.latest_version == latest
    assert r.confidence.value == confidence
    assert "was inferred" in r.message


def test_wildcard_inferred_revision_stays_in_its_group(provider, mock_get_text):
    # 6.30 is an FX-only line: only FX files are considered, not F1's.
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.30.016")
    assert r.message.startswith("Newest image for FX: ")
    # 6.11 is an F1 line: F1 plus its FX wildcard.
    r = provider.lookup("DGS-1210-52", "6.11.B032")
    assert r.message.startswith("Newest image for F1, FX: ")


def test_no_hardware_and_unknown_line_is_ambiguous(provider, mock_get_text):
    # 5.00 sits between the C1 (4.10) and F1 (6.1x) lines: no group
    # holds it and it is not above everything, so nothing can be chosen.
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "5.00.001")
    assert r.status.value == "ambiguous_model"
    for rev in ("B1", "C1", "F1", "FX"):
        assert f"DGS-1210-52 (hardware {rev})" in r.message
    assert r.latest_version is None
    assert r.source_url == F52


def test_version_above_every_listed_image_is_no_update(provider, mock_get_text):
    # Nothing on the mirror is newer than 9.99.001, whatever the hardware.
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "9.99.001")
    assert r.status.value == "ok"
    assert r.update_available is False
    assert r.latest_version == "6.33.B005"
    assert r.confidence.value == "Low"
    assert r.source_url == F52
    assert "newer than every image listed" in r.message
    assert "B1, C1, F1, FX" in r.message


def test_hardware_revision_absent_from_listing(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "1.00", hardware_version="D1")
    assert r.status.value == "cannot_determine"
    assert "B1, C1, F1, FX" in r.message
    assert "hardware D1" in r.message
    assert r.source_url == F52
    assert r.latest_version is None


def test_build_and_rel_suffix_on_current_is_stripped(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.33.B005 Build 20260428 Rel.1", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.update_available is False
    assert r.current_version == "6.33.B005 Build 20260428 Rel.1"


def test_current_newer_than_mirror_is_reported(provider, mock_get_text):
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.40.001", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.update_available is False
    assert "newer than anything the mirror lists" in r.message


def test_sibling_model_file_is_excluded(provider, mock_get_text):
    # DGS-1210-28's folder also holds DGS-1210-28L-1-50-009-ALL.hex (a
    # different model); it must not become a group for the 28.
    mock_get_text(provider, {F28: sample_html("dlink_dgs-1210-28_firmware.html")})
    r = provider.lookup("DGS-1210-28", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.latest_version == "6.33.B005"
    assert "DGS-1210-28L-1-50-009-ALL.hex" in r.message
    r = provider.lookup("DGS-1210-28", "1.50.009")
    assert r.status.value == "ambiguous_model"
    assert "1.50" not in r.message


def test_wildcard_revision_covers_specific_hardware(provider, mock_get_text):
    # DES-1210-28: C1 files up to 4.10.B054 plus a DES-1210-Cx-4-12-B056
    # series file; Cx is the wildcard for every C revision. The .rar in
    # the same folder is an archive and is ignored.
    mock_get_text(provider, {FDES: sample_html("dlink_des-1210-28_firmware.html")})
    r = provider.lookup("DES-1210-28", "4.10.B054", hardware_version="C1")
    assert r.status.value == "ok"
    assert r.latest_version == "4.12.B056"
    assert r.update_available is True
    assert "C1, CX" in r.message
    assert ".rar" not in r.message


def test_underscore_grammar_without_revision_token(provider, mock_get_text):
    mock_get_text(provider, {F1510: sample_html("dlink_dgs-1510-28_firmware.html")})
    r = provider.lookup("DGS-1510-28", "1.60.B034")
    assert r.status.value == "ok"
    assert r.latest_version == "1.70.B041"
    assert r.update_available is True
    assert r.confidence.value == "High"
    assert "carry no hardware revision" in r.message


def test_con_files_count_as_firmware(provider, mock_get_text):
    # 6.33.B005 exists only as a .con; if .con were dropped the FX answer
    # would fall back to the 6.30.016 .hex and be wrong.
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.latest_version == "6.33.B005"
    assert r.message.startswith("Newest image for FX: DGS-1210-FX-6-33-B005.con")


def test_empty_firmware_folder_is_cannot_determine(provider, mock_get_text):
    # DGS-1024C (an unmanaged switch) has a Firmware folder that lists
    # nothing; the message states only what the listing shows.
    mock_get_text(provider, {F1024C: sample_html("dlink_dgs-1024c_firmware.html")})
    r = provider.lookup("DGS-1024C", "1.00")
    assert r.status.value == "cannot_determine"
    assert r.message.startswith(
        "The Firmware folder for DGS-1024C on ftp.dlink.ru returned an empty listing"
    )
    assert "no firmware is documented there" in r.message
    assert "unmanaged" not in r.message
    assert r.source_url == F1024C
    assert r.latest_version is None
    assert r.update_available is None


def test_model_folder_missing_is_model_not_found(provider, mock_get_text):
    # Folder 404s (None), the catalogue answers and has no such model.
    mock_get_text(provider, {RU: sample_html("dlink_switch_index.html")})
    r = provider.lookup("DGS-9999-99", "1.00")
    assert r.status.value == "model_not_found"
    assert r.source_url == RU


def test_folder_resolved_through_catalogue_case(provider, mock_get_text):
    # "des-1008fxpro" upper-cases to DES-1008FXPRO, which is not the
    # folder's spelling; the catalogue gives the real name DES-1008FxPRO.
    mock_get_text(
        provider,
        {
            RU: sample_html("dlink_switch_index.html"),
            FXPRO: sample_html("dlink_dgs-1024c_firmware.html"),
        },
    )
    r = provider.lookup("des-1008fxpro", "1.00")
    assert r.status.value == "cannot_determine"
    assert r.source_url == FXPRO


def test_me_variant_is_its_own_folder(provider, mock_get_text):
    mock_get_text(provider, {F52_ME: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52/ME", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.source_url == F52_ME


def test_revision_folder_adopted_when_base_folder_missing(provider, mock_get_text):
    # No DGS-1210-52P folder; the catalogue has DGS-1210-52P_C1A (same
    # model, hardware C1) and DGS-1210-52P_ME (a different product).
    mock_get_text(
        provider,
        {
            RU: sample_html("dlink_switch_index.html"),
            F52P_C1A: sample_html("dlink_dgs-1210-52_firmware.html"),
        },
    )
    r = provider.lookup("DGS-1210-52P", "4.10.B044")
    assert r.status.value == "ok"
    assert r.source_url == F52P_C1A
    assert r.latest_version == "4.10.B049"
    assert "from the folder name DGS-1210-52P_C1A" in r.message


def test_several_revision_folders_without_hardware_is_ambiguous(provider, mock_get_text):
    # Catalogue rows DGS-1210-52_B1A / _C1 / _C1A but no exact folder.
    index = sample_html("dlink_switch_index.html").replace(
        '<a href="DGS-1210-52/">DGS-1210-52/</a>', '<a href="DGS-1210-52-gone/">x</a>'
    )
    mock_get_text(provider, {RU: index})
    r = provider.lookup("DGS-1210-52", "6.30.016")
    assert r.status.value == "ambiguous_model"
    assert "DGS-1210-52_B1A" in r.message
    assert "DGS-1210-52_C1" in r.message
    assert r.source_url == RU


def test_model_typed_without_dashes_resolves_through_catalogue(provider, mock_get_text):
    # "dgs121052" has no folder of its own; the catalogue holds exactly one
    # folder with the same letters and digits, DGS-1210-52.
    mock_get_text(
        provider,
        {
            RU: sample_html("dlink_switch_index.html"),
            F52: sample_html("dlink_dgs-1210-52_firmware.html"),
        },
    )
    r = provider.lookup("dgs121052", "6.30.016")
    assert r.status.value == "ok"
    assert r.source_url == F52
    assert r.latest_version == "6.33.B005"


def test_folder_in_catalogue_but_listing_missing(provider, mock_get_text):
    index = sample_html("dlink_switch_index.html").replace(
        '<a href="DGS-1210-52/">DGS-1210-52/</a>', '<a href="DGS-1210-52-gone/">x</a>'
    )
    mock_get_text(provider, {RU: index})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="C1")
    # C1 selects DGS-1210-52_C1 (C1A is also a C1 folder -> two hits -> ambiguous)
    assert r.status.value == "ambiguous_model"


def test_host_down_is_cannot_determine(provider, mock_get_text):
    mock_get_text(provider, {})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.status.value == "cannot_determine"
    assert "ftp.dlink.ru did not answer" in r.message
    assert r.source_url == SUPPORT_URL
    assert r.latest_version is None


def test_mirrors_are_tried_in_order(provider, mock_get_text, monkeypatch):
    monkeypatch.setattr(dlink, "MIRRORS", ("https://ftp.example.invalid", *MIRRORS))
    mock_get_text(provider, {F52: sample_html("dlink_dgs-1210-52_firmware.html")})
    r = provider.lookup("DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.source_url == F52


def test_non_listing_page_is_not_mistaken_for_an_empty_folder(provider, mock_get_text):
    mock_get_text(provider, {F52: "<html><body>Access denied</body></html>"})
    r = provider.lookup("DGS-1210-52", "6.30.016")
    assert r.status.value == "cannot_determine"
    assert "not with a directory listing" in r.message


def test_no_model(provider, mock_get_text):
    mock_get_text(provider, {})
    r = provider.lookup("", "6.30.016")
    assert r.status.value == "cannot_determine"


def test_provider_never_raises(provider, monkeypatch):
    def boom(url, **kw):
        raise RuntimeError("socket exploded")

    monkeypatch.setattr(provider.http, "get_text", boom)
    r = provider.get_latest_firmware("D-Link", "DGS-1210-52", "6.30.016")
    assert r.status.value == "cannot_determine"
    assert "socket exploded" in r.message


def test_orchestrator_passes_hardware_version_through(monkeypatch):
    p = PROVIDERS["D-Link"]
    monkeypatch.setattr(
        p.http, "get_text", lambda url, **kw: sample_html("dlink_dgs-1210-52_firmware.html")
    )
    r = get_latest_firmware("D-Link Corporation", "DGS-1210-52", "6.30.016", hardware_version="F3")
    assert r.status.value == "ok"
    assert r.latest_version == "6.33.B005"
    assert r.vendor == "D-Link"
