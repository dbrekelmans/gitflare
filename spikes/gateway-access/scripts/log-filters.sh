#!/usr/bin/env bash
# Filter the gateway's logs by metadata. Needs CF_API (…/client/v4/accounts/<account-id>)
# and CLOUDFLARE_API_TOKEN with AI Gateway Read. Run metadata.sh and the two
# run-and-log calls from the README first so there is something to find.
# (The live run made these same requests through the Cloudflare MCP tool; this
# curl form was not executed.)
set -euo pipefail
q() {
	printf "%-52s " "$1"
	curl -sS -G "$CF_API/ai-gateway/gateways/gitflare-spike-g-gw/logs" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
		--data-urlencode "per_page=50" --data-urlencode "$2" |
		python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("result") or []; print(len(r), "rows", [l.get("metadata") for l in r[:2]], d.get("errors") or "")'
}
q "metadata.value eq u-alice" 'filters=[{"key":"metadata.value","operator":"eq","value":["u-alice"]}]'
q "metadata.key eq change" 'filters=[{"key":"metadata.key","operator":"eq","value":["change"]}]'
q "key=user AND value=u-bob" 'filters=[{"key":"metadata.key","operator":"eq","value":["user"]},{"key":"metadata.value","operator":"eq","value":["u-bob"]}]'
q "key=agent AND value=u-bob (not a real pair)" 'filters=[{"key":"metadata.key","operator":"eq","value":["agent"]},{"key":"metadata.value","operator":"eq","value":["u-bob"]}]'
q "key=session AND value=u-bob (no session key)" 'filters=[{"key":"metadata.key","operator":"eq","value":["session"]},{"key":"metadata.value","operator":"eq","value":["u-bob"]}]'
q "metadata.user eq u-bob (invalid key)" 'filters=[{"key":"metadata.user","operator":"eq","value":["u-bob"]}]'
# u-in1 is the user of a spend-window.sh run (one call above $0.001).
q "value=u-in1 AND cost gt 0.001" 'filters=[{"key":"metadata.value","operator":"eq","value":["u-in1"]},{"key":"cost","operator":"gt","value":[0.001]}]'
q "search=c-102" 'search=c-102'
