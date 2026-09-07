"""D-Link -- official FTP mirror directory listing, no login.

Source (verified live 2026-09-07 from this network):
    https://ftp.dlink.ru/pub/Switch/<MODEL>/Firmware/
A plain Apache index (Name / Last modified / Size). Listings read while
building this: DGS-1210-52, DGS-1210-28, DGS-1210-28P, DGS-1210-52MP,
DES-1210-28, DGS-1510-28, DGS-3000-28X, DXS-3400-24TC. DGS-1024C,
DGS-1008D and DGS-1016D have a Firmware folder that lists nothing.

Other hosts probed the same day, with short timeouts:
  - https://ftp.dlink.de answers (HTTP 200) but is a different tree: an
    IIS listing under /dgs/dgs-1210/driver_software/ holding per-series
    zips such as dgs-1210_fw_revf_632b019_ALL_en_20241115.zip; the
    /pub/Switch/... path returns 404 there. Not a same-path mirror, so
    it is not in MIRRORS.
  - https://ftp.dlink.eu: the host name does not resolve.
  - http://ftp.dlink.com.tw: TCP connect timed out after 10 s.
  - www.dlink.com does not answer from this network and tsd.dlink.com.tw
    denies access.
MIRRORS is therefore a one-entry ordered list today; the lookup walks it
in order and stops at the first host that answers.

File-name grammar seen in the listings (extension handled separately):
    <model or series>-<hardware rev>-<major>-<minor>-<build>
    DGS-1210-52-B1-3-12-B056.hex        model file, rev B1, 3.12.B056
    DGS-1210-52-C1-4-10-B049.hex        model file, rev C1, 4.10.B049
    DGS-1210-F1-SERIES-F1-6-12-B007.hex series file, rev F1, 6.12.B007
    DGS-1210-FX-SERIES-FX-6-30-016.hex  series file, rev FX, 6.30.016
    DGS-1210-FX-6-33-B005.con           series file, rev FX, 6.33.B005
    DES-1210-Cx-4-12-B056.hex           series file, rev Cx, 4.12.B056
    DGS-1210-28L-1-50-009-ALL.hex       a different model (28L) filed in
                                        the 28 folder; no rev token
    DGS-1510_Run_1_60_B022.had          underscore form, "Run" marker,
                                        no rev token
    DXS-3400-R3.11.B013.had             dotted form, "R" prefix
The build is either B-numbered ("B056") or bare ("016"). Versions are
rendered <major>.<minor>.<build> -- "6.30.016", "6.33.B005" -- which is
how the lab DGS-1210-52 reports itself over SNMP (firmware "6.30.016",
hardware "F3"); the .con header of the B005 image spells it v6.33.b005.

Hardware revision mapping derived from those names: a token
<letter><digit> is one revision (B1, C1, F1); <letter>X / <letter>x is
D-Link's wildcard for every revision with that letter (FX-SERIES,
DES-1210-Cx). So hardware "F3" selects the FX group (and an F3 group if
one existed), "C1" selects C1 (and CX if present). The lab F3 unit runs
6.30.016, which is the FX-SERIES file -- consistent with that reading.

".con" files: the first 64 bytes of DGS-1210-FX-SERIES-FX-6-30-016.con
were read live -- header "dlink_dgs1210 ... v6.30.016 ... dgs1210f",
12,775,084 bytes against 12,774,896 for the .hex of the same version. A
.con is therefore a firmware image in D-Link's newer container format,
not a console or configuration file, and it counts as firmware here.
Archives (.zip/.rar) and anything else are not counted.

The listing's "Last modified" column is the mirror's file date, not a
release date from D-Link, so it is reported in the message as "last
modified on <host>" rather than as a release date.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlparse

from firmware_lookup.http_client import FirmwareHttpClient
from firmware_lookup.matching import normalize_model
from firmware_lookup.providers.base import FirmwareProvider
from firmware_lookup.result import (
    Confidence,
    FirmwareResult,
    ambiguous_model,
    cannot_determine,
    model_not_found,
    ok_result,
)

logger = logging.getLogger("firmware_lookup.providers.dlink")

VENDOR = "D-Link"
# Ordered: the first host whose listing answers wins. See the module
# docstring for why only one host is here today.
MIRRORS: tuple[str, ...] = ("https://ftp.dlink.ru",)
SWITCH_PATH = "/pub/Switch/"
SUPPORT_URL = "https://www.dlink.com/en/support"
RETRIEVAL_METHOD = "vendor_ftp_directory_listing"

# Extensions that are firmware images in the listings read so far.
FIRMWARE_EXTENSIONS = frozenset({"hex", "con", "had", "bin", "img"})
# Name tokens that describe the file, not the model.
_MARKER_TOKENS = frozenset({"SERIES", "RUN", "RUNTIME", "FW", "FIRMWARE", "ALL"})

_INDEX_MARKER_RE = re.compile(r"<title>\s*Index of ", re.IGNORECASE)
# One Apache index row: link, then the "Last modified" cell.
_ROW_RE = re.compile(
    r'<a href="(?P<href>[^"?/][^"]*)">[^<]*</a>\s*</td>\s*'
    r"<td[^>]*>\s*(?P<date>\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)
_DASH_NAME_RE = re.compile(
    r"^(?P<head>.+?)(?:[-_](?P<rev>[A-Z][0-9X]))?"
    r"[-_](?P<major>\d+)[-_](?P<minor>\d+)[-_](?P<build>B?\d+)"
    r"(?:[-_](?P<tag>[A-Z]+))?$",
    re.IGNORECASE,
)
_DOT_NAME_RE = re.compile(
    r"^(?P<head>.+?)[-_]?[RV]?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<build>B?\d+)$",
    re.IGNORECASE,
)
_REV_TOKEN_RE = re.compile(r"^[A-Z][0-9X]$")
_HW_RE = re.compile(r"(?<![A-Z0-9])([A-Z])([0-9X])")
_HW_LETTER_ONLY_RE = re.compile(r"^\s*([A-Z])\s*$")
# "DGS-1210-52/F3", "DGS-1210-52 F3", "DGS-1210-52 rev. F3", "DGS-1210-52 (F3)",
# "DGS-1210-52_C1A". A hyphen is deliberately not a separator here: D-Link
# model names end in digits or letter groups like 28P/52MP, never in a
# hyphenated rev, and the catalogue uses "_" for revision folders.
_MODEL_REV_SUFFIX_RE = re.compile(
    r"^(?P<base>.*?[A-Z0-9])[\s/_(]+(?:rev(?:ision)?\.?\s*|hw\s*|hardware\s*)?"
    r"(?P<rev>[A-Z][0-9X])A?\)?\s*$",
    re.IGNORECASE,
)
# Catalogue folders such as DGS-1210-52_C1, DGS-1210-52_B1A, DGS-1024C_F6.
_REV_FOLDER_RE = re.compile(r"^(?P<base>.+)_(?P<rev>[A-Z][0-9X])A?$", re.IGNORECASE)
_CURRENT_RE = re.compile(r"(\d+)\.(\d+)(?:\.([A-Za-z]?\d+))?")


@dataclass(frozen=True)
class _Image:
    """One firmware image parsed out of a listing row."""

    name: str
    url: str
    rev: str | None
    major: int
    minor: int
    build: int
    build_raw: str
    modified: str

    @property
    def version(self) -> str:
        """Version the way the switch reports it: major.minor.build."""
        return f"{self.major}.{self.minor}.{self.build_raw}"

    @property
    def key(self) -> tuple[int, int, int]:
        """Numeric sort key; a B-prefix on the build carries no order."""
        return (self.major, self.minor, self.build)


@dataclass
class _Choice:
    """The image group(s) picked for the device, and why."""

    images: list[_Image]
    revs: list[str]
    how: str
    confidence: Confidence


def _host(url: str) -> str:
    return urlparse(url).netloc


def _join(items: list[str]) -> str:
    return ", ".join(items)


def _squash(text: str) -> str:
    """Letters and digits only, lower case: 'DGS-1210-52' -> 'dgs121052'."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _runs(text: str) -> list[str]:
    """Split into letter runs and digit runs: 'DGS-1210-52MP' -> DGS 1210 52 MP."""
    return re.findall(r"[A-Z]+|\d+", text.upper())


def _normalise_hw(raw: str | None) -> str | None:
    """'F3' -> 'F3'; 'Rev. C1A' -> 'C1'; 'F' -> 'FX' (whole F series); else None."""
    if not raw:
        return None
    text = raw.strip().upper()
    m = _HW_RE.search(text)
    if m:
        return m.group(1) + m.group(2)
    m = _HW_LETTER_ONLY_RE.match(text)
    if m:
        return m.group(1) + "X"
    return None


def _hw_covers(rev: str | None, hw: str) -> bool:
    """True when a file's revision token applies to the given hardware."""
    if rev is None:
        return False
    if rev == hw:
        return True
    return rev[0] == hw[0] and (rev[1] == "X" or hw[1] == "X")


def _split_model(model: str) -> tuple[str, str | None]:
    """Peel a hardware-revision suffix off the model string, if present."""
    text = model.strip()
    m = _MODEL_REV_SUFFIX_RE.match(text)
    if not m:
        return text, None
    return m.group("base").strip(), m.group("rev").upper()


def _folder_name(base_model: str) -> str:
    """Catalogue folder form of a model: upper case, '/' and spaces as '_'."""
    return re.sub(r"\s+", "_", base_model.strip().upper().replace("/", "_"))


def _folder_url(base_url: str, folder: str) -> str:
    return f"{base_url}{SWITCH_PATH}{quote(folder, safe='')}/Firmware/"


def _is_index(html: str) -> bool:
    return bool(_INDEX_MARKER_RE.search(html))


def _parse_rows(html: str) -> list[tuple[str, str]]:
    """(name, last-modified date) for every entry of an Apache index page."""
    rows = []
    for m in _ROW_RE.finditer(html):
        name = unquote(m.group("href"))
        rows.append((name, m.group("date")))
    return rows


def _parse_folders(html: str) -> list[str]:
    return [name.rstrip("/") for name, _ in _parse_rows(html) if name.endswith("/")]


def _parse_image_name(stem: str) -> tuple[list[str], str | None, int, int, str] | None:
    """Split a file stem into (model tokens, rev, major, minor, build)."""
    m = _DASH_NAME_RE.match(stem) or _DOT_NAME_RE.match(stem)
    if not m:
        return None
    rev = (m.groupdict().get("rev") or "").upper() or None
    tokens = [t for t in re.split(r"[-_\s]+", m.group("head")) if t]
    tokens = [t for t in tokens if t.upper() not in _MARKER_TOKENS and t.upper() != rev]
    if rev is None and tokens and _REV_TOKEN_RE.match(tokens[-1].upper()):
        rev = tokens.pop().upper()
    if not tokens:
        return None
    return tokens, rev, int(m.group("major")), int(m.group("minor")), m.group("build").upper()


def _head_applies(head_tokens: list[str], base_model: str) -> bool:
    """A file applies when its model/series part is a prefix of the model.

    Compared as letter/digit runs so 'DES3200' matches 'DES-3200-28' and
    'DGS-1210' matches 'DGS-1210-52MP', while 'DGS-1210-28L' does not
    match 'DGS-1210-28'.
    """
    head = _runs(" ".join(head_tokens))
    model = _runs(base_model)
    return bool(head) and model[: len(head)] == head


def _classify(
    rows: list[tuple[str, str]], folder_url: str, base_model: str
) -> tuple[list[_Image], list[str]]:
    """Firmware images for this model, plus names of versioned files skipped.

    Skipped means: a firmware-image extension whose name either carries
    another model's name or does not fit a known grammar. Archives and
    documents are dropped silently.
    """
    images: list[_Image] = []
    skipped: list[str] = []
    for name, date in rows:
        if name.endswith("/"):
            continue
        stem, dot, ext = name.rpartition(".")
        if not dot or ext.lower() not in FIRMWARE_EXTENSIONS:
            continue
        parsed = _parse_image_name(stem)
        if parsed is None:
            skipped.append(name)
            continue
        tokens, rev, major, minor, build_raw = parsed
        if not _head_applies(tokens, base_model):
            skipped.append(name)
            continue
        images.append(
            _Image(
                name=name,
                url=folder_url + quote(name, safe=""),
                rev=rev,
                major=major,
                minor=minor,
                build=int(re.sub(r"\D", "", build_raw)),
                build_raw=build_raw,
                modified=date,
            )
        )
    return images, skipped


def _parse_current(text: str | None) -> tuple[int, int, int] | None:
    """Core (major, minor, build) of a reported version.

    'Build 20260509 Rel.23533'-style suffixes are dropped: the listing
    carries nothing to compare them against, so they cannot break a tie.
    """
    if not text:
        return None
    m = _CURRENT_RE.search(text)
    if not m:
        return None
    build = int(re.sub(r"\D", "", m.group(3))) if m.group(3) else 0
    return int(m.group(1)), int(m.group(2)), build


def _pick_folder(
    base_model: str, hw: str | None, folders: list[str]
) -> tuple[str | None, str | None, list[str]]:
    """Choose the catalogue folder for a model.

    Returns (folder, rev_from_folder, candidates). An exact (case and
    punctuation insensitive) name wins. Otherwise folders of the form
    <model>_<rev>[A] are the same model at one hardware revision: one of
    them is taken when the hardware is known or when there is only one;
    several are returned as candidates. Other suffixes (_ME, _FL, MP...)
    are different products and are never substituted.
    """
    want = normalize_model(base_model)
    exact = [f for f in folders if normalize_model(f) == want]
    if exact:
        return exact[0], None, []
    # "dgs121052" typed without its dashes: the same letters and digits as
    # exactly one folder is still that folder.
    squashed = [f for f in folders if _squash(f) == _squash(base_model)]
    if len(squashed) == 1:
        return squashed[0], None, []
    rev_folders: list[tuple[str, str]] = []
    for f in folders:
        m = _REV_FOLDER_RE.match(f)
        if m and normalize_model(m.group("base")) == want:
            rev_folders.append((f, m.group("rev").upper()))
    if not rev_folders:
        return None, None, []
    if hw:
        hits = [(f, r) for f, r in rev_folders if _hw_covers(r, hw)]
        if len(hits) == 1:
            return hits[0][0], hits[0][1], []
        return None, None, [f for f, _ in rev_folders]
    if len(rev_folders) == 1:
        return rev_folders[0][0], rev_folders[0][1], []
    return None, None, [f for f, _ in rev_folders]


def _choose(
    groups: dict[str | None, list[_Image]],
    hw: str | None,
    hw_origin: str,
    current: tuple[int, int, int] | None,
) -> _Choice | list[str]:
    """Pick the image group(s) for the device.

    Returns a _Choice, or the list of revision labels when the choice
    cannot be made without a hardware revision (the caller reports that
    as ambiguous_model). A hardware revision that matches nothing is
    returned as a _Choice with no images so the caller can name it.
    """
    labels = sorted(r for r in groups if r is not None)
    unlabeled = groups.get(None, [])

    if hw:
        sel = [r for r in labels if _hw_covers(r, hw)]
        if sel:
            images = [img for r in sel for img in groups[r]]
            return _Choice(
                images,
                sel,
                f"hardware revision {hw} ({hw_origin}) selects the {_join(sel)} image(s)",
                Confidence.HIGH,
            )
        if unlabeled and not labels:
            return _Choice(
                unlabeled,
                [],
                f"the file names carry no hardware revision, so hardware {hw} "
                f"({hw_origin}) could not be checked against them",
                Confidence.MEDIUM,
            )
        return _Choice([], labels, hw_origin, Confidence.LOW)

    if len(groups) == 1:
        ((rev, images),) = groups.items()
        how = (
            f"only one hardware revision ({rev}) is listed"
            if rev
            else "the file names carry no hardware revision"
        )
        return _Choice(images, [rev] if rev else [], how, Confidence.HIGH)

    if current is not None:
        line = current[:2]
        holders = [r for r in labels if any(i.key[:2] == line for i in groups[r])]
        line_text = f"{line[0]}.{line[1]}"
        if holders and len({r[0] for r in holders}) == 1:
            exact = [r for r in holders if r[1] != "X"]
            if len(exact) == 1:
                # A specific revision (F1) also takes its series wildcard (FX).
                derived = exact[0]
                sel = [r for r in labels if _hw_covers(r, derived)]
            else:
                # Only the wildcard is known (FX): files marked for one
                # specific revision are not proven for unknown F hardware.
                derived = holders[0][0] + "X"
                sel = [r for r in labels if r == derived] or holders
            images = [img for r in sel for img in groups[r]]
            return _Choice(
                images,
                sel,
                f"the current version's {line_text} line appears only in the "
                f"{_join(holders)} image(s), so hardware revision {derived} was inferred",
                Confidence.MEDIUM,
            )
        if not holders and unlabeled and any(i.key[:2] == line for i in unlabeled):
            return _Choice(
                unlabeled,
                [],
                f"the current version's {line_text} line appears only in files "
                "whose names carry no hardware revision",
                Confidence.MEDIUM,
            )
    return labels


class DLinkProvider(FirmwareProvider):
    """Latest firmware from D-Link's FTP mirror directory listing."""

    vendor_key = VENDOR
    # Tells the orchestrator it may pass hardware_version= through.
    ACCEPTS_HARDWARE_VERSION = True

    def __init__(self):
        self.http = FirmwareHttpClient("dlink")

    def get_latest_firmware(
        self,
        vendor: str,
        model: str,
        current_version: str,
        hardware_version: str | None = None,
    ) -> FirmwareResult:
        """Provider contract entry point; never raises."""
        try:
            return self.lookup(model, current_version, hardware_version)
        except Exception as e:  # contract: never raise
            logger.exception("[%s] lookup raised", vendor)
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method="error",
                reason=f"Internal error while reading D-Link's FTP listing: {e}",
                manual_check_url=SUPPORT_URL,
            )

    def lookup(
        self, model: str, current_version: str, hardware_version: str | None = None
    ) -> FirmwareResult:
        """Resolve the model folder, read its Firmware/ listing, pick the image."""
        if not model or not model.strip():
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method=RETRIEVAL_METHOD,
                reason="No model was given, so no D-Link folder could be looked up.",
                manual_check_url=SUPPORT_URL,
            )

        base_model, rev_in_model = _split_model(model)
        hw = _normalise_hw(hardware_version)
        hw_origin = "from the hardware_version argument"
        if hw is None and rev_in_model:
            hw, hw_origin = rev_in_model, "from the model name"

        silent_hosts: list[str] = []
        for base_url in MIRRORS:
            host = _host(base_url)
            folder = _folder_name(base_model)
            folder_url = _folder_url(base_url, folder)
            html = self.http.get_text(folder_url)
            if html is None:
                # Either the folder is missing or the host is not answering.
                # The catalogue (one level up) tells the two apart.
                catalog_url = f"{base_url}{SWITCH_PATH}"
                catalog = self.http.get_text(catalog_url)
                if catalog is None or not _is_index(catalog):
                    silent_hosts.append(host)
                    continue
                folder, rev_from_folder, candidates = _pick_folder(
                    base_model, hw, _parse_folders(catalog)
                )
                if folder is None:
                    if candidates:
                        result = ambiguous_model(
                            VENDOR, model, current_version, candidates, RETRIEVAL_METHOD
                        )
                        result.source_url = catalog_url
                        return result
                    return model_not_found(
                        VENDOR,
                        model,
                        current_version,
                        retrieval_method=RETRIEVAL_METHOD,
                        manual_check_url=catalog_url,
                    )
                if hw is None and rev_from_folder:
                    hw, hw_origin = rev_from_folder, f"from the folder name {folder}"
                # The catalogue's spelling is the one the file names follow.
                rev_match = _REV_FOLDER_RE.match(folder) if rev_from_folder else None
                base_model = rev_match.group("base") if rev_match else folder
                folder_url = _folder_url(base_url, folder)
                html = self.http.get_text(folder_url)
                if html is None:
                    return cannot_determine(
                        VENDOR,
                        model,
                        current_version,
                        retrieval_method=RETRIEVAL_METHOD,
                        reason=(
                            f"{host} lists a folder {folder} for this model, but its "
                            "Firmware/ listing returned nothing."
                        ),
                        manual_check_url=f"{base_url}{SWITCH_PATH}{quote(folder, safe='')}/",
                    )
            return self._from_listing(
                html, folder_url, model, base_model, current_version, hw, hw_origin
            )

        return cannot_determine(
            VENDOR,
            model,
            current_version,
            retrieval_method=RETRIEVAL_METHOD,
            reason=(
                f"D-Link's FTP mirror returned nothing for {model}: "
                f"{_join(silent_hosts)} did not answer with a directory listing."
            ),
            manual_check_url=SUPPORT_URL,
        )

    def _from_listing(
        self,
        html: str,
        folder_url: str,
        model: str,
        base_model: str,
        current_version: str,
        hw: str | None,
        hw_origin: str,
    ) -> FirmwareResult:
        host = _host(folder_url)
        if not _is_index(html):
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method=RETRIEVAL_METHOD,
                reason=f"{host} answered for {model}, but not with a directory listing.",
                manual_check_url=folder_url,
            )

        rows = _parse_rows(html)
        if not rows:
            # An existing but empty Firmware folder is what the mirror
            # holds for D-Link's unmanaged switches (DGS-1024C, DGS-1008D,
            # DGS-1016D all read this way live).
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method=RETRIEVAL_METHOD,
                reason=(
                    f"The Firmware folder for {model} on {host} returned an empty "
                    "listing: no firmware is documented there for this model."
                ),
                manual_check_url=folder_url,
            )

        images, skipped = _classify(rows, folder_url, base_model)
        if not images:
            names = _join([name for name, _ in rows if not name.endswith("/")])
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method=RETRIEVAL_METHOD,
                reason=(
                    f"The Firmware folder for {model} on {host} lists {names}, but "
                    "none of these names could be read as a firmware image for "
                    "this model."
                ),
                manual_check_url=folder_url,
            )

        groups: dict[str | None, list[_Image]] = {}
        for img in images:
            groups.setdefault(img.rev, []).append(img)
        current = _parse_current(current_version)

        choice = _choose(groups, hw, hw_origin, current)
        if isinstance(choice, list):
            if current is not None and all(img.key < current for img in images):
                return self._newer_than_listed(images, folder_url, model, current_version, choice)
            candidates = [f"{base_model} (hardware {r})" for r in choice]
            if None in groups:
                candidates.append(f"{base_model} (files without a hardware revision)")
            result = ambiguous_model(VENDOR, model, current_version, candidates, RETRIEVAL_METHOD)
            result.source_url = folder_url
            return result
        if not choice.images:
            return cannot_determine(
                VENDOR,
                model,
                current_version,
                retrieval_method=RETRIEVAL_METHOD,
                reason=(
                    f"The Firmware folder for {model} on {host} lists images for "
                    f"hardware revision(s) {_join(choice.revs)} only; nothing there is "
                    f"marked for hardware {hw} ({choice.how})."
                ),
                manual_check_url=folder_url,
            )

        latest = max(choice.images, key=lambda i: (i.key, i.modified))
        update_available: bool | None = None
        if current is not None:
            update_available = latest.key > current

        parts = [
            f"Newest image for {_join(choice.revs) if choice.revs else 'this model'}: "
            f"{latest.name}, last modified {latest.modified} on {host}.",
            choice.how[0].upper() + choice.how[1:] + ".",
        ]
        if current is not None and latest.key < current:
            parts.append(
                f"The reported version {current_version} is newer than anything the mirror lists."
            )
        if skipped:
            parts.append(
                "Skipped, as their names carry another model or an unknown pattern: "
                f"{_join(skipped)}."
            )

        return ok_result(
            vendor=VENDOR,
            model=model,
            current_version=current_version,
            latest_version=latest.version,
            source_url=folder_url,
            confidence=choice.confidence,
            retrieval_method=RETRIEVAL_METHOD,
            update_available=update_available,
            message=" ".join(parts),
        )

    @staticmethod
    def _newer_than_listed(
        images: list[_Image],
        folder_url: str,
        model: str,
        current_version: str,
        revs: list[str],
    ) -> FirmwareResult:
        """The reported version is above every image listed: no update, revision unknown."""
        host = _host(folder_url)
        latest = max(images, key=lambda i: (i.key, i.modified))
        return ok_result(
            vendor=VENDOR,
            model=model,
            current_version=current_version,
            latest_version=latest.version,
            source_url=folder_url,
            confidence=Confidence.LOW,
            retrieval_method=RETRIEVAL_METHOD,
            update_available=False,
            message=(
                f"The reported version {current_version} is newer than every image listed "
                f"for {model} on {host}; the newest listed is {latest.name} (hardware "
                f"{latest.rev or 'not marked'}), last modified {latest.modified}. No update "
                f"is available from this source. Hardware revisions listed: {_join(revs)}; "
                "which one this device is was not identified."
            ),
        )


_PROVIDER: DLinkProvider | None = None


def lookup(model: str, current_version: str, hardware_version: str | None = None) -> FirmwareResult:
    """Look a model up through one shared provider instance (one HTTP cache per process)."""
    global _PROVIDER
    if _PROVIDER is None:
        _PROVIDER = DLinkProvider()
    return _PROVIDER.lookup(model, current_version, hardware_version)
