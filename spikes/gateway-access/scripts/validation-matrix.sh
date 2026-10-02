#!/usr/bin/env bash
# Which Anthropic Messages fields does each catalog model's gateway-side
# validation accept? Costs nothing on an account without Unified Billing
# credits: a body that passes validation stops at 402 (code 2021), one that
# does not stops at 400 (code 7003). With credits, every 402 here becomes a
# real (16-token) call.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

M='"max_tokens":16,"messages":[{"role":"user","content":"pong"}]'
T='"tools":[{"name":"report","description":"d","input_schema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}}]'
F='"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}}}'

names=(
	"tool_choice:tool"
	"tool_choice:any"
	"tool_choice:auto"
	"tools only"
	"output_config.format json_schema"
	"output_config.format = string"
	"system as block array"
	"message blocks + cache_control"
	"thinking adaptive"
	"temperature"
)
bodies=(
	"{$M,$T,\"tool_choice\":{\"type\":\"tool\",\"name\":\"report\"}}"
	"{$M,$T,\"tool_choice\":{\"type\":\"any\"}}"
	"{$M,$T,\"tool_choice\":{\"type\":\"auto\"}}"
	"{$M,$T}"
	"{$M,$F}"
	"{$M,\"output_config\":{\"format\":\"nonsense\"}}"
	"{$M,\"system\":[{\"type\":\"text\",\"text\":\"s\"}]}"
	"{\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"pong\",\"cache_control\":{\"type\":\"ephemeral\"}}]}]}"
	"{$M,\"thinking\":{\"type\":\"adaptive\"}}"
	"{$M,\"temperature\":0}"
)

for m in "${@:-claude-haiku-4.5 claude-sonnet-5 claude-sonnet-5.5 claude-opus-5.5 claude-fable-5.1}"; do
	for model in $m; do
		echo "=== anthropic/$model"
		for i in "${!names[@]}"; do
			printf "%-34s " "${names[$i]}"
			"$here/call.sh" run "{\"model\":\"anthropic/$model\",\"body\":${bodies[$i]},\"options\":{\"returnRawResponse\":true}}" |
				python3 -c 'import sys,json; d=json.load(sys.stdin); r=d.get("response"); b=json.loads(r["body"]) if r else d; print(r["status"] if r else "?", (b.get("message") or json.dumps(b))[:150])'
		done
	done
done
