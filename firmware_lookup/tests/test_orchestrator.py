# ruff: noqa: S101 -- pytest asserts
from firmware_lookup.orchestrator import get_latest_firmware
from firmware_lookup.providers.unimplemented import MANUAL_CHECK_URLS


def test_unrecognized_vendor_never_raises():
    r = get_latest_firmware("Totally Unknown Vendor", "SomeModel", "1.0")
    assert r.status.value == "not_implemented"


def test_provider_exception_becomes_cannot_determine(monkeypatch):
    import firmware_lookup.orchestrator as orch

    class ExplodingProvider:
        http = None

        def get_latest_firmware(self, vendor, model, current_version):
            raise RuntimeError("boom")

    monkeypatch.setitem(orch.PROVIDERS, "MikroTik", ExplodingProvider())
    r = get_latest_firmware("MikroTik", "RB5009", "7.15")
    assert r.status.value == "cannot_determine"
    assert "boom" in r.message


def test_known_dead_end_vendor_returns_not_implemented(monkeypatch):
    # UnimplementedProvider now makes one real live re-check on every
    # call before falling back to the historical "blocked" claim (see
    # providers/base.py's UnimplementedProvider -- fixed live 2026-07-16
    # so it tries first instead of assuming forever). Mock that probe so
    # this test stays fast/deterministic with zero live network calls,
    # same rule as everywhere else in this suite.
    import firmware_lookup.http_client as http_client_mod

    monkeypatch.setattr(
        http_client_mod.FirmwareHttpClient, "get_text", lambda self, url, **kw: None
    )

    r = get_latest_firmware("Teltonika", "RUTX50", "1.0")
    assert r.status.value == "not_implemented"
    # Teltonika is bot-walled to automated access but reachable by a
    # real human browser -- message now carries that real link (see
    # providers/unimplemented.py's MANUAL_CHECK_URLS) instead of a dead
    # end, so this checks the prefix rather than an exact match.
    assert r.message.startswith("Provider not implemented.")
    assert r.source_url == MANUAL_CHECK_URLS["Teltonika"]
