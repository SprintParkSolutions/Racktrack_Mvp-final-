"""
Manual-testing CLI:
    python -m firmware_lookup <vendor> "<model>" <current_version>
    python -m firmware_lookup lookup <vendor> "<model>" <current_version>
    python -m firmware_lookup login <vendor>          # e.g. Cisco, Juniper, Arista, ...
"""

from __future__ import annotations

import argparse
import json
import sys

from firmware_lookup.orchestrator import get_latest_firmware
from firmware_lookup.result import FirmwareResult

_KNOWN_SUBCOMMANDS = {"lookup", "login", "register"}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="firmware_lookup",
        description="Look up the latest official firmware version for a vendor/model.",
    )
    sub = p.add_subparsers(dest="command")

    lookup = sub.add_parser("lookup", help="Look up latest firmware for vendor/model")
    lookup.add_argument("vendor")
    lookup.add_argument("model")
    lookup.add_argument("current_version")
    lookup.add_argument("--json", action="store_true", help="print the result as JSON")
    lookup.add_argument("--verbose", action="store_true", help="include status/message fields")
    lookup.add_argument(
        "--hardware-version",
        default=None,
        help="hardware revision the device reports (e.g. F3); used by providers "
        "whose firmware is published per hardware revision, such as D-Link",
    )

    login = sub.add_parser(
        "login",
        aliases=["register"],
        help="Browser-assisted login for a login-gated vendor",
    )
    login.add_argument("vendor")

    return p


def format_text(result: FirmwareResult) -> str:
    lines = [
        f"Vendor:            {result.vendor}",
        f"Model:             {result.model}",
        f"Current Version:   {result.current_version}",
        f"Latest Version:    {result.latest_version or '(unknown)'}",
        f"Update Available:  {result.update_available if result.update_available is not None else 'Unknown'}",
        f"Source URL:        {result.source_url or '(none)'}",
        f"Confidence:        {result.confidence.value if result.confidence else '(n/a)'}",
        f"Retrieval Method:  {result.retrieval_method or '(n/a)'}",
        f"Last Checked:      {result.last_checked}",
    ]
    if result.message:
        lines.append(f"\n{result.message}")
    return "\n".join(lines)


def _run_login(vendor_raw: str) -> int:
    from firmware_lookup.normalize import normalize_vendor
    from firmware_lookup.orchestrator import PROVIDERS
    from firmware_lookup.providers.base import BrowserAuthenticatedProvider

    normalized = normalize_vendor(vendor_raw)
    provider = PROVIDERS.get(normalized) if normalized else None
    if not isinstance(provider, BrowserAuthenticatedProvider):
        implemented = sorted(
            name for name, p in PROVIDERS.items() if isinstance(p, BrowserAuthenticatedProvider)
        )
        print(
            f"Browser-assisted login is not implemented for "
            f"{vendor_raw!r} -> {normalized!r}. Implemented: "
            f"{', '.join(implemented)}.",
            file=sys.stderr,
        )
        return 1

    try:
        session = provider.session_manager.ensure_session_interactive()
    except RuntimeError as e:
        print(f"Login failed: {e}", file=sys.stderr)
        return 1
    if session:
        print(f"{normalized} session established and saved (encrypted).")
        print("Next time this session expires, your username/password will be")
        print("auto-filled from encrypted storage -- you'll only need to handle")
        print("MFA/SSO in the browser if your account prompts for it.")
        return 0
    print("Login was not completed.", file=sys.stderr)
    return 1


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Legacy shim: `firmware_lookup <vendor> <model> <version>` (no
    # subcommand) keeps working by implicitly inserting "lookup".
    if argv and argv[0] not in _KNOWN_SUBCOMMANDS and not argv[0].startswith("-"):
        argv = ["lookup"] + argv

    args = build_parser().parse_args(argv)

    if args.command in ("login", "register"):
        return _run_login(args.vendor)

    if args.command != "lookup":
        build_parser().print_help()
        return 1

    result = get_latest_firmware(
        args.vendor,
        args.model,
        args.current_version,
        hardware_version=args.hardware_version,
    )
    if args.json:
        d = result.to_full_dict() if args.verbose else result.to_dict()
        print(json.dumps(d, indent=2, default=str))
    else:
        print(format_text(result))
    return 0
