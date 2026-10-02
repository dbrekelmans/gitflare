# Clone strategies against Artifacts, and whether a shallow parent clone is enough to diff and merge a fork branch.
REPO=${REPO:-gitflare-spike-c-big}
N=https://$H/git/gitflare-spike-c-ns
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
rm -rf /work/v; mkdir -p /work/v; cd /work/v
t git clone -q --depth=1 $N/$REPO.git shallow
echo "shallow .git=$(du -sh shallow/.git | cut -f1)"
t git clone -q --filter=blob:none $N/$REPO.git blobless 2>&1 | tail -3
echo "blobless .git=$(du -sh blobless/.git 2>/dev/null | cut -f1) promisor=$(git -C blobless config remote.origin.promisor 2>/dev/null) missing=$(git -C blobless rev-list --objects --missing=print HEAD 2>/dev/null | grep -c '^?')"
t git clone -q --filter=tree:0 --depth=1 $N/$REPO.git treeless 2>&1 | tail -3
echo "--- capabilities advertised (v2)"
GIT_TRACE_PACKET=1 git ls-remote $N/$REPO.git 2>&1 | grep 'packet:.*git< ' | grep -v 'refs/\|HEAD\|0000\|0001' | sed 's/.*git< //' | head -20
echo "--- capabilities advertised (v0/v1)"
GIT_TRACE_PACKET=1 git -c protocol.version=0 ls-remote $N/$REPO.git 2>&1 | grep 'packet:.*git< .*HEAD' | head -1 | sed 's/.*HEAD.//' | tr ' ' '\n' | head -30 | tr '\n' ' '; echo
echo "--- diff and merge from a depth=1 parent clone"
cd shallow && git config user.name gitflare && git config user.email gitflare@example.invalid
git remote add fork $N/$REPO-fork.git
t git fetch -q --depth=2 fork change
echo "merge-base: $(git merge-base main fork/change 2>&1 | cut -c1-12)"
t sh -c 'git diff -M --stat main...fork/change | tail -4'
t sh -c 'git merge-tree --write-tree main fork/change | cut -c1-12'
echo ".git after fork fetch=$(du -sh .git | cut -f1)"
