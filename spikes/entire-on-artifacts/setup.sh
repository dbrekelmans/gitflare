#!/bin/sh
# Creates the two Artifacts repositories, downloads the released Entire CLI into
# $GF15/bin and writes an isolated git config. Run OUTSIDE any command sandbox:
# wrangler cannot refresh its login from inside one.
set -e
. "$(dirname "$0")/env.sh"
umask 077
mkdir -p "$GF15/secrets" "$GF15/bin" "$GF15/dl" "$GF15/shim" "$XDG_CONFIG_HOME"
export npm_config_cache="$GF15/npm-cache"
w() { npx -y wrangler@4.147.0 "$@"; }

# EXPECTED_ACCOUNT: the account name `wrangler whoami` must report before anything is created.
w whoami | grep -qF "${EXPECTED_ACCOUNT:?set EXPECTED_ACCOUNT to the Cloudflare account name}" || { echo "wrong Cloudflare account"; exit 1; }

# Creating a repo in an unknown namespace creates the namespace. The create result
# carries the remote and a write token valid for 24 hours.
for r in code checkpoints; do
  w artifacts repos create "gitflare-spike-e-$r" --namespace "$NS" --default-branch main --json \
    > "$GF15/secrets/create-$r.json"
  python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'], end='')" \
    "$GF15/secrets/create-$r.json" > "$GF15/secrets/gitflare-spike-e-$r.token"
done

cd "$GF15/dl"
curl -sSLO https://github.com/entireio/cli/releases/download/v0.11.3/checksums.txt \
     -O https://github.com/entireio/cli/releases/download/v0.11.3/entire_darwin_arm64.tar.gz
grep darwin_arm64 checksums.txt | shasum -a 256 -c -
tar -xzf entire_darwin_arm64.tar.gz -C "$GF15/bin"

cat > "$GIT_CONFIG_GLOBAL" <<CFG
[user]
	name = Spike E
	email = spike-e@example.invalid
[init]
	defaultBranch = main
[credential]
	useHttpPath = true
	helper = $SPIKE_DIR/git-credential-artifacts
CFG
cp "$SPIKE_DIR/git-shim" "$GF15/shim/git"
echo "ready: $GF15"
