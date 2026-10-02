#!/usr/bin/env bash
# What does the gateway keep of the metadata a caller sends? One tiny uncached
# Workers AI call per case, then the metadata as stored on that call's log.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
m() {
	printf "%-30s " "$1"
	"$here/call.sh" run-and-log "{\"model\":\"@cf/meta/llama-3.2-3b-instruct\",\"body\":{\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"pong\"}]},\"gateway\":{\"skipCache\":true,\"metadata\":$2},\"waitMs\":5000}" |
		python3 -c 'import sys,json; d=json.load(sys.stdin); m=(d.get("log") or {}).get("metadata"); e=(d.get("error") or {}).get("message"); print("log.metadata =", json.dumps({k:(v if not isinstance(v,str) or len(v)<40 else f"<string of {len(v)}>") for k,v in m.items()}) if isinstance(m,dict) else json.dumps(m), ("| error: "+e) if e else "")'
}
L=$(python3 -c 'print("x"*600)')
m "string values" '{"user":"u-alice","agent":"review"}'
m "number + boolean" '{"user":12345,"flag":true}'
m "null value" '{"user":"u","nothing":null}'
m "nested object" '{"obj":{"a":1},"user":"u"}'
m "reserved cf.user_id" '{"cf.user_id":"spoofed","user":"u"}'
m "600-character value" "{\"long\":\"$L\",\"user\":\"u\"}"
m "6 entries" '{"a":"1","b":"2","c":"3","d":"4","e":"5","f":"6"}'
m "7 entries" '{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5","k6":"v6","k7":"v7"}'
