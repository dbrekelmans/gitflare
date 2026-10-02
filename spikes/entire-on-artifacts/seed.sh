#!/bin/sh
# Builds the pre-configured code repository and pushes it to Artifacts:
# `entire enable` writes the hook and settings files, then settings.json is replaced by
# the hand-written one carrying the sibling checkpoint remote and commit_linking=always.
set -e
. "$(dirname "$0")/env.sh"
rm -rf "$GF15/seed" && mkdir "$GF15/seed" && cd "$GF15/seed"
git init -q && echo "# spike" > README.md && git add . && git commit -qm "Initial commit"
git remote add origin "$CODE_URL"
# The flag form is rejected for an unknown provider (a warning; enable still succeeds):
entire enable --agent claude-code --telemetry=false --checkpoint-remote "artifacts:git/$NS/$CKPT_REPO" </dev/null || true
sed "s#__NS__#$NS#; s#__CKPT_REPO__#$CKPT_REPO#" "$SPIKE_DIR/settings.json.tmpl" > .entire/settings.json
entire status
git add -A && git commit -qm "Pre-configure Entire: hooks, sibling checkpoint remote, commit_linking=always"
git push -u origin main
