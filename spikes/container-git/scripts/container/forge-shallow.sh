# The forge's merge, depth-limited end to end: shallow clone of the parent, shallow fetch of the fork
# branch, diff with rename detection, merge, push. TARGET is the branch the merge is pushed to, so the
# run can be repeated without changing main.
REPO=${REPO:-gitflare-spike-c-big}; TARGET=${TARGET:-main}
N=https://$H/git/gitflare-spike-c-ns
git config --global user.name gitflare; git config --global user.email gitflare@example.invalid
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
all=$(date +%s%3N)
rm -rf /work/parent; mkdir -p /work
t git clone -q --depth=1 $N/$REPO.git /work/parent
cd /work/parent || exit 1
git remote add fork $N/$REPO-fork.git
t git fetch -q --depth=2 fork change
t sh -c 'git diff -M main...fork/change > /tmp/change.patch'
echo "patch bytes: $(wc -c < /tmp/change.patch); renames: $(git diff -M --name-status main...fork/change | grep -c ^R)"
t git merge -q --no-ff -m "Merge change" fork/change
t git push -q origin HEAD:refs/heads/$TARGET
echo "TOTAL in container: $(( $(date +%s%3N) - all )) ms"
git log --oneline --graph -3 | cat
