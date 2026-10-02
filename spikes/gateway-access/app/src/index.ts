// Throwaway spike: a Worker with static assets, an API route and a Durable
// Object WebSocket, to see what Cloudflare Access hands to Worker code.
// TEAM_DOMAIN (https://<team>.cloudflareaccess.com) and POLICY_AUD are secrets.

import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

interface Env {
	ASSETS: Fetcher;
	ROOM: DurableObjectNamespace<Room>;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
}

// Redact anything that identifies the account or team before echoing it back.
function scrub(value: unknown, env: Env): unknown {
	const team = env.TEAM_DOMAIN ? new URL(env.TEAM_DOMAIN).hostname.split(".")[0] : "";
	let text = JSON.stringify(value) ?? "null";
	if (team) text = text.split(team).join("<team>");
	return JSON.parse(text.replace(/[0-9a-f]{64}/g, "<aud>").replace(/[0-9a-f]{32}/g, "<hex32>"));
}

async function inspect(request: Request, env: Env, ctx: ExecutionContext) {
	const token = request.headers.get("cf-access-jwt-assertion");
	const cookie = request.headers.get("cookie") ?? "";
	const access = (ctx as any).access;
	const out: Record<string, unknown> = {
		headerNames: [...request.headers.keys()].sort(),
		jwtHeaderPresent: token !== null,
		cfAuthorizationCookiePresent: cookie.includes("CF_Authorization="),
		clientSecretHeaderReachedWorker: request.headers.has("cf-access-client-secret"),
		authenticatedUserEmailHeader: request.headers.get("cf-access-authenticated-user-email"),
		ctxAccess: access === undefined ? "undefined" : typeof access,
		ctxKeys: Object.keys(ctx),
	};
	if (access) {
		out.ctxAccessAudMatches = access.aud === env.POLICY_AUD;
		try {
			out.ctxAccessIdentity = await access.getIdentity();
		} catch (e) {
			out.ctxAccessIdentityError = (e as Error).message;
		}
	}
	if (token) {
		out.jwtProtectedHeader = decodeProtectedHeader(token);
		out.jwtClaimsUnverified = decodeJwt(token);
		try {
			const started = Date.now();
			const JWKS = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
			const { payload } = await jwtVerify(token, JWKS, { issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD });
			out.joseVerify = { ok: true, ms: Date.now() - started, claimNames: Object.keys(payload).sort() };
		} catch (e) {
			out.joseVerify = { ok: false, error: (e as Error).name, message: (e as Error).message };
		}
		try {
			const JWKS = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
			await jwtVerify(token, JWKS, { issuer: env.TEAM_DOMAIN, audience: "wrong-audience" });
			out.joseVerifyWrongAud = "accepted (bad)";
		} catch (e) {
			out.joseVerifyWrongAud = `${(e as Error).name}: ${(e as Error).message}`;
		}
	}
	return scrub(out, env);
}

export class Room extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ hello: "from Room", seenByWorker: JSON.parse(request.headers.get("x-spike-inspect") ?? "null") }));
		return new Response(null, { status: 101, webSocket: client });
	}
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		ws.send(`echo:${message}`);
	}
	async webSocketClose(ws: WebSocket, code: number) {
		ws.close(code === 1005 ? 1000 : code);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/whoami") {
			return Response.json(await inspect(request, env, ctx));
		}
		if (url.pathname.startsWith("/ws/")) {
			const seen = (await inspect(request, env, ctx)) as Record<string, unknown>;
			const headers = new Headers(request.headers);
			headers.set("x-spike-inspect", JSON.stringify({ jwtHeaderPresent: seen.jwtHeaderPresent, joseVerify: seen.joseVerify, ctxAccess: seen.ctxAccess }));
			const stub = env.ROOM.get(env.ROOM.idFromName(url.pathname));
			return stub.fetch(new Request(request, { headers }));
		}
		// Only reached for paths listed in run_worker_first that match nothing above.
		return new Response("worker: no route", { status: 404 });
	},
};
