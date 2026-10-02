#!/usr/bin/env bash
# GF-12 spike: plain git against Cloudflare Artifacts. Throwaway.
# usage: git-tests.sh <env-file> <stage>...   stages: auth clones tokens refs forks events raw
# The env file (never committed) exports the remotes and tokens listed in README.md.
set -u
# Resolved to a path first: a bare name such as `env` would be looked up on PATH.
source "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
shift

export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=spike GIT_AUTHOR_EMAIL=spike@example.com
export GIT_COMMITTER_NAME=spike GIT_COMMITTER_EMAIL=spike@example.com

WORK="${WORK:-${TMPDIR:-/tmp}/gitflare-spike-a}"
mkdir -p "$WORK"
cd "$WORK" || exit 1

# git with a bearer token: B <token> <git args...>
B() { git -c http.extraHeader="Authorization: Bearer $1" "${@:2}"; }
secret() { printf %s "${1%%\?expires=*}"; }
say() { printf '\n== %s\n' "$*"; }
# Appends the Basic-auth userinfo to a remote URL: with_userinfo <userinfo> <remote>
with_userinfo() { printf 'https://%s@%s' "$1" "${2#https://}"; }

seed() {
	[ -d seed ] && return
	git init -q -b main seed
	(
		cd seed || exit 1
		echo "# spike" >README.md
		mkdir src
		echo 'export const a = 1;' >src/a.ts
		git add . && git commit -q -m "initial"
		echo 'export const b = 2;' >src/b.ts
		git add . && git commit -q -m "second"
	)
}

stage_auth() {
	seed
	say "push, bearer, full token including ?expires="
	B "$T_WRITE" -C seed push "$REMOTE" main 2>&1 | tail -2
	say "no credentials"
	git ls-remote "$REMOTE" 2>&1 | tail -1
	curl -s -D - -o /dev/null "$REMOTE/info/refs?service=git-upload-pack" | grep -i -E "^HTTP|www-authenticate"
	say "bearer, full token"
	B "$T_READ" ls-remote "$REMOTE" 2>&1 | tail -1
	say "bearer, secret only (suffix stripped)"
	B "$(secret "$T_READ")" ls-remote "$REMOTE" 2>&1 | tail -1
	say "bearer, valid secret with ?expires= rewritten to the past"
	B "$(secret "$T_READ")?expires=1600000000" ls-remote "$REMOTE" 2>&1 | tail -1
	say "basic, in the URL: x:<secret>"
	git ls-remote "$(with_userinfo "x:$(secret "$T_READ")" "$REMOTE")" 2>&1 | tail -1
	say "basic, in the URL: x:<full token, percent-encoded>"
	git ls-remote "$(with_userinfo "x:$(secret "$T_READ")%3Fexpires%3D${T_READ##*=}" "$REMOTE")" 2>&1 | tail -1
	say "basic, in the URL: <secret> as username, password x"
	git ls-remote "$(with_userinfo "$(secret "$T_READ"):x" "$REMOTE")" 2>&1 | tail -2
	say "capability advertisements: upload-pack v1, upload-pack v2, receive-pack"
	curl -s -H "Authorization: Bearer $T_READ" "$REMOTE/info/refs?service=git-upload-pack" | head -c 600 | tr '\0' '\n'
	echo
	curl -s -H "Authorization: Bearer $T_READ" -H "Git-Protocol: version=2" "$REMOTE/info/refs?service=git-upload-pack" | head -c 600
	echo
	curl -s -H "Authorization: Bearer $T_WRITE" "$REMOTE/info/refs?service=git-receive-pack" | head -c 400 | tr '\0' '\n'
}

stage_clones() {
	rm -rf c-depth c-filter c-filter1 c-tree0 c-sha
	say "--depth 1"
	B "$T_READ" clone -q --depth 1 "$REMOTE" c-depth
	git -C c-depth log --oneline | cat
	git -C c-depth rev-parse --is-shallow-repository
	say "--filter=blob:none (protocol v2, the default)"
	B "$T_READ" clone -q --filter=blob:none --no-checkout "$REMOTE" c-filter
	echo "missing objects before checkout: $(git -C c-filter rev-list --objects --all --missing=print | grep -c '^?')"
	B "$T_READ" -C c-filter checkout -q main
	echo "missing objects after checkout:  $(git -C c-filter rev-list --objects --all --missing=print | grep -c '^?')"
	say "--filter=blob:none forced to protocol v1"
	B "$T_READ" -c protocol.version=1 clone --filter=blob:none --no-checkout "$REMOTE" c-filter1 2>&1 | tail -2
	echo "missing objects: $(git -C c-filter1 rev-list --objects --all --missing=print | grep -c '^?')"
	say "--filter=tree:0"
	B "$T_READ" clone --filter=tree:0 --no-checkout "$REMOTE" c-tree0 2>&1 | tail -3
	say "fetch --depth=1 of a bare SHA into an empty repository"
	git init -q c-sha
	B "$T_READ" -C c-sha fetch --depth=1 "$REMOTE" "$(git -C seed rev-parse HEAD~1)" 2>&1 | tail -1
}

stage_tokens() {
	(
		cd seed || exit 1
		say "push with a read token"
		git commit -q --allow-empty -m "token test"
		B "$T_READ" push "$REMOTE" main 2>&1 | tail -2
		say "revoked token: ls-remote, push"
		B "$T_REVOKED" ls-remote "$REMOTE" 2>&1 | tail -2
		B "$T_REVOKED" push "$REMOTE" main 2>&1 | tail -2
		say "60 s token (expires $(date -u -r "${T_SHORT##*=}" +%T 2>/dev/null || date -u -d "@${T_SHORT##*=}" +%T), now $(date -u +%T)); re-run this stage after expiry"
		B "$T_SHORT" ls-remote "$REMOTE" 2>&1 | tail -2
		say "same token, ?expires= rewritten a day ahead"
		B "$(secret "$T_SHORT")?expires=$(($(date +%s) + 86400))" ls-remote "$REMOTE" 2>&1 | tail -2
		say "same token, secret only, basic"
		git ls-remote "$(with_userinfo "x:$(secret "$T_SHORT")" "$REMOTE")" 2>&1 | tail -2
		say "token for one repository used on another"
		B "$T_WRITE" ls-remote "$RO_REMOTE" 2>&1 | tail -2
		say "read_only repository, write token: push twice"
		B "$T_RO_WRITE" push "$RO_REMOTE" main 2>&1 | tail -2
		git commit -q --allow-empty -m "second push to read_only"
		B "$T_RO_WRITE" push "$RO_REMOTE" main 2>&1 | tail -2
		say "write token (control)"
		B "$T_WRITE" push "$REMOTE" main 2>&1 | tail -1
	)
}

stage_refs() {
	local id=01M3WE2VX9HQC3NVY9BWYCW6JV
	local cp="refs/entire/checkpoints/JV/${id}"
	(
		cd seed || exit 1
		local blob tree commit
		blob=$(printf '{"session":"x"}\n' | git hash-object -w --stdin)
		tree=$(printf '100644 blob %s\tmetadata.json\n' "$blob" | git mktree)
		commit=$(git commit-tree "$tree" -m "checkpoint ${id}")
		git update-ref "$cp" "$commit"
		git notes add -f -m "note on HEAD" HEAD
		git tag -f v0.1 HEAD~1 >/dev/null
		git tag -f -a v0.2 -m "annotated" HEAD >/dev/null
		git update-ref refs/gitflare/changes/1/head HEAD
		say "push: checkpoint ref, notes, tags, an arbitrary namespace"
		B "$T_WRITE" push "$REMOTE" "${cp}:${cp}" 2>&1 | tail -1
		B "$T_WRITE" push "$REMOTE" 'refs/notes/*:refs/notes/*' 2>&1 | tail -1
		B "$T_WRITE" push "$REMOTE" --tags 2>&1 | tail -2
		B "$T_WRITE" push "$REMOTE" refs/gitflare/changes/1/head 2>&1 | tail -1
		say "--atomic and push options"
		git commit -q --allow-empty -m "atomic test"
		B "$T_WRITE" push --atomic "$REMOTE" main refs/gitflare/changes/1/head 2>&1 | head -1
		B "$T_WRITE" push -o actor=someone "$REMOTE" main 2>&1 | head -1
		B "$T_WRITE" push "$REMOTE" main 2>&1 | tail -1
	)
	say "ls-remote: everything, then a pattern"
	B "$T_READ" ls-remote "$REMOTE"
	B "$T_READ" ls-remote "$REMOTE" 'refs/entire/*'
	rm -rf c-refs c-cp
	B "$T_READ" clone -q "$REMOTE" c-refs
	say "refs a plain clone brings"
	git -C c-refs for-each-ref --format='%(refname)' | cat
	say "fetch by explicit refspec, by wildcard, and --depth=1 into an empty repository"
	B "$T_READ" -C c-refs fetch "$REMOTE" "+${cp}:${cp}" 2>&1 | tail -1
	B "$T_READ" -C c-refs fetch "$REMOTE" '+refs/entire/*:refs/entire/*' '+refs/notes/*:refs/notes/*' 2>&1 | tail -2
	git -C c-refs show "${cp}:metadata.json"
	git -C c-refs notes show HEAD~1
	git init -q c-cp
	B "$T_READ" -C c-cp fetch --depth=1 "$REMOTE" "$cp" 2>&1 | tail -1
	git -C c-cp show FETCH_HEAD:metadata.json
}

stage_forks() {
	say "refs: parent, then fork"
	B "$T_READ" ls-remote "$REMOTE" | cut -f2 | tr '\n' ' '
	echo
	B "$T_FORK" ls-remote "$FORK_REMOTE" | cut -f2 | tr '\n' ' '
	echo
	say "tokens across the pair: parent token on fork, fork token on parent"
	B "$T_WRITE" ls-remote "$FORK_REMOTE" 2>&1 | head -1
	B "$T_FORK" ls-remote "$REMOTE" 2>&1 | head -1
	rm -rf fk pc
	B "$T_FORK" clone -q "$FORK_REMOTE" fk
	(
		cd fk || exit 1
		git config "http.$FORK_REMOTE.extraHeader" "Authorization: Bearer $T_FORK"
		git config "http.$REMOTE.extraHeader" "Authorization: Bearer $T_READ"
		git remote add upstream "$REMOTE"
		say "fetch the parent as a second remote"
		git fetch upstream 2>&1 | tail -3
		say "push a branch to the fork with the fork token"
		git checkout -q -b session/1
		echo s1 >src/session.ts
		git add . && git commit -qm "fork commit 1"
		echo s2 >>src/session.ts
		git commit -qam "fork commit 2"
		git push origin session/1 2>&1 | tail -1
	)
	B "$T_WRITE" clone -q "$REMOTE" pc
	(
		cd pc || exit 1
		say "the fork token pushing to the parent"
		B "$T_FORK" push "$REMOTE" main:refs/heads/from-fork-token 2>&1 | tail -2
		say "fetch the fork's branch into a clone of the parent, merge, push"
		B "$T_FORK" fetch "$FORK_REMOTE" session/1 2>&1 | tail -1
		git merge --no-ff -q -m "Merge fork session/1 (local git)" FETCH_HEAD
		git log --oneline --graph -4 | cat
		B "$T_WRITE" push "$REMOTE" main 2>&1 | tail -1
	)
}

# Pushes whose events the Workflow in worker/ records. Run after `forks`.
stage_events() {
	P() { B "$T_WRITE" push "$@" 2>&1 | grep -v '^To ' | tail -6; }
	(
		cd pc || exit 1
		B "$T_READ" fetch -q "$REMOTE" '+refs/notes/*:refs/notes/*'
		say "non-branch refs"
		local blob tree commit
		blob=$(printf '{"session":"e3"}\n' | git hash-object -w --stdin)
		tree=$(printf '100644 blob %s\tmetadata.json\n' "$blob" | git mktree)
		commit=$(git commit-tree "$tree" -m "E3: checkpoint")
		git update-ref refs/entire/checkpoints/E3/CHECKPOINT3 "$commit"
		P "$REMOTE" refs/entire/checkpoints/E3/CHECKPOINT3
		git notes add -f -m "E3 note" HEAD
		P "$REMOTE" refs/notes/commits
		say "one push, five refs"
		git checkout -q -b e4-a
		echo a >e4a && git add . && git commit -qm "E4: branch a"
		git checkout -q -b e4-b main
		echo b >e4b && git add . && git commit -qm "E4: branch b"
		git tag e4-light e4-a
		git tag -a e4-annot -m "E4 annotated" e4-b
		git update-ref refs/gitflare/changes/4/head e4-b
		P "$REMOTE" e4-a e4-b refs/tags/e4-light refs/tags/e4-annot refs/gitflare/changes/4/head
		say "force push"
		git checkout -q e4-a
		git commit -q --amend -m "E5: amended, force pushed"
		P --force "$REMOTE" e4-a
		say "deletions: branch, tag, other ref"
		P "$REMOTE" :e4-b
		P "$REMOTE" :refs/tags/e4-light
		P "$REMOTE" :refs/gitflare/changes/4/head
		say "30 commits in one push, one with a 20 kB message"
		git checkout -q main
		for i in $(seq 1 29); do git commit -q --allow-empty -m "E7: commit $i"; done
		git commit -q --allow-empty -m "E7: long $(head -c 20000 /dev/zero | tr '\0' 'x')"
		P "$REMOTE" main
		say "nothing to push"
		P "$REMOTE" main
	)
}

# Hand-built receive-pack requests: does the server check the old value, and does it refuse a non-fast-forward?
stage_raw() {
	(
		cd pc || exit 1
		B "$T_READ" fetch -q "$REMOTE" main
		git reset -q --hard FETCH_HEAD
		local tip stale new
		tip=$(git rev-parse HEAD)
		stale=$(git rev-parse HEAD~2)
		new=$(git commit-tree "HEAD^{tree}" -p "$stale" -m "raw: built on a stale base")
		raw() {
			{
				printf '%04x%s %s refs/heads/main\0 report-status\n' $((4 + 40 + 1 + 40 + 1 + 15 + 1 + 14 + 1)) "$1" "$2"
				printf '0000'
				git rev-list --objects "$2" "^$stale" | git pack-objects --stdout -q
			} >../receive.req
			curl -s -X POST "$REMOTE/git-receive-pack" -H "Authorization: Bearer $T_WRITE" \
				-H "content-type: application/x-git-receive-pack-request" --data-binary @../receive.req -w '\nHTTP %{http_code}\n' | tr '\0' ' '
		}
		say "old value is stale"
		raw "$stale" "$new"
		say "old value is right, new commit is not a descendant"
		raw "$tip" "$new"
		say "put main back"
		B "$T_WRITE" push -f "$REMOTE" "${tip}:refs/heads/main" 2>&1 | tail -1
	)
}

for stage in "$@"; do "stage_$stage"; done
