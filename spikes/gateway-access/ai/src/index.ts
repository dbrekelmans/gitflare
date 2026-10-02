// Throwaway spike: a generic executor over the AI binding so each test is one
// curl with a JSON body instead of a redeploy. Every route needs the shared
// secret (`wrangler secret put SPIKE_KEY`), because each call is real spend.

interface Env {
	AI: any;
	SPIKE_KEY: string;
}

const GATEWAY = "gitflare-spike-g-gw";

function describe(value: unknown): string {
	if (value === null) return "null";
	if (value instanceof ReadableStream) return "ReadableStream";
	if (value instanceof Response) return "Response";
	if (typeof value === "object") return `object:${(value as object).constructor?.name}`;
	return typeof value;
}

function errorShape(e: unknown) {
	const err = e as Record<string, unknown>;
	return {
		thrown: true,
		constructor: (e as object)?.constructor?.name,
		name: err?.name,
		message: err?.message,
		// Anything the binding hangs on the error beyond name/message.
		ownKeys: e && typeof e === "object" ? Object.getOwnPropertyNames(e) : [],
		extra: e && typeof e === "object" ? JSON.parse(JSON.stringify(e)) : undefined,
	};
}

async function responseShape(res: Response) {
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers),
		body: (await res.text()).slice(0, 6000),
	};
}

async function readStream(stream: ReadableStream, limit = 6000) {
	const started = Date.now();
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let chunks = 0;
	let firstChunkMs: number | null = null;
	let firstChunkType = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (firstChunkMs === null) {
			firstChunkMs = Date.now() - started;
			firstChunkType = describe(value);
		}
		chunks++;
		text += typeof value === "string" ? value : decoder.decode(value, { stream: true });
	}
	return { chunks, firstChunkMs, totalMs: Date.now() - started, firstChunkType, bytes: text.length, text: text.slice(0, limit) };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.SPIKE_KEY || request.headers.get("x-spike-key") !== env.SPIKE_KEY) {
			return new Response("forbidden", { status: 403 });
		}
		const op = new URL(request.url).pathname.slice(1);
		const input = request.method === "POST" ? ((await request.json()) as any) : {};
		const gateway = { id: GATEWAY, ...(input.gateway ?? {}) };
		const started = Date.now();
		let out: Record<string, unknown>;

		try {
			if (op === "run") {
				// { model, body, options?, gateway? } -> env.AI.run(model, body, { gateway, ...options })
				const result = await env.AI.run(input.model, input.body, { gateway, ...(input.options ?? {}) });
				const logId = env.AI.aiGatewayLogId;
				out = { returned: describe(result), logId };
				if (result instanceof ReadableStream) out.stream = await readStream(result);
				else if (result instanceof Response) out.response = await responseShape(result);
				else out.result = result;
			} else if (op === "run-nogateway") {
				const result = await env.AI.run(input.model, input.body, input.options ?? {});
				out = { returned: describe(result), logId: env.AI.aiGatewayLogId, result };
			} else if (op === "gateway-run") {
				// { provider, endpoint, headers?, query } -> env.AI.gateway(id).run(...)
				const res: Response = await env.AI.gateway(GATEWAY).run(
					{ provider: input.provider, endpoint: input.endpoint, headers: input.headers ?? {}, query: input.query },
					input.gateway ? { gateway: input.gateway } : undefined,
				);
				out = { returned: describe(res), logId: env.AI.aiGatewayLogId, response: await responseShape(res) };
			} else if (op === "log") {
				// { id, waitMs? } -> poll getLog until cost is a number or the wait runs out
				const deadline = Date.now() + (input.waitMs ?? 0);
				const attempts: unknown[] = [];
				let log: any;
				for (;;) {
					const at = Date.now() - started;
					try {
						log = await env.AI.gateway(GATEWAY).getLog(input.id);
						attempts.push({ at, cost: log?.cost, tokens_in: log?.tokens_in, tokens_out: log?.tokens_out });
						if (typeof log?.cost === "number" && log.cost > 0) break;
					} catch (e) {
						attempts.push({ at, error: (e as Error).message });
					}
					if (Date.now() >= deadline) break;
					await new Promise((r) => setTimeout(r, 500));
				}
				if (log) {
					delete log.request_head;
					delete log.response_head;
				}
				out = { attempts, log };
			} else if (op === "run-and-log") {
				// The path the forge would use: call, read the log id, poll for cost.
				const result = await env.AI.run(input.model, input.body, { gateway, ...(input.options ?? {}) });
				const logId = env.AI.aiGatewayLogId;
				const callMs = Date.now() - started;
				let stream;
				if (result instanceof ReadableStream) stream = await readStream(result, 400);
				const pollStart = Date.now();
				const attempts: unknown[] = [];
				let log: any;
				while (Date.now() - pollStart < (input.waitMs ?? 20000)) {
					const at = Date.now() - pollStart;
					try {
						log = await env.AI.gateway(GATEWAY).getLog(logId);
						attempts.push({ at, cost: log?.cost, tokens_in: log?.tokens_in, tokens_out: log?.tokens_out });
						if (typeof log?.cost === "number" && log.cost > 0) break;
					} catch (e) {
						attempts.push({ at, error: (e as Error).message });
					}
					await new Promise((r) => setTimeout(r, 250));
				}
				out = {
					logId,
					callMs,
					usage: stream ? undefined : result?.usage,
					stream,
					attempts,
					log: log && { cost: log.cost, tokens_in: log.tokens_in, tokens_out: log.tokens_out, model: log.model, provider: log.provider, metadata: log.metadata, cached: log.cached, status_code: log.status_code },
				};
			} else if (op === "concurrent") {
				// Is `env.AI.aiGatewayLogId` safe when two calls overlap? Start a slow
				// and a fast call together, read the property as each resolves, and
				// compare with the `cf-aig-log-id` header of the same response.
				const call = async (tag: string, maxTokens: number) => {
					const res: Response = await env.AI.run(
						input.model,
						{ max_tokens: maxTokens, messages: [{ role: "user", content: `Write ${maxTokens} words about ${tag}.` }] },
						{ gateway: { id: GATEWAY, skipCache: true, metadata: { tag } }, returnRawResponse: true },
					);
					const property = env.AI.aiGatewayLogId;
					await res.text();
					return { tag, header: res.headers.get("cf-aig-log-id"), property, propertyAfterBody: env.AI.aiGatewayLogId };
				};
				const results = await Promise.all([call("slow", 300), call("fast", 5)]);
				const logs = await Promise.all(
					results.map(async (r) => ({ tag: r.tag, headerLogMetadata: (await env.AI.gateway(GATEWAY).getLog(r.header)).metadata })),
				);
				out = { results, logs, propertyAtEnd: env.AI.aiGatewayLogId };
			} else if (op === "url") {
				out = { url: String(await env.AI.gateway(GATEWAY).getUrl(input.provider)).replace(/[0-9a-f]{32}/, "<account-id>") };
			} else {
				return new Response("unknown op", { status: 404 });
			}
		} catch (e) {
			out = { error: errorShape(e), logId: env.AI.aiGatewayLogId };
		}
		return Response.json({ op, ms: Date.now() - started, ...out });
	},
};
