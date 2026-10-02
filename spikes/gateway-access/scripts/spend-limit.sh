#!/usr/bin/env bash
# Exceed a per-user spend rule and time it. Usage: spend-limit.sh <user> <calls> [sleep-seconds]
# Prints one line per call: wall-clock time, HTTP status the binding saw, cost or error message.
# skipCache defaults to true: without it every call after the first is a cache
# hit that costs 0 and never reaches the rule (SKIP_CACHE=false reproduces that).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
user="$1"; calls="$2"; pause="${3:-0}"
for i in $(seq 1 "$calls"); do
	printf "%s #%02d %s " "$(date -u +%H:%M:%S)" "$i" "$user"
	"$here/call.sh" run "{\"model\":\"@cf/meta/llama-3.2-3b-instruct\",\"body\":{\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]},\"gateway\":{\"skipCache\":${SKIP_CACHE:-true},\"metadata\":{\"user\":\"$user\"}},\"options\":{\"returnRawResponse\":true}}" |
		python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("response"); print(r["status"], r["body"][:260].replace("\n"," ")) if r else print(json.dumps(d)[:300])'
	sleep "$pause"
done
