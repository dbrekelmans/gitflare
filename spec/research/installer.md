# Installer: Cloudflare auth, resource creation, prebuilt deploy

Verified 2026-10-02 against live docs.

Sources are the live documentation pages (fetched as raw markdown), the Cloudflare API reference, and the published npm tarballs `wrangler@4.147.0`, `cf@1.0.0-beta.11`, `create-cloudflare@2.73.2`. **Nothing here was exercised against a live Cloudflare account** — no resources were created and no token was used. Where a fact comes from reading a bundle rather than from documentation it is marked *(source)*; where behaviour was inferred rather than stated it is under "Could not verify".

## What this forces

- **`wrangler login` cannot provision the whole install.** Wrangler's OAuth client has a fixed scope list that covers Workers, D1, Queues, Artifacts and Containers but has no Access and no AI Gateway scope, and `--scopes` only accepts scopes from that list. A second credential path is required for the Access application and the AI Gateway. The installer needs an auth port with more than one implementation.
- **Cloudflare now lets third parties register OAuth clients**, including public clients using Authorization Code + PKCE for CLIs. That is the clean long-term route (one consent screen, exactly our scopes), but making a client public needs a one-time DNS `TXT` verification of the client URL's domain by the project, and Device Authorization is not available to third-party clients.
- **The `cf` CLI does not expose its token.** `cf auth login` has every scope the install needs (including Access, AI Gateway and `account_api_tokens:create`), but it keeps its own credentials, does not reuse a Wrangler login, and has no `auth token` command. It can only be used by shelling out to `cf <command>`.
- **A push event does not need a Queue.** Wrangler config has `triggers.events`, which starts a Workflow directly from an Artifacts event, filtered by namespace (one entry covers every repo in the namespace, forks included). The Queue subscription route still exists. The published docs and the `wrangler@4.147.0` schema disagree on the field names of this block — the generated config must follow the schema of the wrangler version the installer pins.
- **Durable Object lifecycle is declarative now.** `exports` in the Wrangler config replaces the `migrations` array (the two are mutually exclusive). An upgrade ships the full desired class map; there are no migration tags for the installer to track.
- **A custom Sandbox image costs a Docker dependency at install time.** With the `durable_object` scheduling policy (what Sandbox 1.0 uses), the only image usable without a registry push is the managed `cloudflare/debian-trixie`; any other image must be a digest-pinned reference in the account's own Cloudflare registry, and external registries are not pulled. Docker Hub references work only with the `default` policy.
- **Protect the forge with a hostname-based Access application, not a Worker-level one.** Worker-level Access rejects WebSocket upgrades with `403`. New Zero Trust organisations also no longer get One-time PIN by default — the default login is "Cloudflare account" — so letting in people by email requires the installer to add the OTP identity provider through the API.
- **Per-user spend limits by Access identity need a zone.** AI Gateway only sets `cf.user_id` for requests that arrive through an Access-protected gateway *custom domain*. A deployment on `workers.dev` must attach its own user id as custom metadata and scope spend-limit rules on that key instead.
- **Three steps cannot be automated and need a dashboard visit:** subscribing to Workers Paid, completing Zero Trust onboarding (team name, plan selection, payment details — required even on the free plan), and loading AI Gateway credits if models are billed through Cloudflare (Unified Billing). The installer must detect each and stop with a link.
- **`npx create-gitflare` pulls in Node ≥ 22 and a `workerd` binary.** `wrangler@4.147.0` declares `engines.node >= 22.0.0` and depends on `workerd` and `miniflare`; this is the install-time cost of using Wrangler as the deploy engine and counts against the ten-minute target.

## Verified facts

### Authentication

**Wrangler OAuth (`wrangler@4.147.0`).** `wrangler login` opens the browser and listens on `localhost:8976`; `--device` uses the Device Authorization Grant instead (no callback server); `--scopes` takes a whitespace-separated list. "`wrangler login` uses all the available scopes by default if no flags are provided." — https://developers.cloudflare.com/workers/wrangler/commands/general/#login

The complete scope list wrangler can request *(source: `wrangler-dist/cli.js`, `DefaultScopes`; `validateScopeKeys` rejects anything else)*:

```txt
k2.read  k2.write  account:read  user:read  workers:write  workers_kv:write
workers_routes:write  workers_scripts:write  workers_tail:read  d1:write
pages:write  zone:read  ssl_certs:write  ai:write  ai-search:write
ai-search:run  agent-memory:write  queues:write  pipelines:write
secrets_store:write  artifacts:write  flagship:write  containers:write
cloudchamber:write  connectivity:admin  email_routing:write
email_sending:write  browser:write  challenge-widgets.write
```

No `access*`, `aig*`/`agw*`, `account_api_tokens*` or `billing*` scope is present.

**Reading wrangler's token.** `wrangler auth token` prints the active credential; with `--json`:

```jsonc
// API token
{ "type": "api_token", "token": "..." }

// OAuth token
{ "type": "oauth", "token": "..." }

// API key/email (only available with --json)
{ "type": "api_key", "key": "...", "email": "..." }
```

Precedence is `CLOUDFLARE_API_TOKEN`, then `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`, then the OAuth token from `wrangler login` "(automatically refreshed if expired)". — https://developers.cloudflare.com/workers/wrangler/commands/general/#auth-token

OAuth credentials are stored by default in a plaintext TOML file "typically `~/.config/.wrangler/config/default.toml`", or in the OS keychain with `--use-keyring`. Shelling out to `wrangler auth token` is the supported way to read them. — same page, "Storing OAuth credentials in the OS keychain"

**Environment variables wrangler honours** (so a token obtained any other way can drive it): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_BASE_URL`, `WRANGLER_SEND_METRICS`, `WRANGLER_OUTPUT_FILE_PATH`. — https://developers.cloudflare.com/workers/wrangler/system-environment-variables/

**Third-party OAuth clients.** Created under **Manage Account > OAuth clients** or by API:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/oauth_clients" \
	-H "Content-Type: application/json" \
	-H "Authorization: Bearer $API_TOKEN" \
	-d '{
		"client_name": "Cloudflare OAuth Client",
		"grant_types": ["authorization_code"],
		"redirect_uris": ["https://example.com/oauth/callback"],
		"scopes": ["workers-platform.read", "workers-platform.write"],
		"optional_scopes": ["workers-platform.read"],
		"post_logout_redirect_uris": ["https://example.com/logout"],
		"response_types": ["code"],
		"token_endpoint_auth_method": "client_secret_basic",
		"logo_uri": "https://example.com/logo.png",
		"policy_uri": "https://example.com/policy",
		"tos_uri": "https://example.com/tos",
		"client_uri": "https://example.com",
		"allowed_cors_origins": ["https://example.com"]
	}'
```

- Flow for a CLI: Authorization Code with PKCE, token endpoint auth `none`, PKCE required with `S256`.
- "Cloudflare does not support Client Credentials, Implicit, Resource Owner Password Credentials, Device Authorization, or other OAuth grant types for third-party clients."
- "OAuth scope names correspond to Cloudflare API token permission names." Available scopes: `GET https://api.cloudflare.com/client/v4/oauth/scopes`.
- New clients are private (only members of the owning account can authorise). A public client needs name, logo, client URL, scopes, and DNS verification: a `TXT` record containing the `cloudflare_oauth_client_publisher=` value. Promotion to public is permanent.
- Account administrators can block public OAuth apps for their account (**Members > Settings > Public OAuth App access**).

— https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ · https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/

Endpoints — https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/:

```txt
Open ID config: https://dash.cloudflare.com/.well-known/openid-configuration
Authorization:  https://dash.cloudflare.com/oauth2/auth
Token:          https://dash.cloudflare.com/oauth2/token
Revoke:         https://dash.cloudflare.com/oauth2/revoke
User info:      https://dash.cloudflare.com/oauth2/userinfo
```

**The `cf` CLI (`cf@1.0.0-beta.11`, beta since 2026-09-28).** `cf auth login` "prints a link and a one-time code, and opens the link in your browser"; `--no-browser` for remote machines. "`cf` keeps its own credentials and does not reuse a Wrangler login." Credential order: `CLOUDFLARE_API_TOKEN`, then `--profile`, then the directory-bound profile, then the default profile. Requires Node.js 22.18 or later. "Commands, configuration, and Build Output can change before the stable release." — https://developers.cloudflare.com/cf/get-started/ · https://developers.cloudflare.com/cf/

The `auth` subcommands are `login`, `logout`, `whoami`, `create`, `activate`, `deactivate`, `delete`, `list` — there is no command that prints the token *(source: `dist/_meta/hand-written-commands.json`)*. The scopes registered for cf's OAuth client include `access:write`, `access-app.write`, `access-policy.write`, `access-idp.write`, `access-org.write`, `aig:write`, `artifacts.write`, `d1.write`, `queues:write`, `containers.write`, `workers_scripts:write` and `account_api_tokens:create`; `billing:read` and `billing:write` are registered but not grantable *(source: `CF_CLIENT_REGISTERED_SCOPES`, `CF_REGISTERED_BUT_UNGRANTABLE_SCOPES`)*.

**Account API tokens.** `POST /accounts/{account_id}/tokens` creates an account-owned token (`cfat_` prefix) that acts as a service principal; accepted permission: `Account API Tokens Write`. Creating one requires API Token Provisioning capability or Super Administrator, and "account members may only grant account API tokens permissions which are a subset of their own account permissions." Permission group ids come from `GET /accounts/{account_id}/tokens/permission_groups`. — https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ · https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/

**API token permissions each step needs** (from the "Accepted Permissions" line of each API reference page, or the product page named):

| Step | Permission |
| --- | --- |
| Deploy Worker, custom domain, `workers.dev` subdomain | `Workers Scripts Write` |
| D1 create | `D1 Write` |
| Queue create, event subscription create | `Queues Write` or `Workers Scripts Write` |
| R2 bucket create | `Workers R2 Storage Write` |
| Artifacts namespace create | **Artifacts > Edit** (https://developers.cloudflare.com/artifacts/guides/authentication/) |
| AI Gateway create/update | `AI Gateway Write` (docs also call it `AI Gateway - Edit`) |
| Access application and policy | `Access: Apps and Policies Write` |
| Zero Trust org, identity provider (OTP) | `Access: Organizations, Identity Providers, and Groups Write` |
| Containers | `Containers Write` |
| List subscriptions (plan detection) | `Billing Read` |

**Recommendation.** Three routes, in order of certainty:

1. *Works today, no browser OAuth:* accept `CLOUDFLARE_API_TOKEN` (pasted or from the environment) and pass it to both direct API calls and the wrangler subprocess. Always keep this as the fallback and the CI path.
2. *Works today through the browser, with two tools:* `wrangler login` for everything wrangler's scopes cover, then `wrangler auth token --json` to reuse that token for direct API calls; Access and AI Gateway calls go through `cf` (`cf auth login`, then `cf zero-trust access …` / `cf ai-gateway …`). Two consent screens, and a beta dependency.
3. *Target:* gitflare's own public OAuth client (Authorization Code + PKCE) requesting exactly the permissions in the table. One consent screen, no dependency on another CLI's credential store. Needs the one-time client registration and domain verification, and the open points listed under "Could not verify".

A variant of route 2 worth testing first: one `cf auth login`, then `cf accounts tokens create` to mint a scoped account API token, and use that token for everything else (wrangler included, via `CLOUDFLARE_API_TOKEN`) and as the forge's runtime credential. It needs only one consent screen, but it is unexercised.

### Deploying a prebuilt Worker

**Shelling out to `wrangler deploy` against a generated config is a documented path.** "If your build tooling already produces build artifacts suitable for direct deployment to Cloudflare, you can opt out of bundling by using the `--no-bundle` command line flag: `npx wrangler deploy --no-bundle`." Config equivalent: `no_bundle` (boolean); `find_additional_modules` "defaults to true if `no_bundle` is true", traversing below `base_dir` for files matching `rules`. — https://developers.cloudflare.com/workers/wrangler/bundling/#disable-bundling · https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys

```txt
wrangler deploy [<PATH>] [OPTIONS]
```

Relevant options (`wrangler@4.147.0`) — https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy:

- `--config <path>` and `--cwd <dir>` (global flags) — point at the generated config in a temp directory.
- `--no-bundle` — skip Wrangler's build steps.
- `--secrets-file <path>` — "Accepts JSON or `.env` format … Existing secrets not included in the file are preserved from the previous version."
- `--var key:value`, `--keep-vars` — "Secrets are never deleted by a deployment whether this flag is true or false."
- `--domain <host>` — custom domains; `--routes`.
- `--containers-rollout immediate | gradual | none` — "`none` skips container image and instance updates."
- `--tag`, `--message` — recorded on the Worker version.
- `--dry-run` with `--outdir` — compile without deploying.
- `--strict` — "prevents deployments if the deployment would potentially override remote settings in non-interactive environments."

**Machine-readable result.** With `WRANGLER_OUTPUT_FILE_PATH` set, wrangler writes ND-JSON; a successful deploy writes:

```json
{"type":"deploy","version":1,"worker_name":"my-worker","worker_tag":"abc123def456","version_id":"v1-abc123","targets":["https://my-worker.example.workers.dev"],"worker_name_overridden":false,"wrangler_environment":"production","timestamp":"2024-11-03T12:00:05.000Z"}
```

A failure writes a `command-failed` entry "including error code and message". — https://developers.cloudflare.com/workers/wrangler/system-environment-variables/#example-output-file

**Config fragments the generated file needs**, each copied from https://developers.cloudflare.com/workers/wrangler/configuration/ unless noted.

Static assets — `assets.directory`, optional `assets.binding`, `run_worker_first`, `not_found_handling` (`"single-page-application" | "404-page" | "none"`). One asset collection per Worker.

Durable Objects — declarative `exports` (preferred; `migrations` is "the legacy imperative configuration"; the two "are mutually exclusive"):

```jsonc
{
	"exports": {
		"MyDurableObject": {
			"type": "durable-object",
			"storage": "sqlite",
		},
		"OldClass": {
			"type": "durable-object",
			"state": "deleted",
		},
	},
}
```

`state` is one of `"created"` (default), `"deleted"`, `"renamed"`, `"transferred"`, `"expecting-transfer"`; `storage` is `"sqlite"` ("required for new namespaces") or `"legacy-kv"`.

Workflows — binding form, or binding-less export (Wrangler ≥ 4.139.0, called through `ctx.exports`):

```jsonc
{
	"workflows": [
		{
			"binding": "<BINDING_NAME>",
			"name": "<WORKFLOW_NAME>",
			"class_name": "<CLASS_NAME>",
		},
	],
}
```

```jsonc
{
	"exports": {
		"MyWorkflow": {
			"type": "workflow",
			"name": "my-workflow",
			"limits": {
				"steps": 25000,
			},
			"schedules": ["0 * * * *"],
		},
	},
}
```

"Workflow names are unique per account."

Queues — producers `{ "binding", "queue", "delivery_delay"? }`; consumers:

```jsonc
{
	"queues": {
		"consumers": [
			{
				"queue": "my-queue",
				"max_batch_size": 10,
				"max_batch_timeout": 30,
				"max_retries": 10,
				"dead_letter_queue": "my-queue-dlq",
				"max_concurrency": 5,
				"retry_delay": 120, // Delay retried messages by 2 minutes before re-attempting delivery
```

Artifacts binding — https://developers.cloudflare.com/artifacts/concepts/namespaces/ (schema in `wrangler@4.147.0` `config-schema.json`: `binding` and `namespace` required, optional `remote`):

```jsonc
{
	"artifacts": [
		{
			"binding": "ARTIFACTS",
			"namespace": "default"
		}
	]
}
```

D1 binding — `binding`, `database_name`, `database_id` required; optional `migrations_dir`, `migrations_table`, `migrations_pattern`.

Required secrets — `"secrets": { "required": ["API_KEY", "DB_PASSWORD"] }`: "`wrangler deploy` and `wrangler versions upload` validate that all secrets in `secrets.required` are configured on the Worker before the operation succeeds."

Custom domain and `workers.dev`:

```jsonc
{
	"routes": [
		{
			"pattern": "shop.example.com",
			"custom_domain": true,
		},
	],
}
```

`workers_dev` "defaults to `true` when the configuration has no `route` or `routes`, and `false` otherwise."

**Automatic provisioning.** "This currently works for the following resources: KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues. To use this feature, add bindings to your configuration file *without* adding resource IDs, or in the case of R2, a bucket name. Resources will be created with the name of your worker as the prefix." On `wrangler deploy`, "their IDs will be written back to your configuration file." Artifacts, AI Gateway and Access are not in the list. — https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning

**Containers / Sandbox image.** — https://developers.cloudflare.com/containers/guides/image-management/ · https://developers.cloudflare.com/workers/wrangler/configuration/#durable_object-scheduling-policy

- `durable_object` policy (beta): "It lets each Durable Object supply its Container image or snapshot and instance size to `ctx.container.start()`." Config accepts only `scheduling_policy`, `images`, `class_name`, `name`, `observability`, `ssh`, `authorized_keys`; wrangler "rejects every other Container application field for this policy, including `image`, `instance_type`, `max_instances`".
- Managed image, no registry involved: "`cloudflare/debian-trixie` is a Cloudflare-managed identifier, not a public Cloudflare Docker Hub image" (Node.js 24.20.0 on Debian Trixie slim), "available only with the `durable_object` scheduling policy":

```ts
this.ctx.container.start({
	image: "cloudflare/debian-trixie",
	enableInternet: false,
});
```

- Custom image with `durable_object`: "does not support direct image references from external registries. A named `image` source must use a digest-pinned reference from the Cloudflare managed registry." Getting one there is `wrangler containers push <IMAGE>:<TAG>` or `wrangler containers build -p -t <TAG> .`, both of which need Docker ("Docker or a Docker-compatible CLI tool must be running for Wrangler to build and push images").

```jsonc
{
	"containers": [
		{
			"class_name": "AgentComputer",
			"scheduling_policy": "durable_object",
			"images": {
				"tools": {
					"image": "registry.cloudflare.com/<YOUR_ACCOUNT_ID>/<IMAGE>@sha256:<DIGEST>",
				},
			},
		},
	],
}
```

- `default` policy: `image` may be a Dockerfile path or a reference to `registry.cloudflare.com`, Docker Hub, Amazon ECR or Google Artifact Registry. "Public Docker Hub images do not require registry configuration" — `"image": "docker.io/<NAMESPACE>/<REPOSITORY>:<TAG>"` — but "Cloudflare does not cache images pulled from Docker Hub" and pulls "may be subject to Docker Hub pull limits".
- The minimal Sandbox config in the current docs uses the `durable_object` policy with no `images` at all — https://developers.cloudflare.com/sandbox/get-started/.
- Wrangler only checks for Docker when a container entry uses a Dockerfile source *(source: `buildAndWriteContainerOutput` calls `verifyDockerInstalled` only when `countDockerfiles(...) > 0`)*.

**Direct upload API.** `PUT /accounts/{account_id}/workers/scripts/{script_name}` takes `multipart/form-data` with a `metadata` part; `migrations`, `logpush`, `tail_consumers`, `tags` are "**not available** for version uploads". Static assets are a separate three-step flow (upload manifest, upload assets, create version with the completion `jwt`). The documented binding types on that page do not include Workflows, Containers, Artifacts or queue consumers, which wrangler configures through separate API calls after the upload. Wrangler is the lower-risk path. — https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/ · https://developers.cloudflare.com/workers/static-assets/direct-upload/

**`cf deploy --prebuilt`.** "Pass `--prebuilt` to deploy an existing `.cloudflare/output/v0/` directory without building. … `--prebuilt` also skips automatic configuration." The recorded mode must match (`cf build` records `production`, so `cf deploy --prebuilt --mode production`). `cf` project commands read `cloudflare.config.ts`, not Wrangler config; after `cf migrate`, "some settings need manual work afterwards, such as Durable Object migrations, Workflows, Containers". `cf` cannot yet set a single secret (`--secrets-file` on deploy works). Beta. — https://developers.cloudflare.com/cf/projects/#deploy-a-prebuilt-build · https://developers.cloudflare.com/cf/wrangler/

### Resources to create

Base for all: `https://api.cloudflare.com/client/v4`. Paths below were cross-checked against `cf@1.0.0-beta.11` `dist/_meta/commands.json`, which is generated from the API schemas.

**Artifacts namespace (jurisdiction).** — https://developers.cloudflare.com/artifacts/api/rest-api/#create-a-namespace · https://developers.cloudflare.com/artifacts/guides/data-localization/

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

- `namespace` required; `jurisdiction` `"eu" | "us"` optional, "If you omit it, the namespace remains unrestricted." "You cannot change the jurisdiction after creating the namespace."
- "If you create a repo under a namespace name that does not exist, Artifacts creates the namespace automatically" — so the installer must create the namespace explicitly *before* anything creates a repo, or the jurisdiction is lost. — https://developers.cloudflare.com/artifacts/concepts/namespaces/
- Existence check: `GET /accounts/{account_id}/artifacts/namespaces/{namespace}`; list: `GET /accounts/{account_id}/artifacts/namespaces?limit=&cursor=`.
- Names: 2–63 characters, start with a letter or digit, then letters, digits, `.`, `_`, `-`. — https://developers.cloudflare.com/artifacts/platform/limits/
- Wrangler has `artifacts namespaces list|get` and `artifacts repos …` but no namespace-create command. — https://developers.cloudflare.com/workers/wrangler/commands/artifacts/

**D1.** `wrangler d1 create <NAME>` with `--location` (`weur`, `eeur`, `apac`, `oc`, `wnam`, `enam`) or `--jurisdiction` (`eu`, `fedramp`, `us`; "if jurisdictions are set, the location hint is ignored"). API: `POST /accounts/{account_id}/d1/database` with `name` (required), `jurisdiction`, `primary_location_hint`. List: `GET /accounts/{account_id}/d1/database`. — https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-create

Migrations: `wrangler d1 migrations apply <DATABASE> --remote` ("The name or binding of the DB"). Applied migrations are recorded in the `d1_migrations` table (name configurable with `migrations_table`), so re-running applies only what is new. "When running the apply command in a CI/CD environment or another non-interactive command line, the confirmation step will be skipped, but the backup will still be captured. If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." `wrangler d1 migrations list` shows unapplied ones. — https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply · https://developers.cloudflare.com/d1/reference/migrations/

**Queue.** `POST /accounts/{account_id}/queues` with `queue_name` (required). Also auto-provisioned by wrangler, and a consumer's `dead_letter_queue` "will be created automatically" if missing. — https://developers.cloudflare.com/api/resources/queues/methods/create/

**Artifacts events — route A, Workflow trigger in Wrangler config.** Schema accepted by `wrangler@4.147.0` *(source: `config-schema.json`, `ArtifactsEventTrigger`)*:

```json
{
 "type": "object",
 "properties": {
  "type": { "$ref": "#/definitions/ArtifactsEventType" },
  "filter": {
   "type": "object",
   "properties": {
    "namespace": { "type": "string" },
    "repo_name": { "type": "string" }
   },
   "additionalProperties": false
  },
  "targets": {
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "type": { "type": "string", "const": "workflow" },
     "workflow_name": { "type": "string" }
    },
    "required": ["type", "workflow_name"],
    "additionalProperties": false
   }
  }
 },
 "required": ["type", "targets"],
 "additionalProperties": false
}
```

`ArtifactsEventType` enum: `cf.artifacts.repo.created`, `.deleted`, `.forked`, `.imported`, `.pushed`, `.cloned`, `.fetched`, `.token.created`, `.token.revoked`.

The guide (last updated 2026-10-01) shows a different shape for the same block — camelCase `repoName` and a single `target` object:

```jsonc
"triggers": {
    "events": [
      {
        "type": "cf.artifacts.repo.pushed",
        // filter is optional. If you don't set repoName we will run the same workflow for every push on any repo in your Artifacts namespace
        "filter": {
          "namespace": "CI",
          "repoName": "my-repo"
        },
        "target": {
          "scriptName": "<worker-name>",
          "workflowName": "<workflow-name>"
        }
      }
    ]
  },
```

"When you omit `repoName`, Cloudflare runs the same Workflow for every push to any repo in your Artifacts namespace. … Each push still starts its own Workflow instance for the repo, branch, and commit that changed." — https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/

**Artifacts events — route B, Queue subscription.**

```bash
npx wrangler queues subscription create <queue-name> --source <source-type> --events <event1,event2> --<source-specific-option> <value>
```

API: `POST /accounts/{account_id}/event_subscriptions/subscriptions` with `name`, `enabled`, `source: { type, … }`, `destination: { type: "queues.queue", queue_id }`, `events: string[]`. List: `GET` on the same path. — https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/ · https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/

Two sources: `artifacts` (account level: `repo.created`, `repo.deleted`, `repo.forked`, `repo.imported`) and `artifacts.repo` (`pushed`, `cloned`, `fetched`, `token.created`, `token.revoked`). The docs say to "subscribe to the `artifacts.repo` source with a `namespace` and `repo_name` to receive events scoped to a single repository", but wrangler's CLI has no option for either and sends `{ type: "artifacts.repo" }` alone *(source: `parseSourceArgument`)*. Push payload:

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
        "author": { "name": "Developer Name", "email": "developer@example.com" },
        "committer": { "name": "Developer Name", "email": "developer@example.com" },
        "parents": ["abc123def456abc123def456abc123def456abc1"]
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

— https://developers.cloudflare.com/artifacts/guides/event-subscriptions/

**AI Gateway and spend limit.** — https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/gateways \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{
          "id": "my-gateway",
          "cache_invalidate_on_update": true,
          "cache_ttl": 0,
          "collect_logs": true,
          "rate_limiting_interval": 0,
          "rate_limiting_limit": 0
        }'
```

Those six fields are the required ones. Optional body fields relevant here, from the same page:

```txt
authentication: optional boolean
byok_only: optional boolean
workers_ai_billing_mode: 'postpaid' | 'unified'
spend_limits: optional object { enabled, rules }
  enabled: optional boolean
  rules: optional array of object
    limit: number            (exclusive minimum 0)
    limitType: "cost"
    window: number           (exclusive minimum 0)
    id: optional string
    enabled: optional boolean
    technique: optional "fixed" or "sliding"
    metadata: optional map[ {mode: "partition"} or {mode: "filter", values: string[]} ]
    model: optional { mode: "filter", values: string[] }
    provider: optional { mode: "filter", values: string[] }
```

- Update: `PUT /accounts/{account_id}/ai-gateway/gateways/{id}`; get: `GET` on the same path; list: `GET /accounts/{account_id}/ai-gateway/gateways`.
- Up to 20 spend-limit rules per gateway; on breach the gateway returns `429`; "Spend limits are eventually consistent"; "Cost tracking is a best-effort estimation". — https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Only the gateway id `default` is auto-created (on the first authenticated request, with authentication on and standard billing). "Using any other gateway ID requires creating the gateway first." Gateway name limit: 64 characters. — https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/
- "`cf.user_id` is only present on requests that arrive through an Access-protected custom domain with a valid Access user subject. Service-token requests do not include `cf.user_id`." The value "is the Access JWT `sub` claim, not the user's email address." — https://developers.cloudflare.com/ai-gateway/features/spend-limits/ · https://developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/
- Unified Billing: "you must purchase and load credits into your Cloudflare account in the Cloudflare dashboard"; a 5% fee applies to credit purchases. BYOK-only is `byok_only: true`. — https://developers.cloudflare.com/ai-gateway/features/unified-billing/

**R2 bucket.** `POST /accounts/{account_id}/r2/buckets` with `name` (required), optional `locationHint`/`storageClass` and a `cf-r2-jurisdiction` header; `GET /accounts/{account_id}/r2/buckets/{bucket_name}` to check. Auto-provisioned by wrangler when the binding has no `bucket_name`. — https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/

**Access application and policy.** — https://developers.cloudflare.com/workers/configuration/cloudflare-access/

Prerequisite: "Zero Trust enabled on your account. If Zero Trust is not turned on, complete Zero Trust setup first."

Worker-level application (protects routes, custom domains, `workers.dev` and previews of one Worker); inline policy included:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{
    "type": "self_hosted",
    "name": "Access for my-worker",
    "destinations": [
      {
        "type": "preview_worker",
        "worker_id": "c81a2d22c29840ed9d61681a3270dbff"
      }
    ],
    "policies": [
      {
        "decision": "allow",
        "include": [
          {
            "email_domain": {
              "domain": "example.com"
            }
          }
        ]
      }
    ]
  }'
```

Use `"type": "worker"` for production and previews. Destination types: `all_preview_workers`, `all_workers`, `preview_worker`, `worker`.

- "Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error. If your Worker uses WebSockets (including Durable Objects, real-time applications, …), protect it with a hostname-based Access application instead."
- Hostname-based: "Create the self-hosted application with a `POST /accounts/{account_id}/access/apps` request, setting the application domain to the hostname or path." The hostname "can be `workers.dev`, a Custom Domain, or a path".
- Reusable policies: `POST /accounts/{account_id}/access/policies` with `name`, `decision`, `include` (required), optional `exclude`, `require`.
- Identity inside the Worker: "`ctx.access` is `undefined` if Access did not authenticate the request"; `await ctx.access.getIdentity()` returns the identity (email, groups, …) with "no extra configuration or JWT parsing".
- One-time PIN: "New Zero Trust organizations use the Cloudflare identity provider as their default login method. OTP is no longer added automatically." Add it with:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/identity_providers" \
	--request POST \
	--header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
	--json '{
		"name": "One-time PIN login",
		"type": "onetimepin",
		"config": {}
	}'
```

— https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/

**Custom domain or `workers.dev`.** Declared in the Wrangler config (`routes[].custom_domain: true`) or `wrangler deploy --domain`. Requires "an active Cloudflare zone"; "Cloudflare will create DNS records and issue necessary certificates on your behalf"; "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record or on a zone you do not own." `workers.dev` hostnames are `<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev`; the account subdomain is read with `GET /accounts/{account_id}/workers/subdomain`. The docs describe `workers.dev` as "intended for personal or hobby projects that aren't business-critical". — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ · https://developers.cloudflare.com/workers/configuration/routing/workers-dev/

**Idempotency.** Documented: D1 migrations (tracked table); `wrangler deploy` (re-deploying replaces the version, secrets are preserved); AI Gateway `PUT`; the `default` gateway. Not documented for namespace, D1, queue, bucket, subscription or Access-app creation — the installer should look up by name before creating (list/get endpoints above) rather than rely on create being safe to repeat.

### Preconditions

- **Workers Paid.** "Artifacts is currently only available on the Workers Paid plan." Containers have no free allocation (pricing table: Free "N/A"). Billing for Artifacts begins 2026-10-14. — https://developers.cloudflare.com/artifacts/platform/pricing/ · https://developers.cloudflare.com/containers/platform/pricing/
- **Plan detection.** `GET /accounts/{account_id}/subscriptions` returns `rate_plan.id`, `rate_plan.public_name`, `state`, but requires `Billing Read` — a permission neither wrangler's OAuth scopes nor cf's grantable scopes include. — https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/
- **Artifacts open beta.** Open since 2026-10-01, no access form. — https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/
- **Zero Trust organisation.** Created in the dashboard: choose a team name, then "complete your onboarding by selecting a subscription plan and entering your payment details. If you chose the Zero Trust Free plan, this step is still needed but you will not be charged." An API endpoint exists (`POST /accounts/{account_id}/access/organizations` with `auth_domain`, `name`). — https://developers.cloudflare.com/cloudflare-one/setup/ · https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/
- **Custom domain.** Needs a zone already active in the same account.
- **Local toolchain.** Node ≥ 22.0.0 for `wrangler@4.147.0` (22.18 for `cf`); Docker only if the release builds or pushes a container image.

### Upgrades

- Stored answers plus name-based lookups are enough to make a second run non-interactive: every resource above has a get or list endpoint.
- New bundle: `wrangler deploy` again with the same Worker name. "Wrangler will not delete your secrets … unless you run `wrangler secret delete <key>`"; vars in the config override dashboard edits unless `keep_vars`. — https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth
- New D1 migrations: `wrangler d1 migrations apply <DATABASE> --remote` applies only unapplied files.
- Durable Object classes: update `exports`. Retiring a class means replacing its entry with a `"state": "deleted"` tombstone, which "removes its namespace and **all of its stored data permanently**"; the class must already be gone from the Worker code, and once applied the deploy response lists the tombstone in `removable_entries`. "You cannot roll back a Durable Object lifecycle change to a version from before the change." — https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ · https://developers.cloudflare.com/cf/wrangler/reference/
- Container image: with `durable_object`, "deploying an updated image map does not restart running Containers. A running Container continues to use its startup image." A snapshot "is tied to the image it was created from".
- Version labelling: `--tag` / `--message` on deploy; the deployed `version_id` is in the ND-JSON output.

### Cost at rest (Workers Paid)

Minimum charge **$5 USD per month** per account, which "includes Workers, Pages Functions, Workers KV, Hyperdrive, and Durable Objects usage". Included monthly allotments — https://developers.cloudflare.com/workers/platform/pricing/ unless noted:

| Resource | Included per month | Beyond |
| --- | --- | --- |
| Workers | 10 million requests, 30 million CPU ms | $0.30 / million, $0.02 / million CPU ms |
| Durable Objects | 1 million requests, 400,000 GB-s | $0.15 / million, $12.50 / million GB-s |
| DO SQLite storage | 5 GB-month | $0.20 / GB-month |
| D1 | 25 billion rows read, 50 million written, 5 GB | $0.001 / million, $1.00 / million, $0.75 / GB-mo |
| Queues | 1,000,000 operations | $0.40 / million |
| Workflows | 500,000 steps, 1 GB-month | $0.80 / 100,000 steps, $0.20 / GB-month |
| Workers Logs | 20 million events | $0.60 / million |
| Containers | 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk | per-second rates; billed only while running |
| Artifacts | 10,000 operations, 1 GB-month | $0.15 / 1,000, $0.50 / GB-month |
| R2 (free tier) | 10 GB-month, 1 million Class A, 10 million Class B | $0.015 / GB-month |
| AI Gateway | core features free; logs follow Workers Logs pricing for gateways first created on or after 2026-09-24 | — |

— https://developers.cloudflare.com/containers/platform/pricing/ · https://developers.cloudflare.com/artifacts/platform/pricing/ · https://developers.cloudflare.com/r2/pricing/ · https://developers.cloudflare.com/ai-gateway/reference/pricing/

An idle deployment that stays inside these allotments costs the $5 minimum. What moves it: Artifacts storage past 1 GB across all repos and forks, Durable Objects held awake (duration is billed in GB-s), and Container run time. Access seats and a registered domain are outside this table.

### Distribution

- `npm init <initializer>` / `npm create <initializer>` runs the package `create-<initializer>` through `npm exec` and executes its main `bin`. `npm init foo@latest` forces the latest version; "if a user already has the `create-<initializer>` package globally installed, that will be what `npm init` uses." Extra arguments pass through after `--`. `npx create-foo` is the same `npm exec` path. — https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-init.md
- A package ships whatever its `files` array names. — https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md#files
- Reference implementation: `create-cloudflare@2.73.2` has `"bin": "./bin/c3.js"`, `"files": ["bin", "dist", "templates", "templates-experimental"]`, `engines.node >= 22.0.0` and **no runtime dependencies** — the CLI is one pre-bundled `dist/cli.js` (4.5 MB) with its payload (`templates/`, 1.3 MB) inside the tarball, and it invokes `wrangler` as a subprocess through the user's package manager *(source: tarball)*.
- So the two normal shapes are: the release bundle inside the installer's own tarball (installer version = forge version, no second download, no GitHub involved), or a thin installer that fetches a versioned bundle package from the npm registry at run time. Both keep the "no GitHub account" target.
- Limits on the bundle itself: Worker size 64 MiB uncompressed ("There is no compressed size limit"), individual static asset file 25 MiB. — https://developers.cloudflare.com/workers/platform/limits/#worker-size

## Local development and tests

- **The installer is a Node CLI; there is no local emulator for the Cloudflare REST API.** Resource creation, Access, AI Gateway management, OAuth and event subscriptions need a fake HTTP server. `CLOUDFLARE_API_BASE_URL` redirects both wrangler and `cf` to one. — https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- **Wrangler as a subprocess** should sit behind a command-runner port so tests assert on arguments and on the generated config rather than running a deploy. `wrangler deploy --dry-run --outdir <dir>` compiles without deploying and is a usable check that a generated config and prebuilt bundle are accepted.
- **Validating a generated config without network:** `wrangler@4.147.0` ships `config-schema.json`; validating against it catches shape errors such as the `triggers.events` mismatch above.
- **D1 migrations** run locally with `wrangler d1 migrations apply <DATABASE> --local`.
- **Running the built forge locally:** `createTestHarness()` from `wrangler` "runs production build output from Wrangler configuration files … The API wraps Miniflare" and works from any Node test runner; `getPlatformProxy()` exposes vars, KV, R2, Queues, D1, Durable Objects and Workers AI bindings but "does not run your Worker's code" and "ignores the Workflows declared in the `exports` field". — https://developers.cloudflare.com/workers/wrangler/api/
- **Needs Docker:** any Container/Sandbox under `wrangler dev`. `durable_object`-policy containers need Wrangler ≥ 4.136.0 locally and the managed `cloudflare/debian-trixie` image needs ≥ 4.141.0. A deployed container differs from the local one (for example a 64-character hostname that does not resolve). — https://developers.cloudflare.com/containers/guides/local-dev/
- **Remote even in local dev:** Workers AI ("always accesses your Cloudflare account … and will incur usage charges even in local development"). The Artifacts binding has a `remote` flag ("Whether to use the remote Artifacts service in local dev").
- **Cannot run locally, needs a fake:** Cloudflare Access (`ctx.access`), AI Gateway spend limits, OAuth consent, Artifacts event delivery, custom domains.

## Could not verify

Nothing was run against a real account (no credentials were used, and creating resources was out of bounds), so every item below needs a live check before code depends on it.

- **Which API calls an OAuth token from `wrangler login` is actually allowed to make.** The scope list is certain; the mapping from those scopes to endpoints is not documented. In particular: whether R2 bucket creation, Artifacts namespace creation with `jurisdiction`, and event-subscription creation succeed, and whether Access and AI Gateway management really fail. Tried: scope descriptions in the bundle; API reference pages list API-token permissions only.
- **Third-party OAuth client details.** Whether `http://localhost:<port>/…` is accepted as a redirect URI, token lifetime, whether refresh tokens are issued to public clients, and the exact scope ids for Artifacts, AI Gateway and Access (the docs say to fetch `GET /oauth/scopes`, which needs a token). Tried: the three `fundamentals/oauth` pages.
- **`cf accounts tokens create` from a `cf auth login` session** — whether the `account_api_tokens:create` scope is enough to mint a token carrying Access, AI Gateway and Artifacts permissions. The scope is registered for cf's client; the call was not made.
- **Detecting Workers Paid without `Billing Read`.** No documented error code for "account is not on Workers Paid" on Artifacts or Containers endpoints (the Artifacts error table has none), and wrangler contains no plan check. Probing a paid-only endpoint and reading the failure is the likely route but the response is unknown.
- **Whether `POST /access/organizations` completes Zero Trust onboarding** or the dashboard plan-selection step is still required afterwards. The docs describe only the dashboard flow.
- **Zero Trust Free plan seat limit and price.** Not stated on the developer docs pages read; the plans page is rendered client-side and yielded nothing. Affects "cost at rest".
- **Idempotency of create calls** for Artifacts namespaces, D1 databases, queues, R2 buckets, event subscriptions and Access applications — response to a duplicate name is not documented on any page read.
- **`triggers.events` field names.** Docs and the `wrangler@4.147.0` schema disagree (`repoName` + `target{scriptName, workflowName}` versus `repo_name` + `targets[{type, workflow_name}]`). Which one the platform accepts through wrangler was not tested; whether a trigger without `filter.repo_name` also fires for forks was not tested.
- **`artifacts.repo` Queue subscriptions without a repo filter.** Wrangler sends none; the docs imply one is expected. Whether the result is account-wide delivery or a rejected request is unknown, as are the exact strings accepted by `--events` (the docs use the short names `pushed`, `repo.created`). The API reference page for subscription create does not list the Artifacts sources at all.
- **Spend-limit `window` units** (seconds is the guess) and how a calendar-month budget is expressed with `technique: "fixed"`. The API reference gives only `window: number`.
- **`wrangler deploy` with an `artifacts` binding whose namespace does not exist yet**, and with a `durable_object` container entry and no Docker installed. The second is read from source only.
- **Whether `wrangler deploy --dry-run` needs credentials.** Documented as credential-free for `cf deploy --dry-run`; not stated for wrangler.
- **`cf deploy --prebuilt` without a `cloudflare.config.ts`** — whether a Build Output directory alone is deployable. If it is, Build Output would be a cleaner release format than a generated Wrangler config, once `cf` leaves beta.
- **Pushing an image to `registry.cloudflare.com` without Docker.** `POST /accounts/{account_id}/containers/registries/{domain}/credentials` and `POST /accounts/{account_id}/containers/image-preparations` exist in the API, which suggests a plain OCI push is possible, but no document describes it.
- **Install duration.** The ten-minute target was not measured; the dominant unknowns are the npm install of wrangler + `workerd`, certificate issuance for a custom domain, and any container image push.
