#!/bin/sh
# Usage: human-commit.sh <clone-dir> <message> [answer]
# Commits the agent's uncommitted edit the way a human at a terminal would: `git commit -m`
# under a pseudo-terminal, in an environment stripped of the agent's own variables
# (CLAUDECODE, CLAUDE_CODE_*, …). [answer] is typed at Entire's link prompt, if one appears.
# Needs a real pty, which a command sandbox does not provide.
. "$(dirname "$0")/env.sh"
cd "$1" || exit 1
before=$(git rev-parse HEAD)
{ sleep 4; printf '%s\n' "${3:-}"; sleep 3; } | env -i PATH="$PATH" HOME="$HOME" TERM=xterm GF15="$GF15" \
  GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 ENTIRE_TELEMETRY_OPTOUT=1 \
  script -q /dev/null git commit -am "$2" 2>&1 | tr -d '\r' | sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g'
[ "$(git rev-parse HEAD)" != "$before" ] || { echo "no commit was made"; exit 1; }
git log -1 --format='%h %s | trailer=[%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2C)]'
