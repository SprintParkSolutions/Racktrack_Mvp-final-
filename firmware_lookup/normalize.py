"""
Vendor name normalization. Maps every known spelling variant DIRECTLY to
the short canonical key used as a PROVIDERS dict key (e.g. "Juniper", not
"Juniper Networks") — no long-name indirection, which is what caused a
silent lookup-miss bug in the older firmware.py/DEFAULT_GATED_NOS system.

normalize_vendor() never raises. Unrecognized input returns None, and the
caller (orchestrator) falls through to a "Provider not implemented" result.
"""

from __future__ import annotations

import re

# alias (lowercase) -> canonical short key
_ALIAS_TO_CANONICAL: dict[str, str] = {
    # Tier 1 — public source
    "mikrotik": "MikroTik",
    "routeros": "MikroTik",
    "mt": "MikroTik",
    "ubiquiti": "Ubiquiti",
    "ubiquiti networks": "Ubiquiti",
    "ubnt": "Ubiquiti",
    "unifi": "Ubiquiti",
    "nvidia": "NVIDIA",
    "mellanox": "NVIDIA",
    "cumulus": "NVIDIA",
    "cumulus linux": "NVIDIA",
    "cumulus networks": "NVIDIA",
    "allied telesis": "Allied Telesis",
    "alliedtelesis": "Allied Telesis",
    "at": "Allied Telesis",
    "d-link": "D-Link",
    "dlink": "D-Link",
    "d link": "D-Link",
    "d-link corporation": "D-Link",
    "dlink corporation": "D-Link",
    "d-link international": "D-Link",
    "dlink international": "D-Link",
    "d-link systems": "D-Link",
    "netgear": "NETGEAR",
    "tp-link": "TP-Link",
    "tplink": "TP-Link",
    "tp link": "TP-Link",
    "omada": "TP-Link",
    "jetstream": "TP-Link",
    "teltonika": "Teltonika",
    "teltonika networks": "Teltonika",
    "planet": "PLANET",
    "planet technology": "PLANET",
    "edgecore": "Edgecore",
    "edgecore networks": "Edgecore",
    "edge-core": "Edgecore",
    "accton": "Edgecore",
    "moxa": "MOXA",
    "buffalo": "Buffalo",
    "buffalo inc": "Buffalo",
    # Tier 2 — enterprise
    "cisco": "Cisco",
    "catalyst": "Cisco",
    "nexus": "Cisco",
    "meraki": "Cisco",
    "juniper": "Juniper",
    "juniper networks": "Juniper",
    "jnpr": "Juniper",
    "qfx": "Juniper",
    "ex-series": "Juniper",
    "junos": "Juniper",
    "arista": "Arista",
    "arista networks": "Arista",
    "eos": "Arista",
    "aruba": "Aruba",
    "hpe aruba": "Aruba",
    "hpe aruba networking": "Aruba",
    "hp aruba": "Aruba",
    "arubaos": "Aruba",
    "arubaos-cx": "Aruba",
    "dell": "Dell",
    "dell technologies": "Dell",
    "dell emc": "Dell",
    "powerswitch": "Dell",
    "os10": "Dell",
    "fortinet": "Fortinet",
    "fortiswitch": "Fortinet",
    "fortios": "Fortinet",
    "huawei": "Huawei",
    "cloudengine": "Huawei",
    "h3c": "H3C",
    "nokia": "Nokia",
    "nokia networks": "Nokia",
    "ruckus": "RUCKUS",
    "ruckus networks": "RUCKUS",
    "ruckus wireless": "RUCKUS",
    # Brocade's ICX switch line: Broadcom (2017) -> ARRIS -> CommScope ->
    # Belden's Ruckus Networks (2026) -- confirmed live this session
    # ICX support/login now lives on the SAME support.ruckuswireless.com
    # portal RuckusProvider already targets, so this is a real alias to
    # the same current vendor, not a guess.
    "brocade": "RUCKUS",
    "icx": "RUCKUS",
    "brocade icx": "RUCKUS",
    "extreme": "Extreme",
    "extreme networks": "Extreme",
    "extremexos": "Extreme",
    "exos": "Extreme",
    "zyxel": "Zyxel",
    "zyxel networks": "Zyxel",
    "zyxel communications": "Zyxel",
    "adtran": "Adtran",
    "netvanta": "Adtran",
    "advantech": "Advantech",
    "alcatel-lucent enterprise": "Alcatel-Lucent Enterprise",
    "alcatel lucent enterprise": "Alcatel-Lucent Enterprise",
    "ale": "Alcatel-Lucent Enterprise",
    "alcatel-lucent": "Alcatel-Lucent Enterprise",
    "omniswitch": "Alcatel-Lucent Enterprise",
    "avaya": "Avaya",
    "draytek": "DrayTek",
    "vigorswitch": "DrayTek",
    "trendnet": "TRENDnet",
    "trend net": "TRENDnet",
    "ruijie": "Ruijie",
    "ruijie networks": "Ruijie",
    "lantronix": "Lantronix",
    "perle": "Perle",
    "perle systems": "Perle",
    "supermicro": "Supermicro",
    "super micro": "Supermicro",
    "oring": "ORing",
    "oring industrial networking": "ORing",
    "antaira": "Antaira",
    "antaira technologies": "Antaira",
    "linksys": "Linksys",
    "kyland": "Kyland",
    "kyland technology": "Kyland",
    "sicom": "Kyland",
    "totolink": "TOTOLINK",
    "c-data": "C-Data",
    "cdata": "C-Data",
    "c-data technology": "C-Data",
    "etherwan": "EtherWAN",
    "etherwan systems": "EtherWAN",
    "korenix": "Korenix",
    "korenix technology": "Korenix",
    "jetnet": "Korenix",
    "startech": "StarTech",
    "startech.com": "StarTech",
    "star tech": "StarTech",
    "westermo": "Westermo",
    "weos": "Westermo",
    "ip infusion": "IP Infusion",
    "ipinfusion": "IP Infusion",
    "ocnos": "IP Infusion",
    "microsens": "MICROSENS",
    "qnap": "QNAP",
    "red lion": "Red Lion",
    "red lion controls": "Red Lion",
    "sixnet": "Red Lion",
    "ciena": "Ciena",
    "phoenix contact": "Phoenix Contact",
    "phoenixcontact": "Phoenix Contact",
    "silicom": "Silicom",
    "hikvision": "Hikvision",
    "schneider electric": "Schneider Electric",
    "schneider": "Schneider Electric",
    "connexium": "Schneider Electric",
    "zte": "ZTE",
    "vertiv": "Vertiv",
    "fs": "FS.com",
    "fs.com": "FS.com",
    "fiberstore": "FS.com",
    "tejas networks": "Tejas Networks",
    "tejas": "Tejas Networks",
    "versa networks": "Versa Networks",
    "versa": "Versa Networks",
    "yamaha": "Yamaha",
    "swx": "Yamaha",
    "wago": "WAGO",
    "belden": "Belden",
    "hirschmann": "Belden",
    "beckhoff": "Beckhoff",
    "beckhoff automation": "Beckhoff",
    "edimax": "Edimax",
    "harting": "HARTING",
    "delta electronics": "Delta Electronics",
    "delta": "Delta Electronics",
    "lenovo": "Lenovo",
    "qct": "QCT",
    "quanta": "QCT",
    "quanta cloud technology": "QCT",
    "noviflow": "NoviFlow",
    "ufispace": "UfiSpace",
    "ufi space": "UfiSpace",
    "aerohive": "Aerohive",
    "aerohive networks": "Aerohive",
    "celestica": "Celestica",
    "signamax": "Signamax",
    "oring industrial": "ORing",
    "qnap systems": "QNAP",
    "schweitzer engineering laboratories": "Schweitzer Engineering Laboratories",
    "sel": "Schweitzer Engineering Laboratories",
    "schweitzer engineering labs": "Schweitzer Engineering Laboratories",
    "icp das": "ICP DAS",
    "icp electronics": "ICP DAS",
    "icpdas": "ICP DAS",
    "engenius": "EnGenius",
    "engenius technologies": "EnGenius",
    "cerio": "CERIO Corporation",
    "cerio corporation": "CERIO Corporation",
    "amg systems": "AMG Systems",
    "beijer electronics": "Beijer Electronics",
    "beijer": "Beijer Electronics",
    "omnitron systems": "Omnitron Systems",
    "omnitron systems technology": "Omnitron Systems",
    "araknis": "Araknis Networks",
    "araknis networks": "Araknis Networks",
    "nomadix": "Nomadix",
    "micas networks": "Micas Networks",
    "micas": "Micas Networks",
    "datto": "Datto",
    "oracle": "Oracle",
    "oracle corporation": "Oracle",
    "yokogawa": "Yokogawa",
    "billion electric": "Billion Electric",
    "billion": "Billion Electric",
    "airpro": "AirPro",
    "airpro technology": "AirPro",
    "alpha networks": "Alpha Networks",
    "avalan wireless systems": "AvaLan Wireless Systems",
    "avalan": "AvaLan Wireless Systems",
    "avalan wireless": "AvaLan Wireless Systems",
    "rs pro": "RS PRO",
    "scomp enterprises private limited": "Scomp Enterprises Private Limited",
    "scomp": "Scomp Enterprises Private Limited",
    "scomp enterprises": "Scomp Enterprises Private Limited",
    "rubytech": "Rubytech",
    "linkoh": "LINKOH",
    "wanglink": "Wanglink",
    "chilinkiot": "Chilinkiot",
    "chilink iot": "Chilinkiot",
    "xexagon": "Xexagon",
    "brainboxes": "Brainboxes",
    "intellisystem technologies": "Intellisystem Technologies",
    "intellisystem": "Intellisystem Technologies",
    "l-com": "L-com",
    "lcom": "L-com",
    "proscend communications": "Proscend Communications",
    "proscend": "Proscend Communications",
    "lantech communications": "Lantech Communications",
    "lantech": "Lantech Communications",
    "te connectivity": "TE Connectivity",
    "te": "TE Connectivity",
    "nvt phybridge": "NVT Phybridge",
    "nsgate": "NSGate",
    "alaxala networks": "Alaxala Networks",
    "alaxala": "Alaxala Networks",
    "asterfusion data technologies": "Asterfusion Data Technologies",
    "asterfusion": "Asterfusion Data Technologies",
    "beijing fibridge": "Beijing Fibridge",
    "fibridge": "Beijing Fibridge",
    "maple systems": "Maple Systems",
    "telco systems": "Telco Systems",
    "obsidian control systems": "Obsidian Control Systems",
    "obsidian controls": "Obsidian Control Systems",
    "obsidian": "Obsidian Control Systems",
}

_SUFFIX_RE = re.compile(
    r"\b(networks?|technolog(?:y|ies)|networking|systems?|corporation|"
    r"communications?|digital technology|electronics?|inc\.?|corp\.?|llc|"
    r"co\.?,?\s*ltd\.?|ltd\.?)\b"
)
_PAREN_RE = re.compile(r"\([^)]*\)")


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"[.,]+$", "", text).strip()


def normalize_vendor(raw: str | None) -> str | None:
    """Return the short canonical PROVIDERS key, or None if unrecognized.
    Never raises.
    """
    if not raw or not isinstance(raw, str):
        return None
    key = raw.strip().lower()
    if not key:
        return None
    if key in _ALIAS_TO_CANONICAL:
        return _ALIAS_TO_CANONICAL[key]

    # Parenthetical content, e.g. "Aruba (HPE)" or "NVIDIA (Mellanox)" --
    # try both the outer name with the parens removed and the inner
    # parenthetical text itself, since either can be the real alias.
    without_paren = _clean(_PAREN_RE.sub("", key))
    if without_paren and without_paren != key:
        hit = _ALIAS_TO_CANONICAL.get(without_paren)
        if hit:
            return hit
        stripped_wp = _clean(_SUFFIX_RE.sub("", without_paren))
        if stripped_wp:
            hit = _ALIAS_TO_CANONICAL.get(stripped_wp)
            if hit:
                return hit
    for inner in re.findall(r"\(([^)]*)\)", key):
        hit = _ALIAS_TO_CANONICAL.get(_clean(inner))
        if hit:
            return hit

    # Loose fallback: strip common corporate suffixes and retry once.
    stripped = _clean(_SUFFIX_RE.sub("", key))
    if stripped and stripped != key:
        return _ALIAS_TO_CANONICAL.get(stripped)
    return None
