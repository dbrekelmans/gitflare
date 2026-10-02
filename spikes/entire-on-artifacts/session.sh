#!/bin/sh
# Usage: session.sh <clone-dir> <prompt> [extra claude flags…]
# Drives one tiny headless Claude Code turn in <clone-dir>. Only project settings are
# loaded (the committed .claude/settings.json with Entire's hooks); no MCP servers.
. "$(dirname "$0")/env.sh"
dir=$1; prompt=$2; shift 2
cd "$dir" || exit 1
claude -p "$prompt" --model haiku --setting-sources project --strict-mcp-config \
  --allowedTools Read Edit Write "Bash(git add:*)" "Bash(git commit:*)" "Bash(git status:*)" \
  --output-format json --max-budget-usd 0.20 "$@" </dev/null
