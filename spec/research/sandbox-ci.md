# Sandbox SDK, Containers and `@cloudflare/ci`

Verified 2026-10-02 against live docs.

Sources are the live `developers.cloudflare.com` pages (fetched as `<url>/index.md`), the published npm tarballs (`npm pack`, read directly), and the `cloudflare/ci`, `cloudflare/sandbox-sdk` and `cloudflare/workerd` repositories on GitHub. Versions read: `@cloudflare/sandbox@1.0.0`, `@cloudflare/ci@0.2.0`, `@cloudflare/workers-types@5.20261002.1`, `wrangler@4.147.0`, `@cloudflare/vitest-plugin@1.3.6`, `@cloudflare/vitest-pool-workers@0.22.0`.

Short names used below:

- **DO container API** — https://developers.cloudflare.com/containers/api/durable-object-container/
- **Lifetime** — https://developers.cloudflare.com/sandbox/concepts/lifetime/
- **Security** — https://developers.cloudflare.com/sandbox/concepts/security/
- **Runner tutorial** — https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/

## What this forces

1. **"Sandbox SDK 1.0" is three helper classes, not a sandbox API.** `@cloudflare/sandbox@1.0.0` exports only `Files`, `S3Mount`, `DirectoryBackup` (plus their gateways and error types). Running commands, streaming, exit codes, ports, env, snapshots and egress interception are all on the runtime's `this.ctx.container` inside a Durable Object we write. The package stores nothing, retries nothing and sets no timeouts. Our sandbox package is therefore a Durable Object class of our own, and everything the 0.x `Sandbox` class did (process tracking, preview tokens, keep-alive) is our code.
2. **`@cloudflare/ci@0.2.0` is built on the deprecated stack.** It pins `@cloudflare/sandbox` to exactly `0.12.1`, subclasses the 0.x `Sandbox` class, and its example uses the `default` scheduling policy with a fixed `standard-4` instance. 0.x gets bug and security fixes only until 2026-12-31. It therefore does not get the fast start path, runtime image/instance selection, or native snapshots, and it brings a second copy of `@cloudflare/sandbox` and a second container image into the Worker.
3. **A `@cloudflare/ci` pipeline is TypeScript compiled into the CI Worker, not a file in the repository under test.** Changing it means redeploying the Worker. Nothing loads or executes repository TypeScript. A forge that wants per-repository CI definitions has to read a data file from the repository and translate it into `runner()` calls itself.
4. **`@cloudflare/ci` has no live logs and, for Artifacts, no step reporting.** A runner's output is returned only when the Workflow step finishes; the Artifacts provider does not implement step notifications. Live step status has to come from the Workflow instance (`status()` / `subscribe()`), and live log lines are not available at all. If the change page must stream CI output, we need our own runner (see "Thinnest alternative").
5. **Credentials stay out of the container only if we use egress interception, and the documented Artifacts example does the opposite.** The mechanism is `interceptOutboundHttps(host, workerEntrypoint)` with `enableInternet: false`; the Worker adds the header after the request has left the container. The only Artifacts + Sandbox example in the docs is 0.x and puts a write token into the sandbox environment as an authenticated remote URL. Git push to Artifacts through an intercept is a composition of two verified mechanisms that no primary source demonstrates end to end.
6. **Work inside the container does not keep it alive, and piped output kills background work.** Only Durable Object activity counts; the inactivity timeout is at most 6 hours, is lost when the Durable Object restarts (every deploy), and must be re-set in the constructor. A long agent session or CI command needs a Durable Object alarm that fires more often than the timeout, and must write its output to files: a process with piped stdout receives `SIGPIPE` once the request that started it ends.
7. **Snapshots are full-root-filesystem, tied to the image they were taken from, and cannot be listed or deleted.** Max 20 GB, kept 30 days from creation or last restore. A snapshot cannot be restored onto an updated image, so a workspace-image upgrade invalidates every saved session; sessions need a rebuild path from git. Running processes do not survive a restore.
8. **Docker inside a Sandbox must run as root, not rootless.** The FAQ states rootless Docker does not start in Containers, and `durable_object`-policy containers additionally need `dockerd --ip-forward=false`. Earlier notes that assumed rootless Docker are wrong. Also: in a deployed `durable_object` container every process has root's Linux capabilities regardless of `user`, so one sandbox is the smallest trust unit.
9. **ArtifactFS is not the documented default for repositories of our size.** The docs say to use a regular `git clone` for smaller repositories and reserve ArtifactFS (FUSE, a Go binary, a daemon) for large ones. The published "~10–15 seconds" figure is the target for multi-GB repositories, not a clone time we should plan around; ordinary repositories are described as taking "a few seconds" to clone.
10. **Vitest cannot run containers.** Both Workers Vitest packages hard-code `enableContainers: false`. Anything that touches `ctx.container` needs a fake behind a port in unit tests; real container behaviour is only testable under `wrangler dev` with Docker, and local Docker differs from production in documented ways.

## Verified facts

### Package: `@cloudflare/sandbox` 1.0

- Latest is `1.0.0`, published 2026-09-30. Apache-2.0, repo `cloudflare/sandbox-sdk`. Dist-tags also carry `release-0-12-6: 0.12.6` and `next: 0.13.0-next.776.1`; last 0.x release is `0.12.10`. Source: `npm view @cloudflare/sandbox`.
- "`@cloudflare/sandbox` works with a container you start from a Durable Object. Its classes run helper processes in the running container through `exec()`. The package does not start, stop, or monitor the container." Source: https://developers.cloudflare.com/sandbox/reference/
- Requirements for every class: the image contains `/usr/local/bin/sandbox-shim` copied from the `cloudflare/sandbox` image whose tag matches the npm version (a static `linux/amd64` binary); the Worker has `nodejs_compat`; the container is running when a method is called. Source: same page. The `docker.io/cloudflare/sandbox:1.0.0` tag exists (amd64, ~1.6 MB). Source: https://hub.docker.com/v2/repositories/cloudflare/sandbox/tags

  ```dockerfile
  COPY --from=docker.io/cloudflare/sandbox:<VERSION> /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
  ```

- "The package writes nothing to Durable Object storage. A preview token, a process record, or a snapshot ID exists only if your class stores it." and "The package also retries nothing and sets no time limits." Source: https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/
- 0.x: "Sandbox SDK 0.x receives bug and security fixes until 2026-12-31, and no new features. After that date, deployed 0.x applications keep running, and `@cloudflare/sandbox` 0.x stays on npm." Source: https://developers.cloudflare.com/sandbox/sdk/migrate/
- Complete export list of `@cloudflare/sandbox@1.0.0` (`dist/index.d.mts`): `DirectoryBackup`, `DirectoryBackupGateway`, `Files`, `S3Gateway`, `S3Mount`, `SandboxBackupError`, `SandboxFileError`, `SandboxProtocolError`, `SandboxS3MountError`, plus types. There is no `getSandbox`, no `Sandbox` class, no git helper.

### Wrangler configuration (container + Durable Object)

Copied from https://developers.cloudflare.com/sandbox/reference/ :

```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "sandbox-files",
	"main": "src/index.ts",
	// Set this to today's date
	"compatibility_date": "2026-10-02",
	"compatibility_flags": ["nodejs_compat"],
	"containers": [
		{
			"class_name": "MyContainer",
			"scheduling_policy": "durable_object",
			"images": {
				"workspace": {
					"dockerfile": "./Dockerfile",
				},
			},
		},
	],
	"durable_objects": {
		"bindings": [
			{
				"class_name": "MyContainer",
				"name": "MY_CONTAINER",
			},
		],
	},
	"exports": {
		"MyContainer": {
			"type": "durable-object",
			"storage": "sqlite",
		},
	},
}
```

- `exports` replaces the legacy `migrations` array; "Do not configure `exports` and `migrations` together." Source: https://developers.cloudflare.com/containers/configuration/wrangler/
- Named image entries (`wrangler@4.147.0` `config-schema.json`, `DurableObjectContainerImage`): either `{ dockerfile, build_context?, build_vars? }` or `{ image }` where `image` is "Digest-pinned image in the account's managed registry" (`registry.cloudflare.com/<ACCOUNT_ID>/<REPOSITORY>@sha256:<DIGEST>`). Up to 100 named images; names 1–128 characters. The `durable_object` policy does not pull from Docker Hub, ECR or Google Artifact Registry. Source: https://developers.cloudflare.com/containers/guides/image-management/
- The scheduling policy is immutable per Container application, and `durable_object` does not support `max_instances`. It is in public beta. Source: https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- Secrets are declared with `"secrets": { "required": ["NAME"] }`, which makes `wrangler deploy` fail when one is missing; the first deploy can supply them with `wrangler deploy --secrets-file .secrets.json`. Source: Runner tutorial.

### `ctx.container`: exact types

Copied from `@cloudflare/workers-types@5.20261002.1` (`index.d.ts`):

```ts
interface ExecOutput {
  readonly stdout: ArrayBuffer;
  readonly stderr: ArrayBuffer;
  readonly exitCode: number;
}
interface ContainerExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  signal?: AbortSignal;
  pty?: boolean | ContainerExecPtyOptions;
  stdin?: ReadableStream | "pipe";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
}
interface ContainerExecPtyOptions {
  cols?: number;
  rows?: number;
}
interface ExecProcess {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly pid: number;
  readonly isPty: boolean;
  readonly exitCode: Promise<number>;
  output(): Promise<ExecOutput>;
  kill(signal?: number): void;
  resize(cols: number, rows: number): void;
}
interface Container {
  get running(): boolean;
  get images(): Record<string, string>;
  start(options?: ContainerStartupOptions): void;
  monitor(): Promise<void>;
  destroy(error?: any): Promise<void>;
  signal(signo: number): void;
  getTcpPort(port: number): Fetcher;
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
  interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void>;
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
  snapshotContainer(
    options?: ContainerSnapshotOptions,
  ): Promise<ContainerSnapshot>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
  exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess>;
  inspect(): Promise<ContainerInfo | null>;
}
interface ContainerSnapshot {
  id: string;
  size: number;
  name?: string;
}
interface ContainerSnapshotRestoreParams {
  id: string;
}
interface ContainerSnapshotOptions {
  name?: string;
}
type ContainerStartupOptions = {
  entrypoint?: string[];
  enableInternet: boolean;
  env?: Record<string, string>;
  instance?:
    | "lite"
    | "standard-1"
    | "standard-2"
    | "standard-3"
    | "standard-4"
    | ContainerStartResources;
  labels?: Record<string, string>;
  directorySnapshots?: ContainerDirectorySnapshotRestoreParams[];
} & (
  | {
      image: string;
      containerSnapshot?: never;
    }
  | {
      image?: never;
      containerSnapshot?: ContainerSnapshotRestoreParams;
    }
);
interface ContainerInfo {
  labels: Record<string, string>;
  image: string;
}
interface ContainerStartResources {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}
```

Two places where the types and the docs disagree; follow the docs:

- The types make `snapshotContainer(options?)` optional, but the DO container API page says "`snapshotContainer()` throws a `TypeError` when `options` is omitted" and "Pass `{}` when you do not set a name".
- The types declare streams as `| null`; the docs say a stream the process does not provide is `undefined`: "Test for a stream, such as `if (process.stderr)`, instead of comparing with `null`."

Behaviour, all from the DO container API page unless noted:

- **Start.** "`start()` boots a container. It returns before the container is ready to accept requests." `enableInternet` is required whenever options are passed. `start()` throws when the container is already running. `ctx.container` can be undefined (every official example guards for it).
- **Run a command.** "`exec()` starts the executable directly with the provided arguments. It does not start a shell or interpret pipes, redirects, expansion, or other shell syntax." It does not start a stopped container; it waits for one that is still starting. Use `["bash", "-lc", "<COMMAND>"]` or `["sh", "-c", "<COMMAND>"]` for shell syntax.
- **Exit codes.** `process.exitCode` is a `Promise<number>`: "Nonzero codes resolve normally instead of rejecting." `output()` buffers both streams and the exit code, can be called once, and "holds all of the output in the memory of the Durable Object".
- **Streaming.** Read `process.stdout` and `process.stderr` concurrently; "a stream that nobody reads can block a process that keeps writing to it". A documented server-sent-events implementation is at https://developers.cloudflare.com/sandbox/commands/stream-command-output/
- **Timeouts and kill.** "`exec()` has no built-in timeout." `kill()` defaults to `SIGTERM` and reaches only the process `exec()` started, not its children. To bound a command and its children, run it under GNU `timeout`: `["timeout", "--kill-after=5", "60", "sh", "-c", "npm test"]` (exit code `124` on timeout). Do not pass `AbortSignal.timeout()` or `request.signal` directly; signalling an exited process "raises an uncaught `internal error` in the Durable Object".
- **Retries duplicate work.** "Canceling the request that started a process does not stop the process. If the client retries, a second copy of the command runs."
- **Env vars.** `start({ env })` sets container variables, but "Processes started with `exec()` do not receive these variables, except `PATH`." Each `exec()` passes its own `env` and `cwd`; there are no sessions. There is no secrets API: an env var is readable by every process in the container (Security).
- **User.** `user` is numeric `uid:gid`. "A user ID without a group ID runs the process as `root`, and a user or group name makes `exec()` reject with an internal error." And: "`user` does not restrict a process in a deployed container with the `durable_object` scheduling policy. Every process has the same Linux capabilities as `root`".
- **Ports.** `getTcpPort(port)` returns a `Fetcher`; `port.fetch(request)` proxies HTTP and WebSocket upgrades. There is no public port and no built-in preview URL: "The server has no public port, so your Worker forwards requests to it." The server must listen on `0.0.0.0`. A WebSocket that only passes through does not keep the sandbox alive; the Durable Object has to accept both ends. Source: https://developers.cloudflare.com/sandbox/previews/ . Previews should be served from a separate hostname: https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/
- **Monitor.** `monitor()` resolves when the main process exits with code 0 or `destroy()` is called without an error value; rejects otherwise. A pending call keeps the Durable Object in memory for up to 15 minutes and does not survive a Durable Object restart.
- **Git.** There are no git helpers. The 0.x `gitCheckout()` is replaced by "`exec()` of `git clone --filter=blob:none` in `/workspace`". Source: https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/

### `Files` (`@cloudflare/sandbox@1.0.0`)

Copied from `dist/index.d.mts`:

```ts
type FileContent = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
interface FileOperationOptions {
  cwd?: string;
  user?: string;
  signal?: AbortSignal;
}
type RemoveOptions = FileOperationOptions & {
  recursive?: boolean;
  force?: boolean;
};
type MkdirOptions = FileOperationOptions & {
  recursive?: boolean;
};
declare class Files {
  #private;
  constructor(container: Pick<Container, "exec">);
  readFile(path: string, options?: FileOperationOptions): Promise<Response>;
  writeFile(path: string, content: FileContent, options?: FileOperationOptions): Promise<void>;
  stat(path: string, options?: FileOperationOptions): Promise<SandboxFileStat>;
  lstat(path: string, options?: FileOperationOptions): Promise<SandboxFileStat>;
  readDirectory(path: string, options?: FileOperationOptions): Promise<SandboxDirectoryEntry[]>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rename(source: string, destination: string, options?: FileOperationOptions): Promise<void>;
  remove(path: string, options?: RemoveOptions): Promise<void>;
}
```

- `readFile` resolves to a `Response`, so the body can be streamed or read with `.text()`. Errors are `SandboxFileError` with a Linux `code` such as `ENOENT`; test with `SandboxFileError.is(error)`. `Files` does not start the container. Source: https://developers.cloudflare.com/sandbox/reference/files/ and the tarball.

### Long-running processes

Source: https://developers.cloudflare.com/sandbox/commands/run-background-processes/ and the Runner tutorial.

- "The process object that `exec()` returns belongs to the request that started it, so later requests manage the process through files in the sandbox."
- Start with `stdout: "ignore", stderr: "ignore"` and redirect to files inside the container: "A process with piped output receives `SIGPIPE` after the request that started it ends".
- The documented launcher, copied from the page (records pid plus boot id, then the exit code atomically):

  ```ts
  const RUN = `dir=$1; shift
  setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
  	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
  echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
  ```

- Live output afterwards is a second `exec()` of `["tail", "-n", "+1", "-F", "--pid", `${pid}`, path]` piped to the client.
- "A running process does not keep the container running. The alarm checks every process each minute, and each alarm keeps the container running." A Durable Object has one alarm, so process checks, snapshot checks and anything else share one handler.

### Network egress and credentials

Sources: DO container API; Security; https://developers.cloudflare.com/sandbox/network/clone-a-private-repository/ ; https://developers.cloudflare.com/sandbox/network/call-an-authenticated-api/ ; https://developers.cloudflare.com/containers/configuration/outbound-traffic/

- `interceptOutboundHttps(addr, fetcher)` routes HTTPS for a hostname or glob (port 443 by default, or `host:port`) to a `WorkerEntrypoint` in our Worker; `interceptOutboundHttp` does the same for HTTP and also accepts IP, IP:port and CIDR; `interceptAllOutboundHttp(fetcher)` covers all port-80 HTTP. The fetcher is `this.ctx.exports.<Entrypoint>` or `this.ctx.exports.<Entrypoint>({ props: {...} })`.
- "An intercept lasts until the container stops, so register intercepts again for each new container." Re-registering replaces the handler without dropping connections. An intercept cannot be removed while the container runs.
- Limit: 128 intercept entries per container; a hostname uses two (IPv4 and IPv6), so at most 64 hostname targets. For a changing set, register `*` once and decide per hostname inside the entrypoint, changing behaviour by re-registering with new `props`.
- With `enableInternet: false`: "no public resolver answers DNS lookups"; intercepted hostnames resolve to a placeholder address, everything else times out. Only ports 80 and 443 are reachable. "Keep Internet access off when you use an outbound handler… With Internet access on, connections to other ports go out directly."
- TLS: the container must trust `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The CA "is ephemeral and only exists at runtime, so do not try to bake it into your image". Per-tool env vars from the Runner tutorial:

  ```ts
  const caPath = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
  // The CA alone replaces the system trust store. This works because
  // Outbound intercepts every HTTPS request from the container.
  const trustEnv = {
  	NODE_EXTRA_CA_CERTS: caPath,
  	GIT_SSL_CAINFO: caPath,
  	CURL_CA_BUNDLE: caPath,
  	SSL_CERT_FILE: caPath,
  };
  ```

  "If you copy them to a class that intercepts some hostnames only, add the certificate to the system trust store instead."
- "Add the credential only to HTTPS requests. The handler fetches with the scheme that the container used, so a credential added to a plain HTTP request crosses the Internet unencrypted."
- The documented git gateway allows only `GET <repo>.git/info/refs?service=git-upload-pack` and `POST <repo>.git/git-upload-pack`, then sets `Authorization`. The result: "`git remote get-url origin` prints the URL without a token. A `git push` from the sandbox fails with `403`." Push is the same pattern with `git-receive-pack` allowed.
- AI Gateway through the intercept, copied from the Runner tutorial (`src/outbound.ts`):

  ```ts
  if (
  	url.hostname === gatewayHost &&
  	(url.pathname === gatewayPath ||
  		url.pathname.startsWith(`${gatewayPath}/`))
  ) {
  	const headers = new Headers(request.headers);
  	headers.delete("x-api-key");
  	headers.set(
  		"cf-aig-authorization",
  		`Bearer ${this.env.AI_GATEWAY_TOKEN}`,
  	);
  	return fetch(new Request(request, { headers }));
  }
  ```

  where `gatewayHost = "gateway.ai.cloudflare.com"` and `gatewayPath = `/v1/${AI_GATEWAY_ACCOUNT_ID}/${AI_GATEWAY_ID}``. The `x-api-key` delete is required: "If the placeholder stays, AI Gateway forwards it to Anthropic, and the model request fails."
- The official example adds per-request tags the same way: `headers.set("cf-aig-metadata", this.env.AI_GATEWAY_METADATA)` (a JSON object string). Source: https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/shared/outbound.ts . AI Gateway keeps at most five custom metadata entries per request, and `cf.*` keys are reserved. Source: https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
- AI Gateway tokens are account-scoped: "Any token with `AI Gateway Run` can send requests through every gateway in the account". The path check in the outbound entrypoint is what confines a sandbox to one gateway. Source: https://developers.cloudflare.com/ai-gateway/configuration/authentication/
- Artifacts git auth accepts either `Authorization: Bearer <full token>` or HTTP Basic with the token secret as password; remotes are `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. Push uses `git-receive-pack` over protocol v1 only. Source: https://developers.cloudflare.com/artifacts/api/git-protocol/

### Lifetime, sleep and wake

Source: Lifetime; https://developers.cloudflare.com/containers/faq/

- "After the Durable Object becomes inactive, the instance keeps running for the time set with `setInactivityTimeout()`, up to 6 hours… Without a timeout, Cloudflare stops the instance shortly after the Durable Object becomes inactive."
- "Code that runs inside the instance does not count as activity. If no requests arrive, the instance stops when the inactivity timeout ends, even while a build, a test suite, or an agent task still runs inside it."
- "The restarted Durable Object starts without an inactivity timeout". Set it after `start()` and again in the constructor when `container.running` is true.
- An instance stops when the timeout ends, `destroy()` is called, or the main process exits. "The default command of `cloudflare/debian-trixie` exits right away", so start it with `entrypoint: ["sleep", "infinity"]`.
- "Cloudflare does not wake the Durable Object when its instance stops." To observe stops: https://developers.cloudflare.com/sandbox/manage/run-code-when-a-sandbox-stops/
- Deploys: every Durable Object restarts; running instances keep running with their original image, entrypoint and env. "no rollout replaces a sandbox." Requests, streams and WebSockets in flight end.
- Disk: "All disk is ephemeral by default. When a Container instance goes to sleep, the next time it starts, it uses a fresh disk from the container image." Nothing survives a stop except a snapshot or a mounted bucket.
- No fixed maximum runtime, but "Cloudflare does not guarantee that any container instance will run for a set period" (host restarts send `SIGTERM`, wait up to 15 minutes, then `SIGKILL`). Out-of-memory restarts the instance; there is no swap.

### Snapshots

Sources: DO container API; https://developers.cloudflare.com/containers/guides/snapshots/ ; https://developers.cloudflare.com/containers/platform/limits/ ; https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/

- Public beta; `durable_object` scheduling policy only.
- Save: `await this.ctx.container.snapshotContainer({ name })` returns `{ id, size, name? }`. Restore: `this.ctx.container.start({ containerSnapshot, enableInternet })`, where `containerSnapshot` is the returned object or `{ id }`. `image` and `containerSnapshot` are mutually exclusive.
- Captures "the writable root filesystem of a running container. It does not capture memory, running processes, or separately mounted filesystems. A container started from the snapshot runs its entrypoint again." Files in `/run` are in memory and are not saved. Process IDs are reused, so a pid file from before the snapshot can point at another process.
- Limits: maximum snapshot size 20 GB; retention "30 days from creation or the most recent restore"; "You cannot set a custom time-to-live yet."
- Immutable. "The Worker API has no method to list snapshots. Store the returned `id`". "The Durable Object container API has no method to delete a snapshot."
- "A snapshot is tied to the Container image version it was created from and is not portable to a different image."
- The handle is plain data and can be restored "including from another Durable Object"; many containers can start from one snapshot.
- "A save takes a few seconds, and the instance keeps running commands during it." A process writing during a save can leave a partial file in the snapshot.
- Nothing restores automatically: the application stores the id and passes it to the next `start()`.
- Snapshots carry whatever was written to disk, including any credential.

`DirectoryBackup` in `@cloudflare/sandbox` is a separate mechanism (one directory, tar+zstd to R2 through a gateway entrypoint). It is the replacement for 0.x `createBackup()` and is not needed if whole-filesystem snapshots are enough. Source: https://developers.cloudflare.com/sandbox/reference/directory-backups/

### Images and sizing

- Managed image: `cloudflare/debian-trixie` is `node:24.20.0-trixie-slim` pinned by digest, usable only with the `durable_object` policy, and "a Cloudflare-managed identifier, not a public Cloudflare Docker Hub image". It contains none of Python, Git, `curl`, `wget`, `jq`, `unzip`, `ps`. Sources: https://developers.cloudflare.com/containers/guides/image-management/ and https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/
- Custom images: a `Dockerfile` built by Wrangler at deploy (Docker must be running), or a digest-pinned managed-registry reference. `linux/amd64`. Image size is limited to the instance's disk; 50 GB total image storage per account.
- Instance types (https://developers.cloudflare.com/containers/platform/limits/):

  | Instance type | vCPU | Memory | Disk |
  | --- | --- | --- | --- |
  | lite | 1/16 | 256 MiB | 2 GB |
  | basic | 1/4 | 1 GiB | 4 GB |
  | standard-1 | 1/2 | 4 GiB | 8 GB |
  | standard-2 | 1 | 6 GiB | 12 GB |
  | standard-3 | 2 | 8 GiB | 16 GB |
  | standard-4 | 4 | 12 GiB | 20 GB |

- Chosen per launch with `start({ instance })`. Default is `lite`. "The runtime does not accept `basic` or the legacy `dev` and `standard` aliases." Custom object `{ vcpu, memoryMib, diskMb }` (camel case at runtime): vCPU 1–4, memory ≤ 12 GiB and at least 3 GiB per vCPU, disk ≤ 20 GB.
- Account limits: 6 TiB memory, 1,500 vCPU, 30 TB disk concurrently.
- A running container keeps its start image; `inspect()` returns `{ image, labels }`, with `image` empty while starting and for a container restored from a snapshot.
- Start time: on ComputeSDK's Burst TTI benchmark (100 sandboxes launched concurrently, time to interactive from the client) the `durable_object` path measured median 648 ms, p95 910 ms, p99 1,129 ms, against 4.049 s, 5.839 s and 6.717 s for the previous path. Source: https://blog.cloudflare.com/faster-agent-sandboxes/ (2026-09-30). The Containers FAQ still says "Container cold starts can often be in the 1-3 second range", and the Runner tutorial says of its custom image "The first request starts the container, so it can take about a minute." Treat 648 ms as the best case for a cached image, not a guarantee.
- Pricing, billed per 10 ms while running, Workers Paid (https://developers.cloudflare.com/containers/platform/pricing/): memory $0.0000025 per GiB-second (25 GiB-hours included), CPU $0.000020 per vCPU-second (375 vCPU-minutes included), disk $0.00000007 per GB-second (200 GB-hours included). "Memory and disk usage are based on the *provisioned resources*… while CPU usage is based on *active usage* only." Derived, not quoted: ten minutes of `standard-4` is at most about $0.067 (12 GiB × 600 s memory = $0.018, 4 vCPU × 600 s at full load = $0.048, disk under $0.001).
- Docker in a container: use `docker:dind` and `dockerd --iptables=false --ip6tables=false --ip-forward=false`; "Run the Docker daemon as `root`. Rootless Docker does not start in Containers." Inner containers need `--network=host`, and `docker build` steps that use the network need `--network=host`. Source: https://developers.cloudflare.com/containers/faq/

### `@cloudflare/ci`

Sources: `@cloudflare/ci@0.2.0` tarball (publishes TypeScript source, no build) and https://github.com/cloudflare/ci (last commit 2026-09-14, identical to 0.2.0).

- Versions: `0.1.0` (2026-08-03), `0.2.0` (2026-09-14). Apache-2.0. Dependencies: `"@cloudflare/sandbox": "0.12.1"` (exact) and `"zod": "^4.4.3"`.
- Entry points and exports:
  - `@cloudflare/ci`: `CIWorkflow`, `cloudflareArtifacts`, `isCiRunnerFailure`; types `CiContext`, `CiParams`, `CiRunnerFailureDiagnostics`, `CiRunnerResult`, `CiWorkflowPayload`, `CloudflareArtifacts`, `CloudflareArtifactsPushEvent`, `RunnerConfig`.
  - `@cloudflare/ci/worker`: `CiSandbox`, `restartCiRun`, `startCiRun`; types `CiBindings`, `DirectoryBackup`, `RunnerOptions`, `CreatePullRequestResult`, `SourceControlCheckout`, `SourceControlPushCredentials`, `SourceControlSource`.
  - `@cloudflare/ci/worker/source-control`: `cloudflareArtifacts`, type `SourceControlAdapter`.
  - There is no `HealingAgent` export. "The Healing Agent, its tools, and its AI dependencies are not part of `@cloudflare/ci`" (README); it is application code in `examples/self-healing`.
- It is a library used inside your own Worker: "The HTTP routes, queue handler, Wrangler configuration, bindings, and concrete Workflow classes remain application code". It needs `nodejs_compat` and a Workers-aware bundler. It expects these bindings by name (`src/env.ts`):

  ```ts
  type Secrets = {
    [name: string]: unknown;
    CF_TOKEN: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  };

  export type Bindings = Secrets & {
    ARTIFACTS: Artifacts;
    BACKUP_BUCKET: R2Bucket;
    BACKUP_BUCKET_NAME: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    SANDBOX: DurableObjectNamespace<import('./ci/sandbox').CiSandbox>;
    CI_WORKFLOW: Workflow<
      import('./pipeline/types').CiParams<
        import('./pipeline/types').CloudflareArtifacts
      >
    >;
  };
  ```

- Pipeline definition, copied from `examples/cloudflare-artifacts/cloudflare.ci.ts`:

  ```ts
  export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
    protected async pipeline(
      _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
      _step: WorkflowStep,
      ci: CiContext
    ): Promise<void> {
      const deps = await ci.runner({
        name: 'install',
        command: 'npm ci',
        cache: { inputs: ['package.json', 'package-lock.json'] },
      });

      await Promise.all([
        deps.runner({ name: 'lint', command: 'npm run lint' }),
        deps.runner({ name: 'test', command: 'npm run test' }),
        deps.runner({ name: 'typecheck', command: 'npm run typecheck' }),
        deps.runner({ name: 'build', command: 'npm run build' }),
      ]);
      // ...
    }
  }
  ```

  The file lives in the CI Worker's own source and is exported from its entry module. "Changes to `cloudflare.ci.ts` take effect after the Worker is deployed." (example README).
- `RunnerOptions` (`src/pipeline/types.ts`):

  ```ts
  export type RunnerOptions = {
    // Names identify durable Workflow steps and must be deterministic.
    name: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    cache?: { inputs: string[] };
    config?: RunnerConfig;
    cloudflareCredentials?: boolean | { accountId: string };
    // Inject provider-specific source-control credentials into the command env.
    sourceControlCredentials?: boolean;
    // Names of Worker secrets/vars resolved and injected into the command.
    secrets?: string[];
  };
  ```

- Execution model (`src/pipeline/ci-workflow.ts`, `src/ci/runners/sandbox.ts`): each `runner()` is one `step.do(name, …)` with defaults of 2 retries, 30 s linear delay and a 12-minute step timeout; the command timeout defaults to the step timeout minus 10 s. Each runner gets a fresh sandbox (`getSandbox(env.SANDBOX, "<slug>-<uuid>")`), checks out the commit with `git fetch --depth=1 origin <sha>` in a scratch directory and copies the tree without `.git` into `/workspace`, runs the command with stdout/stderr redirected to files, and on success backs `/workspace` up to R2 (`createBackup`, default retention 30 days); a chained runner restores that backup first. The sandbox is destroyed after each runner. "Commands with external side effects must therefore be idempotent" (README).
- Trigger from a push: a Wrangler `triggers.events` entry delivers `cf.artifacts.repo.pushed` directly to the Workflow; "no Queue is required" (example README). Copied from `examples/cloudflare-artifacts/wrangler.jsonc`:

  ```jsonc
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

  This shape matches `wrangler@4.147.0`'s `config-schema.json` (`ArtifactsEventTrigger`: `filter.namespace`, `filter.repo_name`, `targets[].type: "workflow"`, `targets[].workflow_name`, `additionalProperties: false`). **The docs page https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/ shows a different shape (`repoName`, `target.scriptName`, `target.workflowName`) that the schema rejects.** The same page states the filter is optional and that omitting the repository name runs the Workflow "for every push to any repo in your Artifacts namespace". The schema accepts nine event types on this trigger (`cf.artifacts.repo.created|deleted|forked|imported|pushed|cloned|fetched|token.created|token.revoked`).
- It can also be started from code: `startCiRun(env, params)` calls `env.CI_WORKFLOW.createBatch([{ id, params }])` with a deterministic id derived from provider, owner, repository and commit SHA, and returns `null` if a run for that commit already exists; `restartCiRun(env, source)` restarts it (`src/ci/dispatch.ts`).
- Push event payload as the package parses it (`src/artifacts/events.ts`): `type: 'cf.artifacts.repo.pushed'`, `source: { namespace, repoName }`, `payload: { ref, before, after, commits: [{ id, message, author: { name, email } }] }`. Only `refs/heads/*` and `refs/tags/*` start a run; a ref deletion (`after` all zeros) is ignored. The package reads no pusher or token identity from the event.
- Observing a run: a runner returns `{ exitCode, logs: { stdout, stderr }, snapshot, cachePointer? }` when its step completes; logs above 300,000 bytes are returned as streams. A failed runner throws `CiRunnerFailure` carrying the last 20,000 characters of output. `StepNotificationHandle` (`succeed`/`fail`) exists as a provider hook, but the Artifacts provider does not implement `startStepNotification`, so nothing is reported per step. The docs point at the Workflows dashboard: "To identify which stage failed, inspect the instance in the Workflows dashboard". Programmatically that is the Workflow instance's `status(): Promise<InstanceStatus>` and `subscribe(options?): Promise<WorkflowInstanceSubscription>` ("historical and live execution events"). Source: https://developers.cloudflare.com/workflows/build/workers-api/
- "`CiRunnerResult.logs` contains raw command output and is not secret-redacted; only provider notification previews and failure messages are redacted." (README)
- Caching: `cache: { inputs: [...] }` keys the runner's workspace backup on the git blob hashes of the listed paths (globs `*` and `**`), plus repository, ref, runner name, command, cwd and env. A hit skips the command and returns the cached workspace with a synthetic log line. Keys are scoped by ref "so an untrusted branch cannot publish a workspace later restored by the default branch" (`src/ci/capabilities.ts`). The pointer is a small JSON object in R2 under `cache/<key>.json`.
- Credentials in the sandbox: the checkout step receives a one-hour repository read token as the `SOURCE_CONTROL_TOKEN` env var of the checkout command; `sourceControlCredentials: true` puts `ARTIFACTS_REMOTE` and `ARTIFACTS_TOKEN` into the user command's env; `cloudflareCredentials` puts `CLOUDFLARE_API_TOKEN` there; `secrets: [...]` copies named Worker secrets into it. No egress interception is used.
- Cost: no separate price. A run costs its Workflow steps (500,000 included per month on Workers Paid, then $0.80 per 100,000; https://developers.cloudflare.com/workflows/reference/pricing/), container time for each runner (the example uses `standard-4`), and R2 storage for one workspace backup per successful runner.
- Workflows limits that shape any CI runner: a non-stream step result is at most 1 MiB; an event payload at most 1 MiB; step wall time is unlimited; CPU per step is 30 s by default, configurable to 5 minutes. Source: https://developers.cloudflare.com/workflows/reference/limits/

**Thinnest alternative (a recommendation, not a documented product):** one Workflow of our own, triggered by the same `triggers.events` entry, whose steps call RPC methods on our own `durable_object`-policy sandbox Durable Object. Each step starts a command with the documented background-process launcher, an alarm keeps the container alive, logs are tailed from files for live streaming, and `snapshotContainer()` carries the installed workspace between steps instead of R2 backups. Every piece is a documented 1.0 pattern above; it avoids the 0.x dependency, the R2 access keys and the fixed binding names, and it lets the pipeline come from data in the repository.

### Running a coding agent in a Sandbox

Sources: Runner tutorial; https://developers.cloudflare.com/sandbox/coding-agents/claude-code/ ; https://github.com/cloudflare/sandbox-sdk/tree/main/examples/coding-agents

- Image, copied from the tutorial:

  ```dockerfile
  FROM node:24-trixie-slim

  RUN apt-get update \
  	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  	&& rm -rf /var/lib/apt/lists/*

  # The install script from the Claude Code package puts its native binary in place
  RUN npm install --global @anthropic-ai/claude-code@2.1.280

  COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

  WORKDIR /workspace
  # Keep the container running between requests
  CMD ["sleep", "infinity"]
  ```

  "Install everything the agent needs in the image, because the sandbox cannot download packages at run time." "Pin the Claude Code version. Its command-line flags and event format can change between releases."
- Command and environment, copied from the tutorial:

  ```ts
  	private agentCommand(prompt: string): string[] {
  		return [
  			"claude",
  			"--print",
  			"--output-format",
  			"stream-json",
  			"--verbose",
  			"--dangerously-skip-permissions",
  			"--no-session-persistence",
  			"--model",
  			this.env.MODEL,
  			"--",
  			prompt,
  		];
  	}

  	private agentEnv(): Record<string, string> {
  		return {
  			ANTHROPIC_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/anthropic`,
  			ANTHROPIC_API_KEY: "provided-by-worker",
  			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  			IS_SANDBOX: "1",
  		};
  	}
  ```

  `ANTHROPIC_API_KEY` is a placeholder because Claude Code will not start without one. `IS_SANDBOX=1` is required to skip permissions as root. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off update checks, telemetry and error reporting so only the gateway is called.
- The sandbox starts with `enableInternet: false` and `interceptAllOutboundHttp` plus `interceptOutboundHttps("*", …)` registered on every start; the tutorial uses `instance: "standard-1"` and a 30-minute inactivity timeout.
- Output: Claude Code writes one JSON event per line to a file in the container; the Durable Object reads it with `Files.readFile()`. The example repository's `GET …/events` route returns that file. A live stream is the `tail -F --pid` pattern from "Long-running processes".
- Outcome: "Claude Code exits successfully even when a model request fails, so the outcome comes from the `is_error` field of the final `result` event instead of the exit code." A rejected gateway token takes about three minutes to surface because Claude Code retries a failing model request 10 times. The events file comes from untrusted code and is validated before use.
- The prompt is one argv entry: "Linux rejects a command argument of 128 KiB or more".
- "If the repository has a `CLAUDE.md` file, Claude Code reads it."
- Gateway prerequisites: an authenticated gateway, a token with `Run` permission, and Anthropic credentials held by the gateway (Unified Billing credits or a stored provider key). Outside a sandbox the equivalent is `ANTHROPIC_CUSTOM_HEADERS="cf-aig-authorization: Bearer <CF_AIG_TOKEN>"`. Source: https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/
- Session resume is not covered: the official command passes `--no-session-persistence`, and every task is a fresh `claude --print` invocation. See "Could not verify".

### Git in a Sandbox against Artifacts

- Recommended approach by repository size: "Use ArtifactFS for large repos in sandboxes, containers, and virtual machines. For smaller repos, a regular `git clone` is usually simpler." Source: https://developers.cloudflare.com/artifacts/guides/artifact-fs/
- ArtifactFS "starts with a blobless clone. It fetches commits, trees, and refs first, then mounts the working tree through FUSE"; contents hydrate on read. It is installed with `go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@latest` and needs "a working FUSE implementation on the host" and a running `artifact-fs daemon`. The documented example passes the token inside the remote URL.
- Timings: the docs give none. The launch post says "most repositories take only a few seconds to clone at most", that a 2.4 GB repository "takes close to 2 minutes to clone", and frames ArtifactFS as getting large repositories "down to ~10-15 second[s]". Source: https://blog.cloudflare.com/artifacts-git-for-agents-beta/ (2026-04-16).
- Plain git over HTTPS works with the standard client for `clone`, `fetch`, `pull`, `push`; fetch supports protocol v1 and v2 including shallow fetches; "Some optional v1 capabilities, such as `filter` and `include-tag`, are not supported." Source: https://developers.cloudflare.com/artifacts/api/git-protocol/
- The only Sandbox + Artifacts page (https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) uses the 0.x `getSandbox()` and `sandbox.setEnvVars({ ARTIFACTS_GIT_REMOTE: … })` with the token embedded in the URL. That is the pattern the Security page warns about ("Git saves that URL in the `.git/config` file… Any of that code can read the token").
- Fetching a fork and merging have no Cloudflare-specific documentation: they are ordinary `git remote add` / `git fetch` / `git merge` against two Artifacts remotes, each needing its own token because tokens are repository-scoped.

## Local development and tests

- **`wrangler dev` needs Docker.** "You will need to first ensure that a Docker compatible CLI tool and Engine are installed" (Docker Desktop or Colima). `durable_object`-policy containers need Wrangler 4.136.0 or later; running `cloudflare/debian-trixie` locally needs 4.141.0 or later. `vite dev` with the Cloudflare Vite plugin also works but cannot pull from the Cloudflare Registry. Source: https://developers.cloudflare.com/containers/guides/local-dev/
- **`wrangler deploy` needs Docker too** whenever an image is built from a Dockerfile.
- **Egress interception works locally.** "`wrangler dev` supports outbound interception. A sidecar process is spawned inside the container's network namespace. It applies `TPROXY` rules to route matching traffic to the local Workerd instance". Source: https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- **Snapshots have a local implementation** in workerd's Docker client (`ContainerClient::snapshotContainer`, using the Docker commit API). Source: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/container-client.c++ . The docs do not describe local snapshot behaviour, so limits and retention locally are unverified.
- **Documented differences between local Docker and production** (same local-dev page): the deployed hostname is 64 characters and does not resolve (breaks Python's `http.server`); locally a non-root user has no capabilities and file permissions apply, in production every process has root's capabilities; `max_instances` is not applied locally. `DirectoryBackup.restore()` cannot replace a directory that is part of the image under `wrangler dev` (`EXDEV`).
- **FUSE locally** (needed for `S3Mount` and ArtifactFS) works when Docker runs in a VM (macOS, WSL) or with rootless Docker on Linux when `/dev/fuse` exists; not with rootful Docker on Linux.
- **Vitest does not run containers.** `@cloudflare/vitest-plugin@1.3.6` (the current package; docs now direct `@cloudflare/vitest-pool-workers` users to migrate to it) and `@cloudflare/vitest-pool-workers@0.22.0` both build their Miniflare options with `overrides: { …, enableContainers: false }` (`dist/pool/index.mjs` in each tarball). The Vitest docs and known-issues page do not mention Containers at all. Code that depends on a sandbox must take it through an interface and be tested against a fake; the real implementation is exercised under `wrangler dev`.
- **Needs a fake or a real account:** Artifacts push triggers (`triggers.events`) and AI Gateway are account services; no local emulation is documented for either.
- **`@cloudflare/ci` locally:** 0.2.0 "automatically select[s] the local R2 backup path when `/dev/fuse` is unavailable, allowing backups and restores to work under `wrangler dev`" (CHANGELOG).

## Could not verify

- **Git push from a sandbox to Artifacts with the token added by an intercept.** Verified separately: `interceptOutboundHttps` on a hostname with a `WorkerEntrypoint` that sets `Authorization` (documented for `github.com`), and that Artifacts accepts `Authorization: Bearer <token>` on `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/...`. No doc or example combines them, and nothing was run. Open points: whether `git-receive-pack` request bodies (packfiles) stream through the entrypoint without a size limit, and whether a Worker `fetch()` to `*.artifacts.cloudflare.net` from the same account behaves like an external client. Keep behind a port and test first.
- **Session resume for a headless coding agent.** The official guide and example run with `--no-session-persistence` and document no resume. Tried: the Runner tutorial, the Claude Code page, the `cloudflare/sandbox-sdk` `examples/coding-agents` source. Whether Claude Code's own session files survive a container snapshot and can be resumed afterwards is undocumented by Cloudflare.
- **Snapshot pricing.** The Containers pricing page has no snapshot line; the limits page gives only size and retention.
- **Snapshot behaviour under `wrangler dev`** beyond the fact that an implementation exists: size limit, retention, and whether a local snapshot is tied to the image the same way.
- **Start time for our own image.** The 648 ms median comes from a third-party benchmark quoted in a Cloudflare blog post; image, instance type and region are not stated there. No figure exists for a restore from a multi-GB snapshot.
- **ArtifactFS inside a `durable_object`-policy container.** The docs require "a working FUSE implementation on the host"; `S3Mount` shows FUSE works in these containers, but no source shows ArtifactFS running in one, and no timing is documented for repositories under 1 GB.
- **`directorySnapshots` on `ContainerStartupOptions` and the `ContainerDirectorySnapshot` types.** They appear in `@cloudflare/workers-types@5.20261002.1`, but the `Container` interface has no method that creates one and no docs page describes them. Do not use.
- **Whether a push event identifies the pusher or the token.** `@cloudflare/ci`'s schema reads only `ref`, `before`, `after` and `commits`; that shows what the package uses, not everything the event carries. Out of scope here (Artifacts note).
- **`@cloudflare/ci` moving to Sandbox 1.0.** No branch, issue or changelog entry in `cloudflare/ci` mentions it as of the last commit (2026-09-14).
- **Sandbox-specific limits** such as maximum concurrent `exec()` processes per container or maximum `exec()` output rate: not stated on any page read.
