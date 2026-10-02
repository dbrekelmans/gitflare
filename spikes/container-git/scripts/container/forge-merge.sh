# The forge's operations: clone the parent, fetch the fork branch, diff with rename detection, merge, push.
REPO=${REPO:-gitflare-spike-c-small}
N=https://$H/git/gitflare-spike-c-ns
git config --global user.name gitflare; git config --global user.email gitflare@example.invalid
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
rm -rf /work/parent; mkdir -p /work
t git clone -q $N/$REPO.git /work/parent
cd /work/parent || exit 1
echo "size: .git=$(du -sh .git | cut -f1) worktree=$(du -sh --exclude=.git . | cut -f1) files=$(git ls-files | wc -l) commits=$(git rev-list --count HEAD)"
git remote add fork $N/$REPO-fork.git
t git fetch -q fork change
t sh -c 'git diff -M --stat main...fork/change | tail -6'
t sh -c 'git diff -M main...fork/change > /tmp/change.patch'
echo "patch bytes: $(wc -c < /tmp/change.patch); renames: $(git diff -M --name-status main...fork/change | grep -c ^R)"
t sh -c 'git merge-tree --write-tree main fork/change'
[ -n "$NOPUSH" ] && exit 0
t git merge -q --no-ff -m "Merge change" fork/change
t git push -q origin main
git log --oneline --graph -4 | cat
