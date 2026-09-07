"""TP-Link provider tests.

Every fixture under tests/fixtures/tplink_* was recorded from the real
endpoints on 2026-09-07 and trimmed to the entries the tests reason about;
no test touches the network.
"""

# ruff: noqa: S101 -- pytest asserts

from __future__ import annotations

import json

import pytest

from firmware_lookup.normalize import normalize_vendor
from firmware_lookup.providers.tplink import (
    OMADA_API_FIRMWARE,
    OMADA_API_VERSIONS,
    OMADA_SITE_ID,
    WWW_BASE,
    FirmwareVersion,
    TPLinkProvider,
    hardware_family,
    normalize_hardware,
    omada_firmware_page,
    omada_product_page,
    parse_firmware_version,
    split_model,
)
from firmware_lookup.tests.conftest import sample_html, sample_text

VERSIONS = {
    "TL-SG2428P": "tplink_omada_versions_tl-sg2428p.json",
    "SG2428P": "tplink_omada_versions_sg2428p.json",
}
FIRMWARE = {
    ("TL-SG2428P", "V5"): "tplink_omada_firmware_tl-sg2428p_v5.json",
    ("TL-SG2428P", "V4"): "tplink_omada_firmware_tl-sg2428p_v4.json",
    ("SG2428P", "V5.20"): "tplink_omada_firmware_sg2428p_v5.20.json",
    ("SG2428P", "V5.30"): "tplink_omada_firmware_sg2428p_v5.30.json",
    ("SG2428P", "V5.40"): "tplink_omada_firmware_sg2428p_v5.40.json",
}
NONE = "tplink_omada_versions_none.json"
PORTAL = omada_product_page("TL-SG2428P")


@pytest.fixture
def omada(monkeypatch):
    """Wire a provider to the recorded portal answers; returns the POSTs made.

    Answers the two portal endpoints from the recorded fixtures (an empty
    list for any model not in VERSIONS) and makes every GET return None,
    so the www.tp-link.com fallback only answers when a test wires it.
    `override(url, body)` replaces the whole POST answer when given.
    """

    def _apply(provider, override=None):
        calls: list[tuple[str, dict]] = []

        def fake_post(url, *, data, headers=None, timeout=None):
            body = json.loads(data)
            calls.append((url, body))
            if override is not None:
                return override(url, body)
            name = body["modelName"].upper()
            if url == OMADA_API_VERSIONS:
                return sample_text(VERSIONS.get(name, NONE))
            if url == OMADA_API_FIRMWARE:
                return sample_text(FIRMWARE.get((name, body["productVersion"]), NONE))
            raise AssertionError(f"unexpected POST {url}")

        monkeypatch.setattr(provider.http, "post_text", fake_post)
        monkeypatch.setattr(provider.http, "get_text", lambda url, **kw: None)
        return calls

    return _apply


def _fetched(calls):
    return {(b["modelName"], b["productVersion"]) for u, b in calls if u == OMADA_API_FIRMWARE}


# ----------------------------------------------------------------- Omada API


def test_current_is_latest(omada):
    """The lab switch: 5.20.27 read over SNMP, with the build stamp attached."""
    p = TPLinkProvider()
    calls = omada(p)
    r = p.get_latest_firmware("TP-Link", "TL-SG2428P", "5.20.27 Build 20260509 Rel.23533")
    assert r.status.value == "ok"
    assert r.latest_version == "5.20.27"
    assert r.update_available is False
    assert r.current_version == "5.20.27 Build 20260509 Rel.23533"
    assert r.confidence.value == "High"
    assert r.retrieval_method == "public_api"
    assert r.source_url == omada_firmware_page("SG2428P", "V5.20")
    assert r.release_date == "2026-06-09"
    assert r.build == "Build 20260509"
    assert "V5.20" in r.message and "'SG2428P'" in r.message
    assert "Release notes: https://static.tp-link.com/" in r.message
    # Only hardware versions whose major matches the running 5.x were fetched.
    assert _fetched(calls) == {
        ("TL-SG2428P", "V5"),
        ("SG2428P", "V5.40"),
        ("SG2428P", "V5.30"),
        ("SG2428P", "V5.20"),
    }
    assert all(b["siteId"] == OMADA_SITE_ID for _, b in calls)
    assert all(b["siteId"] == 1 for _, b in calls)


def test_update_available(omada):
    p = TPLinkProvider()
    omada(p)
    r = p.get_latest_firmware("TP-Link", "TL-SG2428P", "5.20.17")
    assert r.status.value == "ok"
    assert r.latest_version == "5.20.27"
    assert r.update_available is True
    assert r.release_date == "2026-06-09"


def test_build_stamp_breaks_a_tie(omada):
    p = TPLinkProvider()
    omada(p)
    older_build = p.lookup("TL-SG2428P", "5.20.27 Build 20260310")
    assert older_build.latest_version == "5.20.27"
    assert older_build.update_available is True
    no_build = p.lookup("TL-SG2428P", "5.20.27")
    assert no_build.update_available is False


def test_hardware_version_parameter_selects_the_group(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("TL-SG2428P", "5.20.27", hardware_version="V5.40")
    assert r.status.value == "ok"
    assert r.latest_version == "5.40.6"
    assert r.update_available is True
    assert r.source_url == omada_firmware_page("SG2428P", "V5.40")
    assert _fetched(calls) == {("SG2428P", "V5.40")}


def test_hardware_version_embedded_in_the_model(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.get_latest_firmware("TP-Link", "TL-SG2428P V4", "4.0.3")
    assert r.status.value == "ok"
    assert r.model == "TL-SG2428P V4"
    assert r.latest_version == "4.0.28"
    assert r.build == "Build 20260310"
    assert r.update_available is True
    assert r.source_url == omada_firmware_page("TL-SG2428P", "V4")
    assert _fetched(calls) == {("TL-SG2428P", "V4")}


def test_hardware_version_equivalence_rule(omada):
    """TP-Link's own note: Vx.x0 = Vx.x6/x8/x9 and Vx.0 = Vx.6/8/9."""
    p = TPLinkProvider()
    omada(p)
    assert p.lookup("TL-SG2428P", "5.20.0", hardware_version="V5.26").latest_version == "5.20.27"
    assert p.lookup("TL-SG2428P", "4.0.3", hardware_version="v4.6").latest_version == "4.0.28"


def test_hardware_version_not_listed(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("TL-SG2428P", "9.0.0", hardware_version="V9")
    assert r.status.value == "cannot_determine"
    assert "V9 is not listed" in r.message
    assert "SG2428P V5.20" in r.message
    assert r.source_url == PORTAL
    assert _fetched(calls) == set()


def test_first_two_groups_rule_picks_the_hardware_running_that_train(omada):
    """5.0.x only ever shipped for TL-SG2428P V5, whose newest image is 5.20.2."""
    p = TPLinkProvider()
    omada(p)
    r = p.get_latest_firmware("TP-Link", "TL-SG2428P", "5.0.2")
    assert r.status.value == "ok"
    assert r.latest_version == "5.20.2"
    assert r.update_available is True
    assert r.source_url == omada_firmware_page("TL-SG2428P", "V5")
    assert p.lookup("TL-SG2428P", "5.30.18").latest_version == "5.30.23"


def test_no_current_version_and_several_hardware_versions_is_ambiguous(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("TL-SG2428P", None)
    assert r.status.value == "ambiguous_model"
    assert "TL-SG2428P V5" in r.message and "SG2428P V5.20" in r.message
    assert PORTAL in r.message
    assert r.source_url == PORTAL
    assert _fetched(calls) == set()


def test_current_version_matching_no_group_is_ambiguous(omada):
    p = TPLinkProvider()
    omada(p)
    r = p.lookup("TL-SG2428P", "5.10.1")
    assert r.status.value == "ambiguous_model"
    assert "SG2428P V5.30" in r.message
    assert r.source_url == PORTAL


def test_version_above_every_hardware_version_is_no_update(omada):
    # 9.9.9 shares its major with no hardware version: every group is
    # fetched, nothing listed is newer, so no update -- not an error.
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("TL-SG2428P", "9.9.9")
    assert r.status.value == "ok"
    assert r.update_available is False
    assert r.latest_version == "5.40.6"
    assert r.confidence.value == "Low"
    assert r.source_url == PORTAL
    assert "newer than every image" in r.message
    assert "SG2428P V5.40" in r.message
    assert len(_fetched(calls)) == 8


def test_model_typed_without_the_hyphen_reaches_the_portal(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("tlsg2428p", "5.20.27")
    assert r.status.value == "ok"
    assert r.latest_version == "5.20.27"
    assert r.model == "tlsg2428p"
    assert {b["modelName"] for _, b in calls} >= {"TL-SG2428P", "SG2428P"}


def test_orchestrator_passes_hardware_version_to_tplink(omada):
    from firmware_lookup.orchestrator import PROVIDERS, get_latest_firmware

    omada(PROVIDERS["TP-Link"])
    r = get_latest_firmware("TP-Link", "TL-SG2428P", "5.20.27", hardware_version="V5.40")
    assert r.status.value == "ok"
    assert r.latest_version == "5.40.6"
    assert r.source_url == omada_firmware_page("SG2428P", "V5.40")


def test_model_not_found(omada):
    p = TPLinkProvider()
    omada(p)
    r = p.get_latest_firmware("TP-Link", "TL-NONEXISTENT", "1.0.0")
    assert r.status.value == "model_not_found"
    assert r.source_url == omada_product_page("TL-NONEXISTENT")
    assert f"{WWW_BASE}/tl-nonexistent/" in r.message
    assert r.latest_version is None


def test_www_empty_body_is_model_not_found(omada, monkeypatch):
    # www.tp-link.com answers an unknown slug with HTTP 200 and an empty
    # body (seen live 2026-09-07): that is nothing, not a page without firmware.
    p = TPLinkProvider()
    omada(p)
    monkeypatch.setattr(p.http, "get_text", lambda u, **kw: "")
    r = p.lookup("TL-NOPE", "1.0.0")
    assert r.status.value == "model_not_found"
    assert "returned nothing" in r.message
    assert "lists no firmware" not in r.message


def test_api_returning_nothing_is_graceful(omada):
    p = TPLinkProvider()
    omada(p, override=lambda url, body: None)
    r = p.get_latest_firmware("TP-Link", "TL-SG2428P", "5.20.27")
    assert r.status.value == "cannot_determine"
    assert "returned nothing" in r.message
    assert r.source_url == PORTAL
    assert r.latest_version is None


def test_api_error_code_and_non_json_are_graceful(omada):
    p = TPLinkProvider()
    omada(p, override=lambda url, body: json.dumps({"errorCode": 500, "result": None}))
    assert p.lookup("TL-SG2428P", "5.20.27").status.value == "cannot_determine"
    omada(p, override=lambda url, body: "<html>maintenance</html>")
    r = p.lookup("TL-SG2428P", "5.20.27")
    assert r.status.value == "cannot_determine"
    assert r.source_url == PORTAL


def test_empty_model_makes_no_request(omada):
    p = TPLinkProvider()
    calls = omada(p)
    r = p.lookup("", "1.0")
    assert r.status.value == "model_not_found"
    assert calls == []


# ------------------------------------------------------- www.tp-link.com


def test_non_omada_model_falls_back_to_the_www_page(omada, monkeypatch):
    p = TPLinkProvider()
    omada(p)
    url = f"{WWW_BASE}/tl-sg108e/"
    page = sample_html("tplink_www_download_page_tl-sg108e.html")
    monkeypatch.setattr(p.http, "get_text", lambda u, **kw: page if u == url else None)
    r = p.get_latest_firmware("TP-Link", "TL-SG108E", "1.0.0")
    assert r.status.value == "ok"
    assert r.latest_version == "1.0.0"
    assert r.build == "Build 20230218"
    assert r.release_date == "2023-02-20"
    assert r.update_available is False
    assert r.confidence.value == "Medium"
    assert r.retrieval_method == "public_html"
    assert r.source_url == url
    assert "V6.60" in r.message and "V5" in r.message
    assert p.lookup("TL-SG108E", "0.9.0").update_available is True


def test_www_page_with_a_hardware_hint(omada, monkeypatch):
    p = TPLinkProvider()
    omada(p)
    url = f"{WWW_BASE}/tl-sg108e/v6.60/"
    page = sample_html("tplink_www_download_page_tl-sg108e.html")
    monkeypatch.setattr(p.http, "get_text", lambda u, **kw: page if u == url else None)
    r = p.lookup("TL-SG108E", "1.0.0", hardware_version="V6.6")
    assert r.status.value == "ok"
    assert r.confidence.value == "High"
    assert r.source_url == url


def test_www_page_without_firmware_rows(omada, monkeypatch):
    p = TPLinkProvider()
    omada(p)
    url = f"{WWW_BASE}/tl-sg1024d/"
    page = sample_html("tplink_www_download_page_tl-sg1024d.html")
    monkeypatch.setattr(p.http, "get_text", lambda u, **kw: page if u == url else None)
    r = p.get_latest_firmware("TP-Link", "TL-SG1024D", "1.0.0")
    assert r.status.value == "cannot_determine"
    assert "lists no firmware" in r.message
    assert r.source_url == url


def test_legacy_www_markup_with_versions_only_in_file_names(omada, monkeypatch):
    p = TPLinkProvider()
    omada(p)
    url = f"{WWW_BASE}/tl-sg1016de/"
    page = sample_html("tplink_download_page.html")
    monkeypatch.setattr(p.http, "get_text", lambda u, **kw: page if u == url else None)
    r = p.get_latest_firmware("TP-Link", "TL-SG1016DE", "1.0.0")
    assert r.status.value == "ok"
    assert r.latest_version == "1.0.1"
    assert r.build == "Build 20240628 Rel.34903"
    assert r.update_available is True


# --------------------------------------------------------------- registry


def test_vendor_aliases_reach_the_provider():
    from firmware_lookup.orchestrator import PROVIDERS

    for alias in (
        "TP-Link",
        "tp-link",
        "tplink",
        "TP-LINK Technologies",
        "TP-Link Technologies Co., Ltd.",
        "TP-Link Systems Inc.",
        "Omada",
    ):
        assert normalize_vendor(alias) == "TP-Link", alias
    assert isinstance(PROVIDERS["TP-Link"], TPLinkProvider)


# ---------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    ("text", "groups", "build", "rel"),
    [
        ("SG2428P(UN)_V5.20_5.20.27 Build 20260509", (5, 20, 27), "20260509", None),
        ("TL-SG2428P(UN)_V5.6_5.0.2 Build 20220909", (5, 0, 2), "20220909", None),
        ("SG3428X(UN) 1.40_1.40.9 Build 20260720 Rel.22968.zip", (1, 40, 9), "20260720", "22968"),
        ("TL-SG108E(UN) 6.0_1.0.0_20230218.zip", (1, 0, 0), "20230218", None),
        (
            "SG1016DE(UN) 7.0_1.0.1 Build 20240628 Rel.34903_up.bin.zip",
            (1, 0, 1),
            "20240628",
            "34903",
        ),
    ],
)
def test_parse_firmware_version_from_titles_and_file_names(text, groups, build, rel):
    v = parse_firmware_version(text)
    assert v is not None
    assert (v.groups, v.build, v.rel) == (groups, build, rel)


@pytest.mark.parametrize(
    "text",
    [
        "TL-SG2428P(UN)_V4_ 20210903",
        "TL-SG2428P(UN)_V1_20210806",
        "TL-SL2428P(UN)_4.2_20210806",
        "",
    ],
)
def test_titles_without_a_firmware_version_are_skipped(text):
    assert parse_firmware_version(text) is None


def test_parse_current_version_is_lenient():
    v = parse_firmware_version("5.20.27 Build 20260509 Rel.23533", lenient=True)
    assert (v.groups, v.build, v.rel, v.text) == ((5, 20, 27), "20260509", "23533", "5.20.27")
    assert v.build_text == "Build 20260509 Rel.23533"
    assert parse_firmware_version("1.0", lenient=True).groups == (1, 0)
    assert parse_firmware_version("1.0") is None


def test_version_compare_pads_and_uses_build_then_rel():
    a = FirmwareVersion((5, 20, 27), "20260509", "23533")
    assert a.compare(FirmwareVersion((5, 20, 27), "20260509")) == 0
    assert a.compare(FirmwareVersion((5, 20, 27))) == 0
    assert a.compare(FirmwareVersion((5, 20, 27), "20260601")) == -1
    assert a.compare(FirmwareVersion((5, 20, 27), "20260509", "23600")) == -1
    assert FirmwareVersion((5, 20)).compare(FirmwareVersion((5, 20, 0))) == 0
    assert FirmwareVersion((5, 9, 0)).compare(FirmwareVersion((5, 10, 0))) == -1


@pytest.mark.parametrize(
    ("label", "normalized"),
    [("v5.6", "V5.60"), ("V5.0", "V5"), ("V5", "V5"), ("5.20", "V5.20"), ("", None), ("abc", None)],
)
def test_normalize_hardware(label, normalized):
    assert normalize_hardware(label) == normalized


@pytest.mark.parametrize(
    ("normalized", "family"),
    [("V5.26", "V5.20"), ("V5.33", "V5.30"), ("V5.60", "V5"), ("V5.20", "V5.20"), ("V5", "V5")],
)
def test_hardware_family(normalized, family):
    assert hardware_family(normalized) == family


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("TL-SG2428P V5.20", ("TL-SG2428P", "V5.20")),
        ("TL-SG2428P(UN) v5", ("TL-SG2428P", "V5")),
        ("  TL-SG2428P ", ("TL-SG2428P", None)),
        ("tlsg2428p", ("TL-SG2428P", None)),
        ("TLSG2428P V5.20", ("TL-SG2428P", "V5.20")),
        ("", ("", None)),
        (None, ("", None)),
    ],
)
def test_split_model(raw, expected):
    assert split_model(raw) == expected
