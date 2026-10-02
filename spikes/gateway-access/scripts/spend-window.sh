#!/usr/bin/env bash
# How long does a breached spend rule take to bite and to clear?
# Usage: spend-window.sh <user> <poll-seconds> <polls>
# Makes one streamed ~$0.003 call (70b model, ~1300 output tokens) for <user>,
# then polls with a tiny uncached call and prints the status of each.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
user="$1"; every="$2"; polls="$3"
# START_AT_SEC=NN waits for that second of the minute before the big call, to
# place it inside one clock minute or across a minute boundary.
if [ -n "${START_AT_SEC:-}" ]; then while [ "$(date -u +%S)" != "$START_AT_SEC" ]; do sleep 0.3; done; fi
echo "$(date -u +%H:%M:%S) big call starts"
"$here/call.sh" run-and-log "{\"model\":\"@cf/meta/llama-3.3-70b-instruct-fp8-fast\",\"body\":{\"stream\":true,\"max_tokens\":1500,\"messages\":[{\"role\":\"user\",\"content\":\"Write a 1000 word essay about merge conflicts. Seed: $user\"}]},\"gateway\":{\"skipCache\":true,\"metadata\":{\"user\":\"$user\"}},\"waitMs\":10000}" |
	python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("stream") or {}; print("  stream chunks", s.get("chunks"), "bytes", s.get("bytes"), "totalMs", s.get("totalMs"), "| attempts", d.get("attempts"), "| error", d.get("error"))'
echo "$(date -u +%H:%M:%S) big call done"
for i in $(seq 1 "$polls"); do
	printf "%s " "$(date -u +%H:%M:%S)"
	"$here/call.sh" run "{\"model\":\"@cf/meta/llama-3.2-3b-instruct\",\"body\":{\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"pong\"}]},\"gateway\":{\"skipCache\":true,\"metadata\":{\"user\":\"$user\"}},\"options\":{\"returnRawResponse\":true}}" |
		python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["response"]["status"])'
	sleep "$every"
done
