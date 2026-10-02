// The shell a hosted session runs inside its sandbox. Each script is the body
// of a `-c`, with its inputs as positional arguments: nothing is ever
// interpolated into the text. `scripts.test.ts` runs both for real against a
// local repository, and checks them with shellcheck where it is installed.

/**
 * Checks out the session's fork: `$1` is the remote, `$2` the directory, `$3`
 * the session's branch, `$4` and `$5` the owner's name and address for
 * commits. The branch is taken from the fork when it was pushed before (a
 * resumed session), and otherwise created at the default branch's tip.
 *
 * The clone is shallow: a full clone of an Artifacts repository takes most of
 * a minute at tens of megabytes (spec/research/live/container-git.md). The
 * commit it ends on is recorded as already pushed, so that a turn which
 * commits nothing pushes nothing.
 */
export const CHECKOUT_SCRIPT = `remote=$1
dir=$2
branch=$3
# What an interrupted start left behind is in the way of a clone.
rm -rf "$dir" || exit 1
mkdir -p "$dir" || exit 1
cd "$dir" || exit 1
git ls-remote --exit-code --heads "$remote" "refs/heads/$branch" >/dev/null
case $? in
0) git clone -q --depth=1 --branch "$branch" "$remote" . || exit 1 ;;
2)
	git clone -q --depth=1 "$remote" . || exit 1
	git checkout -q -b "$branch" || exit 1
	;;
*) exit 1 ;;
esac
git config user.name "$4" || exit 1
git config user.email "$5" || exit 1
git rev-parse HEAD >"$(git rev-parse --git-dir)/gitflare-pushed"`;

/**
 * One turn of the agent, as a background process in the checkout: `$1` is the
 * session's branch, `$2` how many seconds the agent may run, and the rest is
 * the agent's command. Its standard output is
 * the turn's stream, one JSON object per line, which `parseAgentEvents` reads:
 *
 *   {"at": <ms>, "agent": "<a line the agent printed>"}
 *   {"at": <ms>, "pushed": "<commit>"}
 *   {"at": <ms>, "error": "<what went wrong>"}
 *
 * The agent's own events carry no time, so each is stamped as it is printed.
 * Only its `assistant` and `result` events are kept: the rest is mostly tool
 * output, file contents included, and the stream is read whole on every poll.
 *
 * When the agent is done, or has run out of time, whatever it committed is
 * pushed to the session's branch on the fork, which is what opens or revises
 * the change. The script exits with the agent's code, 124 when it ran out of
 * time. It is bash for `pipefail`, without which the stamping would hide that
 * code. The limit is the script's own, not the sandbox's: a turn killed from
 * outside would lose its commits.
 */
export const TURN_SCRIPT = `set -o pipefail
branch=$1
limit=$2
shift 2
# shellcheck disable=SC2016
stamp='. as $line | (try fromjson catch null) | select(type == "object" and (.type == "assistant" or .type == "result")) | {at: (now * 1000 | floor), agent: $line}'
timeout --kill-after=30 "$limit" "$@" </dev/null | jq -R -c --unbuffered "$stamp"
code=$?
note() {
	# shellcheck disable=SC2016
	jq -n -c --arg key "$1" --arg value "$2" '{at: (now * 1000 | floor), ($key): $value}'
}
marker=$(git rev-parse --git-dir)/gitflare-pushed
head=$(git rev-parse HEAD)
if [ -n "$head" ] && [ "$head" != "$(cat "$marker" 2>/dev/null)" ]; then
	if git push -q origin "HEAD:refs/heads/$branch"; then
		echo "$head" >"$marker"
		note pushed "$head"
	else
		note error "The agent's commits could not be pushed to the fork."
	fi
fi
exit "$code"`;

/** Every script with the shell it is written for: what `scripts.test.ts` hands to shellcheck. */
export const scripts = {
  checkout: { shell: "sh", text: CHECKOUT_SCRIPT },
  turn: { shell: "bash", text: TURN_SCRIPT },
} as const;
