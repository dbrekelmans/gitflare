#!/usr/bin/env bash
# WebSocket upgrade through Access, with controls that show the application is
# enforcing at that moment. Run it after pointing the application at a
# destination (hostname or Worker-level). Needs APP_URL, CF_ACCESS_CLIENT_ID,
# CF_ACCESS_CLIENT_SECRET.
set -uo pipefail
ws=(--http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: c3Bpa2Utc3Bpa2Utc3Bpaw==")
svc=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
redact() { sed -E "s#$(echo "$APP_URL" | sed -E 's#https://[^.]+\.([^.]+)\..*#\1#')#<subdomain>#g; s#[a-z0-9-]+\.cloudflareaccess\.com#<team>.cloudflareaccess.com#g; s/[0-9a-f]{64}/<aud>/g; s/(meta)=[^&]+/\1=…/g"; }
echo "=== $(date -u +%H:%M:%S)"
printf "control, no credentials, GET /api/whoami : "; curl -sS -o /dev/null -w '%{http_code}\n' "$APP_URL/api/whoami"
printf "control, no credentials, WS upgrade      : "; curl -sS -o /dev/null -D - --max-time 5 "${ws[@]}" "$APP_URL/ws/room1" 2>/dev/null | grep -E '^HTTP/1.1 [1345]|^[Ll]ocation' | tr -d '\r' | tr '\n' ' ' | redact; echo
printf "control, wrong secret, WS upgrade        : "; curl -sS -o /dev/null -D - --max-time 5 -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: wrong" "${ws[@]}" "$APP_URL/ws/room1" 2>/dev/null | grep -E '^HTTP/1.1 [1345]' | tr -d '\r'
echo "service token, WS upgrade:"; curl -sS -D - --max-time 4 "${svc[@]}" "${ws[@]}" "$APP_URL/ws/room1" 2>/dev/null | strings | grep -E '^HTTP/1.1 [1345]|^Upgrade|hello' | redact
