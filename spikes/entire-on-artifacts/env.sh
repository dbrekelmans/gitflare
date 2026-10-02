# Source this from every other script. Nothing here is account-specific:
# remotes and tokens are read from $GF15/secrets, which setup.sh fills.
export GF15="${GF15:?set GF15 to a scratch directory (the same one for every script)}"
export SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export NS=gitflare-spike-e-ns
export CODE_REPO=gitflare-spike-e-code
export CKPT_REPO=gitflare-spike-e-checkpoints

# The released Entire binary lives in $GF15/bin only; it is never installed system-wide.
export PATH="$GF15/bin:$SPIKE_DIR:$PATH"

# Isolate git from the developer's own config (signing, keychain helper).
export GIT_CONFIG_GLOBAL="$GF15/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0

export ENTIRE_TELEMETRY_OPTOUT=1
export XDG_CONFIG_HOME="$GF15/xdg/config" XDG_STATE_HOME="$GF15/xdg/state" \
       XDG_CACHE_HOME="$GF15/xdg/cache" XDG_DATA_HOME="$GF15/xdg/data"

json() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
if [ -f "$GF15/secrets/create-code.json" ]; then
  export CODE_URL="$(json "$GF15/secrets/create-code.json" remote)"
  export CKPT_URL="$(json "$GF15/secrets/create-checkpoints.json" remote)"
  export ARTIFACTS_HOST="$(printf %s "$CODE_URL" | sed -E 's#https://([^/]+)/.*#\1#')"
fi

# Masks the account id and token secrets in anything that is pasted into the note.
mask() { sed -E "s/${ARTIFACTS_HOST%%.*}/<account-id>/g; s/art_v[0-9]_[A-Za-z0-9_]+/art_<redacted>/g; s/(Basic|Bearer) [A-Za-z0-9+\/=_?.-]+/\\1 <redacted>/g"; }
