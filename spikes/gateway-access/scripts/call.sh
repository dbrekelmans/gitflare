#!/usr/bin/env bash
# Usage: SPIKE_URL=https://gitflare-spike-g-ai.<subdomain>.workers.dev SPIKE_KEY=… scripts/call.sh <op> '<json>'
set -euo pipefail
curl -sS -X POST "$SPIKE_URL/$1" -H "x-spike-key: $SPIKE_KEY" -H "content-type: application/json" --data "${2:-{\}}"
