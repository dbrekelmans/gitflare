# A "session": clone its fork, make a change with a rename, push a branch to the fork.
# REPO is the parent repo name; the gateway for this box holds a write token for the fork only.
REPO=${REPO:-gitflare-spike-c-small}
N=https://$H/git/gitflare-spike-c-ns
git config --global user.name session; git config --global user.email session@example.invalid
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
rm -rf /work/fork; mkdir -p /work
t git clone -q $N/$REPO-fork.git /work/fork
cd /work/fork || exit 1
git checkout -q -b change
if [ -f src/greet.js ]; then
  git mv src/greet.js src/greeting.js
  sed -i 's/hello /hi /' src/greeting.js
  printf 'export function sub(a, b) {\n  return a - b;\n}\n' >> src/math.js
else
  # big repo: rename one real source file with a small edit, edit another, add a file
  f=$(git ls-files '*.ts' | grep -v test | head -1); g=$(git ls-files '*.ts' | grep -v test | sed -n 20p)
  git mv "$f" "${f%.ts}Renamed.ts"; echo "// spike edit" >> "${f%.ts}Renamed.ts"
  echo "// spike edit" >> "$g"; echo "spike" > SPIKE.md; git add -A
fi
git commit -q -am "session change" && git show --stat --oneline -M HEAD | tail -5
t git push -q origin change
echo "--- negative: push to the parent, which this gateway has no token for"
git push $N/$REPO.git change 2>&1 | sed "s/$H/<host>/g"; echo "exit=$?"
echo "--- negative: any other host"
git ls-remote https://github.com/vuejs/core.git 2>&1 | head -2; echo "exit=$?"
