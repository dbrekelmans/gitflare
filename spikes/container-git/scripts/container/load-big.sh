# Loads a real ~50 MB repository (vuejs/core) into Artifacts: clone from GitHub directly (this box has
# Internet access), then push through the gateway. The push is the large git-receive-pack request.
N=https://$H/git/gitflare-spike-c-ns
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
rm -rf /work/big; mkdir -p /work
GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt t git clone -q --single-branch --branch main https://github.com/vuejs/core.git /work/big
cd /work/big || exit 1
git gc -q 2>/dev/null
echo "size: .git=$(du -sh .git | cut -f1) pack=$(du -ch .git/objects/pack/*.pack | tail -1 | cut -f1) worktree=$(du -sh --exclude=.git . | cut -f1) files=$(git ls-files | wc -l) commits=$(git rev-list --count HEAD)"
git remote add artifacts $N/gitflare-spike-c-big.git
t git push -q artifacts main
git ls-remote artifacts | cut -c1-60
