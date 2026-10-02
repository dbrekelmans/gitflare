// Throwaway spike for GF-13. One Worker, one container-backed Durable Object driven over HTTP by
// the scripts in ../scripts. Nothing here is product code.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const MANAGED_IMAGE = "cloudflare/debian-trixie";
const OUTPUT_TAIL = 16_000;

// The documented background launcher (developers.cloudflare.com/sandbox/commands/run-background-processes/).
const RUN = `dir=$1; shift
mkdir -p "$dir"
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

type GatewayProps = {
	box: string;
	host: string;
	namespace: string;
	// repo name -> token plaintext. The token never enters the container.
	tokens: Record<string, string>;
	allowPush: boolean;
	// Hosts passed through unchanged (no credential added), for a "*" intercept with Internet off.
	allowHosts?: string[];
	aiGateway?: string;
};

type StartBody = {
	image?: string;
	snapshot?: { id: string };
	instance?: unknown;
	enableInternet?: boolean;
	entrypoint?: string[];
	inactivityMs?: number;
	gateway?: { repos: string[]; allowPush?: boolean; allowHosts?: string[]; aiGateway?: string };
	// Fallback under test: mint a token and hand it to the container as $ARTIFACTS_TOKEN.
	directToken?: { repo: string; scope: "read" | "write"; ttl: number };
	heartbeat?: boolean;
	monitor?: boolean;
	labels?: Record<string, string>;
};

type ExecBody = {
	cmd: string | string[];
	env?: Record<string, string>;
	cwd?: string;
	timeoutS?: number;
	trust?: boolean;
	token?: boolean;
};

type CiBody = {
	steps: { name: string; cmd: string; timeoutS?: number }[];
	cwd?: string;
	detach?: boolean;
	env?: Record<string, string>;
};

const decoder = new TextDecoder();
const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…[${s.length - OUTPUT_TAIL} chars cut]…${s.slice(-OUTPUT_TAIL)}` : s);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const errorText = (e: unknown) => {
	const err = e as { name?: string; message?: string; exitCode?: number };
	return `${err?.name ?? typeof e}: ${err?.message ?? String(e)}${err?.exitCode === undefined ? "" : ` (exitCode=${err.exitCode})`}`;
};

async function pumpLines(stream: ReadableStream | null | undefined, onLine: (line: string) => void) {
	if (!stream) return;
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			onLine(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
		}
	}
	if (buffer) onLine(buffer);
}

export class Box extends DurableObject<Env> {
	private createdAt = Date.now();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, step TEXT, stream TEXT, t INTEGER, line TEXT)",
		);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, kind TEXT, detail TEXT)");
		this.event("constructed", `running=${ctx.container?.running}`);
		const container = ctx.container;
		const timeout = ctx.storage.kv.get<number>("inactivityMs");
		if (container?.running && timeout) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(timeout));
		}
	}

	private event(kind: string, detail = "") {
		this.ctx.storage.sql.exec("INSERT INTO event (t, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, detail);
	}

	private get container(): Container {
		const container = this.ctx.container;
		if (!container) throw new Error("no container binding on this Durable Object");
		return container;
	}

	private argv(body: ExecBody): string[] {
		const base = typeof body.cmd === "string" ? ["sh", "-c", body.cmd] : body.cmd;
		return body.timeoutS ? ["timeout", "--kill-after=5", String(body.timeoutS), ...base] : base;
	}

	private procEnv(body: { env?: Record<string, string>; trust?: boolean; token?: boolean }): Record<string, string> {
		return {
			HOME: "/root",
			...(body.token ? { ARTIFACTS_TOKEN: this.ctx.storage.kv.get<string>("directToken") ?? "" } : {}),
			...(body.trust === false ? {} : { GIT_SSL_CAINFO: CA, NODE_EXTRA_CA_CERTS: CA, SSL_CERT_FILE: CA, CURL_CA_BUNDLE: CA }),
			...body.env,
		};
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const op = url.pathname.split("/").slice(3).join("/");
		const name = url.pathname.split("/")[2];
		const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
		try {
			switch (op) {
				case "start":
					return json(await this.start(name, body));
				case "exec":
					return json(await this.exec(body));
				case "stream":
					return this.stream(body);
				case "bg":
					return json(await this.background(body));
				case "ci":
					return json(await this.ci(body));
				case "pipe-noread": {
					// stdout is piped (the default) and nobody reads it; the request returns at once.
					const process = await this.container.exec(["sh", "-c", body.cmd]);
					return json({ pid: process.pid });
				}
				case "log":
					return json(
						this.ctx.storage.sql
							.exec("SELECT run, step, stream, t, line FROM log WHERE run = ? AND id > ? ORDER BY id", url.searchParams.get("run"), Number(url.searchParams.get("after") ?? 0))
							.toArray(),
					);
				case "events":
					return json(this.ctx.storage.sql.exec("SELECT t, kind, detail FROM event ORDER BY id").toArray());
				case "state":
					return json({
						now: Date.now(),
						instanceCreatedAt: this.createdAt,
						running: this.container.running,
						inspect: await this.container.inspect().catch(errorText),
						images: this.container.images,
						snapshot: this.ctx.storage.kv.get("snapshot"),
						alarm: await this.ctx.storage.getAlarm(),
					});
				case "snapshot": {
					const t0 = Date.now();
					const snapshot = await this.container.snapshotContainer(body.name ? { name: body.name } : {});
					this.ctx.storage.kv.put("snapshot", snapshot);
					return json({ snapshot, ms: Date.now() - t0 });
				}
				case "timeout":
					await this.container.setInactivityTimeout(body.ms);
					this.ctx.storage.kv.put("inactivityMs", body.ms);
					return json({ ok: true });
				case "keepalive":
					// An alarm every `everyMs` until `forMs` from now; the alarm does nothing but run.
					this.ctx.storage.kv.put("keepaliveUntil", Date.now() + body.forMs);
					this.ctx.storage.kv.put("keepaliveEveryMs", body.everyMs);
					await this.ctx.storage.setAlarm(Date.now() + body.everyMs);
					return json({ ok: true });
				case "signal":
					this.container.signal(body.signo);
					return json({ ok: true });
				case "destroy": {
					const t0 = Date.now();
					await this.container.destroy(body.reason);
					return json({ ms: Date.now() - t0, running: this.container.running });
				}
				case "reset":
					await this.ctx.storage.deleteAlarm();
					await this.ctx.storage.deleteAll();
					return json({ ok: true });
				default:
					return json({ error: `unknown op ${op}` }, 404);
			}
		} catch (e) {
			this.event("op-error", `${op}: ${errorText(e)}`);
			return json({ error: errorText(e) }, 500);
		}
	}

	async alarm() {
		const until = this.ctx.storage.kv.get<number>("keepaliveUntil") ?? 0;
		this.event("alarm", `running=${this.ctx.container?.running}`);
		if (Date.now() < until) {
			await this.ctx.storage.setAlarm(Date.now() + (this.ctx.storage.kv.get<number>("keepaliveEveryMs") ?? 30_000));
		}
	}

	private async gateway(name: string, config: NonNullable<StartBody["gateway"]>) {
		const tokens: Record<string, string> = {};
		let host = "";
		for (const repoName of config.repos) {
			using repo = await this.env.ARTIFACTS.get(repoName);
			host = new URL((await repo.info()).remote).hostname;
			tokens[repoName] = (await repo.createToken(config.allowPush ? "write" : "read", 3600)).plaintext;
		}
		const props: GatewayProps = { box: name, host, namespace: this.env.NAMESPACE, tokens, allowPush: config.allowPush ?? false, allowHosts: config.allowHosts, aiGateway: config.aiGateway };
		await this.container.interceptOutboundHttps(config.allowHosts ? "*" : host, this.ctx.exports.GitGateway({ props }));
		return host;
	}

	private async start(name: string, body: StartBody) {
		const container = this.container;
		const timings: Record<string, number> = {};
		let t0 = Date.now();
		let gatewayHost: string | undefined;
		if (body.gateway) {
			gatewayHost = await this.gateway(name, body.gateway);
			timings.gatewayMs = Date.now() - t0;
		}
		if (body.directToken) {
			using repo = await this.env.ARTIFACTS.get(body.directToken.repo);
			this.ctx.storage.kv.put("directToken", (await repo.createToken(body.directToken.scope, body.directToken.ttl)).plaintext);
		}
		if (body.heartbeat) {
			await container.interceptOutboundHttp("hb.spike", this.ctx.exports.GitGateway({ props: { box: name, host: "", namespace: "", tokens: {}, allowPush: false } }));
		}
		const options: Record<string, unknown> = {
			enableInternet: body.enableInternet ?? false,
			entrypoint: body.entrypoint ?? ["sleep", "infinity"],
		};
		if (body.snapshot) options.containerSnapshot = body.snapshot;
		else options.image = body.image === undefined || body.image === "managed" ? MANAGED_IMAGE : (container.images[body.image] ?? body.image);
		if (body.instance !== undefined) options.instance = body.instance;
		if (body.labels) options.labels = body.labels;

		t0 = Date.now();
		container.start(options as ContainerStartupOptions);
		timings.startCallMs = Date.now() - t0;
		this.event("start", JSON.stringify({ ...options, containerSnapshot: body.snapshot?.id }));
		if (body.monitor !== false) {
			this.ctx.waitUntil(
				container.monitor().then(
					() => this.event("monitor-resolved"),
					(e) => this.event("monitor-rejected", errorText(e)),
				),
			);
		}
		// exec() waits for a container that is still starting, so the first exec measures readiness.
		const first = await container.exec(["true"]);
		const exitCode = await first.exitCode;
		timings.readyMs = Date.now() - t0;
		if (body.inactivityMs) {
			await container.setInactivityTimeout(body.inactivityMs);
			this.ctx.storage.kv.put("inactivityMs", body.inactivityMs);
		}
		return { ...timings, firstExecExitCode: exitCode, gatewayHost: gatewayHost?.replace(/^[0-9a-f]{32}/, "<account-id>"), inspect: await container.inspect() };
	}

	private async exec(body: ExecBody) {
		const t0 = Date.now();
		const process = await this.container.exec(this.argv(body), { cwd: body.cwd, env: this.procEnv(body) });
		const output = await process.output();
		return {
			exitCode: output.exitCode,
			ms: Date.now() - t0,
			stdout: tail(decoder.decode(output.stdout)),
			stderr: tail(decoder.decode(output.stderr)),
		};
	}

	// Streams output to the caller as it is produced; each chunk is prefixed with the ms since exec().
	private async stream(body: ExecBody): Promise<Response> {
		const t0 = Date.now();
		const process = await this.container.exec(this.argv(body), { cwd: body.cwd, env: this.procEnv(body), stderr: "combined" });
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		void (async () => {
			try {
				await pumpLines(process.stdout, (line) => void writer.write(encoder.encode(`[+${Date.now() - t0}ms] ${line}\n`)));
				await writer.write(encoder.encode(`[+${Date.now() - t0}ms] exit=${await process.exitCode}\n`));
			} catch (e) {
				await writer.write(encoder.encode(`[+${Date.now() - t0}ms] stream error: ${errorText(e)}\n`)).catch(() => {});
			} finally {
				await writer.close().catch(() => {});
			}
		})();
		return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" } });
	}

	// Output goes to files in the container; the exec() promise is not awaited to completion.
	private async background(body: { dir: string; cmd: string; env?: Record<string, string>; cwd?: string }) {
		const process = await this.container.exec(["sh", "-c", RUN, "run", body.dir, "sh", "-c", body.cmd], {
			stdout: "ignore",
			stderr: "ignore",
			cwd: body.cwd,
			env: this.procEnv(body),
		});
		return { pid: process.pid, dir: body.dir };
	}

	// A CI run: each step is one exec() under GNU timeout; every output line is written to SQLite the
	// moment the Durable Object reads it, and the exit code decides pass or fail.
	private async ci(body: CiBody) {
		const run = crypto.randomUUID().slice(0, 8);
		const work = this.runSteps(run, body);
		if (body.detach) {
			this.ctx.waitUntil(work);
			return { run, detached: true };
		}
		return work;
	}

	private async runSteps(run: string, body: CiBody) {
		const insert = (step: string, stream: string, line: string) =>
			this.ctx.storage.sql.exec("INSERT INTO log (run, step, stream, t, line) VALUES (?, ?, ?, ?, ?)", run, step, stream, Date.now(), line);
		const results: { name: string; exitCode: number | null; ms: number; error?: string }[] = [];
		for (const step of body.steps) {
			const t0 = Date.now();
			let exitCode: number | null = null;
			let error: string | undefined;
			try {
				const process = await this.container.exec(["timeout", "--kill-after=5", String(step.timeoutS ?? 600), "sh", "-c", step.cmd], {
					cwd: body.cwd,
					env: this.procEnv(body),
				});
				await Promise.all([
					pumpLines(process.stdout, (line) => insert(step.name, "out", line)),
					pumpLines(process.stderr, (line) => insert(step.name, "err", line)),
				]);
				exitCode = await process.exitCode;
			} catch (e) {
				error = errorText(e);
			}
			const result = { name: step.name, exitCode, ms: Date.now() - t0, error };
			results.push(result);
			insert(step.name, "meta", JSON.stringify(result));
			if (exitCode !== 0) break;
		}
		const summary = { run, passed: results.length === body.steps.length && results.every((r) => r.exitCode === 0), steps: results };
		this.event("ci-finished", JSON.stringify(summary));
		return summary;
	}
}

// Append-only notes kept outside Box, so writing one is not activity on the Box Durable Object.
export class Recorder extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, detail TEXT)");
	}
	append(detail: string) {
		this.ctx.storage.sql.exec("INSERT INTO note (t, detail) VALUES (?, ?)", Date.now(), detail);
	}
	list() {
		return this.ctx.storage.sql.exec("SELECT t, detail FROM note ORDER BY id").toArray();
	}
	async clear() {
		await this.ctx.storage.deleteAll();
	}
}

// Receives the container's HTTPS requests to the Artifacts host and adds the credential.
export class GitGateway extends WorkerEntrypoint<Env, GatewayProps> {
	async fetch(request: Request): Promise<Response> {
		const t0 = Date.now();
		const props = this.ctx.props;
		const url = new URL(request.url);
		const recorder = this.env.RECORDER.getByName(props.box);
		if (url.hostname === "hb.spike") {
			await recorder.append(`hb ${url.search}`);
			return new Response("ok\n");
		}
		const note: Record<string, unknown> = {
			method: request.method,
			scheme: url.protocol,
			path: url.pathname.replace(/[0-9a-f]{32}/, "<account-id>") + url.search,
			reqContentLength: request.headers.get("content-length"),
			reqTransferEncoding: request.headers.get("transfer-encoding"),
			reqContentEncoding: request.headers.get("content-encoding"),
			gitProtocol: request.headers.get("git-protocol"),
			hadAuthorization: request.headers.has("authorization"),
			userAgent: request.headers.get("user-agent"),
		};
		if (url.protocol === "https:" && props.allowHosts?.includes(url.hostname)) {
			const response = await fetch(request);
			this.ctx.waitUntil(recorder.append(JSON.stringify({ method: request.method, host: url.hostname, path: url.pathname, status: response.status, passThrough: true })));
			return response;
		}
		// Q6: model traffic. The container holds a placeholder key; the gateway credential is the Worker's
		// AI binding, so no AI Gateway token exists anywhere.
		const model = url.hostname === "gateway.ai.cloudflare.com" && url.pathname.match(/^\/v1\/[^/]+\/([^/]+)\/anthropic\/(.+)$/);
		if (model && url.protocol === "https:" && model[1] === props.aiGateway) {
			const headers: Record<string, string> = {};
			for (const name of ["content-type", "anthropic-version", "anthropic-beta", "accept"]) {
				const value = request.headers.get(name);
				if (value) headers[name] = value;
			}
			const query = request.method === "POST" ? await request.json() : undefined;
			const response = await this.env.AI.gateway(model[1]).run({ provider: "anthropic", endpoint: model[2] + url.search, headers, query });
			const record: Record<string, unknown> = { method: request.method, host: url.hostname, endpoint: model[2], model: (query as any)?.model, hadApiKeyHeader: request.headers.has("x-api-key"), status: response.status, contentType: response.headers.get("content-type"), msToHeaders: Date.now() - t0 };
			if (!response.ok) record.body = (await response.clone().text()).slice(0, 400);
			this.ctx.waitUntil(recorder.append(JSON.stringify(record)));
			return response;
		}
		const match = url.pathname.match(/^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
		const service = match?.[3] === "info/refs" ? url.searchParams.get("service") : match?.[3];
		const token = match && match[1] === props.namespace ? props.tokens[match[2]] : undefined;
		const allowed =
			url.protocol === "https:" &&
			url.hostname === props.host &&
			token !== undefined &&
			(service === "git-upload-pack" || (service === "git-receive-pack" && props.allowPush));
		if (!allowed) {
			this.ctx.waitUntil(recorder.append(JSON.stringify({ ...note, status: 403, by: "gateway" })));
			return new Response("Forbidden by gateway\n", { status: 403 });
		}
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${token}`);
		let response: Response;
		try {
			response = await fetch(new Request(request, { headers }));
		} catch (e) {
			this.ctx.waitUntil(recorder.append(JSON.stringify({ ...note, error: errorText(e), ms: Date.now() - t0 })));
			return new Response(`gateway fetch failed: ${errorText(e)}\n`, { status: 502 });
		}
		this.ctx.waitUntil(
			recorder.append(
				JSON.stringify({
					...note,
					status: response.status,
					resContentLength: response.headers.get("content-length"),
					resContentType: response.headers.get("content-type"),
					msToHeaders: Date.now() - t0,
				}),
			),
		);
		return response;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.headers.get("x-spike-key") !== env.SPIKE_KEY) return new Response("not found\n", { status: 404 });
		const url = new URL(request.url);
		const parts = url.pathname.split("/");
		try {
			if (parts[1] === "box") return env.BOX.getByName(parts[2]).fetch(request);
			if (parts[1] === "notes") {
				const recorder = env.RECORDER.getByName(parts[2]);
				if (request.method === "DELETE") return json({ cleared: (await recorder.clear(), true) });
				return json(await recorder.list());
			}
			if (parts[1] === "artifacts") {
				const body = request.method === "POST" ? ((await request.json()) as any) : {};
				// Tokens returned by create/fork/import are dropped: nothing outside the Worker needs one.
				const strip = ({ token, ...rest }: any) => ({ ...rest, remote: rest.remote?.replace(/[0-9a-f]{32}/, "<account-id>"), hadToken: Boolean(token) });
				const t0 = Date.now();
				switch (parts[2]) {
					case "create":
						return json({ ...strip(await env.ARTIFACTS.create(body.name, body.opts)), ms: Date.now() - t0 });
					case "import":
						return json({ ...strip(await env.ARTIFACTS.import({ source: body.source, target: { name: body.name } })), ms: Date.now() - t0 });
					case "fork": {
						using repo = await env.ARTIFACTS.get(body.name);
						return json({ ...strip(await repo.fork(body.to, body.opts)), ms: Date.now() - t0 });
					}
					case "info": {
						using repo = await env.ARTIFACTS.get(url.searchParams.get("name")!);
						return json({ ...strip(await repo.info()), ms: Date.now() - t0 });
					}
					case "log": {
						using repo = await env.ARTIFACTS.get(url.searchParams.get("name")!);
						return json(await repo.log({ ref: url.searchParams.get("ref") ?? undefined, limit: 5 }));
					}
					case "list":
						return json(await env.ARTIFACTS.list({ limit: 200 }));
					case "delete":
						return json({ deleted: await env.ARTIFACTS.delete(body.name) });
				}
			}
			return new Response("not found\n", { status: 404 });
		} catch (e) {
			return json({ error: errorText(e), code: (e as any)?.code }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
