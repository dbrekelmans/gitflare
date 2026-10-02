#!/usr/bin/env bash
# What does Access do in front of the app Worker? Needs APP_URL,
# CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment.
set -uo pipefail
redact() { sed -E "s#$(echo "$APP_URL" | sed -E 's#https://[^.]+\.([^.]+)\..*#\1#')#<subdomain>#g; s#[a-z0-9-]+\.cloudflareaccess\.com#<team>.cloudflareaccess.com#g; s/[0-9a-f]{64}/<aud>/g; s/[0-9a-f]{32}/<hex32>/g; s/(CF_Authorization=|CF_AppSession=|meta=|nonce=|sig=)[^;& ]+/\1<redacted>/g; s/(cf-ray: ).*/\1<ray>/; s/\"ip_address\":\"[^\"]*\"/\"ip_address\":\"<ip>\"/; s/\"ray_id\":\"[^\"]*\"/\"ray_id\":\"<ray>\"/"; }
svc=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
ws=(--http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: c3Bpa2Utc3Bpa2Utc3Bpaw==")
jar="${TMPDIR:-/tmp}/spike-jar.$$"

echo "### 1. unauthenticated"
for p in / /api/whoami; do echo "--- GET $p"; curl -sS -o /dev/null -D - "$APP_URL$p" | grep -iE '^(HTTP|location|www-authenticate|content-type|set-cookie|cf-access)' | redact; done
echo "--- GET /api/whoami, Accept: application/json, body"; curl -sS -H "accept: application/json" "$APP_URL/api/whoami" | head -c 300 | redact; echo
echo "--- websocket upgrade"; curl -sS -o /dev/null -D - --max-time 5 "${ws[@]}" "$APP_URL/ws/room1" | grep -iE '^(HTTP|location|upgrade)' | redact

echo "### 2. wrong service token secret"
curl -sS -o /dev/null -D - -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: wrong" "$APP_URL/api/whoami" | grep -iE '^(HTTP|location)' | redact

echo "### 3. service token"
echo "--- GET /api/whoami"; curl -sS -c "$jar" -D "$jar.h" "${svc[@]}" "$APP_URL/api/whoami" | redact; echo
grep -iE '^(HTTP|set-cookie)' "$jar.h" | redact
echo "--- GET / (static asset)"; curl -sS -D - "${svc[@]}" "$APP_URL/" | grep -iE '^(HTTP|content-type)|static asset' | redact
echo "--- GET /some/spa/route (asset fallback)"; curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "${svc[@]}" "$APP_URL/some/spa/route"

echo "### 4. the cookie Access set, without the service token headers"
curl -sS -b "$jar" -w '\n%{http_code}' "$APP_URL/api/whoami" | python3 -c 'import sys,json
body,code=sys.stdin.read().rsplit("\n",1)
try: d=json.loads(body); print(code,{k:d.get(k) for k in ("jwtHeaderPresent","cfAuthorizationCookiePresent","ctxAccess","joseVerify")})
except ValueError: print(code,"(not from the Worker)")' 2>&1 | redact

echo "### 5. websocket upgrade to the Durable Object, service token"
curl -sS -D - --max-time 4 "${svc[@]}" "${ws[@]}" "$APP_URL/ws/room1" 2>/dev/null | strings | grep -iE '^(HTTP|upgrade|connection|sec-websocket-accept)|hello' | redact
echo "--- same, cookie only"
curl -sS -D - --max-time 4 -b "$jar" "${ws[@]}" "$APP_URL/ws/room1" 2>/dev/null | strings | grep -iE '^(HTTP|upgrade)|hello' | redact
echo "### 6. can a client supply its own Cf-Access-Jwt-Assertion?"
echo "--- bogus header, no credentials (does it reach the Worker?)"
curl -sS -o /dev/null -w '%{http_code}\n' -H "Cf-Access-Jwt-Assertion: bogus.bogus.bogus" "$APP_URL/api/whoami"
echo "--- bogus header alongside a valid service token (which token does the Worker see?)"
curl -sS "${svc[@]}" -H "Cf-Access-Jwt-Assertion: bogus.bogus.bogus" "$APP_URL/api/whoami" | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ("jwtHeaderPresent","joseVerify")})' 2>&1 | redact
echo "--- the JWT Access issued, replayed without the service token"
tok="$(awk '$6=="CF_Authorization"{print $7}' "$jar")"
for h in "cookie: CF_Authorization=$tok" "cf-access-token: $tok" "Cf-Access-Jwt-Assertion: $tok" "Authorization: Bearer $tok"; do printf "%-26s -> " "${h%%:*}"; curl -sS -o /dev/null -w '%{http_code}\n' -H "$h" "$APP_URL/api/whoami"; done

echo "### 7. unauthenticated, by request header"
for h in "accept: application/json" "sec-fetch-mode: cors" "sec-fetch-mode: navigate" "x-requested-with: XMLHttpRequest"; do printf "%-36s -> " "$h"; curl -sS -o /dev/null -w '%{http_code}\n' -H "$h" "$APP_URL/api/whoami"; done
echo "--- response to X-Requested-With: XMLHttpRequest"
curl -sS -D - -H "x-requested-with: XMLHttpRequest" "$APP_URL/api/whoami" | grep -iE '^(HTTP/2|www-authenticate|content-type|access-control)|<title>' | redact
echo "--- discovery documents"
curl -sS -w ' [%{http_code}]\n' "$APP_URL/.well-known/cloudflare-access-protected-resource/" | head -c 900 | redact
rm -f "$jar" "$jar.h"
