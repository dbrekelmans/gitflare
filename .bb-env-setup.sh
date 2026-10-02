#!/usr/bin/env bash
# Runs in each new bb worktree. Every step is optional: never fail provisioning.
export PATH="$HOME/Library/pnpm/bin:$HOME/Library/pnpm:$HOME/.vite-plus/bin:$PATH"
if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile --prefer-offline || echo "pnpm install failed; run it manually"
fi
exit 0
