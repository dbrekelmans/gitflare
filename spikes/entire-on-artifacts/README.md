# Spike: unmodified Entire CLI capturing into a sibling Artifacts repository

Throwaway scripts behind `spec/research/live/entire-on-artifacts.md` (GF-15). They create two
Artifacts repositories in a real, billed Cloudflare account and drive a handful of tiny headless
Claude Code sessions (Haiku, about $0.02–0.05 each). Nothing here holds an account id or a token:
both are read from `$GF15/secrets`, which `setup.sh` writes and `cleanup.sh` removes.

Needs: macOS on arm64 (the binary download is pinned to `entire_darwin_arm64` v0.11.3), `git`,
`python3`, `npx`, a `wrangler login` on the target account, and a logged-in `claude` CLI.

## Files

| File | What it is |
|---|---|
| `env.sh` | Sourced by everything. Scratch dir, `PATH` (Entire binary, credential helper), an isolated git config, `mask` for output. |
| `setup.sh` | Creates `gitflare-spike-e-code` and `gitflare-spike-e-checkpoints` in namespace `gitflare-spike-e-ns`, downloads and checksums Entire v0.11.3 into `$GF15/bin`. |
| `seed.sh` | `entire enable`, then the hand-written `settings.json.tmpl`; commits and pushes the pre-configured code repository. |
| `settings.json.tmpl` | The committed `.entire/settings.json`: `checkpoint_remote` in `{provider, repo}` form, `commit_linking: always`. |
| `git-credential-artifacts` | Credential helper: one repo-scoped token per repository path (`credential.useHttpPath=true`). |
| `session.sh` | One headless Claude Code turn in a clone, project settings only. |
| `human-commit.sh` | `git commit -m` under a pseudo-terminal with the agent's environment variables stripped. |
| `git-shim` | Logs the network git commands the CLI runs (it does not pass `GIT_TRACE` through). |
| `read_checkpoint.py` | Commit trailer → checkpoint ref → metadata → transcript slice, from a bare clone of the sibling repository. |
| `cleanup.sh` | Deletes both repositories and the local token files. |

## Steps

Use one scratch directory for the whole run. Inside a command sandbox `$TMPDIR` differs from
outside it, so set `GF15` explicitly.

```sh
export GF15=/tmp/gf15            # any empty scratch directory
export EXPECTED_ACCOUNT="<account name>"   # setup.sh stops if `wrangler whoami` reports another
S=spikes/entire-on-artifacts

# 1. Repositories, binary, git config. Outside the sandbox (wrangler).
$S/setup.sh
$S/seed.sh
. $S/env.sh

# 2. Questions 6 and 1: fresh clone, no `entire enable`, first prompt.
#    Outside the sandbox: Claude Code must be able to write its transcript under ~/.claude/projects.
git clone "$CODE_URL" $GF15/clone2
ls $GF15/clone2/.git/hooks | grep -v sample          # nothing: hooks are not installed yet
$S/session.sh $GF15/clone2 "Append the line 'hello from session one' to README.md, then commit that change with git using the message 'Add greeting'. Do nothing else." > $GF15/session2.json
cd $GF15/clone2
ls .git/hooks | grep -v sample                         # five Entire hooks
git log -1 --format=%B                                 # Entire-Checkpoint trailer
git for-each-ref refs/entire; cat .git/entire-checkpoint-push-queue.jsonl

# 3. Questions 1, 2, 3, 5: push; the pre-push hook sends the checkpoint ref to the sibling first.
GIT_TRACE=1 git push origin main
git ls-remote "$CKPT_URL"

# 4. Second turn of the same session (cumulative transcript, question 4).
SID=$(python3 -c "import json;print(json.load(open('$GF15/session2.json'))['session_id'])")
$S/session.sh $GF15/clone2 "Now append the line 'second turn' to README.md and commit it with the message 'Second line'. Do nothing else." --resume "$SID"

# 5. Question 5, failures. A token directory whose checkpoint token is invalid:
mkdir -p $GF15/secrets-bad && cp $GF15/secrets/$CODE_REPO.token $GF15/secrets-bad/
printf 'art_v2_x_%040d?expires=<unix-seconds>' 0 > $GF15/secrets-bad/$CKPT_REPO.token   # any future timestamp
ARTIFACTS_TOKEN_DIR=$GF15/secrets-bad git push origin main      # code goes through, checkpoint stays queued
entire status                                                    # "1 checkpoint not yet pushed"
#    A checkpoint repository that does not exist (local override, then remove it again):
cp $GF15/secrets/$CKPT_REPO.token $GF15/secrets/gitflare-spike-e-missing.token
echo '{ "strategy_options": { "checkpoint_remote": { "provider": "artifacts", "repo": "git/'$NS'/gitflare-spike-e-missing" } } }' > .entire/settings.local.json
git push origin main; rm .entire/settings.local.json

# 6. Question 2, ENTIRE_CHECKPOINT_TOKEN for the push (helper has only the code token).
#    First the control with no checkpoint credential at all, then with the variable:
mkdir -p $GF15/secrets-codeonly && cp $GF15/secrets/$CODE_REPO.token $GF15/secrets-codeonly/
ARTIFACTS_TOKEN_DIR=$GF15/secrets-codeonly git push origin main   # "could not read Username", ref stays queued
ARTIFACTS_TOKEN_DIR=$GF15/secrets-codeonly ENTIRE_CHECKPOINT_TOKEN="$(cat $GF15/secrets/$CKPT_REPO.token)" git push origin main

# 7. Question 2, fetch paths, from a clone with no local checkpoints.
git clone "$CODE_URL" $GF15/clone3 && cd $GF15/clone3
export REAL_GIT=$(command -v git) PATH="$GF15/shim:$PATH"; : > $GF15/gitshim.log
ARTIFACTS_TOKEN_DIR=$GF15/secrets-codeonly ENTIRE_CHECKPOINT_TOKEN="$(cat $GF15/secrets/$CKPT_REPO.token)" \
  entire checkpoint explain --commit HEAD~1 --no-pager --short   # "checkpoint not found"; gitshim.log shows the code repo URL
entire checkpoint explain --commit HEAD~1 --no-pager --short     # helper: works; gitshim.log shows the sibling URL
#    Never run the env-var variant with provider "github"/"gitlab" and a real token: the fetch goes to
#    that public host with the token attached. Use a dummy value to see it.

# 8. Question 4: bare fetch of the sibling alone.
git init --bare $GF15/ckpt.git && git -C $GF15/ckpt.git fetch "$CKPT_URL" '+refs/*:refs/*'
git -C $GF15/clone2 log -1 --format=%B HEAD | $S/read_checkpoint.py $GF15/ckpt.git

# 9. Question 6, a human at a terminal (needs a real pty; outside the sandbox).
git clone "$CODE_URL" $GF15/clone4
$S/session.sh $GF15/clone4 "Append the line 'edit for always' to README.md. Do not commit and do not run git."
$S/human-commit.sh $GF15/clone4 "Human commit (always)"                    # no prompt, trailer added
$S/session.sh $GF15/clone4 "Append the line 'edit for prompt' to README.md. Do not commit and do not run git."
echo '{ "commit_linking": "prompt" }' > $GF15/clone4/.entire/settings.local.json
$S/human-commit.sh $GF15/clone4 "Human commit (prompt, declined)" n       # prompt shown, no trailer

# 10. Question 3, legacy branch backend.
git clone "$CODE_URL" $GF15/clone5
echo '{ "checkpoints": { "primary": { "type": "git-branch" } } }' > $GF15/clone5/.entire/settings.local.json
$S/session.sh $GF15/clone5 "Append the line 'legacy backend' to README.md, then commit that change with git using the message 'Legacy backend commit'. Do nothing else."
cd $GF15/clone5 && git push origin main && git ls-remote --symref "$CKPT_URL"

# 11. The run in which Claude Code cannot write its transcript (dangling trailer, commit-time
#     probe of the sibling). Run this one INSIDE a command sandbox that denies writes to
#     ~/.claude/projects and allows only api.anthropic.com; outside such a sandbox it simply succeeds.
git clone "$CODE_URL" $GF15/clone1
$S/session.sh $GF15/clone1 "Append the line 'hello from session one' to README.md, then commit that change with git using the message 'Add greeting'. Do nothing else."
git -C $GF15/clone1 log -1 --format=%B; git -C $GF15/clone1 for-each-ref refs/entire   # trailer, no ref
grep -E '"level":"WARN"' $GF15/clone1/.entire/logs/entire.log

# 12. Clean up (outside the sandbox).
$S/cleanup.sh
```

The namespace was deleted with the Cloudflare API MCP tool (`execute`), not with an API token:
a `GET /accounts/<account-id>/artifacts/namespaces/gitflare-spike-e-ns` to confirm `repo_count: 0`,
then `DELETE` on the same path (204). No other way of issuing that call was tried.

Not reproducible from these steps: the second dangling trailer in the note. It came from two extra
edit-only sessions in `clone2` and a `git reset --soft` made while the human-commit test was still
being worked out; the exact sequence was not kept as a script, and its cause was not isolated.

Other one-off checks in the note (`Bearer`/`Basic` token variants, force-push and delete of a ref
under `refs/entire/`, `git clone --filter=blob:none`) are plain git commands quoted there in full.

`setup.sh`, `seed.sh` and `cleanup.sh` collect commands that were typed by hand during the test;
they are syntax-checked but were not re-run as scripts. The other files are the ones that ran.
