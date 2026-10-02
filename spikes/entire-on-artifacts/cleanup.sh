#!/bin/sh
# Deletes both repositories (run outside the sandbox) and the local token files.
# The empty namespace is not removable with wrangler 4.147.0; delete it with
#   DELETE /accounts/<account-id>/artifacts/namespaces/gitflare-spike-e-ns
# (returns 204) using an API token or the Cloudflare MCP tools.
. "$(dirname "$0")/env.sh"
export npm_config_cache="$GF15/npm-cache"
for r in "$CODE_REPO" "$CKPT_REPO"; do
  npx -y wrangler@4.147.0 artifacts repos delete "$r" --namespace "$NS" --force
done
npx -y wrangler@4.147.0 artifacts repos list --namespace "$NS"
rm -rf "$GF15/secrets" "$GF15/secrets-bad" "$GF15/secrets-codeonly"
