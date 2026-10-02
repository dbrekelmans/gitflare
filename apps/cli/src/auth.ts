import { httpRoutes } from "@gitflare/core/api";
import { z } from "zod";
import { type CliContext, CliError } from "./context.ts";

// Access Managed OAuth: authorisation code with PKCE on a loopback redirect,
// a public client registered on the spot, and a refresh token. The endpoints
// are discovered from the deployment, never assumed. Facts and their
// provenance: spec/research/ai-identity.md, "Cloudflare Access for a CLI".

/** An access token this close to expiring is replaced before it is used. */
const EXPIRY_MARGIN_MS = 30_000;
/** Access's default lifetime, for a token response that names none. */
const DEFAULT_LIFETIME_SECONDS = 900;

const HttpsUrl = z.url({ protocol: /^https$/ });

/** What the keychain holds for one forge, under the forge's origin. */
const Login = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oauth"),
    clientId: z.string(),
    tokenEndpoint: HttpsUrl,
    refreshToken: z.string(),
    accessToken: z.string(),
    expiresAt: z.number(),
  }),
  /** `cloudflared` keeps its own token; this only records that it is the one to ask. */
  z.object({ kind: z.literal("cloudflared") }),
]);
export type Login = z.infer<typeof Login>;

const ResourceMetadata = z.object({ authorization_servers: z.array(HttpsUrl).min(1) });
const ServerMetadata = z.object({
  authorization_endpoint: HttpsUrl,
  token_endpoint: HttpsUrl,
  registration_endpoint: HttpsUrl.optional(),
});
const Registration = z.object({ client_id: z.string().min(1) });
const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().default(DEFAULT_LIFETIME_SECONDS),
  refresh_token: z.string().min(1).optional(),
});

/** A forge is named by its origin. Plain http is for a forge on this machine only. */
export function forgeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`"${input}" is not a URL. A forge is named like https://forge.example.com.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new CliError(`${input} must be an https URL.`);
  }
  return url.origin;
}

export async function readLogin(ctx: CliContext, forge: string): Promise<Login | null> {
  const stored = await ctx.secrets.get(forge);
  if (stored === null) return null;
  try {
    return Login.parse(JSON.parse(stored));
  } catch {
    return null;
  }
}

const writeLogin = (ctx: CliContext, forge: string, login: Login) =>
  ctx.secrets.set(forge, JSON.stringify(login));

function signInAgain(forge: string): CliError {
  return new CliError(
    `Your sign-in to ${forge} has ended. Run \`gitflare login ${forge}\`.`,
    "unauthenticated",
  );
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * A PKCE verifier and its S256 challenge. Access refuses a challenge that
 * begins with `-` or `_`, so such a pair is thrown away.
 */
export async function createPkce(
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32)),
): Promise<{ verifier: string; challenge: string }> {
  for (;;) {
    const verifier = base64url(random());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64url(new Uint8Array(digest));
    if (/^[a-zA-Z0-9]/.test(challenge)) return { verifier, challenge };
  }
}

async function readJson<S extends z.ZodType>(
  response: Response,
  schema: S,
  what: string,
): Promise<z.output<S>> {
  const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new CliError(`${what} did not answer as expected (HTTP ${response.status}).`);
  }
  return parsed.data;
}

/**
 * Where the forge's Access application takes logins, found from the forge
 * itself. Null when the forge answers without a login, as it does in local
 * development.
 */
async function discover(
  ctx: CliContext,
  forge: string,
): Promise<z.infer<typeof ServerMetadata> | null> {
  const probe = await ctx.fetch(`${forge}${httpRoutes.me}`, {
    redirect: "manual",
    headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
  });
  if (probe.ok) return null;
  if (probe.status !== 401 && (probe.status < 300 || probe.status >= 400)) {
    throw new CliError(`${forge} is not answering as a gitflare forge (HTTP ${probe.status}).`);
  }

  const pointer = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "");
  let server = forge;
  if (pointer?.[1]) {
    const resource = await readJson(
      await ctx.fetch(pointer[1], { headers: { accept: "application/json" } }),
      ResourceMetadata,
      `${forge}'s Access application`,
    );
    server = (resource.authorization_servers[0] as string).replace(/\/+$/, "");
  }
  return readJson(
    await ctx.fetch(`${server}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    }),
    ServerMetadata,
    `${forge}'s login`,
  );
}

async function requestToken(
  ctx: CliContext,
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<Response> {
  return ctx.fetch(tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Signs in through the browser and stores the result in the keychain.
 * Returns false when the forge asks for no login at all.
 */
export async function loginWithOAuth(ctx: CliContext, forge: string): Promise<boolean> {
  const server = await discover(ctx, forge);
  if (!server) return false;
  if (!server.registration_endpoint) {
    throw new CliError(
      `Managed OAuth is not turned on for ${forge}'s Access application. ` +
        `Ask its administrator to enable it, or sign in with \`gitflare login --cloudflared ${forge}\`.`,
    );
  }

  const listener = await ctx.listenForRedirect();
  try {
    const registered = await readJson(
      await ctx.fetch(server.registration_endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "gitflare CLI",
          redirect_uris: [listener.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      Registration,
      "Registering the CLI with Access",
    );

    const { verifier, challenge } = await createPkce();
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorize = new URL(server.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: listener.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: forge,
    }).toString();

    ctx.stderr(`Opening your browser to sign in. If it does not open, visit:\n  ${authorize}\n`);
    await ctx.openBrowser(authorize.toString()).catch(() => undefined);

    const answer = await listener.wait();
    const refused = answer.get("error_description") ?? answer.get("error");
    if (refused) throw new CliError(`The sign-in was refused: ${refused}`);
    const code = answer.get("code");
    if (!code || answer.get("state") !== state) {
      throw new CliError("The browser came back without a valid sign-in. Try again.");
    }

    const token = await readJson(
      await requestToken(ctx, server.token_endpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: listener.redirectUri,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource: forge,
      }),
      TokenResponse,
      "Exchanging the sign-in for a token",
    );
    if (!token.refresh_token) {
      throw new CliError(`${forge}'s login returned no refresh token, so the sign-in cannot last.`);
    }
    await writeLogin(ctx, forge, {
      kind: "oauth",
      clientId: registered.client_id,
      tokenEndpoint: server.token_endpoint,
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      expiresAt: ctx.now() + token.expires_in * 1000,
    });
    return true;
  } finally {
    await listener.close();
  }
}

/** The fallback while Managed OAuth is unproven: `cloudflared` does the login and keeps the token. */
export async function loginWithCloudflared(ctx: CliContext, forge: string): Promise<void> {
  const result = await ctx.exec("cloudflared", ["access", "login", forge], { showProgress: true });
  if (result.exitCode === 127) {
    throw new CliError("cloudflared is not installed, and `--cloudflared` signs in through it.");
  }
  if (result.exitCode !== 0) {
    throw new CliError(`cloudflared could not sign in to ${forge}. ${result.stderr.trim()}`.trim());
  }
  await writeLogin(ctx, forge, { kind: "cloudflared" });
}

/**
 * The headers that authenticate a request to the forge: none when there is no
 * login (a local forge needs none). A stale access token is refreshed first,
 * and `refresh` forces that after the forge has refused one.
 */
export async function accessHeaders(
  ctx: CliContext,
  forge: string,
  options: { refresh?: boolean } = {},
): Promise<Record<string, string>> {
  const login = await readLogin(ctx, forge);
  if (!login) return {};

  if (login.kind === "cloudflared") {
    const result = await ctx.exec("cloudflared", ["access", "token", `-app=${forge}`]);
    const token = result.stdout.trim();
    if (result.exitCode !== 0 || !token) throw signInAgain(forge);
    return { "cf-access-token": token };
  }

  if (!options.refresh && login.expiresAt - EXPIRY_MARGIN_MS > ctx.now()) {
    return { authorization: `Bearer ${login.accessToken}` };
  }
  const response = await requestToken(ctx, login.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    resource: forge,
  });
  const token = TokenResponse.safeParse(
    response.ok ? await response.json().catch(() => undefined) : undefined,
  );
  if (!token.success) throw signInAgain(forge);
  await writeLogin(ctx, forge, {
    ...login,
    accessToken: token.data.access_token,
    refreshToken: token.data.refresh_token ?? login.refreshToken,
    expiresAt: ctx.now() + token.data.expires_in * 1000,
  });
  return { authorization: `Bearer ${token.data.access_token}` };
}
