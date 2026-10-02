# Fallback under test: Internet on, no gateway, a read token for one repository in $ARTIFACTS_TOKEN.
N=https://$H/git/gitflare-spike-c-ns
t() { s=$(date +%s%3N); "$@"; r=$?; echo "TIME $(( $(date +%s%3N) - s )) ms exit=$r :: $*" | sed -e "s/$H/<host>/g" -e 's/art_v[0-9]_[a-z0-9_]*[?]expires=[0-9]*/<token>/g'; }
rm -rf /work/d; mkdir -p /work/d; cd /work/d
echo "token shape: $(echo "$ARTIFACTS_TOKEN" | sed -E 's/_[0-9a-f]{40}/_<40 hex>/')"
t git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone -q --depth=1 $N/gitflare-spike-c-big.git shallow
t git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone -q $N/gitflare-spike-c-big.git full
echo "--- without the token"
git clone -q --depth=1 $N/gitflare-spike-c-big.git anon 2>&1 | sed "s/$H/<host>/g"
echo "--- the token on another repository"
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" ls-remote $N/gitflare-spike-c-small.git 2>&1 | sed "s/$H/<host>/g" | head -2
echo "--- push with a read token"
cd shallow && git -c user.name=x -c user.email=x@example.invalid commit -q --allow-empty -m x && git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" push origin HEAD:refs/heads/readtoken 2>&1 | sed "s/$H/<host>/g" | head -3
