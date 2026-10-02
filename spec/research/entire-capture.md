# Entire CLI: checkpoint format, capture mechanics and checkpoint remotes

Verified 2026-10-02 against live docs.

Primary source is the code of [`entireio/cli`](https://github.com/entireio/cli) at commit
[`89c2616`](https://github.com/entireio/cli/commit/89c26160877a27a5017dc0bd614768c463e793bd)
(`main`, 2026-10-01; tag `v0.11.4-nightly.202610020627.89c261608`), read from a clone. Source links
below are pinned to that commit. Where the repo's own docs and its code disagree, the code is quoted
and the disagreement is called out. The on-disk format was additionally checked against real
checkpoints fetched from the public repository
[`entireio/cli-checkpoints`](https://github.com/entireio/cli-checkpoints). Nothing was compiled or
run (no Go toolchain); statements about runtime behaviour are from reading code unless marked
"observed".

## What this forces

- **There is no `Entire-Attribution` commit trailer.** Only
  [`docs/architecture/attribution.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/attribution.md)
  mentions it; no Go code emits or parses it, and 0 of the last 2000 commits in `entireio/cli` carry
  it (1144 carry `Entire-Checkpoint`). Attribution is read from the checkpoint:
  `initial_attribution` in the session `metadata.json`, `combined_attribution` in the root one.
- **The only trailer on a code commit is `Entire-Checkpoint: <id>`**, and it may appear several
  times on one commit (squash, redone commits). A reader must collect all of them.
- **A checkpoint is not immutable.** Each per-checkpoint ref has its own commit history: the first
  commit is `Checkpoint: <id>`, later ones (e.g. `Finalize transcript for Checkpoint: <id>`) are
  parented on it and pushed as fast-forwards. In a systematic sample of 99 refs from
  `entireio/cli-checkpoints` (every 27th ULID ref, 2026-10-02), 87 had 2–5 commits and 12 had one.
  A consumer must treat a push to an existing checkpoint ref as an update and read the ref tip.
- **Every checkpoint stores the whole session so far, not a delta.** `full.jsonl` and
  `transcript.jsonl` hold the full session; `checkpoint_transcript_start` /
  `compact_transcript_start` in the session metadata mark where this checkpoint's slice begins. A
  reader aggregating several checkpoints of one session must slice or it will count turns many
  times. Storage grows accordingly (observed: one checkpoint with an 8.8 MB `full.jsonl`).
- **`checkpoint_remote` is not a URL and a "provider" is not an interface.** It is
  `{"provider": string, "repo": "owner/name"}`; the URL is built from the *push remote's* scheme and
  host plus `repo`. There is no generic "any git URL" value. The only provider-specific code is a
  `provider → public host` switch, the CLI flag validator, and the claim-command printer.
- **An unmodified CLI can probably already target a sibling repo on a non-GitHub/GitLab host.**
  For an HTTPS push remote on a host other than `github.com`/`gitlab.com` the derived URL is
  `https://<that host>/<repo>.git`, the provider string is not validated when read from the settings
  file, and `repo` may contain more than one `/`. This is an inference from reading the code, not
  an executed test, and it holds for pushes and for fetches only while `ENTIRE_CHECKPOINT_TOKEN` is
  unset — see "What an Artifacts provider needs".
- **Checkpoints are pushed with the system `git` binary**, from the `pre-push` hook, as
  `git push --no-verify --porcelain <target> <ref>:<ref>…`. Credential helpers and git config
  therefore apply; the CLI has no credential logic of its own beyond one env var
  (`ENTIRE_CHECKPOINT_TOKEN`, sent as HTTP Basic). That env var is **not** safe to use unmodified
  with a non-GitHub/GitLab host: with it set, checkpoint *fetches* go to `github.com`/`gitlab.com`
  (token included) or to `origin`, never to the derived sibling URL.
- **The checkpoint push happens before the code push but is fail-soft.** The hook pushes checkpoint
  refs synchronously, then git sends the user's refs. A failed checkpoint push is swallowed and the
  refs stay queued for the next `git push`, so the code can arrive without its checkpoint, possibly
  for a long time.
- **Default `commit_linking` is `prompt`**: a human committing with `-m` at a terminal is asked
  whether to link the commit, and may decline (no trailer). Agent commits (no TTY) always link. A
  pre-configured settings file should set `"commit_linking": "always"` if every commit is expected
  to carry a trailer.
- **Redaction differs from earlier notes**: five passes are always on (entropy, provider token
  prefixes, credentialed URIs, DB connection strings, bounded credential values); the Betterleaks
  pattern scanner is a *configurable* engine (default on; at least one of Betterleaks/goredact must
  be enabled). The compact transcript additionally drops all `thinking` blocks.

## Verified facts

### The repository

| | |
|---|---|
| URL | <https://github.com/entireio/cli> (default branch `main`) |
| Licence | MIT, "Copyright (c) 2026 Entire Inc." — [`LICENSE`](https://github.com/entireio/cli/blob/89c2616/LICENSE) |
| Language | Go; `module github.com/entireio/cli`, `go 1.27.1` — [`go.mod`](https://github.com/entireio/cli/blob/89c2616/go.mod) |
| Git library | `github.com/go-git/go-git/v6` (pinned pre-release) for object/ref plumbing; network operations shell out to `git` — [`go.mod`](https://github.com/entireio/cli/blob/89c2616/go.mod), [`checkpoint/remote/git.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/git.go#L671-L720) |
| Latest stable | `0.11.3`, 2026-09-25 — [`CHANGELOG.md`](https://github.com/entireio/cli/blob/89c2616/CHANGELOG.md) |
| Nightly | daily at 06:00 UTC (`cron: "0 6 * * *"`), tags `v<next>-nightly.<timestamp>.<sha>` — [`.github/workflows/nightly.yml`](https://github.com/entireio/cli/blob/89c2616/.github/workflows/nightly.yml) |
| Binaries | `entire` (`cmd/entire`) and `git-remote-entire` (`cmd/git-remote-entire`, a git remote helper for `entire://` URLs; not needed for checkpointing) — [`README.md`](https://github.com/entireio/cli/blob/89c2616/README.md) |
| Toolchain | [mise](https://mise.jdx.dev) (`mise.toml`): Go 1.27.1, golangci-lint 2.13.2, gotestsum, shellcheck, tmux |
| Release | GoReleaser Pro on tag push; `CGO_ENABLED=0`; darwin/linux/windows × amd64/arm64; macOS notarisation; Homebrew cask `entireio/tap/entire` (+ `entire@nightly`); Scoop bucket `entireio/scoop-bucket`; install scripts `https://entire.io/install.sh` and `install.ps1` — [`.goreleaser.yaml`](https://github.com/entireio/cli/blob/89c2616/.goreleaser.yaml), [`release.yml`](https://github.com/entireio/cli/blob/89c2616/.github/workflows/release.yml), [`README.md`](https://github.com/entireio/cli/blob/89c2616/README.md) |
| Build from source | `go install github.com/entireio/cli/cmd/entire@latest` — [`README.md`](https://github.com/entireio/cli/blob/89c2616/README.md) |

Test setup, from [`mise.toml`](https://github.com/entireio/cli/blob/89c2616/mise.toml) and
[`docs/development/testing.md`](https://github.com/entireio/cli/blob/89c2616/docs/development/testing.md):

```toml
[tasks.test]
run = "gotestsum --format pkgname --format-icons text --format-hide-empty-pkg --hide-summary skipped -- ./..."

[tasks."test:integration"]
run = "gotestsum --format testname --format-icons text --hide-summary skipped -- -tags=integration ./cmd/entire/cli/integration_test/... ./cmd/entire/cli/auth/..."

[tasks."test:ci"]
run = """
go test -tags=integration -race ./...
mise run test:e2e:canary
"""
```

- `mise run test:e2e:canary` runs the end-to-end suite against **Vogon**, a deterministic fake agent
  (`e2e/vogon/`, `cmd/entire/cli/agent/vogon/`) that needs no API key.
- `mise run test:e2e --agent <name>` drives real agents and is "only when explicitly requested".

Telemetry: anonymous usage analytics to PostHog are on unless opted out with `"telemetry": false`,
`--telemetry=false`, or `ENTIRE_TELEMETRY_OPTOUT=1` —
[`docs/security-and-privacy.md` § Telemetry](https://github.com/entireio/cli/blob/89c2616/docs/security-and-privacy.md#telemetry).
`entire enable` also reports the enabled repo to the Entire backend, but only when `origin` maps to a
known forge; for any other host it returns before any network call —
[`setup.go` `reportRepoEnabled`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/setup.go#L1151-L1190).

### Checkpoint ids and the commit trailer

Two id formats; readers must accept both —
[`checkpoint/id/id.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/id/id.go#L26-L46):

```go
const Pattern = `[0-9a-f]{12}`
const ulidPattern = `[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}`
const CheckpointPattern = `(?:` + Pattern + `|` + ulidPattern + `)`
```

- **ULID** (26 chars, Crockford base32, uppercase canonical, first char `0`–`7`): minted when the
  primary backend is `git-refs`. The leading characters encode Unix milliseconds, so creation time
  is recoverable from the id alone.
- **Legacy hex** (12 lowercase hex chars, random): minted when the primary backend is `git-branch`.
- The regex is a loose shape; authoritative validation is `oklog/ulid` `ParseStrict` plus a
  round-trip check (`isULID`, same file, L84-L87).

The trailer on the user's commit —
[`trailers/trailers.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/trailers/trailers.go#L42-L72)
(constant at L42, regex at L72):

```go
CheckpointTrailerKey = "Entire-Checkpoint"

checkpointTrailerRegex = regexp.MustCompile(CheckpointTrailerKey + `:\s*(` + checkpointID.CheckpointPattern + `)(?:\s|$)`)
```

- `ParseAllCheckpoints` returns every match in the message, de-duplicated in order (L124 onward).
  Multiple trailers are normal: squash merges and redone commits inherit the trailers of the commits
  they replace
  ([`sessions-and-checkpoints.md` § Commit-to-session linking](https://github.com/entireio/cli/blob/89c2616/docs/architecture/sessions-and-checkpoints.md#commit-to-session-linking)).
- The trailer is appended to an existing trailer block, or after a blank line otherwise
  (`appendTrailerLine`, L198 onward).

Real examples (observed, `git log` of `entireio/cli`):

```
remotehelper: build the 507 error in one place; pin the failover test's start node

…body…

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Entire-Checkpoint: 01M3WE2VX9HQC3NVY9BWYCW6JV
```

Other trailer keys exist but appear only on Entire's *own* commits (shadow branch and checkpoint
commits), never on the user's commit — same file, L15-L59:

| Key | Where | Value |
|---|---|---|
| `Entire-Session` | checkpoint commit, shadow commit | session id |
| `Entire-Strategy` | checkpoint commit, shadow commit | `manual-commit` |
| `Entire-Agent` | checkpoint commit | agent display name, e.g. `Claude Code` |
| `Ephemeral-branch` | checkpoint commit | shadow branch name, e.g. `entire/a02a31f-821774` |
| `Entire-OPF-Applied` | checkpoint commit | literal `true`, only when the optional OpenAI Privacy Filter ran |
| `Entire-Metadata`, `Entire-Metadata-Task` | shadow commit | metadata dir path inside the shadow tree |
| `Base-Commit`, `Entire-Source-Ref`, `Entire-Condensation` | defined as constants only; not referenced by any other non-test code | — |

### Where a checkpoint is stored

Two backends, both plain git —
[`docs/architecture/ref-checkpoint-backend.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/ref-checkpoint-backend.md):

| Backend (`checkpoints.primary.type`) | Location | Tree position |
|---|---|---|
| `git-refs` (written by every first-time `entire enable`) | one ref per checkpoint: `refs/entire/checkpoints/<shard>/<id>` | the checkpoint is the **root** of the commit's tree |
| `git-branch` (legacy; also the fallback when no `checkpoints` block exists) | single branch `entire/checkpoints/v1` (`refs/heads/entire/checkpoints/v1`) | subtree at `<id[:2]>/<id[2:]>/` |

Ref naming —
[`checkpoint/refs_naming.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/refs_naming.go#L16-L32)
and [`id.go` `ShardFor`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/id/id.go#L134-L140):

```go
const CheckpointRefPrefix = "refs/entire/checkpoints/"

return plumbing.ReferenceName(CheckpointRefPrefix + cid.ShardFor() + "/" + cid.String()), nil
```

- `<shard>` is the **last two characters** of the id, for both formats. `ParseRef` compares the
  shard case-insensitively (L53-L72).
- **Not every ref under the prefix is a checkpoint.** Observed on `entireio/cli-checkpoints`
  (`git ls-remote`, 2026-10-02): of 2,691 refs under `refs/entire/checkpoints/`, 2,667 are
  `<shard>/<ULID>` and 24 are not — `v1/main`, `v1/full`, `v2/main`, and 21 under `v2/full/`. The
  code at `89c2616` contains no reference to those names (grep for `checkpoints/v2`, `v2/main`,
  `v2/full`, `v1/full`, `v1/main` finds nothing), so what wrote them and what they hold is not
  established here. A consumer must select refs by shape — exactly `<shard>/<id>` with a valid id
  whose last two characters equal the shard, as `ParseRef` does — and ignore the rest. The same
  repository also has a `refs/heads/entire/checkpoints/v1` branch and no 12-hex refs.
- The two sharding schemes differ on purpose: refs use the id's *last* two characters, the v1 branch
  tree uses the *first* two (`id.Path()`, `id.go` L267-L272).

Read routing used by the CLI and, per the doc, by entire.io
([same doc § Kind routing](https://github.com/entireio/cli/blob/89c2616/docs/architecture/ref-checkpoint-backend.md#kind-routing-and-coexistence)):

| Id kind | Read from |
|---|---|
| ULID | per-checkpoint ref only |
| hex | per-checkpoint ref `refs/entire/checkpoints/<last2>/<hex>` first (migrated checkpoints), then the v1 branch |

Commits on a checkpoint ref (observed on `entireio/cli-checkpoints`):

```
$ git log --format='%H %P%n%an <%ae> %cI%n%B' refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV
ee5dcdd92f7a9af780249d9f845f08dfd6fbcae2
Peyton Montei <peyton@entire.io> 2026-10-01T12:12:01-07:00
Checkpoint: 01M3WE2VX9HQC3NVY9BWYCW6JV

Entire-Session: e968c928-847d-4ca2-bea6-9471b8698e48
Entire-Strategy: manual-commit
Entire-Agent: Claude Code
Ephemeral-branch: entire/a02a31f-821774
```

- The first write is an orphan commit; every later write (`WriteSession` for another session, or a
  `Backfill*` for transcript, summary or attribution) adds a commit whose parent is the previous tip
  ([same doc § Write path](https://github.com/entireio/cli/blob/89c2616/docs/architecture/ref-checkpoint-backend.md#write-path)).
  The example ref above has a single commit. In the 99-ref sample, the subjects of the later
  commits were `Finalize transcript for Checkpoint: <id>` (88;
  [`refs_store.go` L297](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/refs_store.go#L297)),
  a further `Checkpoint: <id>` (19) and `Update checkpoint summary for <id>` (3).
- The commit author is the developer's git identity. Checkpoint commits are signed, best-effort,
  when `commit.gpgsign = true` at global/system scope and `sign_checkpoint_commits` is not `false`
  ([`checkpoint-signing.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/checkpoint-signing.md)).
- On the v1 branch the same subject is used, but the CLI "always reads from the tree at HEAD" of the
  branch, not from a specific commit
  ([`sessions-and-checkpoints.md` § Checkpoint ID Linking](https://github.com/entireio/cli/blob/89c2616/docs/architecture/sessions-and-checkpoints.md#checkpoint-id-linking)).

### Tree layout inside a checkpoint

Observed (`git ls-tree -r -l` of the ref above; sizes in bytes):

```
100644 blob f8f2f82f…      71	0/content_hash.txt
100644 blob 751020c6… 8839155	0/full.jsonl
100644 blob 356dbf5e…    3473	0/metadata.json
100644 blob b3ecc840…    1468	0/prompt.txt
100644 blob 72ae5512… 1526949	0/transcript.jsonl
100644 blob 14eecc1c…     921	metadata.json
```

Full layout —
[`sessions-and-checkpoints.md` § Committed Checkpoints](https://github.com/entireio/cli/blob/89c2616/docs/architecture/sessions-and-checkpoints.md#committed-checkpoints)
and [`paths/paths.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/paths/paths.go#L28-L46):

```
<root>/                         # ref root (git-refs) or <id[:2]>/<id[2:]>/ (v1 branch)
├── metadata.json               # CheckpointSummary
├── 0/                          # first session — session directories are 0-based
│   ├── metadata.json           # session Metadata
│   ├── full.jsonl              # agent-native transcript, sanitised + redacted, whole session
│   ├── full.jsonl.001 …        # further chunks when the transcript exceeds 50 MB
│   ├── transcript.jsonl        # compact (normalised) transcript, whole session; best-effort
│   ├── prompt.txt              # user prompts of this checkpoint
│   ├── content_hash.txt        # "sha256:<hex>" of the stored transcript
│   └── assets/                 # only when image externalisation is enabled
│       ├── manifest.json
│       └── <asset files>
├── 1/ …                        # further sessions that contributed to the same commit
└── tasks/<tool-use-id>/        # subagent records, materialised at condensation
    ├── agent-<agent-id>.jsonl  # subagent transcript (omitted when unavailable)
    └── task.json
```

Some code comments still draw the session directories as `1/`, `2/`, `3/`
([`api/checkpoint/metadata.go` L543-L554](https://github.com/entireio/cli/blob/89c2616/api/checkpoint/metadata.go#L543-L554));
the writer uses `strconv.Itoa(sessionIndex)` starting at 0 and real data shows `0/`.

**Root `metadata.json`** — `CheckpointSummary`,
[`api/checkpoint/metadata.go` L520-L589](https://github.com/entireio/cli/blob/89c2616/api/checkpoint/metadata.go#L520-L589):

```go
type SessionFilePaths struct {
	Metadata string `json:"metadata"`
	Transcript string `json:"transcript,omitempty"`
	CompactTranscript string `json:"compact_transcript,omitempty"`
	ContentHash       string `json:"content_hash,omitempty"`
	Prompt            string `json:"prompt"`
	AssetsManifest string `json:"assets_manifest,omitempty"`
}

type CheckpointSummary struct {
	CLIVersion   string          `json:"cli_version,omitempty"`
	CheckpointID id.CheckpointID `json:"checkpoint_id"`
	Strategy     string          `json:"strategy"`
	Branch       string          `json:"branch,omitempty"`
	CommitSHA           string             `json:"commit_sha,omitempty"`
	CheckpointsCount    int                `json:"checkpoints_count"`
	FilesTouched        []string           `json:"files_touched"`
	Sessions            []SessionFilePaths `json:"sessions"`
	TokenUsage          *types.TokenUsage  `json:"token_usage,omitempty"`
	CombinedAttribution *Attribution       `json:"combined_attribution,omitempty"`
	HasReview bool `json:"has_review,omitempty"`
	HasInvestigation bool `json:"has_investigation,omitempty"`
	Imported bool `json:"imported,omitempty"`
}
```

Observed instance (git-refs backend; unabridged):

```json
{
  "cli_version": "0.11.4-nightly.202609260624.c369a70d2",
  "checkpoint_id": "01M3WE2VX9HQC3NVY9BWYCW6JV",
  "strategy": "manual-commit",
  "branch": "peyton/remote-helper-push-size",
  "checkpoints_count": 5,
  "files_touched": [
    "internal/remotehelper/transport/proxy.go",
    "internal/remotehelper/transport/storage_test.go"
  ],
  "sessions": [
    {
      "metadata": "/0/metadata.json",
      "transcript": "/0/full.jsonl",
      "compact_transcript": "/0/transcript.jsonl",
      "content_hash": "/0/content_hash.txt",
      "prompt": "/0/prompt.txt"
    }
  ],
  "token_usage": {
    "input_tokens": 34,
    "cache_creation_tokens": 11396,
    "cache_read_tokens": 11911857,
    "output_tokens": 7066,
    "api_call_count": 14,
    "subagent_tokens": {
      "input_tokens": 0,
      "cache_creation_tokens": 0,
      "cache_read_tokens": 0,
      "output_tokens": 0,
      "api_call_count": 0
    }
  }
}
```

- `sessions[].*` are paths from the **tree root of the commit**, with a leading `/`. Under git-refs
  that is `/0/…`; under the v1 branch it includes the shard prefix, e.g. `/a3/b2c4d5e6f7/0/…`
  ([`persistent.go` `writeSessionToSubdirectory`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/persistent.go#L658-L776)).
- `commit_sha` is set only for imported checkpoints (`imported: true`); normal checkpoints link to
  commits solely through the trailer.
- Root `checkpoints_count` is the sum of per-session prompt-window counts, "not a count of
  checkpoint records".
- `transcript` always points at `full.jsonl`; `compact_transcript` is present only when
  `transcript.jsonl` was written.

**Session `metadata.json`** — `Metadata`,
[`api/checkpoint/metadata.go` L394-L493](https://github.com/entireio/cli/blob/89c2616/api/checkpoint/metadata.go#L394-L493)
(comments trimmed):

```go
type Metadata struct {
	CLIVersion   string          `json:"cli_version,omitempty"`
	CheckpointID id.CheckpointID `json:"checkpoint_id"`
	SessionID    string          `json:"session_id"`
	Strategy     string          `json:"strategy"`
	CreatedAt    time.Time       `json:"created_at"`
	Branch       string          `json:"branch,omitempty"` // Branch where checkpoint was created (empty if detached HEAD)
	CommitSHA        string `json:"commit_sha,omitempty"`
	CheckpointsCount int    `json:"checkpoints_count"`
	SaveStepCount int      `json:"save_step_count,omitempty"`
	FilesTouched  []string `json:"files_touched"`
	Agent types.AgentType `json:"agent,omitempty"`
	Model string `json:"model"`
	TurnID string `json:"turn_id,omitempty"`
	IsTask    bool   `json:"is_task,omitempty"`
	ToolUseID string `json:"tool_use_id,omitempty"`
	TranscriptIdentifierAtStart string `json:"transcript_identifier_at_start,omitempty"`
	CheckpointTranscriptStart   int    `json:"checkpoint_transcript_start,omitempty"`    // Raw transcript (full.jsonl) line offset at start of this checkpoint's data
	TranscriptLinesAtStart int `json:"transcript_lines_at_start,omitempty"` // Deprecated
	CompactTranscriptStart *int `json:"compact_transcript_start,omitempty"`
	TokenUsage *types.TokenUsage `json:"token_usage,omitempty"`
	SkillEventsVersion int                `json:"skill_events_version,omitempty"`
	SkillEvents        []types.SkillEvent `json:"skill_events,omitempty"`
	SessionMetrics *SessionMetrics `json:"session_metrics,omitempty"`
	Summary *Summary `json:"summary,omitempty"`
	Attribution *Attribution `json:"initial_attribution,omitempty"`
	PromptAttributions json.RawMessage `json:"prompt_attributions,omitempty"`
	Kind string `json:"kind,omitempty"`
	ReviewSkills []string `json:"review_skills,omitempty"`
	ReviewPrompt string `json:"review_prompt,omitempty"`
	InvestigateRunID string `json:"investigate_run_id,omitempty"`
	InvestigateTopic string `json:"investigate_topic,omitempty"`
}
```

Observed instance (same checkpoint; `skill_events` elided):

```json
{
  "cli_version": "0.11.4-nightly.202609260624.c369a70d2",
  "checkpoint_id": "01M3WE2VX9HQC3NVY9BWYCW6JV",
  "session_id": "e968c928-847d-4ca2-bea6-9471b8698e48",
  "strategy": "manual-commit",
  "created_at": "2026-10-01T19:12:01.19884Z",
  "branch": "peyton/remote-helper-push-size",
  "checkpoints_count": 5,
  "save_step_count": 2,
  "files_touched": [
    "internal/remotehelper/transport/proxy.go",
    "internal/remotehelper/transport/storage_test.go"
  ],
  "agent": "Claude Code",
  "model": "claude-opus-5-5",
  "turn_id": "c43056f2071b",
  "checkpoint_transcript_start": 4575,
  "transcript_lines_at_start": 4575,
  "compact_transcript_start": 663,
  "token_usage": { "input_tokens": 34, "cache_creation_tokens": 11396, "cache_read_tokens": 11911857, "output_tokens": 7066, "api_call_count": 14, "subagent_tokens": { "…": 0 } },
  "skill_events_version": 1,
  "skill_events": [ "…" ],
  "session_metrics": { "turn_count": 105 },
  "initial_attribution": {
    "calculated_at": "2026-10-01T19:12:01.046459Z",
    "agent_lines": 125,
    "agent_removed": 0,
    "human_added": 0,
    "human_modified": 0,
    "human_removed": 0,
    "total_committed": 125,
    "total_lines_changed": 125,
    "agent_percentage": 100,
    "metric_version": 2
  },
  "prompt_attributions": [
    { "checkpoint_number": 1, "user_lines_added": 0, "user_lines_removed": 0, "agent_lines_added": 0, "agent_lines_removed": 0 },
    { "checkpoint_number": 2, "user_lines_added": 0, "user_lines_removed": 0, "agent_lines_added": 4, "agent_lines_removed": 1 }
  ]
}
```

- `session_id` is the agent's own id (a UUID for Claude Code). `summary` (`intent`, `outcome`,
  `learnings`, `friction`, `open_items`) is present only when AI summaries are enabled
  (`strategy_options.summarize.enabled`).
- `turn_id` correlates checkpoints from one agent turn that spans several commits.

**Attribution** —
[`api/checkpoint/metadata.go` L634-L645](https://github.com/entireio/cli/blob/89c2616/api/checkpoint/metadata.go#L634-L645):

```go
type Attribution struct {
	CalculatedAt      time.Time `json:"calculated_at"`
	AgentLines        int       `json:"agent_lines"`              // Lines added by agent that remain in the commit
	AgentRemoved      int       `json:"agent_removed"`            // Lines removed by agent that remain removed in the commit
	HumanAdded        int       `json:"human_added"`              // Lines added by human (excluding modifications)
	HumanModified     int       `json:"human_modified"`           // Lines modified by human (estimate: min(added, removed))
	HumanRemoved      int       `json:"human_removed"`            // Lines removed by human (excluding modifications)
	TotalCommitted    int       `json:"total_committed"`          // Net additions in commit (legacy additions-focused metric)
	TotalLinesChanged int       `json:"total_lines_changed"`      // Total committed line changes (adds + modifies + removes)
	AgentPercentage   float64   `json:"agent_percentage"`         // (agent_lines + agent_removed) / total_lines_changed * 100
	MetricVersion     int       `json:"metric_version,omitempty"` // 0/absent = legacy (additions-only %), 2 = changed-lines %
}
```

Attribution is a per-file heuristic from line diffs and hook timing, "informational, not
security-critical"
([`attribution.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/attribution.md)).

**Token usage** —
[`sessions-and-checkpoints.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/sessions-and-checkpoints.md#checkpoint-storage-low-level):

```go
type TokenUsage struct {
    InputTokens         int         `json:"input_tokens"`
    CacheCreationTokens int         `json:"cache_creation_tokens"`
    CacheReadTokens     int         `json:"cache_read_tokens"`
    OutputTokens        int         `json:"output_tokens"`
    APICallCount        int         `json:"api_call_count"`
    SubagentTokens      *TokenUsage `json:"subagent_tokens,omitempty"`
}
```

**Other files**

- `full.jsonl` chunking: chunks are at most 50 MB, split on line boundaries; chunk 0 is `full.jsonl`,
  chunk *n* is `full.jsonl.%03d` (`.001`, `.002`, …); reassembly joins chunks with `\n`
  ([`agent/chunking.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/agent/chunking.go#L13-L138)).
  Non-JSONL agents chunk in their own format.
- `content_hash.txt`: the string `sha256:<hex>` over the whole stored transcript, no trailing
  newline (71 bytes)
  ([`persistent.go` L1075](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/persistent.go#L1075)).
  Observed: equals `sha256(full.jsonl)` for an unchunked transcript.
- `prompt.txt`: the prompts of this checkpoint joined with
  `const PromptSeparator = "\n\n---\n\n"`
  ([`checkpoint/prompts.go` L11](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/prompts.go#L11)),
  redacted. It includes non-human "prompts" such as `<task-notification>` blocks (observed).
- `tasks/<tool-use-id>/task.json` —
  [`persistent.go` L1313-L1326](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/persistent.go#L1313-L1326):

  ```go
  type taskRecordMetadata struct {
  	ToolUseID       string            `json:"tool_use_id"`
  	AgentID         string            `json:"agent_id,omitempty"`
  	SubagentType    string            `json:"subagent_type,omitempty"`
  	TaskDescription string            `json:"task_description,omitempty"`
  	Files           []string          `json:"files,omitempty"`
  	TokenUsage      *types.TokenUsage `json:"token_usage,omitempty"`
  	StartedAt                   time.Time `json:"started_at,omitzero"`
  	CompletedAt                 time.Time `json:"completed_at,omitzero"`
  	TranscriptUnavailableReason string    `json:"transcript_unavailable_reason,omitempty"`
  }
  ```

  An absent `completed_at` means the subagent was still running when the checkpoint was written.
- `assets/manifest.json`: `{"version": 1, "assets": [{"name", "media_type", "size", "sha256"}]}`
  ([`persistent.go` L1855-L1900](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/persistent.go#L1855-L1900));
  only written when `redaction.externalize_images` is on.

### From a commit trailer to the transcript (bare clone of the checkpoint repository)

1. In the commit message, collect every match of
   `Entire-Checkpoint:\s*((?:[0-9a-f]{12}|[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}))(?:\s|$)`.
2. Per id, resolve the commit:
   - `refs/entire/checkpoints/<last two chars of id>/<id>` → the checkpoint is the tree root of the
     ref's **tip** commit.
   - If that ref is absent and the id is 12-hex: `refs/heads/entire/checkpoints/v1`, tip tree,
     subtree `<id[:2]>/<id[2:]>/`.
3. Read `metadata.json` at the checkpoint root. For each entry of `sessions[]`, strip the leading `/`
   and resolve the paths from the commit's tree root.
4. Per session: read `metadata.json`; read `full.jsonl` plus any `full.jsonl.NNN` siblings in numeric
   order joined with `\n`; read `transcript.jsonl` if `compact_transcript` is present.
5. This checkpoint's part of the session is `fullLines[checkpoint_transcript_start:]` and
   `compactLines[compact_transcript_start:]`. If `compact_transcript_start` is absent the file is a
   legacy delta: read it from line 0. The compact slice may repeat at most one line from the previous
   checkpoint at its head
   ([`metadata.go` L437-L450](https://github.com/entireio/cli/blob/89c2616/api/checkpoint/metadata.go#L437-L450)).

Verified by doing exactly this for `01M3WE2VX9HQC3NVY9BWYCW6JV`:
`git fetch https://github.com/entireio/cli-checkpoints '+refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV:refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV'`
into an empty bare repository, then `git show <ref>:metadata.json`.

### Transcript formats

There are three distinct things; only the last two are stored.

**1. The normalised lifecycle event** is in-memory only. Each agent adapter translates its native
hook payload into an `agent.Event`; it is a Go struct with no JSON tags and nothing in this shape is
written to git —
[`agent/event.go` L14-L215](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/agent/event.go#L14-L215).
Its fields (names and types as declared; comments omitted): `Type EventType`, `SessionID string`,
`PreviousSessionID string`, `SessionRef string` (transcript reference, typically a file path),
`Prompt string`, `Model string`, `Timestamp time.Time`, `ToolUseID string`, `TurnID string`,
`SubagentID string`, `ProvisionalSubagentStop bool`, `Final bool`, `CompletionWithoutLaunch bool`,
`SubagentTranscriptUnavailable bool`, `SubagentTranscriptPath string`, `ToolInput json.RawMessage`,
`SubagentType string`, `TaskDescription string`, `ModifiedFiles []string`, `NewFiles []string`,
`DeletedFiles []string`, `CWD string`, `ResponseMessage string`, `DurationMs int64`,
`TurnCount int`, `ContextTokens int`, `ContextWindowSize int`, `TokenUsage *TokenUsage`,
`SkillEvents []SkillEvent`, `Metadata map[string]string`, `SuppressIfSessionActive bool`. The event
types:

```go
type EventType int

const (
	SessionStart EventType = iota + 1
	TurnStart
	TurnEnd
	Compaction
	SessionEnd
	SubagentStart
	SubagentEnd
	ModelUpdate
	ToolUse
)
```

**2. `full.jsonl` is the agent's native transcript**, after sanitise → (optional) image
externalisation → redaction. For Claude Code that is Claude Code's own JSONL. Observed line `type`
values in one real file: `user`, `assistant`, `system`, `attachment`, `file-history-snapshot`,
`file-history-delta`, `queue-operation`, `last-prompt`, `mode`, `permission-mode`, `ai-title`,
`pr-link`, and others; `user`/`assistant` lines carry `uuid`, `parentUuid`, `sessionId`, `timestamp`,
`cwd`, `gitBranch`, `isSidechain`, `message`, … This format is owned by the agent vendor and changes
without notice.

**3. `transcript.jsonl` is the compact, cross-agent format** —
[`transcript/compact/compact.go` L24-L73](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/transcript/compact/compact.go#L24-L73):

```go
// transcriptLine is the uniform output format for every line in transcript.jsonl.
// Field order is guaranteed by encoding/json (struct declaration order).
type transcriptLine struct {
	V            int             `json:"v"`
	Agent        string          `json:"agent"`
	CLIVersion   string          `json:"cli_version"`
	Type         string          `json:"type"`
	TS           json.RawMessage `json:"ts,omitempty"`
	ID           string          `json:"id,omitempty"`
	InputTokens  int             `json:"input_tokens,omitempty"`
	OutputTokens int             `json:"output_tokens,omitempty"`
	Content      json.RawMessage `json:"content"`
}

// toolResultJSON is the compact result object inlined into tool_use blocks.
type toolResultJSON struct {
	Output     string              `json:"output"`
	Status     string              `json:"status"`
	File       *toolResultFileJSON `json:"file,omitempty"`
	MatchCount int                 `json:"matchCount,omitempty"`
}

// toolResultFileJSON carries structured file metadata from Read/Edit tool results.
type toolResultFileJSON struct {
	FilePath string `json:"filePath"`
	NumLines int    `json:"numLines,omitempty"`
}

// userTextBlock is a text block within user message content.
type userTextBlock struct {
	ID   string `json:"id,omitempty"`
	Text string `json:"text"`
}
```

Observed lines (Claude Code; long strings shortened with `…`):

```json
{"v": 1, "agent": "claude-code", "cli_version": "0.11.4-nightly.202609260624.c369a70d2", "type": "user", "ts": "2026-09-28T15:28:46.909Z", "content": [{"id": "ec27329e-e666-4a69-844f-fba9901e8ac5", "text": "can you make sure you're on latest main …"}]}
{"v": 1, "agent": "claude-code", "cli_version": "0.11.4-nightly.202609260624.c369a70d2", "type": "assistant", "ts": "2026-09-28T15:29:00.172Z", "id": "msg_011CfW5J279JBYmdJ2n7PbFZ", "input_tokens": 2, "output_tokens": 187, "content": [{"text": "Branch has no local commits and is 480 b…", "type": "text"}, {"id": "toolu_01NQiS2Dv7YpqzCiNABRgHDH", "input": {"command": "git merge --ff-only origin/main --quiet …", "description": "Fast-forward to main, inspect binary and recent releases"}, "name": "Bash", "result": {"output": "8a26deb911 Merge pull request #2500 from…", "status": "success"}, "type": "tool_use"}]}
```

- `v` is `1`; `agent` is the registry name (`claude-code`), not the display name used in
  `metadata.json`.
- `type` is only `user` or `assistant`.
- Observed user `content` is an array of `{id?, text}` blocks; the code comment on `Compact` shows
  it as a plain string, so accept both.
- `result.status` is `success` or `error`. A `tool_use` block may have no `result` (observed).

How it differs from Claude Code's native JSONL (all from `compact.go`):

- Entry types `progress`, `file-history-snapshot`, `queue-operation`, `system` are dropped
  explicitly, and every type that is not user/human/assistant is dropped by `normalizeKind`
  ([L182-L215](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/transcript/compact/compact.go#L182-L215)).
- Consecutive assistant entries with the same message id (streaming fragments) are merged into one
  line; the following user `tool_result` entry is consumed and inlined as `result` on the matching
  `tool_use` block
  ([L239-L297](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/transcript/compact/compact.go#L239-L297)).
- `thinking` and `redacted_thinking` blocks are removed; `tool_use` blocks keep only `type`, `id`,
  `name`, `input`
  ([`stripAssistantContent`, L689-L724](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/transcript/compact/compact.go#L689-L724)).
- IDE context tags are stripped from user text (`textutil.StripIDEContextTags`).
- Envelope fields (`uuid`, `parentUuid`, `cwd`, `gitBranch`, `isSidechain`, `sessionId`, …) are not
  carried over. `compact.go` does not reference `isMeta` or `isSidechain` at all.
- `transcript.jsonl` is best-effort: it is omitted when compaction fails or the output exceeds
  50 MB, and it is never chunked. `full.jsonl` stays authoritative.

**Agents.** Built-in registry —
[`agent/registry.go` L167-L192](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/agent/registry.go#L167-L192):

| Registry name (`--agent`, compact `agent`) | Display name (`metadata.json` `agent`, `Entire-Agent`) | Hook config written |
|---|---|---|
| `antigravity` | `Antigravity` | `.agents/hooks.json` |
| `claude-code` | `Claude Code` | `.claude/settings.json` |
| `codex` | `Codex` | `.codex/hooks.json` |
| `copilot-cli` | `Copilot CLI` | `.github/hooks/entire.json` |
| `cursor` | `Cursor` | `.cursor/hooks.json` |
| `factoryai-droid` | `Factory AI Droid` | `.factory/settings.json` |
| `opencode` | `OpenCode` | `.opencode/plugins/entire.ts` |
| `pi` | `Pi` | `.pi/extensions/entire/index.ts` |

Hook locations from
[`README.md` § Agent Hook Configuration](https://github.com/entireio/cli/blob/89c2616/README.md#agent-hook-configuration).
Gemini CLI is retired as an agent but `Gemini CLI` still appears in stored checkpoints. Further
agents can be added without changing the CLI as `entire-agent-<name>` binaries on `$PATH`
([`external-agent-protocol.md`](https://github.com/entireio/cli/blob/89c2616/docs/architecture/external-agent-protocol.md));
this requires `"external_agents": true` in an untracked `.entire/settings.local.json`. Compact
converters exist for the generic JSONL shape (Claude Code, Cursor) and for Codex, Copilot, Droid,
Gemini, OpenCode and Pi (`transcript/compact/*.go`).

### Capture mechanics

**Claude Code hooks** are written to `.claude/settings.json` in the repository (a file that is
normally committed) —
[`agent/claudecode/hooks.go` L26-L54, L180-L248](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/agent/claudecode/hooks.go#L26-L248):

| Claude Code hook event | `matcher` | Command (inside the wrapper below) | Normalised event |
|---|---|---|---|
| `SessionStart` | `""` | `entire hooks claude-code session-start` | `SessionStart` |
| `UserPromptSubmit` | `""` | `entire hooks claude-code user-prompt-submit` | `TurnStart` |
| `Stop` | `""` | `entire hooks claude-code stop` | `TurnEnd` |
| `SessionEnd` | `""` | `entire hooks claude-code session-end` | `SessionEnd` |
| `PreToolUse` | `Agent` | `entire hooks claude-code pre-task` | `SubagentStart` |
| `PostToolUse` | `Agent` | `entire hooks claude-code post-task` | `SubagentEnd` |
| `PostToolUse` | `TaskCreate\|TaskUpdate` | `entire hooks claude-code post-todo` | none (incremental task checkpoint) |
| `SubagentStop` | `""` | `entire hooks claude-code subagent-stop` | `SubagentEnd` (final) |

An excerpt of the JSON, from the repository's own committed
[`.claude/settings.json`](https://github.com/entireio/cli/blob/89c2616/.claude/settings.json)
(trimmed: one entry shown per shape, and the repository's unrelated top-level keys and its own
second `SessionStart` hook, `bash "${CLAUDE_PROJECT_DIR}"/.claude/scripts/remote-setup.sh`, are
left out; each entry shown is verbatim):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code post-task'"
          }
        ]
      },
      {
        "matcher": "TaskCreate|TaskUpdate",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code post-todo'"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'if ! command -v entire >/dev/null 2>&1; then printf \"%s\\n\" \"{\\\"systemMessage\\\":\\\"\\\\n\\\\nEntire CLI is enabled but not installed or not on PATH.\\\\nInstallation guide: https://docs.entire.io/cli/installation#installation-methods\\\"}\"; exit 0; fi; exec entire hooks claude-code session-start'"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code stop'"
          }
        ]
      }
    ]
  }
}
```

- Every command is wrapped so that a machine without `entire` on `PATH` exits 0 silently (only
  `SessionStart` prints a warning) —
  [`agent/hook_command.go` L121-L145](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/agent/hook_command.go#L121-L145).
  The binary name `entire` is hard-coded in the wrapper and in the prefix used to recognise
  Entire-managed hooks (`const currentHookCommandPrefix = "entire hooks "`).
- The matchers `Agent` and `TaskCreate|TaskUpdate` replaced the older `Task` and `TodoWrite`, under
  which "the hooks silently never fired" (comment at L38-L50).
- No permission rules are added; an older metadata deny rule is actively removed on enable.

**Git hooks** — five, installed into the directory git resolves for hooks (respects
`core.hooksPath`) —
[`strategy/hooks.go` L42, L557-L625](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/hooks.go#L42-L625):

```go
var gitHookNames = []string{"prepare-commit-msg", "commit-msg", "post-commit", postRewriteHook, "pre-push"}
```

```go
prepareCommitMsgCmd := gitHookCommand(cmdPrefix, `prepare-commit-msg "$1" "$2" 2>/dev/null || true`, false)
commitMsgCmd := gitHookCommand(cmdPrefix, `commit-msg "$1" || true`, true)
postCommitCmd := gitHookCommand(cmdPrefix, `post-commit 2>/dev/null || true`, false)
postRewriteCmd := gitHookCommand(cmdPrefix, `post-rewrite "$1" 2>/dev/null || true`, false)
prePushCmd := gitHookCommand(cmdPrefix, `pre-push "$1"`, false)
```

| Hook | Role (from the generated script comments and the docs) |
|---|---|
| `prepare-commit-msg` | adds the `Entire-Checkpoint` trailer when a session has content for this commit |
| `commit-msg` | "strip trailer if no user content (allows aborting empty commits)" |
| `post-commit` | "condense session data if commit has Entire-Checkpoint trailer" — writes the permanent checkpoint |
| `post-rewrite` | "remap session linkage after amend/rebase rewrites" |
| `pre-push` | "push session logs alongside user's push"; the only hook whose exit code is not swallowed |

- Each script is `#!/bin/sh`, a `# Entire CLI hooks` marker line, and one guarded invocation of
  `<prefix> hooks git <name> …`. A pre-existing hook without the marker is backed up with the suffix
  `.pre-entire` and chained.
- When the trailer is added (`-m`/`-F` commits) —
  [`strategy/manual_commit_hooks.go` L489-L524](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/manual_commit_hooks.go#L489-L524):
  no TTY → always; `commit_linking == "always"` → always; otherwise the human is prompted
  `[Y]es / [n]o / [a]lways` and may skip. Editor-flow commits get the trailer with an explanatory
  comment the user can delete. Merge commits are never linked.
- The docs still say the id is "generated during condensation (post-commit hook)"; the code adds the
  trailer, with its id, in `prepare-commit-msg`.

**Temporary checkpoints (shadow branches)** —
[`checkpoint/ephemeral.go` L40-L44, L719-L730](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/ephemeral.go#L40-L730):

```go
ShadowBranchPrefix = "entire/"
ShadowBranchHashLength = 7

// Format: entire/<commit[:7]>-<hash(worktreeID)[:6]>
return ShadowBranchPrefix + commitPart + "-" + worktreeHash
```

- A shadow branch is an ordinary local branch (`refs/heads/entire/<base7>-<wt6>`) holding a full
  worktree snapshot plus `.entire/metadata/<session-id>/{full.jsonl, prompt.txt, tasks/…}`. Several
  concurrent sessions share one branch.
- Written at turn end (`Stop`), deleted after condensation.
- "Shadow branches are **not** pushed by Entire; do not push them manually, because unredacted
  source content would be visible on the remote" —
  [`security-and-privacy.md`](https://github.com/entireio/cli/blob/89c2616/docs/security-and-privacy.md#where-data-is-stored).
  Nothing stops a user's own `git push --all` from pushing them, since they live under `refs/heads/`.
- Session state lives in `.git/entire-sessions/<session-id>.json` (git common dir, shared across
  worktrees); the push queue in `.git/entire-checkpoint-push-queue.jsonl`.

**When checkpoints are pushed** —
[`strategy/manual_commit_push.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/manual_commit_push.go#L56-L117),
[`checkpoint/remote/git.go` L428-L451](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/git.go#L428-L451),
[`strategy/push_common.go` L58-L70](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/push_common.go#L58-L70):

```go
args := []string{"push", "--no-verify", "--porcelain"}
args = append(args, opts.ExtraArgs...)
args = append(args, pushTarget)
args = append(args, opts.RefSpecs...)
```

```go
refSpecs = append(refSpecs, ref.String()+":"+ref.String())
```

- Only from the `pre-push` hook (plus an opt-in "push now" in the migration command). No push at
  turn end, session end or commit.
- git-refs backend: every write appends the ref name to a queue; `pre-push` drains it and pushes all
  queued refs in one `git push`, removing entries only after a confirmed push. On failure it retries
  per ref with fetch + replay (never a force push) under a time budget; anything that does not land
  stays queued. "Failures remain queued and **never fail the user's git push**."
- `GIT_TERMINAL_PROMPT=0` is always set and stdin is disconnected, so a missing credential fails
  rather than prompts.
- Destination: with a usable `checkpoint_remote`, the derived URL, on every push to any remote.
  Without one, only pushes to the single *elected* remote carry checkpoints
  (`checkpoint_push_remote` → captured habit → `origin` → sole remote → first remote); pushes to any
  other remote or to a raw URL carry none.
- `strategy_options.push_sessions: false` disables pushing entirely.
- With the legacy branch backend, the v1 branch is not pushed to a remote that has no
  remote-tracking refs yet, so it cannot become the default branch. Per-checkpoint refs are exempt
  because they are not under `refs/heads/`.

### Configuration

Two files, strict JSON (`DisallowUnknownFields`) —
[`settings/settings.go` L32-L46](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/settings/settings.go#L32-L46):

```go
EntireSettingsFile = ".entire/settings.json"
EntireSettingsLocalFile = ".entire/settings.local.json"
ClonePreferencesFile = "entire/preferences.json" // inside the git common dir
```

- `.entire/settings.json` — project settings, committed.
- `.entire/settings.local.json` — per-clone overrides, gitignored via `.entire/.gitignore`. If it is
  tracked in git it is ignored wholesale.
- An unknown key makes the file fail to load; a newer CLI's key therefore breaks older CLIs.

Schema (JSON keys of `EntireSettings`, same file L80-L238; deprecated keys omitted):

| Key | Type | Notes |
|---|---|---|
| `enabled` | bool | hooks exit silently when false |
| `log_level` | string | `debug`/`info`/`warn`/`error`; env `ENTIRE_LOG_LEVEL` |
| `strategy_options` | object | see below |
| `checkpoints` | `{"primary": {"type": "git-refs"\|"git-branch"}, "mirrors"?: […]}` | env `ENTIRE_CHECKPOINTS_PRIMARY` / `ENTIRE_CHECKPOINTS_MIRRORS` replace the block |
| `commit_linking` | `"always"` \| `"prompt"` | default `prompt` |
| `absolute_git_hook_path` | bool | embed the binary's full path in git hooks |
| `telemetry` | bool | |
| `sign_checkpoint_commits` | bool | default true |
| `redaction` | object | see Redaction |
| `summary_generation` | `{"provider", "model"}` | |
| `summary_timeout_seconds` | int | |
| `review_profiles`, `review_default_profile` | object, string | |
| `external_agents` | bool | honoured only from an untracked local file |
| `allow_symlinked_agent_dirs` | string[] | honoured only from an untracked local file |
| `vercel` | bool | |

`strategy_options` keys read by the code (L1880-L2117):

| Key | Type | Meaning |
|---|---|---|
| `push_sessions` | bool | `false` disables checkpoint pushing |
| `checkpoint_remote` | `{"provider": string, "repo": string}` | dedicated checkpoint repository |
| `checkpoint_push_remote` | string | name of an existing git remote that should carry checkpoints |
| `filtered_fetches` | bool | add `--filter=blob:none` to checkpoint fetches |
| `summarize` | `{"enabled": bool}` | AI summary at commit time |

What a first-time `entire enable` writes
([`README.md` § Configuration](https://github.com/entireio/cli/blob/89c2616/README.md#configuration)):

```json
{
  "enabled": true,
  "checkpoints": {
    "primary": { "type": "git-refs" }
  }
}
```

A real committed file with a checkpoint remote
([`.entire/settings.json` of `entireio/cli`](https://github.com/entireio/cli/blob/89c2616/.entire/settings.json)):

```json
{
  "enabled": true,
  "strategy_options": {
    "checkpoint_remote": {
      "provider": "github",
      "repo": "entireio/cli-checkpoints"
    }
  },
  "strategy": "manual-commit",
  "checkpoints": {
    "primary": { "type": "git-refs" }
  }
}
```

### `checkpoint_remote` and what a "provider" is

Parsing —
[`settings/settings.go` L1905-L2013](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/settings/settings.go#L1905-L2013):

```go
type CheckpointRemoteConfig struct {
	Provider string // e.g., "github"
	Repo     string // e.g., "org/checkpoints-repo"
}

// Owner returns the owner portion of the repo field (before the slash).
func (c *CheckpointRemoteConfig) Owner() string {
	parts := strings.SplitN(c.Repo, "/", 2)
	…
	return parts[0]
}
```

- `GetCheckpointRemote` requires both fields to be non-empty strings and `repo` to contain a `/`.
  It does **not** validate the provider value.
- The CLI flag is stricter: `--checkpoint-remote provider:owner/repo` accepts only `github` and
  `gitlab` ([`setup.go` L410-L436](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/setup.go#L410-L436)).

There is no provider interface, registry or API client. A provider is a string consulted in three
places:

1. `providerHost` — `github` → `github.com`, `gitlab` → `gitlab.com`
   ([`checkpoint/remote/util.go` L1030-L1046](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/util.go#L1030-L1046)).
   Used **only** as a fallback host when the push remote's protocol cannot be mapped (`file://`,
   `entire://` of another forge) and on the fetch side when a token forces HTTPS.
2. `checkpointPublicForgeProviders` — refuses to derive a `gitlab` store on `github.com` or the
   reverse (L869-L896).
3. `parseCheckpointRemoteFlag` and `ClaimCheckpointRemoteFlagValue` — CLI flag validation and the
   "claim" hint ([`inherited_claim.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/inherited_claim.go)).

URL derivation — the scheme and host come from the remote being pushed to, the path from `repo`
(L838-L867):

```go
case ProtocolSSH:
	if info.Port != "" {
		return fmt.Sprintf("ssh://git@%s/%s.git", info.HostPort(), config.Repo), nil
	}
	return fmt.Sprintf("git@%s:%s.git", info.Host, config.Repo), nil
case ProtocolHTTPS:
	return fmt.Sprintf("https://%s/%s.git", info.HostPort(), config.Repo), nil
```

"any other host (GitHub Enterprise, self-managed GitLab) is the user's own installation and is
trusted to serve the configured provider" (comment, L869-L872). No API calls are made to GitHub or
GitLab; neither provider creates the repository or checks that it exists.

Ownership rule (`checkpointRemoteIsInherited`, L546-L695): the setting is honoured only when

- it is in an untracked `.entire/settings.local.json` (no further check), **or**
- the owner (first path segment) of `origin` **and of every push URL** of the remote being pushed to
  equals `repo`'s first segment, case-insensitively, and none of those remotes is on a public forge
  of a different provider.

Otherwise the setting is ignored and checkpoints go to the elected remote instead. A remote URL is
split by
[`gitremote.splitOwnerRepo`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/gitremote/gitremote.go):
after trimming a trailing `.git`, `strings.SplitN(path, "/", 2)` — owner is the first path segment,
repo is everything after it.

Authentication:

- None of its own. Pushes and fetches run `git`, so SSH keys, credential helpers and `http.*` config
  apply as for any git command.
- `ENTIRE_CHECKPOINT_TOKEN` —
  [`checkpoint/remote/git.go` L28-L36, L802-L831](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/git.go#L28-L831):

  ```go
  encoded := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
  return append(filtered,
  	fmt.Sprintf("GIT_CONFIG_COUNT=%d", existingCount+1),
  	fmt.Sprintf("GIT_CONFIG_KEY_%d=http.extraHeader", idx),
  	fmt.Sprintf("GIT_CONFIG_VALUE_%d=Authorization: Basic %s", idx, encoded),
  )
  ```

  When set, SSH targets are rewritten to `https://<same host>/<owner>/<repo>.git` and the header is
  attached to checkpoint pushes and fetches only. Tokens containing control characters are ignored.

  With the token set and a `checkpoint_remote` configured, the **fetch** URL is not derived from the
  origin's host —
  [`util.go` L239-L256](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/checkpoint/remote/util.go#L239-L256):

  ```go
  if withToken {
  	host, ok := providerHost(config.Provider)
  	if ok {
  		checkpointURL, err := deriveCheckpointURLFromInfo(&Info{
  			Protocol: ProtocolHTTPS,
  			Host:     host,
  		}, config)
  		if err == nil {
  			return checkpointURL, true, false, nil
  		}
  	}

  	// In token-based execution path, short-circuit to avoid additional
  	// change in protocol.
  	if originURL != "" {
  		return originURL, false, false, nil
  	}
  }
  ```

  So with the token set: provider `github`/`gitlab` → fetches go to
  `https://github.com/<repo>.git` / `https://gitlab.com/<repo>.git` whatever the origin's host is,
  with the token header attached; any other provider name → fetches go to `origin`. The **push**
  side (`PushURL`, L460-L480) keeps the push remote's host.

**The pull request that added GitLab**:
[entireio/cli#2528](https://github.com/entireio/cli/pull/2528), "Accept gitlab as a
checkpoint_remote provider", merged 2026-09-18 — 4 commits, 9 files, +108 −14 (GitHub API). Of that,
the only functional change is in one file (`git diff --numstat` of the merge):

- `cmd/entire/cli/setup.go` (+16 −7, about 15 changed lines once comments are excluded) — a
  `checkpointProviderGitLab` constant, one extra `case` in `parseCheckpointRemoteFlag`, lower-casing
  the provider, shared flag help text.
- `cmd/entire/cli/checkpoint/remote/git.go` (+7 −3) and `status.go` (+2 −1) — comments only.
- The rest: `util_test.go` (+32), `setup_checkpoint_remote_test.go` (+32),
  `integration_test/http_remote_test.go` (+16 −1), README (+1 −1) and two docs (+1, +1 −1).

`providerHost` already knew `gitlab` before this PR. Follow-up commits added the cross-forge guards
(`876c88bd4`, `1c935ce90`) and the claim hint for GitLab (`e79d5f2d2`).

The entire.io docs page
[Store Checkpoints in Another Repository](https://docs.entire.io/guides/checkpoints/store-checkpoints-in-another-repo.md)
still says "Currently, `github` is the supported provider" and "Entire won't push checkpoint data to
a repository under a different owner"; both are narrower than the code at `89c2616`. The same page
states that the committed setting "is what entire.io reads to locate checkpoint data".

### What an Artifacts provider needs

Facts about the target, from Cloudflare's
[Artifacts Git protocol page](https://developers.cloudflare.com/artifacts/api/git-protocol/)
(last updated 2026-04-25, fetched 2026-10-02):

- "Each repo has a standard Git smart HTTP remote at
  `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`."
- Auth is either `Authorization: Bearer <full token>` via `http.extraHeader`, or HTTP Basic with
  "the token secret in the password slot. Artifacts ignores the Basic auth username." The secret is
  the token without its `?expires=` suffix; tokens are documented as `art_v1_<40 hex>?expires=<unix_seconds>` (observed live: `art_v2_e_<40 hex>?expires=…`).
- Push uses protocol v1 receive-pack ("Artifacts does not support v2 receive-pack").
- The page's only statement about `filter` is the row "Optional protocol v1 capabilities |
  `git-upload-pack` | Partial | Some optional v1 capabilities, such as `filter` and `include-tag`,
  are not supported." It says nothing about `filter` under protocol v2.

Applying the Entire code above to such a remote (derived by reading; **not executed**):

1. `ParseURL("https://<acct>.artifacts.cloudflare.net/git/<ns>/<repo>.git")` yields
   `Owner = "git"`, `Repo = "<ns>/<repo>"`, `Forge = ""`.
2. A committed
   `"checkpoint_remote": {"provider": "<any non-empty string>", "repo": "git/<ns>/<other-repo>"}`
   passes `GetCheckpointRemote` (non-empty provider, `repo` contains `/`).
3. The ownership vote passes: `Owner()` of the setting is `git`, the owner of `origin` and of the
   push URL is `git`, and the host is not a public forge.
4. `deriveCheckpointURLFromInfo` returns
   `https://<acct>.artifacts.cloudflare.net/git/<ns>/<other-repo>.git`.
5. The push is `git push --no-verify --porcelain <that URL> refs/entire/checkpoints/…:refs/entire/checkpoints/…`.

So routing to a second repository in the same Artifacts account and namespace needs **no code
change** — only a hand-written (or forge-written) settings file. The CLI flag would reject an
unknown provider name, but accepts `gitlab:git/<ns>/<other-repo>` (nested paths are allowed for
`gitlab`).

The provider name still matters, in two places:

- When derivation fails (a `file://` or mismatched `entire://` remote), `gitlab`/`github` fall back
  to `gitlab.com`/`github.com`; an unrecognised name falls back to the origin remote.
- **When `ENTIRE_CHECKPOINT_TOKEN` is set, fetches do not follow steps 1–5** (see the `util.go`
  L239-L256 excerpt above). With `gitlab`/`github` the fetch URL is
  `https://gitlab.com/git/<ns>/<other-repo>.git` (or `github.com`) and `newCommand` attaches the
  Basic header, so the Artifacts token is sent to that public host. With any other provider name
  fetches go to `origin`, i.e. the code repository, not the checkpoint repository. Only the push
  side behaves as in steps 1–5.

So the no-code-change route covers pushes, and covers fetches (`entire resume`, `explain`,
on-demand ref fetch, push recovery by fetch + replay) only when the env var is unset.

Without `checkpoint_remote` at all, checkpoints go to the elected remote as-is, whatever its URL —
that is the "any git URL" case, and it already works, but only for storing checkpoints in the *same*
repository the code is pushed to. `checkpoint_push_remote` can name a second configured remote, but
checkpoints then travel only on pushes *to that remote*, not on pushes to `origin`.

How the token can be supplied, in order of how little has to change:

| Mechanism | Change to Entire | Notes |
|---|---|---|
| git credential helper | none | Entire runs `git push <url>`; helpers are consulted (only interactive prompts are disabled). Artifacts tokens are repo-scoped, so the helper must distinguish repositories on one host — git only passes the path to helpers when `credential.useHttpPath=true`. The helper returns the token secret as the password. |
| `ENTIRE_CHECKPOINT_TOKEN=<token secret>` | **needed for fetches** | Sent as Basic `x-access-token:<secret>`; Artifacts ignores the username. Unmodified, it works for pushes only: fetches are redirected as described above (token sent to `github.com`/`gitlab.com` for those provider names, or fetch from `origin` otherwise). Making it usable needs a change to the `withToken` branch of `fetchURLResolved` so a non-public-forge host is kept. A static env var also does not refresh an expiring token. |
| `http.<url>.extraHeader` in git config | none | Bearer form with the full token; static. |
| command hook for the token | new code | No such mechanism exists in the CLI today. |

What a real `artifacts` provider (a fork or an upstream PR in the shape of #2528) would touch:

- `cmd/entire/cli/setup.go` — accept the provider in `parseCheckpointRemoteFlag` and the flag help.
- `cmd/entire/cli/checkpoint/remote/inherited_claim.go` — offer the claim command for it.
- `cmd/entire/cli/checkpoint/remote/util.go` — only if the `repo` value should be written as
  `<namespace>/<repo>` instead of `git/<namespace>/<repo>`: `deriveCheckpointURLFromInfo` would need
  to insert the `/git/` prefix and the ownership vote would need to compare namespaces rather than
  the first path segment. `providerHost` cannot return a fixed host, because the Artifacts host
  contains the account id.
- `cmd/entire/cli/checkpoint/remote/util.go`, `fetchURLResolved` (L239-L256) — required if
  `ENTIRE_CHECKPOINT_TOKEN` is to be supported: the token branch must derive the fetch URL from the
  origin's host for this provider instead of `providerHost`.
- Tests alongside each, as in #2528.

Leave `strategy_options.filtered_fetches` unset. It adds `--filter=blob:none` to checkpoint
fetches; that this fails or degrades on Artifacts is an **inference** from the v1-capability row
quoted above, not something Cloudflare states for protocol v2 and not something tested here.

### Redaction

What runs before anything is written to a git object —
[`docs/security-and-privacy.md`](https://github.com/entireio/cli/blob/89c2616/docs/security-and-privacy.md#what-entire-redacts-automatically):

| # | Layer | Can be turned off? |
|---|---|---|
| 1 | Entropy scoring (`const entropyThreshold = 4.5`, [`redact/redact.go` L67](https://github.com/entireio/cli/blob/89c2616/redact/redact.go#L67)) | no |
| 2 | Pattern scanners: Betterleaks (default on) and/or goredact (default off) | each can; at least one must stay enabled, else settings fail to load |
| 3 | Provider token prefixes (e.g. `sb_secret_`, `sbp_`) | no |
| 4 | Credentialed URIs (`scheme://user:password@host`) | no |
| 5 | Database connection strings | no |
| 6 | Bounded credential values (`DB_PASSWORD=…`) | no |
| 7 | User rules: `redaction.custom_redactions` and rule packs in `.entire/redactors/*.{yaml,yml,json}` | runs only when configured |
| 8 | PII (`redaction.pii`: email, phone, address, `custom_patterns`) | opt-in |
| 9 | OpenAI Privacy Filter (`redaction.openai_privacy_filter`), shells out to `opf` | opt-in; runs only at pre-push |

- Secrets become the literal `REDACTED` (`const RedactedPlaceholder = "REDACTED"`,
  [`redact.go` L70](https://github.com/entireio/cli/blob/89c2616/redact/redact.go#L70)); PII becomes
  `[REDACTED_EMAIL]`, `[REDACTED_PHONE]`, `[REDACTED_ADDRESS]`, `[REDACTED_<LABEL>]`.
- Scanner selection (`redaction.betterleaks.enabled`, `redaction.goredact.enabled`) is honoured only
  from the committed `.entire/settings.json`. The OPF `command` is honoured only from an untracked
  `.entire/settings.local.json`.
- Order on the committed paths is sanitise → externalise images → redact.
- JSONL-aware skips: fields whose name ends in `signature`, `id` or `ids`; path fields (`filepath`,
  `file_path`, `cwd`, `root`, `directory`, `dir`, `path`); objects whose `type` starts with `image`
  or equals `base64`.
- Redacted artefacts: `full.jsonl`, `transcript.jsonl`, `prompt.txt`, subagent transcripts, the
  `task_description` in `task.json`, the summary, `review_prompt`, `investigate_topic`.
- **Not redacted**: pasted images (for Claude Code they stay inline as base64 in `full.jsonl`, or as
  raw blobs under `assets/` with `redaction.externalize_images`), and the source-file snapshots on
  local shadow branches ("written as raw blobs of your working tree without redaction"; gitignored
  files are excluded).
- The docs call the whole thing "Best-effort. Novel or low-entropy secrets … may not be caught."

Settings block —
[`settings/settings.go` L342-L423](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/settings/settings.go#L342-L423):

```go
type RedactionSettings struct {
	PII *PIISettings `json:"pii,omitempty"`
	CustomRedactions map[string]string `json:"custom_redactions,omitempty"`
	OpenAIPrivacyFilter *OPFSettings `json:"openai_privacy_filter,omitempty"`
	ExternalizeImages bool `json:"externalize_images,omitempty"`
	Betterleaks *ScannerSettings `json:"betterleaks,omitempty"`
	Goredact *ScannerSettings `json:"goredact,omitempty"`
}

type ScannerSettings struct {
	Enabled *bool `json:"enabled,omitempty"`
}

type PIISettings struct {
	Enabled        bool              `json:"enabled"`
	Email          *bool             `json:"email,omitempty"`
	Phone          *bool             `json:"phone,omitempty"`
	Address        *bool             `json:"address,omitempty"`
	CustomPatterns map[string]string `json:"custom_patterns,omitempty"`
}
```

### Enable flow

Non-interactive form: `entire enable --agent claude-code` (add `--telemetry=false`,
`--checkpoint-remote provider:owner/repo`, `--project`/`--local` as needed). What it does —
[`setup.go` `setupAgentHooksNonInteractive`, L2223-L2384](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/setup.go#L2223-L2384):

1. Installs the agent's hooks — for Claude Code, merges the eight entries above into
   `.claude/settings.json`, preserving unrelated keys.
2. Optionally installs agent skills (search, agent-help), depending on flags.
3. Creates `.entire/` and `.entire/.gitignore` containing —
   [`strategy/common.go` L1426-L1432](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/common.go#L1426-L1432):

   ```go
   requiredEntries := []string{
   	"tmp/",
   	"settings.local.json",
   	"metadata/",
   	"logs/",
   	redact.RedactorsDirName + "/local/",
   }
   ```

4. Writes `.entire/settings.json` (or `settings.local.json` if a project file already exists and no
   `--project` was given) with `enabled: true` and, on first run, `checkpoints.primary.type:
   "git-refs"`. Refuses if the existing file does not parse.
5. Installs the five git hooks.
6. `strategy.EnsureSetup` — for the branch backend, ensures the metadata branch exists (fetching it
   from a configured `checkpoint_remote`).
7. Offers to import past agent history (first run, interactive).

An Entire account is not required: the identity preflight only runs when git `user.name`/`user.email`
are missing, and its guidance offers plain `git config` as the fix
([`setup_identity.go`](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/setup_identity.go)).

**Committing the configuration to a repository in advance.** The tracked files are
`.entire/settings.json`, `.entire/.gitignore` and `.claude/settings.json`. Git hooks are per-clone and
cannot be committed, but the first prompt in a fresh clone installs them: the `TurnStart` handler
calls `strategy.EnsureSetup`
([`lifecycle.go` L611-L619](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/lifecycle.go#L611-L619)),
which ends with —
[`strategy/common.go` L96-L121](https://github.com/entireio/cli/blob/89c2616/cmd/entire/cli/strategy/common.go#L96-L121):

```go
// Install generic hooks (they delegate to strategy at runtime)
if !IsGitHookInstalled(ctx) {
	if _, err := ReinstallGitHooks(ctx); err != nil {
		return fmt.Errorf("failed to install git hooks: %w", err)
	}
}
```

So a clone of a repository that already carries those three files needs only the `entire` binary on
`PATH`; a commit made before the first agent prompt in that clone has no git hooks yet and gets no
trailer. A machine without the binary is unaffected (every hook command exits 0).

## Local development and tests

None of this is a Cloudflare runtime API, so nothing here runs under `wrangler dev`, Miniflare or
`@cloudflare/vitest-pool-workers` as such. What matters for tests:

- **Reading the format needs only git objects.** A parser for trailers, `metadata.json`,
  `full.jsonl` and `transcript.jsonl` is pure data handling and can be unit-tested in any runtime
  against fixtures.
- **Real fixtures are public.** Any checkpoint named by a trailer in `entireio/cli`'s history can be
  fetched from `https://github.com/entireio/cli-checkpoints` with one `git fetch` of
  `refs/entire/checkpoints/<last2>/<id>` (done for this note; see "From a commit trailer to the
  transcript"). They contain real session content — review before copying one into a repository.
  Synthetic fixtures can be built from the structs above with plain `git` plumbing
  (`hash-object`, `mktree`, `commit-tree`, `update-ref`).
- **Running the Entire CLI needs a real machine or container**: the `entire` binary, `git`, a POSIX
  `sh` for the hook wrappers, and an agent to produce transcripts. Building it (or a fork) needs
  Go 1.27.1; prebuilt binaries exist for darwin/linux/windows on amd64/arm64.
- **A local bare repository works as a checkpoint destination** when no `checkpoint_remote` is set
  (checkpoints follow the elected remote, whatever its URL). With `checkpoint_remote` set, a
  `file://` or path remote cannot be mapped and the CLI falls back to the provider's public host, so
  that mode needs an HTTPS or SSH remote; the repo's own integration test stands up a local HTTP git
  server for it (`cmd/entire/cli/integration_test/http_remote_test.go`).
- **Capture can be exercised without a model**: the Vogon fake agent (`mise run test:e2e:canary`)
  drives the full hook → shadow branch → condensation → push path deterministically. It requires the
  Go toolchain and the repo's `mise` setup.
- **Cannot run locally at all**: nothing. **Needs a fake in Worker-side tests**: the checkpoint
  repository itself (provide commit/tree/blob lookups from a fixture) and whatever delivers "a ref
  under `refs/entire/checkpoints/` was pushed".

## Could not verify

- **Whether Artifacts accepts pushes to, and serves fetches of, refs outside `refs/heads/` and
  `refs/tags/`** — specifically `refs/entire/checkpoints/<shard>/<id>`. _Settled live on 2026-10-02
  (`spec/research/live/artifacts-git.md`, section 2): such refs are accepted, listed by `ls-remote`,
  fetchable by explicit and wildcard refspec, and produce push events; the `git-branch` fallback is
  not needed. The rest of this item is kept as written before the test._ The Git protocol page does
  not say. The nearest statement is on Cloudflare's
  [best-practices page](https://developers.cloudflare.com/artifacts/concepts/best-practices/):
  "Push and fetch `refs/notes/*` with the rest of your repo data" — so one namespace outside
  heads/tags is expected to work, which makes `refs/entire/*` plausible but is not a statement about
  it. Everything about the git-refs backend on Artifacts depends on it. Not tested: creating
  Cloudflare resources is out of bounds for this task. If it does not, the fallback is the
  `git-branch` backend (`checkpoints.primary.type: "git-branch"`, one branch
  `entire/checkpoints/v1`).
- **Whether an Artifacts push event is emitted for such refs, and what it carries.** Out of scope
  here; belongs to the Artifacts note.
- **The no-code-change route end to end.** Steps 1–5 under "What an Artifacts provider needs" are
  from reading `util.go`, `settings.go` and `gitremote.go`; no Go toolchain was available to run the
  CLI against an Artifacts remote, and the repo has no test for a non-forge HTTPS host with a
  three-segment path. `entire status`/`entire enable` messages for an unknown provider name were not
  traced.
- **`ENTIRE_CHECKPOINT_TOKEN` against Artifacts.** Cloudflare documents Basic auth with any
  username and the token secret as password; Entire sends `x-access-token:<token>`. The combination
  was not exercised, and applies to pushes only — the fetch path is redirected (see above). The Entire code itself notes that the equivalent GitLab behaviour is "an
  external contract verified manually against gitlab.com, not enforced by CI".
- **Credential-helper behaviour inside the `pre-push` hook.** Inferred from the CLI invoking plain
  `git push` with only `GIT_TERMINAL_PROMPT=0` and stdin detached; not run.
- **Whether upstream would accept an Artifacts provider.** No issue or discussion was searched for
  beyond PR #2528; only that PR's size and shape are verified.
- **`--filter=blob:none` against Artifacts.** Cloudflare documents `filter` as unsupported only
  among optional protocol v1 upload-pack capabilities; v2 behaviour is unstated and nothing was
  tested.
- **What the `v1/main`, `v1/full`, `v2/main` and `v2/full/*` refs under `refs/entire/checkpoints/`
  in `entireio/cli-checkpoints` are.** They exist on the remote; the pinned code does not mention
  them and their contents were not inspected.
- **Fast-forward-only assumption on the server.** Entire never force-pushes checkpoint refs and
  recovers from non-fast-forward rejection by fetch + replay. Whether Artifacts rejects
  non-fast-forward pushes to arbitrary refs was not checked.
- **Native transcript formats of agents other than Claude Code**, and the compact converter output
  for them: only the Claude Code path was checked against real data. The Codex, Copilot, Droid,
  Gemini, OpenCode and Pi converters were located but not read line by line.
- **The exact detector count of Betterleaks** ("several hundred built-in detectors" in the docs);
  the pinned module is `github.com/betterleaks/betterleaks v1.8.1` and its rule list was not counted.
- **entire.io blog claims.** The blog was not used; every statement above comes from the repository,
  real checkpoint data, the GitHub API, `docs.entire.io` (one page) or Cloudflare's docs.
- **Hook behaviour when `.entire/settings.json` is absent** (hooks present in `.claude/settings.json`
  but no Entire settings file). `enabled` defaults to true in the struct; the dispatcher's gating for
  a repo that was never set up was not traced.
