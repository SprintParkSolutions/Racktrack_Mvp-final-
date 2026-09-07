"""
Switch Spec Agent - answers spec questions about network switches.

Works in two modes:
- Free mode (no LLM): rule-based query parsing + SQL/fuzzy lookup. Always available.
- Enhanced mode (optional hosted LLM API): better natural language understanding.

Designed for sub-second responses on a local SQLite DB.
"""

import json
import logging
import re
import sqlite3
from difflib import SequenceMatcher
from pathlib import Path

logger = logging.getLogger("agent")

DB_PATH = Path(__file__).parent / "data" / "switches.db"

# Known vendor aliases - extends what the user can type
VENDOR_ALIASES = {
    "cisco": "Cisco",
    "arista": "Arista",
    "juniper": "Juniper",
    "jnpr": "Juniper",
    "hpe": "HPE Aruba",
    "aruba": "HPE Aruba",
    "hp": "HPE Aruba",
    "dell": "Dell",
    "dell emc": "Dell",
    "nvidia": "NVIDIA",
    "mellanox": "NVIDIA",
    "connectx": "NVIDIA",
    "bluefield": "NVIDIA",
    "quantum": "NVIDIA",
    "ubnt": "Ubiquiti",
    "ubiquiti": "Ubiquiti",
    "unifi": "Ubiquiti",
    "mikrotik": "MikroTik",
    "mt": "MikroTik",
    "tp-link": "TP-Link",
    "tplink": "TP-Link",
    "tp link": "TP-Link",
    "omada": "TP-Link",
    "netgear": "Netgear",
    "trendnet": "TRENDnet",
    "teg-": "TRENDnet",
    "tpe-": "TRENDnet",
}

# Merge in every alias from the canonical vendor registry (vendors.json).
# Hardcoded entries above win on conflict so existing behaviour is preserved.
try:
    from vendor_registry import aliases as _vr_aliases

    for _a, _name in _vr_aliases().items():
        VENDOR_ALIASES.setdefault(_a, _name)
except Exception:  # pragma: no cover
    pass

# Spec field labels for pretty output
LABELS = {
    "vendor": "Vendor",
    "family": "Family",
    "model": "Model",
    "sku": "SKU",
    "port_count": "Ports",
    "port_config": "Port config",
    "uplink_config": "Uplinks",
    "port_speed_max_gbps": "Max port speed (Gbps)",
    "switching_capacity_gbps": "Switching capacity (Gbps)",
    "forwarding_rate_mpps": "Forwarding rate (Mpps)",
    "buffer_mb": "Buffer (MB)",
    "latency_ns": "Latency (ns)",
    "mac_table_size": "MAC table",
    "poe_standard": "PoE",
    "poe_budget_w": "PoE budget (W)",
    "power_typical_w": "Power typical (W)",
    "power_max_w": "Power max (W)",
    "layer": "Layer",
    "features": "Features",
    "rack_units": "Rack units",
    "nos": "Network OS",
    "status": "Status",
    "use_case": "Typical use",
    "datasheet_url": "Datasheet",
    "image_url": "Image",
}


def _norm(s) -> str:
    """Lowercase, keep only alphanumerics — for robust token matching."""
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def hay_core(hay: str, nt: str) -> bool:
    """True if the digit-anchored core of token `nt` appears in `hay`.

    Lets 'c9300' match '9300' and vice-versa, while still rejecting
    unrelated models. Both args are already _norm()'d.
    """
    m = re.search(r"\d.*", nt)
    core = m.group(0) if m else nt
    return len(core) >= 3 and (core in hay or hay in core)


class SpecAgent:
    def __init__(self, db_path: Path = DB_PATH, live: bool = True, enable_live: bool | None = None):
        # live=True: on a DB miss, fall back to a free multi-engine web
        # lookup (+ multi-source extraction, ~4-9 s, then cached).
        # Set live=False for fully-offline / deterministic behaviour.
        # `enable_live` is a backward-compatible alias for `live`.
        if enable_live is not None:
            live = enable_live
        self.live = live
        if not db_path.exists():
            if db_path == DB_PATH:
                # Default DB missing: auto-build from seed so `streamlit
                # run app.py` / `cli.py` work with no manual build step.
                try:
                    import build_db

                    build_db.build()
                except Exception as e:
                    raise FileNotFoundError(
                        f"DB not found at {db_path} and auto-build failed "
                        f"({e}). Run `python3 build_db.py` first."
                    ) from e
            else:
                # Explicit custom path that doesn't exist -> clear error.
                raise FileNotFoundError(
                    f"DB not found at {db_path}. Run `python3 build_db.py` "
                    f"first, or pass a valid db_path."
                )
        # check_same_thread=False: Streamlit caches this agent via
        # @st.cache_resource and reruns the script on different threads
        # when widgets change (Filter/Browse). The agent is read-only,
        # so sharing the connection across threads is safe here.
        self.con = sqlite3.connect(db_path, check_same_thread=False)
        self.con.row_factory = sqlite3.Row

    # ---------- Query parsing ----------

    def _extract_vendor(self, q: str) -> str | None:
        q_low = q.lower()
        # Longest alias wins (so "tp-link" beats "tp")
        for alias in sorted(VENDOR_ALIASES, key=len, reverse=True):
            if alias in q_low:
                return VENDOR_ALIASES[alias]
        return None

    def _extract_model_candidates(self, q: str) -> list[str]:
        """Pull out tokens that look like model/SKU identifiers."""
        # Match alphanumeric tokens with at least one digit and length >= 3
        tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-\+\._/]{2,}", q)
        return [t for t in tokens if any(c.isdigit() for c in t)]

    # ---------- Lookup ----------

    def lookup(self, query: str, limit: int = 5) -> list[dict]:
        """
        Find switches matching the query.
        Strategy: exact SKU match -> exact model -> fuzzy on model+SKU+family.
        """
        vendor = self._extract_vendor(query)
        candidates = self._extract_model_candidates(query)

        # 1) Exact SKU or model match
        for tok in candidates:
            rows = self._exact(tok, vendor)
            if rows:
                return [self._row_to_dict(r) for r in rows[:limit]]

        # 2) Substring match (case-insensitive)
        for tok in candidates:
            rows = self._substring(tok, vendor)
            if rows:
                return [self._row_to_dict(r) for r in rows[:limit]]

        # 3) Fuzzy ranked match across all rows
        rows = self._fuzzy(query, vendor)
        return [self._row_to_dict(r) for r in rows[:limit]]

    def _exact(self, token: str, vendor: str | None):
        sql = """SELECT * FROM switches
                 WHERE (UPPER(sku)=UPPER(?) OR UPPER(model)=UPPER(?))"""
        args = [token, token]
        if vendor:
            sql += " AND vendor=?"
            args.append(vendor)
        return self.con.execute(sql, args).fetchall()

    def _substring(self, token: str, vendor: str | None):
        like = f"%{token}%"
        sql = """SELECT * FROM switches
                 WHERE (sku LIKE ? OR model LIKE ? OR family LIKE ?)"""
        args = [like, like, like]
        if vendor:
            sql += " AND vendor=?"
            args.append(vendor)
        return self.con.execute(sql, args).fetchall()

    def _fuzzy(self, query: str, vendor: str | None, top: int = 5):
        sql = "SELECT * FROM switches"
        args: list = []
        if vendor:
            sql += " WHERE vendor=?"
            args.append(vendor)
        rows = self.con.execute(sql, args).fetchall()
        q = query.lower()

        def score(row):
            haystack = " ".join(
                str(row[k] or "") for k in ("vendor", "family", "model", "sku")
            ).lower()
            return SequenceMatcher(None, q, haystack).ratio()

        ranked = sorted(rows, key=score, reverse=True)
        return ranked[:top]

    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        if d.get("features"):
            try:
                d["features"] = json.loads(d["features"])
            except json.JSONDecodeError:
                pass
        if d.get("extra_specs"):
            try:
                d["extra_specs"] = json.loads(d["extra_specs"])
            except (json.JSONDecodeError, TypeError):
                d["extra_specs"] = {}
        return d

    # ---------- High-level operations ----------

    def list_vendors(self) -> list[tuple[str, int]]:
        return [
            (r[0], r[1])
            for r in self.con.execute(
                "SELECT vendor, COUNT(*) FROM switches GROUP BY vendor ORDER BY vendor"
            ).fetchall()
        ]

    def list_models(self, vendor: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT * FROM switches WHERE vendor=? ORDER BY family, model", (vendor,)
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def filter(
        self,
        *,
        vendor: str | None = None,
        min_port_speed: int | None = None,
        min_ports: int | None = None,
        poe: bool | None = None,
        min_poe_w: int | None = None,
        layer: str | None = None,
        use_case: str | None = None,
        feature: str | None = None,
    ) -> list[dict]:
        clauses, args = [], []
        if vendor:
            clauses.append("vendor=?")
            args.append(vendor)
        if min_port_speed is not None:
            clauses.append("port_speed_max_gbps >= ?")
            args.append(min_port_speed)
        if min_ports is not None:
            clauses.append("port_count >= ?")
            args.append(min_ports)
        if poe is True:
            clauses.append("poe_standard IS NOT NULL AND poe_standard != 'None'")
        if poe is False:
            clauses.append("(poe_standard IS NULL OR poe_standard='None')")
        if min_poe_w is not None:
            clauses.append("poe_budget_w >= ?")
            args.append(min_poe_w)
        if layer:
            clauses.append("layer=?")
            args.append(layer)
        if use_case:
            clauses.append("use_case=?")
            args.append(use_case)
        if feature:
            clauses.append("features LIKE ?")
            args.append(f"%{feature}%")

        sql = "SELECT * FROM switches"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY vendor, model"
        rows = self.con.execute(sql, args).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def compare(self, query_a: str, query_b: str) -> dict:
        a = self.lookup(query_a, limit=1)
        b = self.lookup(query_b, limit=1)
        return {
            "a": a[0] if a else None,
            "b": b[0] if b else None,
        }

    # ---------- Natural-language router ----------

    def _token_in_record(self, rec: dict, tokens: list[str]) -> bool:
        """True if any model-token actually overlaps this record's id fields."""
        hay = _norm(f"{rec.get('model', '')} {rec.get('sku', '')} {rec.get('family', '')}")
        for t in tokens:
            nt = _norm(t)
            if nt and (nt in hay or hay_core(hay, nt)):
                return True
        return False

    def answer(self, query: str) -> dict:
        """Parse intent from free text and dispatch. Returns a typed dict.

        Types: spec | compare | filter | vendors | notfound | empty
        The notfound case is the honest one: when the user names a specific
        model that isn't in the KB, we say so and flag the web-fallback hook
        rather than returning a misleading fuzzy match.
        """
        query = (query or "").strip()
        if not query:
            return {
                "type": "empty",
                "message": "Ask about a switch, e.g. 'Cisco C9300-48P', "
                "'compare C9300-48P vs EX4400-48P', "
                "'which switches support 400G'.",
            }

        ql = query.lower()
        if ql in ("vendors", "list vendors", "what vendors", "which vendors"):
            return {
                "type": "vendors",
                "message": "Vendors in the knowledge base:",
                "vendors": self.list_vendors(),
            }

        # Comparison: "A vs B", "compare A and B", "A versus B"
        if " vs " in ql or " versus " in ql or ql.startswith("compare "):
            body = re.sub(r"^\s*compare\s+", "", ql, count=1)
            parts = [p.strip() for p in re.split(r"\bvs\b|\bversus\b|\band\b|,", body) if p.strip()]
            if len(parts) >= 2:
                picked = []
                for p in parts[:4]:
                    res = self._gated_lookup(p)
                    if res.get("type") == "spec":
                        picked.append(res["result"])
                if len(picked) >= 2:
                    return {
                        "type": "compare",
                        "message": "Side-by-side comparison:",
                        "results": picked,
                    }

        # Spec filters ("which/with/all ... 400G / PoE over 600W / spine / EVPN")
        filt = self._parse_filter(query)
        if filt:
            results = self.filter(**filt[1])
            return {"type": "filter", "message": filt[0], "results": results}

        # Otherwise: single-model spec lookup, gated.
        return self._gated_lookup(query)

    def _parse_filter(self, query: str):
        q = query.lower()
        listy = any(
            w in q
            for w in ("which", "with ", "have ", "support", "list ", "show ", "all ", "that do")
        )

        m = re.search(r"(\d{2,4})\s*g\b", q)
        if listy and m:
            spd = int(m.group(1))
            return (f"Switches with port speed >= {spd}G", {"min_port_speed": spd})

        poe = re.search(r"poe[^0-9]{0,12}(\d{2,4})\s*w", q) or re.search(
            r"(\d{2,4})\s*w[^0-9]{0,12}poe", q
        )
        if "poe" in q and poe:
            w = int(poe.group(1))
            return (f"Switches with PoE budget >= {w} W", {"min_poe_w": w})

        # Role keywords trigger on "which/list ..." OR a bare
        # "<role> switch(es)" OR just the role word on its own.
        role_ctx = listy or "switch" in q
        for kw, uc in (
            ("spine", "spine"),
            ("leaf", "leaf"),
            ("aggregation", "aggregation"),
            ("core", "core"),
            ("tor", "ToR"),
            ("top of rack", "ToR"),
            ("access", "access"),
            ("campus", "access"),
        ):
            if re.search(rf"\b{re.escape(kw)}\b", q) and (role_ctx or q.strip() in (kw, kw + "s")):
                return (f"Switches for role: {uc}", {"use_case": uc})

        if listy and ("evpn" in q or "vxlan" in q):
            return ("Switches with EVPN-VXLAN", {"feature": "VXLAN"})
        if listy and "macsec" in q:
            return ("Switches with MACsec", {"feature": "MACsec"})
        if listy and re.search(r"\bl3\b|layer 3|layer3", q):
            return ("Layer-3 switches", {"layer": "L3"})
        return None

    def _gated_lookup(self, query: str) -> dict:
        """lookup(), but refuse to return a junk fuzzy match for a model
        the user named explicitly that isn't actually in the KB.
        """
        vendor = self._extract_vendor(query)
        tokens = self._extract_model_candidates(query)
        results = self.lookup(query, limit=5)

        if not results:
            return self._notfound(query, vendor)

        # If the user typed specific model/SKU tokens, at least one result
        # must really contain one of them. Pure fuzzy noise -> not found.
        if tokens and not any(self._token_in_record(r, tokens) for r in results):
            return self._notfound(query, vendor)

        ranked = results
        if tokens:
            ranked = sorted(
                results,
                key=lambda r: self._token_in_record(r, tokens),
                reverse=True,
            )
        top = ranked[0]
        # Auto-enrich thin cached rows: if the local hit has almost no
        # data, kick off a live web fetch and merge in whatever new
        # fields it finds (never overwriting existing values). Caches
        # the enriched row so the next query is instant + complete.
        if self.live and self._is_sparse(top):
            enriched = self._enrich_from_web(query, top)
            if enriched:
                top = enriched

        conf = (
            "high"
            if (tokens and self._token_in_record(top, tokens))
            else "medium"
            if not tokens
            else "low"
        )
        alts = [{"vendor": r["vendor"], "model": r["model"]} for r in ranked[1:4]]
        return {
            "type": "spec",
            "message": f"Best match ({conf} confidence):",
            "result": top,
            "confidence": conf,
            "alternates": alts,
        }

    # ---- Auto-enrichment of sparse cached rows ----

    _USEFUL_FIELDS = (
        "port_count",
        "port_config",
        "port_speed_max_gbps",
        "switching_capacity_gbps",
        "forwarding_rate_mpps",
        "buffer_mb",
        "layer",
        "poe_standard",
        "poe_budget_w",
        "rack_units",
        "nos",
        "use_case",
    )

    def _is_sparse(self, rec: dict) -> bool:
        """A row is 'sparse' if it has <2 useful fields and <3 features
        and no extra_specs — i.e. the UI would show almost nothing.
        """
        useful = sum(1 for k in self._USEFUL_FIELDS if rec.get(k) not in (None, "", 0))
        feats = len(rec.get("features") or [])
        extras = (
            len(rec.get("extra_specs") or {}) if isinstance(rec.get("extra_specs"), dict) else 0
        )
        return useful < 2 and feats < 3 and extras == 0

    def _enrich_from_web(self, query: str, top: dict) -> dict | None:
        """Run a live lookup and fill in any field that's empty in the
        local row. Never overwrites existing values. Persists the result.
        """
        try:
            from dataclasses import asdict

            from live_extract import live_lookup

            rec = live_lookup(query, deadline_sec=8.0, persist=False)
        except Exception as e:
            logger.warning("auto-enrich live lookup failed: %s", e)
            return None
        if rec is None:
            return None

        live = {k: v for k, v in asdict(rec).items() if v not in (None, "", [], {})}
        merged = dict(top)
        added = 0
        for k, v in live.items():
            if k in ("vendor", "model"):
                continue  # never rename the cached identity
            if merged.get(k) in (None, "", [], 0) or (k == "extra_specs" and not merged.get(k)):
                merged[k] = v
                added += 1
        if added == 0:
            return None
        # Persist the merged row back, then re-read so the UI sees the
        # exact same value the DB now holds.
        try:
            self._persist_enriched(merged)
        except Exception as e:
            logger.warning("auto-enrich persist failed: %s", e)
        logger.info(
            "Auto-enriched %s/%s — added %d fields",
            merged.get("vendor"),
            merged.get("model"),
            added,
        )
        return merged

    def _persist_enriched(self, merged: dict) -> None:
        """Write the enriched row back to the switches table."""
        cols = [r[1] for r in self.con.execute("PRAGMA table_info(switches)")]
        d = {}
        for c in cols:
            if c in ("id", "last_updated"):
                continue
            if c not in merged:
                continue
            v = merged[c]
            if c in ("features",) and isinstance(v, list):
                v = json.dumps(v) if v else None
            elif c == "extra_specs" and isinstance(v, dict):
                v = json.dumps(v) if v else None
            d[c] = v
        if not d:
            return
        # UPDATE existing row keyed on (vendor, model).
        sets = ",".join(f"{k}=?" for k in d if k not in ("vendor", "model"))
        vals = [v for k, v in d.items() if k not in ("vendor", "model")]
        # Column names come from our own row dict; values are bound.
        self.con.execute(
            f"UPDATE switches SET {sets} WHERE vendor=? AND model=?",  # noqa: S608
            vals + [d.get("vendor"), d.get("model")],
        )
        self.con.commit()

    def _notfound(self, query: str, vendor: str | None) -> dict:
        # Live web fallback: not in the local DB -> search the web for
        # free, extract specs, cache into the DB, and return. This is
        # what makes the agent answer for ANY vendor/model, not just
        # the ~54 seeded ones.
        if self.live:
            live = self._live_lookup(query)
            if live is not None:
                return live

        if vendor:
            sugg = [m["model"] for m in self.list_models(vendor)][:10]
        else:
            sugg = [
                r["model"]
                for r in self.con.execute("SELECT model FROM switches ORDER BY vendor LIMIT 10")
            ]
        why = (
            "the live web lookup found nothing usable in time"
            if self.live
            else "live lookup is disabled"
        )
        return {
            "type": "notfound",
            "message": f"'{query}' is not in the local database and "
            f"{why}. Try a more specific model number, or add "
            "it to seed_data.json / run the scrapers.",
            "suggestions": sugg,
        }

    def _live_lookup(self, query: str) -> dict | None:
        """Free web fallback. Returns a spec-shaped dict or None."""
        try:
            from dataclasses import asdict

            from live_extract import live_lookup

            rec = live_lookup(query, deadline_sec=8.5, persist=True)
        except Exception as e:
            logger.warning("live lookup failed: %s", e)
            return None
        if rec is None:
            return None
        # Refresh the fuzzy index so the freshly-cached model is found
        # instantly next time.
        try:
            self.con.commit()
        except Exception:
            pass
        result = {k: v for k, v in asdict(rec).items()}
        field_conf = getattr(rec, "confidence", {}) or {}
        return {
            "type": "spec",
            "message": "Not in the local DB — fetched live from the web "
            "(now cached for instant future lookups):",
            "result": result,
            "confidence": "live-web",
            "source": "live",
            "field_confidence": field_conf,
            "alternates": [],
        }

    @staticmethod
    def format_compare(records: list[dict]) -> str:
        keys = [k for k in LABELS if k != "datasheet_url"]
        headers = [r["model"] for r in records]
        wl = max(28, max((len(LABELS[k]) for k in keys), default=28))
        wc = max(20, max((len(h) for h in headers), default=20)) + 2
        out = [" " * wl + "".join(h.ljust(wc) for h in headers)]
        for k in keys:
            row = LABELS[k].ljust(wl)
            for r in records:
                v = r.get(k)
                if v is None or v == "":
                    v = "—"
                elif isinstance(v, list):
                    v = ", ".join(map(str, v))
                row += str(v).ljust(wc)
            out.append(row)
        return "\n".join(out)

    # ---------- Firmware advisor ----------

    def firmware_advise(self, query: str, current_version: str):
        """Look up the switch (or just vendor) to determine vendor + NOS,
        then return a FirmwareAdvice (see firmware.py). Always returns an
        object.

        The user may type:
          • a specific model ("Cisco Catalyst 9300-48P") — full spec lookup
          • a vendor alone ("Aruba", "Cisco", "Juniper") — vendor-level
            advisory lookup, useful when they just have firmware version +
            vendor name and want CVE data
        """
        from firmware import FirmwareAdvice
        from firmware import advise as _advise

        # First try a full model lookup (gives us NOS from spec data).
        # CRITICAL: only trust the lookup if the model tokens in the query
        # actually appear in the matched row — otherwise the fuzzy fallback
        # cross-attributes (e.g. 'CX 6300M-48G' fuzzy-matches Cisco '9300'
        # and we'd return Cisco's firmware for an Aruba switch). Demand a
        # token overlap before honouring the vendor.
        spec = self.lookup(query, limit=1)
        if spec:
            s = spec[0]
            tokens = self._extract_model_candidates(query)
            if not tokens or self._token_in_record(s, tokens):
                return _advise(
                    vendor=s.get("vendor", ""),
                    nos=s.get("nos"),
                    current_version=current_version,
                    model=s.get("model"),
                    live=self.live,
                )

        # No model match — fall back to vendor-only resolution. This is
        # what makes "Aruba" + "10.08.1000" work even without a specific
        # switch model in our DB.
        vendor = self._extract_vendor(query)
        if vendor:
            return _advise(
                vendor=vendor,
                nos=None,
                current_version=current_version,
                live=self.live,
            )

        return FirmwareAdvice(
            vendor="Unknown",
            nos=None,
            current_version=current_version,
            has_data=False,
            message=(
                f"Could not identify vendor or model from {query!r}. Try a "
                "specific model name (e.g. 'Cisco Catalyst 9300-48P') or a "
                "vendor name (e.g. 'Aruba', 'Cisco', 'Juniper')."
            ),
        )

    def latest_firmware(self, query: str) -> dict:
        """Resolve vendor + NOS for a switch query and return the latest
        known firmware (no current-version diff). Used when the user only
        types a model — show them what the latest release is.
        """
        from firmware import (
            LOGIN_GATED_VENDORS,
            PUBLIC_FIRMWARE_VENDORS,
        )
        from firmware import (
            latest_firmware as _latest,
        )

        # Resolve vendor (prefer DB row, fall back to alias parsing).
        vendor, nos = None, None
        spec = self.lookup(query, limit=1)
        if spec:
            vendor = spec[0].get("vendor")
            nos = spec[0].get("nos")
        if not vendor:
            vendor = self._extract_vendor(query)
        if not vendor:
            return {
                "status": "no-vendor",
                "message": (
                    f"Could not identify vendor from {query!r}. "
                    "Include the vendor name, e.g. 'Cisco "
                    "Catalyst 9300-48P'."
                ),
            }

        canonical = PUBLIC_FIRMWARE_VENDORS.get(vendor)
        if canonical:
            nos = canonical

        if not nos:
            portal = LOGIN_GATED_VENDORS.get(vendor)
            if portal:
                return {
                    "status": "login-gated",
                    "vendor": vendor,
                    "portal_url": portal,
                    "message": (
                        f"Latest {vendor} firmware is published behind the vendor's login portal."
                    ),
                }
            return {
                "status": "no-source",
                "vendor": vendor,
                "message": f"No firmware data available for {vendor}.",
            }

        rec = _latest(vendor, nos)
        if not rec:
            return {
                "status": "no-data",
                "vendor": vendor,
                "nos": nos,
                "message": (
                    f"No firmware records cached for {vendor} "
                    f"{nos} yet. Run "
                    f"`python3 fetch_firmware.py "
                    f"{vendor.lower()}` to populate."
                ),
            }

        return {
            "status": "ok",
            "vendor": vendor,
            "nos": nos,
            "version": rec.version,
            "release_date": rec.release_date,
            "train": rec.train,
            "is_recommended": rec.is_recommended,
            "release_notes_url": rec.release_notes_url,
        }

    # ---------- Formatting ----------

    @staticmethod
    def format_spec(spec: dict) -> str:
        """Pretty-print a single switch spec as plain text."""
        if not spec:
            return "No matching switch found."
        lines = []
        title = f"{spec.get('vendor', '')} {spec.get('model', '')}".strip()
        lines.append(title)
        lines.append("=" * len(title))
        for key, label in LABELS.items():
            val = spec.get(key)
            if val is None or val == "":
                continue
            if isinstance(val, list):
                val = ", ".join(val)
            lines.append(f"  {label:30s} {val}")
        return "\n".join(lines)
