# Run in a container restored (Internet off) from a snapshot that holds a clone of vuejs/core in /work/big:
# pushes the whole history to an empty Artifacts repository through the gateway.
N=https://$H/git/gitflare-spike-c-ns
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
cd /work/big || exit 1
echo "size: pack=$(du -ch .git/objects/pack/*.pack | tail -1 | cut -f1) commits=$(git rev-list --count HEAD)"
echo "Internet: $(git ls-remote https://github.com/vuejs/core.git 2>&1 | head -1)"
git remote remove artifacts 2>/dev/null; git remote add artifacts $N/gitflare-spike-c-big.git
t git push -q artifacts main
git ls-remote artifacts | cut -c1-60
