#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Share the local RackTrack dev server with teammates via a public Cloudflare
# tunnel. They get a https://<random>.trycloudflare.com URL that works from any
# network (office, phone, home) — no VPN, no cert warning.
#
# Prereqs: `npm run dev` must be running first (Vite on :5173 + API on :3001).
# Stop the tunnel with Ctrl-C. Keep this Mac awake + the server running while
# teammates are using the link.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

if [ ! -x ./cloudflared ]; then
  echo "❌ ./cloudflared not found. It should be in the project root."
  exit 1
fi

if ! curl -sk -o /dev/null --max-time 5 https://127.0.0.1:5173/ ; then
  echo "❌ Dev server isn't up on https://localhost:5173."
  echo "   Start it first:  npm run dev"
  exit 1
fi

echo "✅ Dev server is up. Opening a public tunnel…"
echo "   → Copy the https://<...>.trycloudflare.com URL below and send it to your team."
echo "   → Press Ctrl-C to stop sharing."
echo
# --protocol http2 forces the tunnel over TCP:443 instead of QUIC/UDP. Some
# networks (and many VPNs) drop QUIC, which makes the tunnel register but serve
# nothing (site "can't be reached" / 000). http2 behaves like normal HTTPS and
# passes everywhere. --url 127.0.0.1 (not localhost) avoids cloudflared dialing
# IPv6 [::1] when Vite only listens on IPv4.
exec ./cloudflared tunnel --protocol http2 --url https://127.0.0.1:5173 --no-tls-verify
