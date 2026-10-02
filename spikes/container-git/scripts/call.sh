#!/bin/sh
# usage: scripts/call.sh METHOD PATH [JSON]   — prints the response body, then "HTTP <status> <seconds>s" on stderr
cd "$(dirname "$0")/.." || exit 1
. ./.env
key=$(node -p 'require("./.secrets.json").SPIKE_KEY')
method=$1; path=$2; shift 2
if [ $# -gt 0 ]; then set -- --data "$1" -H 'content-type: application/json'; fi
exec curl -sS -N --max-time "${MAX_TIME:-900}" -X "$method" -H "x-spike-key: $key" "$@" \
	-w '\nHTTP %{http_code} %{time_total}s\n' "$SPIKE_URL$path"
