"""
Send a file via Outlook (Microsoft Graph /me/sendMail) using MSAL.

Usage:
    python -m pipeline.outlook_send --email user@example.com --file /path/to/report.pdf \
                                    [--subject "Device Report"] [--body "Message body"]

Stdout (one JSON line):
    {"ok": true,  "recipient": "...", "file_name": "..."}
    {"ok": false, "error": "..."}

Auth: MSAL with a shared SerializableTokenCache (the SAME Azure app + account as
Teams — pipeline/racktrack_teams_cache.json, holding racktrackteam@sprintpark.com).
Because that cache holds a refresh token, Outlook acquires a Mail.Send token
SILENTLY and self-refreshes forever — no per-hour re-login. If the shared cache is
ever missing an account, run once with --interactive to seed it via device flow.

That silent path is also why a stale cache surfaced as "sharing to Outlook
redirects to the sign-in page": the server never passes --interactive, so a
missing or expired refresh token failed the send outright with nowhere for the
user to complete a login. Reports now send as the RackTrack Team mailbox rather
than as whichever individual last signed in.

Note: this uses the inline /me/sendMail path (base64 attachment), which caps the
whole request at ~4 MB. Rack report PDFs are well under that.
"""

import argparse
import base64
import json
import os
import sys

import msal
import requests

# Must match teams_send.py — the cache below is shared, and a cache is only
# usable by the client id that created its entries.
CLIENT_ID = os.environ.get("RACKTRACK_MS_CLIENT_ID", "4f662230-bce9-44ab-86f3-655f918af878")
TENANT_ID = os.environ.get("RACKTRACK_MS_TENANT_ID", "ee8c7b70-7a3a-4155-b1f2-59ff718e1d5c")

SCOPES = ["Mail.Send"]
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
GRAPH_API_URL = "https://graph.microsoft.com/v1.0"

# Shared with Teams: same app + same signed-in account, so the refresh token
# already in this cache lets us mint a Mail.Send token with no re-login. Keep this
# path identical to teams_send.py's — they must read and write the same file.
TOKEN_CACHE_FILE = os.environ.get("RACKTRACK_MSAL_CACHE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "racktrack_teams_cache.json",
)


def _log(*a, **kw):
    print(*a, file=sys.stderr, flush=True, **kw)


def _emit(obj):
    print(json.dumps(obj), flush=True)


def get_access_token(interactive: bool) -> str:
    cache = msal.SerializableTokenCache()
    if os.path.exists(TOKEN_CACHE_FILE):
        with open(TOKEN_CACHE_FILE, encoding="utf-8") as f:
            cache.deserialize(f.read())

    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache)

    result = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])

    if not result:
        if not interactive:
            raise RuntimeError(
                "No valid Outlook token in the shared cache. Run "
                "`python -m pipeline.outlook_send --email X --file Y --interactive` "
                "once on a desktop to complete device-flow login."
            )
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"could not start device flow: {flow}")
        _log(flow["message"])
        result = app.acquire_token_by_device_flow(flow)

    if cache.has_state_changed:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            f.write(cache.serialize())

    if not result or "access_token" not in result:
        raise RuntimeError(f"login failed: {(result or {}).get('error_description', 'unknown')}")
    return result["access_token"]


def send_email(email: str, file_path: str, subject: str, body_text: str) -> dict:
    token = get_access_token(interactive=False)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    file_name = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        content_b64 = base64.b64encode(f.read()).decode("utf-8")

    _log(f"[~] sending {file_name} to {email}")

    body = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body_text},
            "toRecipients": [{"emailAddress": {"address": email}}],
            "attachments": [
                {
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": file_name,
                    "contentType": "application/octet-stream",
                    "contentBytes": content_b64,
                }
            ],
        }
    }

    resp = requests.post(f"{GRAPH_API_URL}/me/sendMail", headers=headers, json=body)
    if resp.status_code != 202:
        raise RuntimeError(f"sendMail failed ({resp.status_code}): {resp.text}")

    return {"recipient": email, "file_name": file_name}


DEFAULT_BODY = (
    "Hello,\n\n"
    "Please find the attached document for your reference.\n\n"
    "If you have any questions, feel free to reach out.\n\n"
    "Regards,\n"
    "racktrack.ai"
)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    p = argparse.ArgumentParser(description="Send a file via Outlook.")
    p.add_argument("--email", required=True, help="Recipient email")
    p.add_argument("--file", required=True, help="Path to file to attach")
    p.add_argument("--subject", default="Device Report - racktrack.ai")
    p.add_argument("--body", default=DEFAULT_BODY)
    p.add_argument(
        "--interactive",
        action="store_true",
        help="Allow device-flow login when cache is missing or expired (requires a TTY).",
    )
    args = p.parse_args()

    try:
        if not os.path.isfile(args.file):
            raise RuntimeError(f"file not found: {args.file}")

        if args.interactive:
            get_access_token(interactive=True)  # force fresh login + cache write

        info = send_email(args.email, args.file, args.subject, args.body)
        _emit({"ok": True, **info})
    except Exception as err:
        _emit({"ok": False, "error": str(err)})
        sys.exit(1)


if __name__ == "__main__":
    main()
