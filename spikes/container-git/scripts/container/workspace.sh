# Builds a realistic workspace: shallow clone of the big repo from Artifacts, then its dependencies.
N=https://$H/git/gitflare-spike-c-ns
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed "s/$H/<host>/g"; }
rm -rf /workspace
t git clone -q --depth=1 $N/gitflare-spike-c-big.git /workspace
cd /workspace || exit 1
t sh -c 'npm install -g --no-audit --no-fund pnpm@10 2>&1 | tail -1'
# With the four trust variables pointing at the container CA alone, this install hung for ten minutes
# without output (this box intercepts one hostname only, so the registry presents its real certificate).
# It was killed and re-run without them, which is what this line does.
t sh -c 'unset SSL_CERT_FILE CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS GIT_SSL_CAINFO; PUPPETEER_SKIP_DOWNLOAD=1 CI=1 pnpm install --frozen-lockfile 2>&1 | tail -3'
echo "node_modules=$(du -sh node_modules | cut -f1) files=$(find node_modules -xdev | wc -l) root-fs=$(df -h / | tail -1 | tr -s ' ' | cut -d' ' -f3)"
echo marker-tmp > /tmp/marker; echo marker-run > /run/marker; echo marker-root > /root/marker; echo marker-ws > /workspace/MARKER
(setsid sleep 9999 >/dev/null 2>&1 &); sync
