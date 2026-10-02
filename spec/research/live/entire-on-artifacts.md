# Unmodified Entire CLI capturing into a sibling Artifacts repository

Observed 2026-10-02 on a live account.

What ran: the released Entire CLI **v0.11.3** (`entire_darwin_arm64.tar.gz`, checksum verified,
unpacked into a scratch directory, never installed), git 2.55.0, `wrangler@4.147.0`, and real
headless Claude Code 2.1.287 sessions (`claude -p … --model haiku`, eight in total) — no hook
payloads were replayed. Two Artifacts repositories in one namespace: `gitflare-spike-e-code` and
`gitflare-spike-e-checkpoints`. Scripts and exact steps: [`spikes/entire-on-artifacts/`](../../../spikes/entire-on-artifacts/README.md).
In the output below the account id is written `<account-id>`, and `<code>` / `<sibling>` stand for
`https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-e-ns/gitflare-spike-e-{code,checkpoints}.git`.

## What this changes

1. **No fork of the Entire CLI is needed to capture into a sibling Artifacts repository.** A
   hand-written `.entire/settings.json` with `checkpoint_remote: {"provider": "artifacts", "repo":
   "git/<namespace>/<sibling>"}` made the unmodified CLI push its checkpoints to the sibling in the pushes made here (two
   per-checkpoint refs, and the legacy branch in question 3). The
   "fork in the meantime" fallback can be dropped; an upstream provider would only buy the CLI flag
   and a nicer `repo` value.
2. **Of the two token routes tested, only the git credential helper worked in both directions.**
   It needs `credential.useHttpPath=true` so the two repositories on one host get different tokens.
   `ENTIRE_CHECKPOINT_TOKEN` pushed fine, but the one read command tested (`entire checkpoint
   explain`) then looked in the *code* repository and reported "checkpoint not found"; with provider
   `gitlab` the same command addressed `gitlab.com` with the Authorization header set in the git
   command's environment (run with a dummy token, connection blocked). Provider `github` was not
   run, and `http.<url>.extraHeader` was not tested with Entire, so that route is not ruled out.
   Until it is tested: helper only, variable unset, provider name neither `github` nor `gitlab`.
3. **Artifacts accepts `refs/entire/checkpoints/<shard>/<id>`**, so the default `git-refs` backend
   is the one to use. The legacy branch backend also worked in the one run made, but is not needed,
   and it had a side effect: the sibling's `HEAD` resolved to `entire/checkpoints/v1` afterwards.
4. **A commit trailer without a checkpoint is a normal state, and can be permanent.** A push whose
   checkpoint token was invalid (rejected at once) still delivered the code, and the developer saw
   two terse lines; a slow or hanging sibling was not tested. And when
   Entire fails to condense a session the commit still carries a trailer whose checkpoint was never
   written. The forge must show "evidence pending" and "evidence missing" rather than assume the
   sibling has what the trailer names.
5. **A write token for the sibling can rewrite or delete any checkpoint.** Artifacts accepted a
   force-push and a delete on a ref under `refs/entire/`. Every developer needs sibling write access
   to push checkpoints, so the sibling is not tamper-proof evidence on its own; the forge should
   index a checkpoint when it arrives if it wants to detect later rewrites.
6. **A pre-configured repository needs no `entire enable`.** A fresh clone carrying the three
   committed files installs the git hooks on the first prompt and links the first commit.
   `commit_linking: "always"` removes the prompt for a human committing at a terminal.
7. **A plain `git clone` of the sibling is empty.** With the `git-refs` backend nothing is under
   `refs/heads/`; "one extra clone" to take the evidence elsewhere means
   `git fetch <sibling> '+refs/entire/*:refs/entire/*'`.
8. **For what was exercised, reading matches the research note**, including the cumulative
   transcript and its slice offsets. Exercised: Claude Code only, one two-turn session plus
   single-turn ones, unchunked transcripts, one session per checkpoint, no subagents. Each checkpoint
   ref had two commits (`Checkpoint:` then `Finalize transcript for Checkpoint:`), so the reader
   must take the ref tip. Both commits always arrived in one push here; a ref updated by a later
   push was not observed.

Corrections made to `spec/research/entire-capture.md` and `spec/research/artifacts.md` in the same
pull request are listed at the end.

## 1. Routing without a fork — `works`

**Ran.** `seed.sh`: `entire enable --agent claude-code --telemetry=false`, then replaced
`.entire/settings.json` with:

```json
{
  "enabled": true,
  "telemetry": false,
  "commit_linking": "always",
  "strategy_options": {
    "checkpoint_remote": {
      "provider": "artifacts",
      "repo": "git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints"
    }
  },
  "checkpoints": { "primary": { "type": "git-refs" } }
}
```

committed it with `.entire/.gitignore` and `.claude/settings.json`, pushed to `<code>`. Then a fresh
clone, one headless Claude Code prompt that edits and commits, and `git push origin main`.

**Came back.**

```
$ entire status
● Enabled · branch main
  Agents · Claude Code
  Checkpoints sync to: dedicated checkpoint remote (git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints)

$ git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote.... done
To <code>
   b7866e9..a4bccf7  main -> main

$ git ls-remote <sibling>
83a5561a7aaa00d24579c38aafd46ec307c5090b	refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE
```

The one thing that does not accept the provider name is the CLI flag, and it only warns:

```
$ entire enable --agent claude-code --telemetry=false --checkpoint-remote artifacts:git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints
Warning: invalid --checkpoint-remote format: unsupported provider "artifacts" (supported: github, gitlab)
  Installed 8 hooks for Claude Code - Anthropic's CLI coding assistant
  ✓ Configured project
```

**Means.** The route the research note derived from the code holds end to end: the settings file is
not validated against a provider list, the first path segment `git` passes the same-owner check, and
the URL is built from the push remote's host. No change to the CLI is required. The smallest change
that would be *nice* is one more `case` in `parseCheckpointRemoteFlag`; gitflare does not need it
because the forge writes the settings file. Not tested: a code repository that is a fork with a
different name pushing to the main repository's sibling (the same-owner check compares only the
`git` segment, so it should pass, but no fork was created here).

## 2. Authentication — `partial` (credential helper `works`; `ENTIRE_CHECKPOINT_TOKEN` push only)

**Ran.** Git config `credential.useHttpPath=true` plus `git-credential-artifacts`, which returns the
token for the repository named in `path=`. Then the same operations with the helper holding only the
code repository's token and `ENTIRE_CHECKPOINT_TOKEN` set. Reads were made from a clone with no
local checkpoint refs, with `git-shim` logging the git commands the CLI runs.

**Came back.** Helper, push — the helper is asked once per repository:

```
16:38:34 get host=<account-id>.<…> path=git/gitflare-spike-e-ns/gitflare-spike-e-code.git
16:38:35 get host=<account-id>.<…> path=git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints.git
```

Helper, read (`entire checkpoint explain --commit HEAD~1`):

```
● Checkpoint 01M3YQP715MH9266Q4XVX1D8SE
  session  66d922ab-5b8b-4ce4-9ec3-decdfaf4012a
  …
git ls-remote <sibling> refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=0]
git fetch --no-auto-gc --no-tags <sibling> +refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE:refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=0]
```

Environment variable, push (helper without the checkpoint token; first without the variable as a
control):

```
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote...
[entire] Checkpoint ref push failed; retrying 1 ref(s) individually... pushed 0 of 1
   … fatal: could not read Username for '<sibling>': terminal prompts disabled

$ ENTIRE_CHECKPOINT_TOKEN=<full token, including ?expires=…> git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote... done
```

Environment variable, read, provider `artifacts` — the fetch goes to the code repository:

```
$ ENTIRE_CHECKPOINT_TOKEN=<token> entire checkpoint explain --commit HEAD~1 --no-pager --short
checkpoint not found: 01M3YQP715MH9266Q4XVX1D8SE
git fetch --no-auto-gc --no-tags <code> +refs/heads/entire/checkpoints/v1:refs/entire-fetch-tmp/entire/checkpoints/v1 [auth-header-in-env=1]
git ls-remote <code> refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=1]
```

Environment variable, read, provider `gitlab` (local override, **dummy** token value; the sandbox
blocked the connection):

```
git ls-remote https://gitlab.com/git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints.git refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=1]
```

Token handling by Artifacts itself, with plain `git ls-remote <sibling>`:

| Presented as | Result |
|---|---|
| nothing | `could not read Username … terminal prompts disabled` |
| helper: username `x`, password = token without `?expires=` | ok |
| `Authorization: Bearer <full token>` | ok |
| `Authorization: Bearer <token without ?expires=>` | ok |
| `Authorization: Basic x-access-token:<token without ?expires=>` | ok |
| `Authorization: Basic x-access-token:<full token>` | ok |
| the code repository's token | `remote: Invalid or expired token` / HTTP 403 |

**Means.** Use a credential helper. It covered the push in the `pre-push` hook and the read command
tested, with no change to Entire, and being a program it can hand out a fresh token each time (not
exercised: no token expired during the test). It must be registered with
`credential.useHttpPath=true`: without the path git cannot tell the code repository from the
sibling, and a token for one repository was refused on the other. `ENTIRE_CHECKPOINT_TOKEN` is
unsuitable for gitflare for the reason the research note gave from the code: the read was
redirected. Fixing that needs a change in the CLI (`fetchURLResolved`), which gitflare has no
reason to make while the helper works.

Limits of this evidence:

- "Read" means one command, `entire checkpoint explain --commit`, which ran `git ls-remote` and
  `git fetch`. `entire session resume`, `checkpoint list` against a remote, and the push-recovery
  fetch were not run with either route (the recovery fetch appears only in the failure log of
  question 5, where it failed with the same bad token).
- Provider `github` was not run. Provider `gitlab` was run once with a dummy token and the
  connection was blocked by the sandbox; what is observed is the URL and that the git command's
  environment carried an Authorization header (`auth-header-in-env=1`), not bytes on the wire.
- `http.<url>.extraHeader` in git config was not tested with Entire (the Bearer form works with
  plain git), so it is untested, not excluded.

## 3. Refs — `works` (git-refs); legacy branch backend also `works`

**Ran.** The pushes above; a force-push and delete of a scratch ref under `refs/entire/`; then a
fresh clone with `{"checkpoints": {"primary": {"type": "git-branch"}}}` in an untracked
`.entire/settings.local.json`, one edit-and-commit session, `git push origin main`.

**Came back.** git-refs: one ref per checkpoint, ULID ids, shard = last two characters:

```
f7eb5850e80286e5724a205f5801ac07185f2fe6	refs/entire/checkpoints/NW/01M3YQQJVN37X48WND4YW3N1NW
83a5561a7aaa00d24579c38aafd46ec307c5090b	refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE
```

Rewriting a ref outside `refs/heads/` (`a`, `b` are unrelated commits):

```
$ git push <sibling> <a>:refs/entire/spike/nonff
 * [new reference]   21285fae… -> refs/entire/spike/nonff
$ git push <sibling> <b>:refs/entire/spike/nonff          # refused by the git client, before sending
hint: Updates were rejected because a pushed branch tip is behind its remote
$ git push --force <sibling> <b>:refs/entire/spike/nonff
 + 21285fa...b5fdccd b5fdccd8… -> refs/entire/spike/nonff (forced update)
$ git push <sibling> :refs/entire/spike/nonff
 - [deleted]         refs/entire/spike/nonff
```

Legacy backend: a 12-hex id, and a branch in the sibling:

```
2b61d1e Legacy backend commit …  Entire-Checkpoint: 40896ba8ff1a
$ git push origin main
[entire] Pushing entire/checkpoints/v1 to checkpoint remote... done
$ git ls-remote <sibling>
cd96739bab14f3d376c556fdb24bd8fd0d47be5f	HEAD
f7eb5850e80286e5724a205f5801ac07185f2fe6	refs/entire/checkpoints/NW/01M3YQQJVN37X48WND4YW3N1NW
83a5561a7aaa00d24579c38aafd46ec307c5090b	refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE
cd96739bab14f3d376c556fdb24bd8fd0d47be5f	refs/heads/entire/checkpoints/v1
$ git ls-remote --symref <sibling> HEAD
ref: refs/heads/entire/checkpoints/v1	HEAD
cd96739bab14f3d376c556fdb24bd8fd0d47be5f	HEAD
```

Before this push the sibling held the two `refs/entire/…` refs from the earlier runs and no branch;
its `ls-remote` listed no `HEAD` (see question 1).

with the checkpoint at `40/896ba8ff1a/` on that branch and `sessions[].*` paths prefixed
`/40/896ba8ff1a/…`.

**Means.** The `git-branch` fallback in the research note is not needed. If it is ever used, expect
the sibling's `HEAD` to resolve to the checkpoint branch (the repository was created with default
branch `main`, which does not exist there). This was one run with one developer. Artifacts does not enforce fast-forward-only updates on
these refs: a force-push and a delete were both accepted, so any holder of a sibling write token can
replace or remove a checkpoint. Not tested: whether a push to `refs/entire/*` emits a
`cf.artifacts.repo.pushed` event (needs a deployed Worker; out of this task's set-up), and two
developers pushing the legacy branch concurrently.

## 4. The read path the forge needs — `works`

**Ran.** `git init --bare ckpt.git && git -C ckpt.git fetch <sibling> '+refs/*:refs/*'`, then
`git -C <code clone> log -1 --format=%B <sha> | read_checkpoint.py ckpt.git` for the two commits of
one two-turn session (the second turn was `claude -p --resume <session id>`).

**Came back.** A plain clone gets nothing; the explicit fetch gets the refs:

```
$ git clone <sibling> plain
warning: You appear to have cloned an empty repository.
```

Second checkpoint (trimmed):

```
trailers: ['01M3YQQJVN37X48WND4YW3N1NW']
ref: refs/entire/checkpoints/NW/01M3YQQJVN37X48WND4YW3N1NW  tip: f7eb5850…  root: /
history:
  f7eb585 1cd1dbd| Finalize transcript for Checkpoint: 01M3YQQJVN37X48WND4YW3N1NW
  1cd1dbd | Checkpoint: 01M3YQQJVN37X48WND4YW3N1NW
tree:
  100644 blob dd2bfc74…      71	0/content_hash.txt
  100644 blob 15a84328…  219272	0/full.jsonl
  100644 blob 13ba590b…    1217	0/metadata.json
  100644 blob 4a25598f…     109	0/prompt.txt
  100644 blob 8440239e…    5178	0/transcript.jsonl
  100644 blob 05397191…     598	metadata.json
root metadata.json:
  "cli_version": "0.11.3", "checkpoint_id": "01M3YQQJVN37X48WND4YW3N1NW", "strategy": "manual-commit",
  "branch": "main", "checkpoints_count": 1, "files_touched": ["README.md"],
  "sessions": [{"metadata": "/0/metadata.json", "transcript": "/0/full.jsonl",
    "compact_transcript": "/0/transcript.jsonl", "content_hash": "/0/content_hash.txt", "prompt": "/0/prompt.txt"}],
  "token_usage": {"input_tokens": 26, "cache_creation_tokens": 690, "cache_read_tokens": 67347, "output_tokens": 456, "api_call_count": 3}
session 0 metadata.json:
  "session_id": "66d922ab-5b8b-4ce4-9ec3-decdfaf4012a", "created_at": "2026-10-02T16:39:05.528476Z",
  "agent": "Claude Code", "model": "claude-haiku-4-5-20251001", "turn_id": "0c264ba79861",
  "checkpoint_transcript_start": 50, "transcript_lines_at_start": 50, "compact_transcript_start": 6,
  "session_metrics": {"turn_count": 1},
  "initial_attribution": {"agent_lines": 1, …, "agent_percentage": 100, "metric_version": 2},
  "prompt_attributions": [{"checkpoint_number": 1, …}]
full.jsonl: 77 lines, 1 chunk(s); this checkpoint = lines[50:] (27 lines)
  last line before slice: assistant: "Done. Added 'hello from session one' to README.md and committed with message 'Add greeting"
    user: "Now append the line 'second turn' to README.md and commit it with the message 'Second line"
    …
    assistant: "Done. Added 'second turn' to README.md and committed with message 'Second line'."
transcript.jsonl: 11 lines; compact_transcript_start=6; slice:
    {'v': 1, 'agent': 'claude-code', 'cli_version': '0.11.3', 'type': 'user'} [{"id": "7280c0de-…", "text": "Now append the line 'second turn' …
    …
prompt.txt: "Now append the line 'second turn' to README.md and commit it with the message 'Second line'. Do nothing else."
content_hash.txt: sha256:2c3e854d… | matches sha256(full.jsonl): True
```

The first checkpoint of the same session holds 50 `full.jsonl` lines and 6 compact lines — exactly
the second one's offsets. Line counts per commit on the two refs:

| Commit | Subject | `full.jsonl` lines | `transcript.jsonl` lines |
|---|---|---|---|
| `df224fb` | `Checkpoint: …SE` | 44 | 5 |
| `83a5561` | `Finalize transcript for Checkpoint: …SE` | 50 | 6 |
| `1cd1dbd` | `Checkpoint: …NW` | 71 | 10 |
| `f7eb585` | `Finalize transcript for Checkpoint: …NW` | 77 | 11 |

First checkpoint of the same session, for comparison (trimmed; note there is no
`checkpoint_transcript_start` key):

```
trailers: ['01M3YQP715MH9266Q4XVX1D8SE']
tree:
  100644 blob deb307bd…  193119	0/full.jsonl
  100644 blob 77d016dd…    2868	0/transcript.jsonl
  …
session 0 metadata.json:
  "checkpoints_count": 1, …, "turn_id": "07b4067a9171",
  "compact_transcript_start": 0,
  "token_usage": {…}, "initial_attribution": {…}, "prompt_attributions": [{"checkpoint_number": 1, …}]
full.jsonl: 50 lines, 1 chunk(s); this checkpoint = lines[0:] (50 lines)
  line types: {'queue-operation': 2, 'attachment': 26, 'user': 5, 'atis-latch': 3, 'last-prompt': 2, 'ai-title': 2, 'assistant': 10}
transcript.jsonl: 6 lines; compact_transcript_start=0; slice:
    … [{"id": "toolu_01Hb6ptwmsh2GTnKwTgdTRYM", "input": {"file_path": "/private/tmp/claude-501/gf15/clone2/README.md"}, "name": "Read", …

$ git log -1 --format='%s | %an | sig=%G?' 83a5561
Finalize transcript for Checkpoint: 01M3YQP715MH9266Q4XVX1D8SE | Spike E | sig=N
```

**Means.** For the cases exercised — Claude Code, one session per checkpoint, transcripts in a
single chunk, no subagents — the layout, both metadata shapes, the leading-`/` session paths, the
trailers on the checkpoint commit, `content_hash.txt` and the slicing rule in the research note
match what the CLI wrote. Chunked transcripts, several sessions on one checkpoint, `tasks/`, and
other agents were not exercised. Details the forge's reader should know:

- `checkpoint_transcript_start` was absent on the session's first checkpoint while
  `compact_transcript_start: 0` was present (output above); treat a missing value as 0.
- The first commit on a ref was written at commit time, mid-turn, and lacked the end of the turn
  (44 against 50 lines in the table); the `Finalize` commit completed it. Both were queued and
  pushed together in every run here, because each push came after the turn had ended. What an agent
  that pushes inside its turn delivers was not tested; from the queue behaviour the likely outcome
  is the first commit alone and the second on a later push, so the reader should not assume a ref
  is final on first sight.
- Root and session `checkpoints_count` were 1 on both checkpoints of the two-turn session (outputs
  above), so it was not a running total there.
- `full.jsonl` is large relative to the work: 193,119 bytes for a four-call session (26 of its 50
  lines are Claude Code `attachment` lines), 219,272 bytes cumulative after the second turn.
  Transcript content includes absolute local paths (visible in the tool input above).
- The checkpoint commits were unsigned here (`sig=N`); the isolated git config had no signing set
  up, so signing was not exercised.

## 5. Ordering and failure — `works` (checkpoint first; the failures tested did not block the code push)

**Ran.** `GIT_TRACE=1 git push origin main`; then a push with an invalid checkpoint token, a push
with `checkpoint_remote` pointed (local override) at a repository that does not exist, and a push
with no checkpoint credential at all.

**Came back.** Order, from the trace:

```
18:38:34.432985 trace: run_command: .git/hooks/pre-push origin <code>
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote.... done
18:38:35.522728 run_processes_parallel: done
18:38:35.522794 trace: run_command: git send-pack --stateless-rpc --helper-status --thin --no-progress <code>/ --stdin
To <code>
   b7866e9..a4bccf7  main -> main
```

Invalid token — everything the developer sees:

```
$ git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote...
[entire] Checkpoint ref push failed; retrying 1 ref(s) individually... pushed 0 of 1
To <code>
   a4bccf7..dd648c8  main -> main
exit=0

$ entire status
  Checkpoints sync to: dedicated checkpoint remote (git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints)
  1 checkpoint not yet pushed
```

The reason is only in `.entire/logs/entire.log`:

```
"msg":"git-refs pre-push: checkpoint ref push failed; refs left queued", … "error":"… git push: exit status 128 (remote: Invalid or expired token fatal: unable to access '<sibling>/': The requested URL returned error: 403) (checkpoint ref recovery failed: fetch failed: remote: Invalid or expired token …"
```

Missing repository — the same two lines on screen, and the same server response as a bad token:

```
remote: Invalid or expired token
fatal: unable to access 'https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-e-ns/gitflare-spike-e-missing.git/': The requested URL returned error: 403
```

The ref stayed in `.git/entire-checkpoint-push-queue.jsonl` through three failed pushes and was sent
by the next push that had a working credential, even though that push had no code to send
(`Everything up-to-date`).

Two further observations from the same runs:

- In a run where Claude Code could not write its transcript file (the first attempt, inside a
  sandbox), `prepare-commit-msg` had already added `Entire-Checkpoint: 01M3YQM9RM702QH2DFDGRXSS95`
  to the commit when `post-commit` logged `condensation failed … transcript not found`. No
  checkpoint ref was ever created for that id. A second commit, made by hand in a clone whose
  history had been reset during testing, ended the same way (`failed to get commit object: object
  not found`; cause not isolated).
- In that failed case `post-commit` ran `git ls-remote <sibling> refs/entire/checkpoints/95/…`: a
  commit can make a network call to the sibling. From `.entire/logs/entire.log` (the sandbox
  refused the connection):

  ```
  "msg":"failed to update combined checkpoint attribution", … "checkpoint_id":"01M3YQM9RM702QH2DFDGRXSS95","error":"reading checkpoint summary: fetch checkpoint ref refs/entire/checkpoints/95/01M3YQM9RM702QH2DFDGRXSS95: probe checkpoint ref … on <sibling>: git ls-remote: exit status 128 (fatal: unable to access '<sibling>/': CONNECT tunnel failed, response 403)"
  ```

  In the successful runs the credential helper's log has no entry at commit time.

**Means.** The research note's reading held in these runs: checkpoint first, synchronous, fail-soft,
with the ref left queued. All three failures were immediate rejections (the push with the invalid
token took about one second in total); a sibling that hangs, times out or is unreachable was not
tested, so how long the hook can delay a code push is unknown. Only the first of the three pushes
had code to send; the other two were `Everything up-to-date` and show the queue surviving, not a
code push surviving. The forge will regularly see a code commit whose checkpoint has not arrived,
and occasionally one whose checkpoint never will. Both need a visible state on the change page. The
on-screen message does not say why the push failed, and Artifacts answers a missing repository like
a bad token, so gitflare's own tooling (the login command or the helper) should be what tells a
developer their sibling token is wrong.

## 6. A pre-configured repository — `works`

**Ran.** Fresh clones of `<code>` (which carries `.entire/settings.json`, `.entire/.gitignore`,
`.claude/settings.json`), `entire` on `PATH`, no `entire enable`. Agent commit: one prompt that
edits and commits. Human commit: an edit-only prompt, then `human-commit.sh` — `git commit -am`
under a pseudo-terminal with the agent's environment variables removed — once with the committed
`commit_linking: "always"`, once with `{"commit_linking": "prompt"}` in `settings.local.json`,
answering `n`.

**Came back.**

```
$ ls .git/hooks | grep -v sample          # after clone: nothing
$ session.sh clone2 "Append the line … then commit …"
$ ls .git/hooks | grep -v sample
commit-msg  post-commit  post-rewrite  pre-push  prepare-commit-msg
$ git log -1 --format=%B
Add greeting

Entire-Checkpoint: 01M3YQP715MH9266Q4XVX1D8SE
```

```
=== committed commit_linking=always, human at a TTY
[main d3e62b0] Human commit (always)
d3e62b0 Human commit (always) | trailer=[01M3YRNB02200R8PJMMXQDGJBK]

=== commit_linking=prompt via settings.local.json, answer n
Entire: Active Claude Code session detected
  Last prompt: Append the line 'edit for prompt' to README.md. Do not commit and do not run ...

Link this commit to session context?
  [Y]es / [n]o / [a]lways (remember my choice): n
[main a3b9656] Human commit (prompt, declined)
a3b9656 Human commit (prompt, declined) | trailer=[]
```

**Means.** The forge can pre-configure a repository by committing three files; a developer needs the
`entire` binary and a credential helper, nothing else. Keep `commit_linking: "always"` in the
committed file: with `prompt`, a human declined and the commit arrived unlinked. A commit made in a
fresh clone *before* the first prompt was not run; the hook directory was empty until the first
prompt (output above), so git had no `prepare-commit-msg` hook to add a trailer — an inference, as
in the research note. Also seen: the same human commit run from a shell that still had
Claude Code's environment variables (`CLAUDECODE`, `CLAUDE_CODE_*`) showed no prompt under
`commit_linking: "prompt"` and added the trailer; which variable causes that was not isolated.

## Other observations

- **A blobless clone completed; lazy fetching was not tested.** One run:

  ```
  $ GIT_TRACE_PACKET=1 git ls-remote <code>
  packet:          git< version 2
  packet:          git< agent=gitty/1.0
  packet:          git< fetch=shallow filter sideband-all
  $ git clone --bare --filter=blob:none <code> blobless
  Cloning into bare repository 'blobless'...
  $ git -C blobless count-objects -v
  count: 0
  in-pack: 10
  $ git -C blobless rev-list --objects --all --missing=print | grep -c '^?'
  6
  ```

  So the server honoured the filter on clone. Fetching a missing blob on demand (a checkout, or
  `git cat-file` of a missing object) was not tried here, and neither was Entire's
  `filtered_fetches`. The Artifacts live test (`artifacts-git.md`) did test on-demand fetching and
  found partial clone working over protocol v2.
- **The token format is not the documented one.** Tokens from `wrangler artifacts repos create` look
  like `art_v2_x_<40 hex>?expires=<unix seconds>` in this unrestricted namespace (`artifacts-git.md`
  saw `art_v2_e_` in an `eu` namespace). The `expires` value of the initial token was
  24 hours after creation (`2026-10-03T16:34:47Z` for a repository created at
  `2026-10-02T16:34:47Z`); the test ended long before that, so expiry itself was not observed.
- **Namespaces can be deleted.** `DELETE /accounts/<account-id>/artifacts/namespaces/<namespace>`
  returned 204 for the empty namespace; the route is in Cloudflare's OpenAPI description but not on
  the REST docs page, and wrangler 4.147.0 has no command for it. It was issued through the
  Cloudflare API MCP tool this thread is authorised for (`search` to find the route, `execute` for a
  `GET` that confirmed `repo_count: 0`, then the `DELETE`); no API token was created. `wrangler artifacts repos delete
  <name> --namespace <ns> --force` deletes a repository.
- **The Entire CLI calls `api.github.com`** on `enable`, `status` and `checkpoint explain` even with
  telemetry off (seen as blocked connections in the sandbox; what it requests was not inspected).
- **Claude Code inside a sandbox that denies writes to `~/.claude/projects` captures nothing**: the
  hooks run and the trailer is added, but there is no transcript to condense. A cloud workspace must
  let the agent persist its transcript where Entire's hook is told to find it.

## Cost and cleanup

Model: eight headless Claude Code sessions on Haiku 4.5, $0.209 in total at list price as reported
by `claude -p --output-format json`. Cloudflare: Artifacts operations only, inside the included
allowance and before billing starts — $0.

| # | Clone | Prompt | Used for | Cost |
|---|---|---|---|---|
| 1 | `clone1`, inside the sandbox | edit + commit | transcript could not be written: dangling trailer, commit-time probe (question 5) | $0.029 |
| 2 | `clone2` | edit + commit | questions 1, 2, 3, 5, 6 | $0.031 |
| 3 | `clone2`, `--resume` of 2 | edit + commit | questions 4, 5 | $0.045 |
| 4 | `clone2` | edit only | first human-commit attempt, run with the agent's environment variables still set (question 6, last sentence) | $0.017 |
| 5 | `clone2` | edit only | second human-commit attempt after a `git reset --soft`; answer typed too early; condensation failed (question 5) | $0.017 |
| 6 | `clone4` | edit only | human commit, `always` (question 6) | $0.024 |
| 7 | `clone4` | edit only | human commit, `prompt` declined (question 6) | $0.017 |
| 8 | `clone5` | edit + commit | legacy branch backend (question 3) | $0.028 |

Sessions 4 and 5 were a mis-designed first attempt at the human commit and are not in the README's
steps; their only lasting results are the two observations attributed to them above.

On the account: namespace `gitflare-spike-e-ns` and repositories `gitflare-spike-e-code` and
`gitflare-spike-e-checkpoints` were created, and all three deleted on 2026-10-02 (repositories with
`wrangler artifacts repos delete … --force`, the namespace with the REST route above). Afterwards
`wrangler artifacts repos list --namespace gitflare-spike-e-ns` reported no repositories and the
namespace list returned by the API no longer contained the namespace. Nothing of this task is left
on the account.

On the machine: the scratch directory (clones, binary, logs, token files) is deleted. Left behind
are Claude Code's own transcripts of sessions 2–8 (session 1 could not write one), in
`~/.claude/projects/` under `-private-tmp-claude-501-gf15-clone2`, `…-clone4` and `…-clone5`; the
command sandbox does not allow deleting there. The sessions only read and edited a scratch
`README.md` and ran `git add`/`git commit`; no token was ever passed to them.

## Corrections made to the research notes

`spec/research/entire-capture.md`:

- "An unmodified CLI can probably already target a sibling repo" and the matching "Could not verify"
  entries (refs outside `refs/heads/`, the no-code-change route, `ENTIRE_CHECKPOINT_TOKEN`, the
  credential helper in `pre-push`, fast-forward enforcement, `--filter=blob:none`) now state what
  was observed and point here.
- The legacy-backend line said the v1 branch "is not pushed to a remote that has no remote-tracking
  refs yet, so it cannot become the default branch". With a `checkpoint_remote` it was pushed to a
  sibling that had no branch (only `refs/entire/*` refs), and the sibling's `HEAD` then pointed at it.
- The Artifacts token format quoted from Cloudflare's page (`art_v1_…`) is annotated with the
  observed `art_v2_x_…`.

`spec/research/artifacts.md` — the Artifacts live test (`artifacts-git.md`) merged first and
corrected the same facts more thoroughly; its wording is kept. What this test adds there:

- The token prefix in an unrestricted namespace (`art_v2_x_`, next to the `art_v2_e_` seen in `eu`).
- Basic auth accepts the token with or without its `?expires=` suffix, and a valid token against a
  repository name that does not exist gets the same 403 as a wrong token.
