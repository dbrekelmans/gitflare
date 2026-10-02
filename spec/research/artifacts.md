# Cloudflare Artifacts

Verified 2026-10-02 against live docs.

Sources were read directly: the Artifacts docs as markdown (`developers.cloudflare.com/artifacts/**/index.md`), the published npm tarballs (`wrangler@4.147.0`, `miniflare@5.20261001.0-alpha`, `@cloudflare/workers-types@5.20261002.1`, `@cloudflare/vitest-pool-workers@0.22.0`), and the `cloudflare/ci` and `cloudflare/artifact-fs` repositories. **Nothing here was run against a live Cloudflare account**; every statement is "the docs or the source say so", not "we observed it".

## What this forces

- **The binding has no local simulator, and never will.** Miniflare classifies `artifacts` as `"DO-NOT-USE-this-resource-will-never-have-a-local-simulator"`: under `wrangler dev` the binding always proxies to the real service and `remote: false` is a hard error. Every package that touches Artifacts needs a port with an in-memory fake for tests; anything else is an integration test against a real, billed account.
- **A push event does not say who pushed.** `cf.artifacts.repo.pushed` carries `ref`, `before`, `after` and commit author/committer strings — no token id, no actor. Cloudflare's own CI SDK sets `actor` from the commit author name. Attribution has to come from the repo itself: one fork per session means the fork's name identifies the session and its user.
- **Tokens cannot carry a label.** No label, name or metadata field exists on token create (binding or REST), and the Basic-auth username is ignored and not logged. Gitflare must store `token id → user` itself, using the `id` returned at mint time.
- **Writing from a Worker without a container is documented, but only for a new repo.** Cloudflare's isomorphic-git example runs `init → commit → push` into a freshly created empty repo, over the HTTPS remote with an in-memory filesystem. Committing into an *existing* repo (clone or fetch, modify, push) is named in that page's prose but not shown, and was not tested. So "decision files can be written to the sibling repo without a Sandbox" is a likely inference, not a verified fact; the same goes for merges (see "Could not verify"). Keep the writer behind a port so a container implementation can replace it.
- **There are two event routes, and only one is namespace-wide.** A `triggers.events` entry in the Wrangler config starts a Workflow directly (no Queue) and can filter on `namespace` alone, so it covers forks created later. The Queues `artifacts.repo` source is documented as scoped to a single repository, and `wrangler queues subscription create` has no flag to name that repository.
- **The docs and Wrangler disagree on the trigger shape.** The guide shows `filter.repoName` and `target: { scriptName, workflowName }`; `wrangler@4.147.0` validates `filter.repo_name` and `targets: [{ type: "workflow", workflow_name }]` and rejects unknown keys. Follow Wrangler (and the `cloudflare/ci` example, which matches it).
- **The binding reads content now** (`readFile`, `readBlob`, `readTree`, `readCommit`, `log`), so a file browser and commit list need neither REST nor a container. Still absent everywhere: diff, compare, merge, ref/branch listing, search, and any write to repo contents.
- **`fork()` copies only the default branch by default** (`defaultBranchOnly` defaults to `true`) and takes no target namespace. A fork is an independent repo: there is no sync or merge-back API, only git with two remotes.
- **Jurisdiction must be set by explicitly creating the namespace before the first repo exists.** Creating a repo in an unknown namespace creates that namespace implicitly and unrestricted. The only documented way to pass a jurisdiction is the REST call; Wrangler has no `namespaces create` command, and the dashboard can create namespaces but whether it offers a jurisdiction there is undocumented.
- **Partial clone works for `blob:none`, but shallow is what to use.** The git protocol page lists `filter` among unsupported capabilities, while the ArtifactFS page says it starts with a blobless clone of an Artifacts remote. Observed 2026-10-02 (`spec/research/live/container-git.md`): protocol v2 advertises `fetch=shallow filter sideband-all`; `--filter=blob:none` works, `--filter=tree:0` returns HTTP 400. On a 33 MB, 7,198-commit repository a full clone took ~60 s, blobless 26.5 s and `--depth=1` 1.9 s, so plan on shallow fetches.

## Verified facts

### Workers binding — config

Source: https://developers.cloudflare.com/artifacts/api/workers-binding/ and `wrangler@4.147.0` `wrangler-dist/cli.d.ts`.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "artifacts": [
    {
      "binding": "ARTIFACTS",
      "namespace": "default"
    }
  ]
}
```

```ts
// wrangler@4.147.0 — wrangler-dist/cli.d.ts
    /**
     * NOTE: This field is not automatically inherited from the top level environment,
     * and so must be specified in every named environment.
     *
     * @default []
     * @nonInheritable
     */
    artifacts: {
        /** The binding name used to refer to the Artifacts instance. */
        binding: string;
        /** The namespace to use. */
        namespace: string;
        /** Whether to use the remote Artifacts service in local dev. */
        remote?: boolean;
    }[];
```

- One binding is one namespace, named in config. The binding has no method that takes a namespace.
- "Make sure to update to Wrangler 4.145.0 or later before generating Artifacts binding types or using Blob-returning methods with a remote binding in local development."
- The Worker passes no token; the binding is the credential.

### Workers binding — methods

Source: `@cloudflare/workers-types@5.20261002.1` `index.d.ts` (https://www.npmjs.com/package/@cloudflare/workers-types/v/5.20261002.1). Doc comments trimmed; signatures verbatim.

```ts
interface Artifacts {
  create(
    name: string,
    opts?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult>;
  /** @throws NOT_FOUND | CREATE_IN_PROGRESS | IMPORT_IN_PROGRESS | FORK_IN_PROGRESS */
  get(name: string): Promise<ArtifactsRepo>;
  import(params: {
    source: {
      url: string;
      branch?: string;
      depth?: number;
    };
    target: {
      name: string;
      opts?: {
        description?: string;
        readOnly?: boolean;
      };
    };
  }): Promise<ArtifactsCreateRepoResult>;
  /** @param opts Optional: limit (1–200, default 50), cursor for next page. */
  list(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<ArtifactsRepoListResult>;
  /** Delete a repository and all associated tokens. @returns true if deleted, false if not found. */
  delete(name: string): Promise<boolean>;
}

interface ArtifactsRepo extends Disposable {
  /** @param scope "write" (default) or "read". @param ttl seconds (default 86400, min 60, max 31536000). */
  createToken(
    scope?: "write" | "read",
    ttl?: number,
  ): Promise<ArtifactsCreateTokenResult>;
  listTokens(): Promise<ArtifactsTokenListResult>;
  /** Revoke a token by plaintext or ID. @returns true if revoked, false if not found. */
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoInfo>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: {
    ref?: string;
    limit?: number;
    offset?: number;
  }): Promise<ArtifactsCommitMetadata[]>;
  /** @param opts Optional: description, readOnly flag, defaultBranchOnly (default true). */
  fork(
    name: string,
    opts?: {
      description?: string;
      readOnly?: boolean;
      defaultBranchOnly?: boolean;
    },
  ): Promise<ArtifactsCreateRepoResult>;
}
```

```ts
interface ArtifactsRepoInfo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  /** Fork source (e.g. "github:owner/repo", "artifacts:namespace/repo"), or null if not a fork. */
  source: string | null;
  readOnly: boolean;
  remote: string;
}
interface ArtifactsCreateRepoResult {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  /** Plaintext access token (only returned at creation time). */
  token: string;
}
interface ArtifactsRepoListResult {
  repos: Omit<ArtifactsRepoInfo, "remote">[];
  total: number;
  cursor?: string;
}
interface ArtifactsCreateTokenResult {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}
interface ArtifactsTokenInfo {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}
interface ArtifactsTokenListResult {
  tokens: ArtifactsTokenInfo[];
  total: number;
}
type ArtifactsTreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";
interface ArtifactsTreeEntry {
  name: string;
  /** Canonical Git mode, such as `100644` for a file or `40000` for a tree. */
  mode: string;
  hash: string;
  type: ArtifactsTreeEntryType;
}
interface ArtifactsCommitMetadata {
  hash: string;
  treeHash: string;
  /** Commit message with one trailing newline removed, if present. */
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  /** Parent commit IDs in Git order; empty for a root commit. */
  parents: string[];
  /** Author timestamp in Unix seconds. */
  authoredAt: number;
  /** Committer timestamp in Unix seconds. */
  committedAt: number;
}
type ArtifactsErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "CREATE_IN_PROGRESS"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "REMOTE_AUTH_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "MEMORY_LIMIT"
  | "INTERNAL_ERROR";
interface ArtifactsError extends Error {
  readonly name: "ArtifactsError";
  readonly code: ArtifactsErrorCode;
  /** Numeric error code matching the REST API. */
  readonly numericCode: number;
}
```

Behaviour, from https://developers.cloudflare.com/artifacts/api/workers-binding/ and the type comments:

- `get()` returns an RPC stub, not metadata. Declare it with `using repo = await env.ARTIFACTS.get(name)`; metadata comes only from `repo.info()`.
- `log()` follows the **first-parent chain**, newest first; `limit` defaults to 50 and is capped at 1000; pagination is `offset`. It returns `[]` when the ref cannot be resolved (it does not throw).
- `readTree()` returns only immediate children; walking a tree is one call per directory.
- `readFile()` returns a MIME-typed `Blob`, `null` for a missing path or a directory. `readBlob()` returns an untyped `Blob`. Both can throw `MEMORY_LIMIT` "if the object cannot be buffered safely".
- `list()` entries carry a `status` of `ready`, `importing`, or `forking` (docs page; the field is not in the published `ArtifactsRepoInfo` type).
- `create()`, `fork()` and `import()` always mint and return an initial token as a bare string; `createToken()` returns `{ id, plaintext, scope, expiresAt }`.
- There is no method to update a repo (description, default branch, `readOnly`) after creation, and none to list refs or branches.

Docs pages that contradict the types — trust the types:

- https://developers.cloudflare.com/artifacts/examples/isomorphic-git/ says the binding "cannot read or write files inside" repos. It can read (`readFile` etc.); it cannot write.
- https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/ reads `repo.defaultBranch` and `repo.remote` off the handle. Those are not properties; use `info()`.
- `cloudflare/ci` (`src/artifacts/source-control.ts`, commit `fbbc290`, 2026-09-14) carries a comment that published types lack `readCommit`/`readTree`. `5.20261002.1` has them.

### REST API

Source: https://developers.cloudflare.com/artifacts/api/rest-api/

```txt
https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces/$ARTIFACTS_NAMESPACE
Authorization: Bearer $CLOUDFLARE_API_TOKEN
```

API token permissions: **Artifacts > Read** for read routes, **Artifacts > Edit** for write routes (https://developers.cloudflare.com/artifacts/guides/authentication/). Repo tokens do not authenticate REST.

Complete documented route list, relative to `/accounts/$ACCOUNT_ID`:

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/artifacts/namespaces` | body `namespace`, optional `jurisdiction` |
| GET | `/artifacts/namespaces?limit=&cursor=` | |
| GET | `/artifacts/namespaces/:namespace` | |
| POST | `/artifacts/namespaces/:namespace/repos` | body `name`, `description?`, `default_branch?`, `read_only?` |
| GET | `/artifacts/namespaces/:namespace/repos?limit=&cursor=&search=&sort=&direction=` | `limit` default 50, max 200; `sort` is `created_at` \| `updated_at` \| `last_push_at` \| `name` |
| GET | `/artifacts/namespaces/:namespace/repos/:name` | |
| DELETE | `/artifacts/namespaces/:namespace/repos/:name` | returns `202 Accepted` |
| POST | `/artifacts/namespaces/:namespace/repos/:name/fork` | body `name`, `description?`, `read_only?`, `default_branch_only?` |
| POST | `/artifacts/namespaces/:namespace/repos/:name/import` | body `url`, `branch?`, `depth?`, `read_only?`; public HTTPS remotes only |
| GET | `/artifacts/namespaces/:namespace/repos/:name/log?ref=&limit=&offset=` | |
| GET | `/artifacts/namespaces/:namespace/repos/:name/commit/:hash` | |
| GET | `/artifacts/namespaces/:namespace/repos/:name/tree/:hash` | |
| GET | `/artifacts/namespaces/:namespace/repos/:name/blob/:hash` | raw bytes |
| GET | `/artifacts/namespaces/:namespace/repos/:name/file?ref=&path=` | raw bytes, `application/octet-stream` |
| GET | `/artifacts/namespaces/:namespace/repos/:name/raw/:ref/:path` | raw bytes, sniffed `Content-Type` |
| GET | `/artifacts/namespaces/:namespace/repos/:name/tokens?state=&per_page=&page=` | `state` is `active` \| `expired` \| `revoked` \| `all`, default `active`; `per_page` default 30, max 100 |
| POST | `/artifacts/namespaces/:namespace/tokens` | body `repo`, `scope?`, `ttl?` |
| DELETE | `/artifacts/namespaces/:namespace/tokens/:id` | |

- **Confirmed: no diff, compare, merge, ref/branch, search-in-content, or write-content route.** "Object routes use immutable Git SHA-1 hashes. File routes resolve a path at a branch, tag, or commit hash."
- JSON responses use the v4 envelope `{ result, success, errors, messages, result_info? }`. Repo lists paginate by cursor (`result_info.cursor`); token lists paginate by page (`page`, `per_page`, `total_pages`, `count`, `total_count`). `log` paginates by `offset`.
- Blob, file and raw routes return bytes on success and the JSON envelope on error (`code: 10200`, "File not found").
- Fork result adds `objects: number` to the create result.
- Under **Import**, the page says: "If a repo exists but is still importing or forking, this route can return `409 Conflict` with a retriable error message." "This route" is the import route. The import guide adds that follow-up REST calls on a repo still importing can return `409 Conflict`. The docs do not state a status code for the fork route or for calls on a repo still forking; `FORK_IN_PROGRESS` (10303) is the documented error code.
- REST-only (not on the binding): namespace create/list/get; repo list `search`/`sort`/`direction`; token list `state` filter and paging; the `raw` route; `objects` in the fork result.
- Error codes (https://developers.cloudflare.com/artifacts/api/errors/): `INVALID_INPUT` 10100, `INVALID_REPO_NAME` 10101, `INVALID_TTL` 10103, `INVALID_URL` 10104, `REMOTE_AUTH_REQUIRED` 10106, `NOT_FOUND` 10200, `ALREADY_EXISTS` 10201, `IMPORT_IN_PROGRESS` 10302, `FORK_IN_PROGRESS` 10303, `INTERNAL_ERROR` 10400, `UPSTREAM_UNAVAILABLE` 10401, `MEMORY_LIMIT` 10402.

```ts
// REST shapes, from the REST API page
export interface RepoInfo {
	id: string;
	name: RepoName;
	description: string | null;
	default_branch: string;
	created_at: string;
	updated_at: string;
	last_push_at: string | null;
	source: string | null;
	read_only: boolean;
}
export interface RepoWithRemote extends RepoInfo {
	remote: string;
}
export interface TokenInfo {
	id: string;
	scope: Scope;
	state: TokenState;
	created_at: string;
	expires_at: string;
}
export interface CreateTokenRequest {
	repo: RepoName;
	scope?: Scope;
	ttl?: number;
}
export interface CreateTokenResult {
	id: string;
	plaintext: ArtifactToken;
	scope: Scope;
	expires_at: string;
}
```

### Git protocol and tokens

Source: https://developers.cloudflare.com/artifacts/api/git-protocol/

- Remote: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. "Use the exact hostname from the repo `remote` returned by the Workers binding or REST API." (The 2026-04-16 changelog entry shows an older host form; do not build the URL by hand.)
- HTTPS smart protocol only. No SSH endpoint is documented anywhere in the docset.
- Token format: `art_v1_<40 hex>?expires=<unix_seconds>` in the docs. Observed 2026-10-02: a token minted with `repo.createToken()` was `art_v2_x_<40 hex>?expires=<unix_seconds>`. Do not parse the prefix.
- Two ways to present it:

```sh
# Bearer: the full token string, including ?expires=
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone "$ARTIFACTS_REMOTE" artifacts-clone

# Basic: the secret only, with the ?expires= suffix stripped, in the password slot
export ARTIFACTS_TOKEN_SECRET="${ARTIFACTS_TOKEN%%\?expires=*}"
export ARTIFACTS_AUTH_REMOTE="https://x:${ARTIFACTS_TOKEN_SECRET}@${ARTIFACTS_REMOTE#https://}"
```

- "Use any non-empty username in the URL. Artifacts accepts that username but does not otherwise use or log it." A credential helper therefore returns any username plus the stripped secret as the password.
- Scopes: `read` allows clone, fetch, pull; `write` adds push. Tokens are repo-scoped. The docs list only these two scopes; no per-branch or per-ref restriction is documented anywhere (an absence, not a stated guarantee).
- TTL: minimum 60 s, maximum 31,536,000 s (1 year), default 86,400 s (24 h). Out of range is `INVALID_TTL`.
- Minting: `repo.createToken(scope?, ttl?)`, `POST …/tokens`, `wrangler artifacts repos issue-token <REPO> --namespace --scope --ttl`, or the dashboard. Listing: `repo.listTokens()` or `GET …/repos/:name/tokens`. Revoking: `repo.revokeToken(tokenOrId)` (plaintext or id) or `DELETE …/tokens/:id`.
- **No label, name or metadata field** on any token create path; `TokenInfo` is `id`, `scope`, `state`, `created_at`, `expires_at`.
- Deleting a repo deletes its tokens (type comment on `Artifacts.delete`).
- Protocol support: clone/fetch over v1 and v2 (`ls-refs`, `fetch`); push over v1 `git-receive-pack` only. "Some optional v1 capabilities, such as `filter` and `include-tag`, are not supported." "Protocol v1 supports normal fetch flows, including shallow and deepen fetches."
- git notes are supported and recommended for harness metadata; they live on `refs/notes/*` and must be pushed and fetched explicitly (https://developers.cloudflare.com/artifacts/concepts/best-practices/).

### Forks and read-only repos

Sources: https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/, the REST page, the binding types.

- "A fork creates a new repo that starts from an existing repo's history, then diverges independently with its own tokens, routing, and lifecycle."
- Neither `fork()` nor `POST …/fork` accepts a target namespace; the fork lands in the source repo's namespace.
- `defaultBranchOnly` defaults to `true` (type comment). Pass `false` to copy every branch.
- Forking is asynchronous: the fork can be in `forking` status and `get()` throws `FORK_IN_PROGRESS`. Observed 2026-10-02: `repo.fork()` through the binding returned only once the fork was usable — after 3.4 s for a tiny repository and 41.3 s for a 33 MB one — and `FORK_IN_PROGRESS` was never seen. The REST status code for a repo still forking is not documented (the `409` statement on the REST page is about the import route).
- `source` on the fork's info reads `"artifacts:namespace/repo"`.
- `readOnly` / `read_only` can be set on create, fork and import. No route or method changes it afterwards.
- No API fetches from the parent or merges back. With a normal git client it is two remotes and two repo tokens.
- Deleting a fork is an ordinary repo delete.

### Events

Sources: https://developers.cloudflare.com/artifacts/guides/event-subscriptions/, https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/

Exact documented payload:

```json
{
  "type": "cf.artifacts.repo.pushed",
  "source": {
    "type": "artifacts.repo",
    "namespace": "my-namespace",
    "repoName": "my-repo"
  },
  "payload": {
    "ref": "refs/heads/main",
    "before": "abc123def456abc123def456abc123def456abc1",
    "after": "def789ghi012def789ghi012def789ghi012def7",
    "commits": [
      {
        "id": "def789ghi012def789ghi012def789ghi012def7",
        "message": "Fix bug in authentication",
        "messageTruncated": false,
        "timestamp": "2025-05-01T02:48:57.000Z",
        "author": {
          "name": "Developer Name",
          "email": "developer@example.com"
        },
        "committer": {
          "name": "Developer Name",
          "email": "developer@example.com"
        },
        "parents": [
          "abc123def456abc123def456abc123def456abc1"
        ]
      }
    ],
    "totalCommitsCount": 1,
    "commitsTruncated": false
  },
  "metadata": {
    "accountId": "f9f79265f388666de8122cfb508d7776",
    "eventSubscriptionId": "1830c4bb612e43c3af7f4cada31fbf3f",
    "eventSchemaVersion": 1,
    "eventTimestamp": "2025-05-01T02:48:57.132Z"
  }
}
```

- It carries the ref and before/after SHAs. It carries **no token id and no actor**. `commits` can be truncated (`commitsTruncated`, `totalCommitsCount`) and long messages too (`messageTruncated`), so the range must be re-read from the repo, not trusted from the event.
- The documented payload has a single `ref` field, not a list. `cloudflare/ci` (`src/artifacts/events.ts`) treats an `after` of forty zeros as a deletion, ignores refs outside `refs/heads/` and `refs/tags/`, and sets `actor: commit?.author.name`.
- Inference, not stated by either source: a push that updates several refs produces one event per ref, and pushes to other refs (for example `refs/notes/*`) also produce events. The single `ref` field and the parser's guard suggest both; handle them, but do not rely on them.
- All event types (`wrangler@4.147.0`, `ARTIFACTS_EVENT_TYPES`): `cf.artifacts.repo.created`, `.deleted`, `.forked`, `.imported`, `.pushed`, `.cloned`, `.fetched`, `.token.created`, `.token.revoked`.
- Account-level source `artifacts`: created, deleted, forked, imported. Repo-level source `artifacts.repo` ("with a `namespace` and `repo_name`"): pushed, cloned, fetched, token.created, token.revoked.
- `cloned` and `fetched` have an empty `payload`. `token.created` payload is `{ tokenId, scope, expiresAt }`; `token.revoked` is `{ tokenId }`. `repo.forked` has the parent in `source` and the fork's `namespace`, `repoName`, `repoId` in `payload`.

Route 1 — Queue event subscription. Created in the dashboard (Queues > queue > Subscriptions > Subscribe to events), with Wrangler, or over REST:

```bash
npx wrangler queues subscription create <queue-name> --source <source-type> --events <event1,event2> --<source-specific-option> <value>
```

`wrangler@4.147.0` accepts `--source artifacts` and `--source artifacts.repo`, but sends `{ type: "artifacts.repo" }` with nothing else: it has no flag for namespace or repo name. The REST route Wrangler calls is `POST /accounts/{account_id}/event_subscriptions/subscriptions` with body `{ name, enabled, source, destination: { type: "queues.queue", queue_id }, events }`.

Route 2 — event trigger straight to a Workflow, no Queue. Shape accepted by `wrangler@4.147.0`:

```ts
// wrangler@4.147.0 — wrangler-dist/cli.d.ts
type ArtifactsEventTrigger = {
    type: ArtifactsEventType;
    filter?: {
        namespace?: string;
        repo_name?: string;
    };
    targets: {
        type: "workflow";
        workflow_name: string;
    }[];
};
// config field: triggers: { crons?: string[]; events?: ArtifactsEventTrigger[]; }
```

```jsonc
// cloudflare/ci examples/cloudflare-artifacts/wrangler.jsonc
"triggers": {
  "events": [
    {
      "type": "cf.artifacts.repo.pushed",
      "filter": {
        "namespace": "cloudflare-ci-example",
        "repo_name": "example-repository",
      },
      "targets": [
        {
          "type": "workflow",
          "workflow_name": "cloudflare-ci-artifacts",
        },
      ],
    },
  ],
},
```

- The target Workflow must be defined by the same Worker; Wrangler refuses the deploy otherwise. Wrangler deploys triggers with `PUT /accounts/{account_id}/triggers/{script_name}`.
- "When you omit `repoName`, Cloudflare runs the same Workflow for every push to any repo in your Artifacts namespace." (https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/ — that page uses the `repoName` / `target` spelling Wrangler rejects.)

### Namespaces, limits, pricing

Sources: https://developers.cloudflare.com/artifacts/concepts/namespaces/, https://developers.cloudflare.com/artifacts/guides/data-localization/, https://developers.cloudflare.com/artifacts/platform/limits/, https://developers.cloudflare.com/artifacts/platform/pricing/

- "If you create a repo under a namespace name that does not exist, Artifacts creates the namespace automatically."
- Jurisdiction: `eu` or `us`, set only at namespace creation, applies to every repo in it, cannot be changed. Omitted means unrestricted.

```bash
curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "namespace": "my-eu-namespace",
    "jurisdiction": "eu"
  }'
```

- Wrangler has `artifacts namespaces list` and `get` only; namespaces can also be created in the dashboard (Storage & databases > Artifacts). Observed 2026-10-02: `DELETE /artifacts/namespaces/:namespace` on an empty namespace returned `204` and removed it, although the route is not in the documented list.

| Limit | Value |
| --- | --- |
| Control-plane request rate | 2,000 requests per 10 seconds per namespace |
| Git request rate | 2,000 requests per 10 seconds per repo |
| Storage per repository | 1 GB |
| Individual file or blob | 32 MB |
| Storage per account | 1 TB (can be raised on request) |
| Repositories, namespaces | Unlimited |
| Namespace name length | 2–63 characters |
| Names | Start with a letter or digit; then letters, digits, `.`, `_`, `-` |

- Pricing: Workers Paid only. Operations ("such as `create`, `push`, `pull`, and `clone`"): first 10,000 per month, then $0.15 per 1,000. Storage: first 1 GB-month, then $0.50 per GB-month, "calculated by averaging peak storage per day over a 30-day billing period", across all repositories. Replicas are not charged. Billing begins 2026-10-14.
- Metrics: GraphQL dataset `artifactsEventsAdaptiveGroups`, 31 days, dimensions include `repositoryNamespace` and `repositoryName`; event types `create`, `fork`, `push`, `pull`, `delete`, and errors `storageLimitReached`, `serverError`, `clientError`, `rateLimited` (https://developers.cloudflare.com/artifacts/observability/metrics/).
- Workers Builds can use an Artifacts repo as a source; "The Artifacts integration only supports `main` as the production branch." (https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/)

### ArtifactFS

Sources: https://developers.cloudflare.com/artifacts/guides/artifact-fs/, https://github.com/cloudflare/artifact-fs (README at commit `2b87a48`, 2026-08-12; "beta release").

- A Go FUSE daemon. Install: `go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@latest` (Go 1.26+). Needs `fuse3` on Linux, macFUSE on macOS.
- Mount:

```bash
artifact-fs add-repo \
  --name starter-repo \
  --remote "$ARTIFACTS_AUTH_REMOTE" \
  --branch main \
  --mount-root /tmp

artifact-fs daemon --root /tmp &
```

- In Docker it needs `--cap-add SYS_ADMIN --device /dev/fuse` (plus `--security-opt apparmor:unconfined` on AppArmor hosts).
- The repo ships a Cloudflare Sandbox example: `FROM docker.io/cloudflare/sandbox:0.12.5`, `apt-get install fuse3 git`, copy the binary in.
- "The remote must advertise Git partial-clone filtering for file contents to hydrate over the network on demand. If it does not, Git downloads the selected revision's blobs eagerly."
- Known costs: `git status` ~7 s and `git reset` ~6.5 s on a 5,800-entry repo; submodules are not initialised.
- Cloudflare's own guidance: "For smaller repos, start with a regular `git clone`. It is usually fast enough and simpler to operate."
- What Cloudflare's CI SDK does instead of ArtifactFS (`cloudflare/ci` `src/shared/source-checkout.ts`): `git init`, `remote add`, then `git -c http.extraHeader="Authorization: Bearer $SOURCE_CONTROL_TOKEN" fetch --depth=1 origin <sha>` and `git checkout --detach FETCH_HEAD`.

### Writing from a Worker without a container

Source: https://developers.cloudflare.com/artifacts/examples/isomorphic-git/ (`isomorphic-git@1.42.6` current on npm).

- Documented, with a full example, for one flow only: `env.ARTIFACTS.create()` a new empty repo, then `git.init`, write files into an in-memory `fs`, `git.add`, `git.commit`, `git.push` against `created.remote`. The example does not clone or fetch.

```ts
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

const tokenSecret = created.token.split("?expires=")[0];

const push = await git.push({
	fs,
	http,
	dir,
	url: created.remote,
	ref: "main",
	onAuth: () => ({
		username: "x",
		password: tokenSecret,
	}),
});
```

- The filesystem is a `MemoryFS` class printed on that page (about 220 lines of TypeScript) exposing `promises.readFile/writeFile/unlink/readdir/mkdir/rmdir/stat/lstat`; it is not an npm package.
- The page names a wider use in prose only: "an automation that clones a repo, modifies files, and pushes changes back". No code for it is shown.
- The binding and REST have no documented write-content operation. That leaves a git client as the only documented way to create a commit: isomorphic-git in a Worker, or real git in a container.
- isomorphic-git has a `merge` command with `fastForward`, `fastForwardOnly`, `dryRun` and `abortOnConflict` options (https://isomorphic-git.org/docs/en/merge).

## Local development and tests

- **Binding under `wrangler dev` / Miniflare: not simulated.** `miniflare@5.20261001.0-alpha` (the version `wrangler@4.147.0` depends on) implements the Artifacts plugin only as a proxy to the remote service. With `remote` unset it warns "Artifacts bindings always access remote resources, and so may incur usage charges even in local dev"; with `remote: false` it throws "bindings do not support local development". Set `remote: true`. This needs `wrangler login`, a Workers Paid account, and creates real repos.
- **`@cloudflare/vitest-pool-workers@0.22.0`**: has a `remoteBindings` pool option that defaults to `true`, so a test with an Artifacts binding in its config would call the real service. Not exercised here. Unit tests should inject a fake through a port instead.
- **Fake needed for**: the binding (all methods), the event payloads (enqueue the documented JSON by hand; Queues and Workflows themselves are simulated locally), and token minting.
- **Git over HTTPS**: there is no local Artifacts git endpoint. Any local smart-HTTP git server can stand in for clone/fetch/push logic; it will not reproduce Artifacts' token format, missing `filter`, or v1-only push.
- **isomorphic-git path**: a JavaScript library with no binding dependency, so it should run under Miniflare and Vitest with only the remote standing in. Not exercised here.
- **ArtifactFS**: needs Docker with FUSE (`--cap-add SYS_ADMIN --device /dev/fuse`). Its own e2e suite runs against a local bare repo, no network.
- **Cannot run locally at all**: event emission on push, `triggers.events` delivery, fork/import asynchrony, rate limits, jurisdiction.

## Could not verify

- **Fork storage accounting.** No page says whether a fork shares objects with its parent or counts in full against the 1 GB repo and 1 TB account limits. The fork response's `objects` count and "diverges independently" suggest a copy, but that is inference. Tried: the Artifacts docset, the two Artifacts blog posts (2026-04 beta, 2026-10 open beta), the pricing and limits pages. Needs a measurement on a real account.
- **Cross-namespace forks.** The `repo.forked` example event shows different source and target namespaces, but no API accepts a target namespace. Possibly dashboard-only or an example artefact.
- **Whether `--filter=blob:none` works.** Resolved 2026-10-02: it does (see "What this forces"). The protocol page says `filter` is unsupported (worded as a v1 capability); the ArtifactFS page describes a blobless clone against Artifacts. No capability advertisement could be inspected without a repo.
- **How to scope a Queue subscription to one repo.** The guide says the `artifacts.repo` source takes `namespace` and `repo_name`; Wrangler 4.147.0 sends neither, and the Queues REST reference (https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/) lists no Artifacts source at all. Also unknown: whether `--events` takes `pushed` or `cf.artifacts.repo.pushed`, and whether an unscoped `artifacts.repo` subscription is accepted.
- **What a Workflow receives from `triggers.events`.** `cloudflare/ci` parses the same `{ type, source, payload }` shape (plus an optional `id`), but the Workflow `event.payload` contract is not documented. Delivery guarantees, ordering and latency are not documented for either route.
- **Undocumented fields on the push event.** Absence of an actor or token id is established from the documented example and Cloudflare's own parser, not from a captured live event.
- **REST JSON for `log`, `commit/:hash`, `tree/:hash`.** The REST page gives routes and curl only. The binding types give the camelCase shapes; the REST field names (probably snake_case) are not published. The Cloudflare API reference has no Artifacts section (`/api/resources/artifacts/` is 404 and absent from `/api/llms.txt`).
- **The initial token from `create()` / `fork()` / `import()`.** A getting-started comment calls it a write token; its TTL is not stated (parse `?expires=`). Whether it appears in `listTokens()` was not checked.
- **`read_only` enforcement.** Not stated whether a push with a write token to a read-only repo is rejected, with what error, or whether the flag can ever be changed.
- **isomorphic-git `clone` / `fetch` against Artifacts.** Cloudflare's example only pushes into a new empty repo. Committing into an existing repo from a Worker needs a clone or fetch first; that is mentioned in prose, not demonstrated, and the protocol page says some optional v1 capabilities are unsupported. Whether isomorphic-git's fetch negotiation works against Artifacts was not tested. Until it is, writing to an existing repo without a container is unproven.
- **One event per ref, and events for refs outside `refs/heads/` and `refs/tags/`.** Inferred from the single `ref` field in the example payload and from a guard in `cloudflare/ci`; neither source states it.
- **Jurisdiction in the dashboard.** The 2026-06-17 changelog says namespaces can be created in the dashboard; it does not say whether a jurisdiction can be chosen there.
- **REST status while a repo is forking.** The `409 Conflict` statement on the REST page belongs to the import route.
- **Merging in a Worker at realistic size.** isomorphic-git needs the objects in memory; no source states what repo size fits a Worker's memory and CPU limits, and its merge behaviour (rename handling, conflict output) was not tested. Treat container git as the default for merges until measured.
- **ArtifactFS inside a Cloudflare Container.** An example image exists, pinned to `cloudflare/sandbox:0.12.5`; how `/dev/fuse` is made available there, and whether it works on Sandbox SDK 1.0 images, was not established.
- **Which calls are billed operations.** The pricing page gives examples only; binding reads (`readFile`, `log`), token mints and fetches are not classified.
- **Rate-limit responses** (status code, `Retry-After`), and what happens to forks when the parent is deleted.
