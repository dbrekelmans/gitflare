#!/usr/bin/env bash
# Runs in each new bb worktree. Every step is optional: never fail provisioning,
# and never wait on input (a hang fails provisioning just like a non-zero exit).
# --ignore-scripts keeps third-party install scripts off the host; it also skips
# this repo's own prepare/postinstall, so run any codegen step by hand.
export PATH="$HOME/Library/pnpm/bin:$HOME/Library/pnpm:$HOME/.vite-plus/bin:$PATH"
export CI=true
if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile --prefer-offline --ignore-scripts </dev/null \
    || echo "pnpm install failed; run it manually"
fi
exit 0
