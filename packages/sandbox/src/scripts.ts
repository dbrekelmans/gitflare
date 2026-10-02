// The shell this package runs inside a container. Each script is the body of
// an `sh -c`, with its inputs as positional arguments: nothing is ever
// interpolated into the text. They are POSIX sh, for the managed image's dash,
// and are checked with shellcheck by `scripts.test.ts`.

/**
 * Kills every process whose session is `$1`. GNU `timeout` signals the
 * command it started, and a child that command left behind was seen to
 * outlive it (spec/research/live/container-git.md, section 4). A launched
 * command is the leader of a session of its own, so its session is exactly
 * its descendants. The managed image has no `ps` or `pkill`; `/proc` is read
 * directly, where the session is the fourth field after the command name.
 */
const SWEEP = `sweep() {
	[ -n "$1" ] || return 0
	for stat in /proc/[0-9]*/stat; do
		read -r line 2>/dev/null <"$stat" || continue
		rest=\${line##*) }
		# shellcheck disable=SC2086
		set -- "$1" $rest
		if [ "\${5:-}" = "$1" ]; then kill -KILL "\${line%% *}" 2>/dev/null; fi
	done
	return 0
}`;

/**
 * Starts a background process: `$1` is its directory, `$2` its time limit in
 * seconds or empty, the rest is the command. This is the launcher from
 * developers.cloudflare.com/sandbox/commands/run-background-processes/ — the
 * command leads its own session, its output goes to files, and its exit code
 * is written atomically when it ends — with two additions: the launcher
 * records itself first, so that a process whose launcher died without an exit
 * code can be told from one still running, and a command that ran out of time
 * has what it left behind killed.
 */
export const SPAWN_SCRIPT = `${SWEEP}
dir=$1
limit=$2
shift 2
mkdir -p "$dir" || exit 1
echo "$$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" >"$dir/launcher"
if [ -n "$limit" ]; then set -- timeout --kill-after=5 "$limit" "$@"; fi
# The inner shell expands these, not this one.
# shellcheck disable=SC2016
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
code=$?
if [ -n "$limit" ] && { [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; }; then
	sweep "$(cat "$dir/pid" 2>/dev/null)"
fi
echo "$code" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

/**
 * Prints the state of the process in directory `$1`: `exited <code>`,
 * `running`, or `lost` when its launcher is gone and left no exit code. The
 * boot id guards against a process id that was reused after a restore.
 */
export const STATUS_SCRIPT = `dir=$1
if [ -f "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"; exit 0; fi
if ! read -r pid boot 2>/dev/null <"$dir/launcher"; then echo running; exit 0; fi
if [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" ] && kill -0 "$pid" 2>/dev/null; then
	echo running
	exit 0
fi
if [ -f "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"; else echo lost; fi`;

/**
 * Runs a command to completion under a time limit: `$1` is the limit in
 * seconds, the rest is the command. Exits with the command's code, or 124
 * when it ran out of time (137 when it had to be killed). Started in the
 * background only so that the shell learns its process id, which `setsid`
 * makes its session id.
 */
export const EXEC_SCRIPT = `${SWEEP}
limit=$1
shift
setsid timeout --kill-after=5 "$limit" "$@" &
session=$!
wait "$session"
code=$?
if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then sweep "$session"; fi
exit "$code"`;

/** Prints at most `$3` bytes of file `$1` starting at byte `$2`, counted from 1. Nothing for a missing file. */
export const READ_LOG_SCRIPT = `tail -c "+$2" "$1" 2>/dev/null | head -c "$3"`;

/**
 * Writes file `$1` in pieces, because one argument is limited to 128 KiB:
 * `$2` is `only` for a file that fits in one piece, otherwise `first`, `more`
 * and `done`; `$3` is the text. A file written in pieces appears whole or not
 * at all.
 */
export const WRITE_FILE_SCRIPT = `path=$1
case $2 in
only) mkdir -p "$(dirname "$path")" && printf %s "$3" >"$path" ;;
first) mkdir -p "$(dirname "$path")" && printf %s "$3" >"$path.gitflare-part" ;;
more) printf %s "$3" >>"$path.gitflare-part" ;;
done) mv "$path.gitflare-part" "$path" ;;
*) exit 2 ;;
esac`;

/** The exit code `READ_FILE_SCRIPT` uses for "no such file". */
export const NO_SUCH_FILE = 44;

/** Prints file `$1`, or exits with `NO_SUCH_FILE` when it is missing or a directory. */
export const READ_FILE_SCRIPT = `if [ -f "$1" ]; then cat "$1"; else exit ${NO_SUCH_FILE}; fi`;

/** Every script, by name: what `scripts.test.ts` hands to shellcheck. */
export const scripts = {
  spawn: SPAWN_SCRIPT,
  status: STATUS_SCRIPT,
  exec: EXEC_SCRIPT,
  readLog: READ_LOG_SCRIPT,
  writeFile: WRITE_FILE_SCRIPT,
  readFile: READ_FILE_SCRIPT,
};
