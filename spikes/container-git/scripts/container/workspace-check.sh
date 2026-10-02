# Run in a container restored from the workspace snapshot: what survived?
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*"; }
for f in /tmp/marker /run/marker /root/marker /workspace/MARKER; do echo "$f: $(cat $f 2>&1)"; done
echo "sleep 9999 processes: $(for p in /proc/[0-9]*; do tr '\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c 'sleep 9999')"
cd /workspace && echo "git: $(git log --oneline -1 | cut -c1-60) status-lines=$(git status --porcelain | wc -l)"
echo "node_modules=$(du -sh node_modules | cut -f1) pnpm=$(pnpm --version 2>&1)"
t sh -c 'pnpm exec vitest run packages/shared 2>&1 | tail -5'
