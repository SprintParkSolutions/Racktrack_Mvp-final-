"""
TP-Link -- Omada support portal firmware API (public, no login), with the
classic www.tp-link.com download page as the fallback for models the portal
does not list (Easy Smart / unmanaged switches).

VERIFIED LIVE 2026-09-07 against https://support.omadanetworks.com. The
portal is a Nuxt app; its firmware page (/en/download/firmware/<slug>/<hw>/)
is driven by two plain-JSON POST endpoints that answer without cookies or a
login -- the same two calls the page itself makes, read out of its JS
bundle rather than guessed:

    POST /api/v1/resource/tourist/findFirmwareModelVersionByList
         {"siteId": 1, "modelName": "TL-SG2428P"}
      -> {"errorCode": 0, "result": ["V5", "V4", "V3", "V2", "V1"], ...}
         (hardware versions that have firmware; [] for an unknown model)

    POST /api/v1/resource/tourist/findFirmwareByModel
         {"siteId": 1, "modelName": "SG2428P", "productVersion": "V5.20"}
      -> {"errorCode": 0, "result": [{"title": "SG2428P(UN)_V5.20_5.20.27 Build 20260509",
             "awsUrl": "https://static.tp-link.com/upload/firmware/.../....zip",
             "publishDate": "06-09-2026", "releaseNotesUrl": "....pdf", ...}, ...]}

Facts that shaped the code (all observed in the responses, none assumed):
  * The firmware version, build date and hardware version live ONLY in the
    title -- the record's `hardwareVersion`/`firmwareVersion` fields are
    null on every entry. Title grammar: <MODEL>(<REGION>)_V<hw>_<fw> Build
    <yyyymmdd>; 2020-21 entries carry just a date and no version at all.
  * `publishDate` is MM-DD-YYYY ("03-31-2026" proves the field order).
  * TP-Link renamed its Omada switches in 2023. The 5.20.0 release note on
    the portal says "remove 'TL-' from the product model number ... the
    firmware of the old and new devices can be upgraded with each other"
    and "Hardware version will change from V5.0/V5.6 to V5.20/V5.26". So a
    TL-SG2428P running 5.20.x is listed under SG2428P V5.20 -- both names
    are queried and their hardware-version groups are merged.
  * siteId 1 is the Worldwide site behind the /en/ pages linked from the
    results (the pages' own payload says so). The geo-located Indian site
    (siteId 6) lists fewer hardware versions (no SG2428P V5.30) and fewer
    images (2 of the 6 for TL-SG2428P V5). Origin/Referer headers are not
    required; they are sent anyway so the requests look like the page's.
  * The portal's generic search endpoint (searchResource) was tried first
    and rejected: a bare-model query returns only controller/utility
    software, and its index lacks images the firmware API lists.
  * Hardware-version equivalence, quoted from the portal's own download
    page note: "Vx.0 = Vx.6/Vx.8/Vx.9 (eg: V1.0=V1.6/V1.8/V1.9); Vx.x0 =
    Vx.x6/Vx.x8/Vx.x9 (eg: V1.20=V1.26/V1.28/V1.29); Vx.30 = Vx.32/Vx.33".
  * TL-SG108E and TL-SG1024D (non-Omada): both endpoints return [] for
    them, so www.tp-link.com/us/support/download/<slug>/ stays as the
    fallback. Its firmware rows are <table class="download-resource-table">
    blocks with the same title grammar and a "Published Date:" cell; the
    TL-SG1024D page has no firmware rows at all. An unknown slug on
    www.tp-link.com answers HTTP 200 with an EMPTY body, so a body that
    never names the slug is treated as nothing, not as a page without
    firmware.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime

from firmware_lookup.http_client import FirmwareHttpClient
from firmware_lookup.providers.base import BrowserAuthenticatedProvider
from firmware_lookup.result import (
    Confidence,
    FirmwareResult,
    ambiguous_model,
    cannot_determine,
    model_not_found,
    ok_result,
)

logger = logging.getLogger("firmware_lookup.providers.tplink")

VENDOR = "TP-Link"

OMADA_BASE = "https://support.omadanetworks.com"
OMADA_API_VERSIONS = f"{OMADA_BASE}/api/v1/resource/tourist/findFirmwareModelVersionByList"
OMADA_API_FIRMWARE = f"{OMADA_BASE}/api/v1/resource/tourist/findFirmwareByModel"
# 1 = Worldwide, the site behind the /en/ pages this provider links to.
OMADA_SITE_ID = 1

WWW_BASE = "https://www.tp-link.com/us/support/download"

RETRIEVAL_OMADA = "public_api"
RETRIEVAL_WWW = "public_html"

# "5.20.27 Build 20260509 Rel.23533" as it appears in a portal title, a file
# name, or the string a switch reports over SNMP. Three or more dotted groups
# so a hardware version such as the "5.20" in "V5.20_5.20.27" is never taken
# for the firmware version; the build date may follow as "Build 20260509" or,
# in older file names, as "_20260509".
_FW_IN_TEXT_RE = re.compile(
    r"(?<![\dV.])(\d+(?:\.\d+){2,})"
    r"(?:[\s_]*(?:Build[\s_]*)?(\d{8})(?!\d))?"
    r"(?:[\s_]*Rel\.?\s*(\d+))?",
    re.IGNORECASE,
)
# A version typed or read from the device: two or more groups are enough.
_CURRENT_RE = re.compile(
    r"(\d+(?:\.\d+)+)(?:[\s_]*(?:Build[\s_]*)?(\d{8})(?!\d))?(?:[\s_]*Rel\.?\s*(\d+))?",
    re.IGNORECASE,
)
_HW_LABEL_RE = re.compile(r"^\s*v?\s*(\d+)(?:\.(\d+))?\s*$", re.IGNORECASE)
# "TL-SG2428P V5.20" -> model "TL-SG2428P", hardware "V5.20".
_MODEL_HW_SUFFIX_RE = re.compile(r"\s+v(\d+(?:\.\d+)?)\s*$", re.IGNORECASE)
_MODEL_REGION_RE = re.compile(r"\(\s*[A-Za-z]{2,3}\s*\)")

# www.tp-link.com download page (current markup, verified 2026-09-07).
_WWW_TABLE_SPLIT_RE = re.compile(r'<table class="download-resource-table"', re.IGNORECASE)
_WWW_FIRMWARE_MARK = "Download-Detail-Firmware"
_WWW_TITLE_RE = re.compile(r"download-resource-name[^>]*>\s*<p>\s*([^<]+?)\s*</p>", re.IGNORECASE)
_WWW_HREF_RE = re.compile(r'href="([^"]+)"', re.IGNORECASE)
_WWW_DATE_RE = re.compile(
    r"Published Date:\s*</span>\s*<span>\s*(\d{4}-\d{2}-\d{2})", re.IGNORECASE
)
_WWW_SHOWN_HW_RE = re.compile(
    r"verison-hidden'>\s*(V[\d.]+)|class=\"current-version\"[^>]*>\s*(V[\d.]+)", re.IGNORECASE
)
# Legacy markup: only the CDN file name carries the version.
_WWW_LEGACY_HREF_RE = re.compile(
    r'href="(https?://static\.tp-link\.com/[^"]*?upload/firmware/[^"]+)"', re.IGNORECASE
)


@dataclass(frozen=True)
class FirmwareVersion:
    """Dotted numeric groups plus TP-Link's build stamp, compared numerically.

    Groups compare first (shorter tuples are padded with zeros, so 5.20 ==
    5.20.0); an equal version is then ordered by build date, then by the
    Rel number, when both sides carry them.
    """

    groups: tuple[int, ...]
    build: str | None = None
    rel: str | None = None

    @property
    def text(self) -> str:
        """The bare version, e.g. "5.20.27"."""
        return ".".join(str(g) for g in self.groups)

    @property
    def build_text(self) -> str | None:
        """The build stamp exactly as TP-Link writes it, or None."""
        if not self.build:
            return None
        return f"Build {self.build}" + (f" Rel.{self.rel}" if self.rel else "")

    def sort_key(self) -> tuple:
        """Key for max(): padded groups, then build date, then Rel."""
        padded = self.groups + (0,) * (8 - len(self.groups))
        return (padded, int(self.build or 0), int(self.rel or 0))

    def compare(self, other: FirmwareVersion) -> int:
        """-1, 0 or 1 -- a missing build/Rel on either side is a tie."""
        width = max(len(self.groups), len(other.groups))
        mine = self.groups + (0,) * (width - len(self.groups))
        theirs = other.groups + (0,) * (width - len(other.groups))
        if mine != theirs:
            return -1 if mine < theirs else 1
        if self.build and other.build and self.build != other.build:
            return -1 if int(self.build) < int(other.build) else 1
        if self.rel and other.rel and self.rel != other.rel:
            return -1 if int(self.rel) < int(other.rel) else 1
        return 0


@dataclass(frozen=True)
class FirmwareEntry:
    """One firmware image as the vendor lists it."""

    title: str
    version: FirmwareVersion
    model_name: str
    hardware: str | None
    published: str | None
    file_url: str | None
    release_notes_url: str | None
    page_url: str


def parse_firmware_version(text: str | None, *, lenient: bool = False) -> FirmwareVersion | None:
    """Pull a FirmwareVersion out of a title, file name or reported string.

    `lenient` accepts two dotted groups (a version typed by a person);
    titles need three so a hardware version is never mistaken for one.
    """
    if not text:
        return None
    match = (_CURRENT_RE if lenient else _FW_IN_TEXT_RE).search(text)
    if not match:
        return None
    groups = tuple(int(g) for g in match.group(1).split("."))
    return FirmwareVersion(groups=groups, build=match.group(2), rel=match.group(3))


def normalize_hardware(label: str | None) -> str | None:
    """Canonical spelling of a hardware version: "v5.6" -> "V5.60", "V5.0" -> "V5".

    TP-Link's own model lists write V5.6 as "V5.60" and V5.0 as plain "V5";
    this makes a typed hint comparable with those labels.
    """
    if not label:
        return None
    match = _HW_LABEL_RE.match(label)
    if not match:
        return None
    major, minor = int(match.group(1)), match.group(2)
    if minor is None or int(minor) == 0:
        return f"V{major}"
    if len(minor) == 1:
        minor += "0"
    return f"V{major}.{minor}"


def hardware_family(normalized: str) -> str:
    """Fold a normalized label with TP-Link's published equivalence rule.

    "Vx.0 = Vx.6/Vx.8/Vx.9; Vx.x0 = Vx.x6/Vx.x8/Vx.x9; Vx.30 = Vx.32/Vx.33"
    (the note on the portal's download page), so V5.26 -> V5.20, V5.33 ->
    V5.30 and V5.60/V5.80/V5.90 -> V5.
    """
    match = re.fullmatch(r"V(\d+)(?:\.(\d\d))?", normalized)
    if not match:
        return normalized
    major, minor = match.group(1), match.group(2)
    if minor is None:
        return f"V{major}"
    if minor in ("32", "33"):
        minor = "30"
    elif minor[1] in "689":
        minor = minor[0] + "0"
    if minor in ("00", "60", "80", "90"):
        return f"V{major}"
    return f"V{major}.{minor}"


def split_model(raw: str | None) -> tuple[str, str | None]:
    """Separate a trailing hardware version from the model: ("TL-SG2428P", "V5.20").

    Also drops a region suffix such as "(UN)" that never appears in the
    portal's model names.
    """
    # The portal spells every model upper-case and answers case-insensitively,
    # so upper-casing costs nothing and keeps messages in TP-Link's spelling.
    model = re.sub(r"\s+", " ", (raw or "").strip()).upper()
    # "TLSG2428P" (hyphen dropped by whoever typed it) -> "TL-SG2428P": the
    # portal returns [] without the hyphen.
    model = re.sub(r"^TL(?=[A-Z])", "TL-", model)
    hardware = None
    match = _MODEL_HW_SUFFIX_RE.search(model)
    if match:
        hardware = "V" + match.group(1)
        model = model[: match.start()].strip()
    model = _MODEL_REGION_RE.sub("", model).strip()
    return model, hardware


def model_slug(model: str) -> str:
    """The lower-cased path segment both TP-Link sites use: tl-sg2428p."""
    return re.sub(r"\s+", "-", model.strip().lower())


def omada_product_page(model: str) -> str:
    """The portal's per-model download page."""
    return f"{OMADA_BASE}/en/product/{model_slug(model)}/download/"


def omada_firmware_page(model_name: str, hardware: str) -> str:
    """The portal page that lists exactly one hardware version's images."""
    return f"{OMADA_BASE}/en/download/firmware/{model_slug(model_name)}/{hardware.lower()}/"


def _name_variants(model: str) -> list[str]:
    """The model as given plus its renamed twin (TL- dropped or added)."""
    variants = [model]
    if model.upper().startswith("TL-"):
        variants.append(model[3:])
    else:
        variants.append(f"TL-{model}")
    return variants


def _iso_from_us_date(text: str | None) -> str | None:
    """Portal publishDate (MM-DD-YYYY, e.g. 06-09-2026) -> ISO 2026-06-09."""
    if not text:
        return None
    try:
        return datetime.strptime(text.strip(), "%m-%d-%Y").date().isoformat()
    except ValueError:
        return None


def _www_page_is_for(html: str, slug: str) -> bool:
    """True when the body is a real download page for the model (it names the slug)."""
    return bool(html.strip()) and slug in html.lower()


def _hardware_major(label: str) -> int | None:
    match = _HW_LABEL_RE.match(label)
    return int(match.group(1)) if match else None


class _ApiFailure:
    """Sentinel: the endpoint returned nothing usable (transport, non-JSON, errorCode)."""


_FAILED = _ApiFailure()


class TPLinkProvider(BrowserAuthenticatedProvider):
    # Kept for the login machinery the base class provides; every lookup
    # below returns a definite result, so that path is never reached.
    HOME_URL = "https://www.tp-link.com/us/support"
    # Tells the orchestrator it may pass hardware_version= through.
    ACCEPTS_HARDWARE_VERSION = True

    def __init__(self):
        super().__init__(VENDOR, self.HOME_URL)
        # Two light JSON calls plus one per hardware version considered;
        # half a second between them is polite without making a lookup
        # with several hardware versions crawl.
        self.http = FirmwareHttpClient("tplink", min_delay_seconds=0.5)

    # ------------------------------------------------------------------ entry

    def get_latest_firmware(
        self,
        vendor: str,
        model: str,
        current_version: str,
        hardware_version: str | None = None,
    ) -> FirmwareResult:
        """Provider contract entry point; never raises and never needs a login."""
        return self.lookup(model, current_version, hardware_version, vendor=vendor or VENDOR)

    def check_public_source(
        self, vendor: str, model: str, current_version: str
    ) -> FirmwareResult | None:
        """Provider hook: always a definite result, never None."""
        return self.lookup(model, current_version, vendor=vendor or VENDOR)

    def lookup(
        self,
        model: str,
        current_version: str | None,
        hardware_version: str | None = None,
        *,
        vendor: str = VENDOR,
    ) -> FirmwareResult:
        """Latest firmware for `model`, disambiguated by hardware version.

        The hardware version can be passed explicitly or embedded in the
        model ("TL-SG2428P V5.20"); without it, the group whose firmware
        shares the current version's first two numeric groups is chosen
        (5.20.x -> V5.20). Never raises.
        """
        try:
            return self._lookup(model, current_version, hardware_version, vendor)
        except Exception as exc:  # the contract: a result, never a traceback
            logger.exception("[TP-Link] lookup raised")
            bare_model, _ = split_model(model)
            return cannot_determine(
                vendor,
                model,
                current_version,
                retrieval_method=RETRIEVAL_OMADA,
                reason=f"Internal error while querying TP-Link: {exc}",
                manual_check_url=omada_product_page(bare_model) if bare_model else None,
            )

    # ------------------------------------------------------------------ omada

    def _lookup(
        self,
        raw_model: str,
        current_version: str | None,
        hardware_version: str | None,
        vendor: str,
    ) -> FirmwareResult:
        model, embedded_hw = split_model(raw_model)
        if not model:
            return model_not_found(
                vendor, raw_model, current_version, RETRIEVAL_OMADA, f"{OMADA_BASE}/en/"
            )
        hw_hint = normalize_hardware(hardware_version) or normalize_hardware(embedded_hw)
        current = parse_firmware_version(current_version, lenient=True)
        portal = omada_product_page(model)

        # 1. Which hardware versions have firmware, under either name.
        labels: list[tuple[str, str]] = []
        for name in _name_variants(model):
            result = self._omada_post(
                OMADA_API_VERSIONS, {"siteId": OMADA_SITE_ID, "modelName": name}, portal
            )
            if result is _FAILED:
                return cannot_determine(
                    vendor,
                    raw_model,
                    current_version,
                    retrieval_method=RETRIEVAL_OMADA,
                    reason=(
                        f"The Omada support portal API returned nothing for {name} "
                        "(hardware-version list)."
                    ),
                    manual_check_url=portal,
                )
            labels.extend((name, str(label)) for label in result if str(label).strip())
        logger.info("[TP-Link] %s: portal hardware versions %s", model, labels)

        if not labels:
            return self._lookup_www(vendor, raw_model, model, current, current_version, hw_hint)

        # 2. Narrow the hardware versions before fetching their images.
        selected = self._select_labels(labels, hw_hint, current)
        if not selected:
            listed = ", ".join(f"{n} {h}" for n, h in labels)
            if hw_hint:
                return cannot_determine(
                    vendor,
                    raw_model,
                    current_version,
                    retrieval_method=RETRIEVAL_OMADA,
                    reason=(
                        f"Hardware version {hw_hint} is not listed for {model} on the "
                        f"Omada support portal; listed: {listed}."
                    ),
                    manual_check_url=portal,
                )
            return self._ambiguous(vendor, raw_model, current_version, labels, portal)

        # 3. Fetch and parse each selected hardware version's images.
        groups: dict[tuple[str, str], list[FirmwareEntry]] = {}
        for name, label in selected:
            result = self._omada_post(
                OMADA_API_FIRMWARE,
                {"siteId": OMADA_SITE_ID, "modelName": name, "productVersion": label},
                omada_firmware_page(name, label),
            )
            if result is _FAILED:
                return cannot_determine(
                    vendor,
                    raw_model,
                    current_version,
                    retrieval_method=RETRIEVAL_OMADA,
                    reason=(
                        f"The Omada support portal API returned nothing for {name} {label} "
                        "(firmware list)."
                    ),
                    manual_check_url=portal,
                )
            entries = self._parse_omada_entries(result, name, label)
            if entries:
                groups[(name, label)] = entries
        if not groups:
            listed = ", ".join(f"{n} {h}" for n, h in selected)
            return cannot_determine(
                vendor,
                raw_model,
                current_version,
                retrieval_method=RETRIEVAL_OMADA,
                reason=(
                    f"The Omada support portal lists firmware for {listed}, but none of "
                    "the entries carries a version number in its title."
                ),
                manual_check_url=portal,
            )

        # 4. Decide which group(s) the current version belongs to.
        chosen = self._choose_groups(groups, hw_hint, current)
        if not chosen:
            everything = [entry for entries in groups.values() for entry in entries]
            if current and all(current.compare(entry.version) > 0 for entry in everything):
                return self._newer_than_listed(
                    vendor, raw_model, model, current_version, everything, portal
                )
            return self._ambiguous(vendor, raw_model, current_version, list(groups), portal)

        # 5. The newest image across the chosen group(s).
        candidates = [entry for key in chosen for entry in groups[key]]
        latest = max(candidates, key=lambda e: e.version.sort_key())
        update_available = current.compare(latest.version) < 0 if current else None

        parts = [
            f"Hardware version {latest.hardware}: latest firmware {latest.version.text}"
            + (f" {latest.version.build_text}" if latest.version.build_text else "")
            + (f", published {latest.published}" if latest.published else "")
            + "."
        ]
        if latest.model_name.upper() != model.upper():
            parts.append(
                f"The Omada support portal lists this hardware under the model name "
                f"'{latest.model_name}'."
            )
        if len(chosen) > 1:
            parts.append(
                "Hardware versions considered: " + ", ".join(f"{n} {h}" for n, h in chosen) + "."
            )
        if latest.release_notes_url:
            parts.append(f"Release notes: {latest.release_notes_url}")

        return ok_result(
            vendor=vendor,
            model=raw_model,
            current_version=current_version,
            latest_version=latest.version.text,
            source_url=latest.page_url,
            confidence=Confidence.HIGH,
            retrieval_method=RETRIEVAL_OMADA,
            update_available=update_available,
            message=" ".join(parts),
            release_date=latest.published,
            build=latest.version.build_text,
        )

    def _omada_post(self, url: str, body: dict, referer: str) -> list | _ApiFailure:
        """POST one portal endpoint; the `result` list, or _FAILED."""
        text = self.http.post_text(
            url,
            data=json.dumps(body),
            headers={
                "Content-Type": "application/json",
                "Origin": OMADA_BASE,
                "Referer": referer,
            },
        )
        if not text:
            return _FAILED
        try:
            payload = json.loads(text)
        except ValueError:
            logger.warning("[TP-Link] %s returned non-JSON", url)
            return _FAILED
        if not isinstance(payload, dict) or payload.get("errorCode") != 0:
            logger.warning("[TP-Link] %s answered %s", url, str(payload)[:200])
            return _FAILED
        result = payload.get("result")
        return result if isinstance(result, list) else []

    @staticmethod
    def _parse_omada_entries(records: list, model_name: str, label: str) -> list[FirmwareEntry]:
        page_url = omada_firmware_page(model_name, label)
        entries: list[FirmwareEntry] = []
        for record in records:
            if not isinstance(record, dict):
                continue
            title = str(record.get("title") or record.get("name") or "").strip()
            file_url = record.get("awsUrl") or record.get("url") or None
            version = parse_firmware_version(title)
            if version is None and file_url:
                version = parse_firmware_version(str(file_url).rsplit("/", 1)[-1])
            if version is None:
                logger.info("[TP-Link] skipping entry without a version: %r", title)
                continue
            if file_url and (not version.build or not version.rel):
                # The file name sometimes carries the Rel the title omits.
                from_file = parse_firmware_version(str(file_url).rsplit("/", 1)[-1])
                if from_file and from_file.groups == version.groups:
                    version = FirmwareVersion(
                        groups=version.groups,
                        build=version.build or from_file.build,
                        rel=version.rel or from_file.rel,
                    )
            entries.append(
                FirmwareEntry(
                    title=title,
                    version=version,
                    model_name=model_name,
                    hardware=label,
                    published=_iso_from_us_date(record.get("publishDate")),
                    file_url=file_url,
                    release_notes_url=record.get("releaseNotesUrl") or None,
                    page_url=page_url,
                )
            )
        return entries

    @staticmethod
    def _select_labels(
        labels: list[tuple[str, str]],
        hw_hint: str | None,
        current: FirmwareVersion | None,
    ) -> list[tuple[str, str]]:
        """Hardware versions worth fetching, before any image is downloaded."""
        if hw_hint:
            exact = [(n, h) for n, h in labels if normalize_hardware(h) == hw_hint]
            if exact:
                return exact
            family = hardware_family(hw_hint)
            return [
                (n, h)
                for n, h in labels
                if normalize_hardware(h) and hardware_family(normalize_hardware(h)) == family
            ]
        if current:
            same_major = [(n, h) for n, h in labels if _hardware_major(h) == current.groups[0]]
            if same_major:
                return same_major
            majors = [m for m in (_hardware_major(h) for _, h in labels) if m is not None]
            if majors and current.groups[0] > max(majors):
                # No hardware version shares the major: fetch every group so
                # "newer than everything listed" is shown, not assumed.
                return labels
        return labels if len(labels) == 1 else []

    @staticmethod
    def _choose_groups(
        groups: dict[tuple[str, str], list[FirmwareEntry]],
        hw_hint: str | None,
        current: FirmwareVersion | None,
    ) -> list[tuple[str, str]]:
        """Which fetched group(s) the device belongs to; [] means ambiguous."""
        keys = list(groups)
        if hw_hint:
            return keys
        if current and len(current.groups) >= 2:
            prefix = current.groups[:2]
            matching = [
                key
                for key in keys
                if any(entry.version.groups[:2] == prefix for entry in groups[key])
            ]
            if matching:
                return matching
        return keys if len(keys) == 1 else []

    @staticmethod
    def _newer_than_listed(
        vendor: str,
        raw_model: str,
        model: str,
        current_version: str | None,
        entries: list[FirmwareEntry],
        portal: str,
    ) -> FirmwareResult:
        """The reported version is above every image fetched: no update, hardware unknown."""
        latest = max(entries, key=lambda e: e.version.sort_key())
        checked = sorted({f"{e.model_name} {e.hardware}" for e in entries})
        message = (
            f"The reported version {current_version} is newer than every image the Omada "
            f"support portal lists for {model} (hardware versions checked: "
            + ", ".join(checked)
            + f"). Newest listed: {latest.version.text}"
            + (f" {latest.version.build_text}" if latest.version.build_text else "")
            + f" for {latest.model_name} {latest.hardware}"
            + (f", published {latest.published}" if latest.published else "")
            + ". No update is available from this source; which hardware version this "
            f"device is was not identified. Portal: {portal}"
        )
        return ok_result(
            vendor=vendor,
            model=raw_model,
            current_version=current_version,
            latest_version=latest.version.text,
            source_url=portal,
            confidence=Confidence.LOW,
            retrieval_method=RETRIEVAL_OMADA,
            update_available=False,
            message=message,
            release_date=latest.published,
            build=latest.version.build_text,
        )

    @staticmethod
    def _ambiguous(
        vendor: str,
        raw_model: str,
        current_version: str | None,
        labels: list[tuple[str, str]],
        portal: str,
    ) -> FirmwareResult:
        result = ambiguous_model(
            vendor,
            raw_model,
            current_version,
            [f"{name} {hardware}" for name, hardware in labels],
            retrieval_method=RETRIEVAL_OMADA,
        )
        result.source_url = portal
        result.message = (
            f"The Omada support portal lists firmware for more than one hardware version "
            f"of {raw_model} and the current version does not point at one of them: "
            + ", ".join(f"{n} {h}" for n, h in labels)
            + ". Pass the hardware version (printed on the device label) to get a "
            f"result, or check the portal yourself: {portal}"
        )
        return result

    # -------------------------------------------------------------------- www

    def _lookup_www(
        self,
        vendor: str,
        raw_model: str,
        model: str,
        current: FirmwareVersion | None,
        current_version: str | None,
        hw_hint: str | None,
    ) -> FirmwareResult:
        """Fallback for models the Omada portal does not list."""
        slug = model_slug(model)
        plain_url = f"{WWW_BASE}/{slug}/"
        page_url = f"{WWW_BASE}/{slug}/{hw_hint.lower()}/" if hw_hint else plain_url
        html = self.http.get_text(page_url)
        if html is not None and not _www_page_is_for(html, slug):
            # HTTP 200 with an empty body is what an unknown slug gets.
            html = None
        if html is None and hw_hint:
            return cannot_determine(
                vendor,
                raw_model,
                current_version,
                retrieval_method=RETRIEVAL_WWW,
                reason=(
                    f"www.tp-link.com returned nothing for {model} hardware version "
                    f"{hw_hint} ({page_url}); the Omada support portal lists no firmware "
                    "for this model."
                ),
                manual_check_url=plain_url,
            )
        if html is None:
            result = model_not_found(
                vendor, raw_model, current_version, RETRIEVAL_WWW, omada_product_page(model)
            )
            result.message += (
                f" The Omada support portal API returned no hardware versions for {model}, "
                f"and {plain_url} returned nothing for it."
            )
            return result

        shown_hw = None
        shown = _WWW_SHOWN_HW_RE.search(html)
        if shown:
            shown_hw = normalize_hardware(shown.group(1) or shown.group(2))
        other_hws = sorted(
            {
                normalize_hardware(m.group(1)) or m.group(1)
                for m in re.finditer(rf"/support/download/{re.escape(slug)}/(v[\d.]+)/", html, re.I)
            }
            - {shown_hw}
        )
        entries = self._parse_www_entries(html, model, shown_hw, page_url)
        if not entries:
            return cannot_determine(
                vendor,
                raw_model,
                current_version,
                retrieval_method=RETRIEVAL_WWW,
                reason=(
                    f"TP-Link's download page for {model}"
                    + (f" ({shown_hw})" if shown_hw else "")
                    + " lists no firmware, and the Omada support portal lists none either."
                ),
                manual_check_url=page_url,
            )

        latest = max(entries, key=lambda e: e.version.sort_key())
        update_available = current.compare(latest.version) < 0 if current else None
        parts = [
            (f"Hardware version {shown_hw}: " if shown_hw else "")
            + f"latest firmware {latest.version.text}"
            + (f" {latest.version.build_text}" if latest.version.build_text else "")
            + (f", published {latest.published}" if latest.published else "")
            + " on www.tp-link.com (the Omada support portal lists no firmware for this model)."
        ]
        confidence = Confidence.HIGH
        if other_hws and not hw_hint:
            confidence = Confidence.MEDIUM
            parts.append(
                "The page also has firmware for hardware versions "
                + ", ".join(other_hws)
                + " -- pass yours if it differs."
            )
        return ok_result(
            vendor=vendor,
            model=raw_model,
            current_version=current_version,
            latest_version=latest.version.text,
            source_url=page_url,
            confidence=confidence,
            retrieval_method=RETRIEVAL_WWW,
            update_available=update_available,
            message=" ".join(parts),
            release_date=latest.published,
            build=latest.version.build_text,
        )

    @staticmethod
    def _parse_www_entries(
        html: str, model: str, shown_hw: str | None, page_url: str
    ) -> list[FirmwareEntry]:
        entries: list[FirmwareEntry] = []
        for block in _WWW_TABLE_SPLIT_RE.split(html)[1:]:
            if _WWW_FIRMWARE_MARK not in block:
                continue
            title_match = _WWW_TITLE_RE.search(block)
            href_match = _WWW_HREF_RE.search(block)
            title = title_match.group(1).strip() if title_match else ""
            file_url = href_match.group(1) if href_match else None
            version = parse_firmware_version(title) or (
                parse_firmware_version(file_url.rsplit("/", 1)[-1]) if file_url else None
            )
            if version is None:
                continue
            date_match = _WWW_DATE_RE.search(block)
            entries.append(
                FirmwareEntry(
                    title=title or (file_url or ""),
                    version=version,
                    model_name=model,
                    hardware=shown_hw,
                    published=date_match.group(1) if date_match else None,
                    file_url=file_url,
                    release_notes_url=None,
                    page_url=page_url,
                )
            )
        if entries:
            return entries
        # Legacy markup: firmware links only, version in the file name.
        for match in _WWW_LEGACY_HREF_RE.finditer(html):
            file_url = match.group(1)
            version = parse_firmware_version(file_url.rsplit("/", 1)[-1])
            if version is None:
                continue
            entries.append(
                FirmwareEntry(
                    title=file_url.rsplit("/", 1)[-1],
                    version=version,
                    model_name=model,
                    hardware=shown_hw,
                    published=None,
                    file_url=file_url,
                    release_notes_url=None,
                    page_url=page_url,
                )
            )
        return entries
