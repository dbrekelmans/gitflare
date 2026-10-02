#!/usr/bin/env bash
# Which model slugs does the gateway know, and what does it reject before
# billing? Without Unified Billing credits an accepted slug or body stops at
# 402 (code 2021); with credits each of those is a real 16-token call.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
M='"messages":[{"role":"user","content":"pong"}]'
show() { python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("response"); b=json.loads(r["body"]) if r else d; print(r["status"] if r else "?", b.get("internalCode"), (b.get("message") or json.dumps(b))[:160])'; }
raw() { printf "%-44s " "$1"; "$here/call.sh" run "{\"model\":\"$2\",\"body\":$3,\"options\":{\"returnRawResponse\":true}}" | show; }

echo "### slugs"
for m in anthropic/claude-haiku-4.5 anthropic/claude-sonnet-5 anthropic/claude-sonnet-5.5 anthropic/claude-opus-5.5 \
	anthropic/claude-fable-5.1 anthropic/claude-fable-5 anthropic/claude-opus-5 anthropic/claude-opus-4.8 \
	anthropic/claude-opus-4.7 anthropic/claude-opus-4.6 anthropic/claude-opus-4.5 anthropic/claude-sonnet-4.6 \
	anthropic/claude-sonnet-4.5 anthropic/claude-haiku-4-5 anthropic/claude-haiku-4-5-20251001 claude-haiku-4.5 \
	anthropic/claude-haiku-5 anthropic/claude-3-5-haiku anthropic/claude-does-not-exist; do
	raw "$m" "$m" "{\"max_tokens\":16,$M}"
done

echo "### body cases (anthropic/claude-haiku-4.5)"
H=anthropic/claude-haiku-4.5
raw "valid" $H "{\"max_tokens\":16,$M}"
raw "no max_tokens" $H "{$M}"
raw "messages not an array" $H '{"max_tokens":16,"messages":"x"}'
raw "unknown top-level field" $H "{\"max_tokens\":16,$M,\"bogus_field\":1}"
raw "system as number" $H "{\"max_tokens\":16,$M,\"system\":5}"
raw "stream: true" $H "{\"max_tokens\":16,$M,\"stream\":true}"

echo "### thrown form (no returnRawResponse)"
"$here/call.sh" run "{\"model\":\"$H\",\"body\":{\"max_tokens\":16,$M}}"; echo
"$here/call.sh" run "{\"model\":\"anthropic/claude-haiku-4-5\",\"body\":{\"max_tokens\":16,$M}}"; echo
