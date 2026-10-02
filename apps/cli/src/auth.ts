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
  const parsed = await parseJson(response, schema);
  if (!parsed) {
    throw new CliError(`${what} did not answer as expected (HTTP ${response.status}).`);
  }
  return parsed;
}

async function parseJson<S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S> | null> {
  const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function noManagedOAuth(forge: string): CliError {
  return new CliError(
    `Managed OAuth is not turned on for ${forge}'s Access application. ` +
      `Ask its administrator to enable it, or sign in with \`gitflare login --cloudflared ${forge}\`.`,
  );
}

/**
 * Where the forge's Access application takes logins, found from the forge
 * itself. Null when the forge answers without a login, as it does in local
 * development.
 *
 * Without Managed OAuth, Access is documented to answer a non-browser client
 * with a `302` and no metadata (spec/research/ai-identity.md); the live spike
 * saw a `401` pointing at metadata that has no `registration_endpoint`
 * (spec/research/live/gateway-access.md). Both, and any discovery document
 * that cannot be read, end in the same advice: the `--cloudflared` fallback.
 * Neither answer has been seen with Managed OAuth turned on (live test #12).
 */
async function discover(
  ctx: CliContext,
  forge: string,
): Promise<(z.infer<typeof ServerMetadata> & { registration_endpoint: string }) | null> {
  const probe = await ctx.fetch(`${forge}${httpRoutes.me}`, {
    redirect: "manual",
    headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
  });
  if (probe.ok) return null;
  if (probe.status !== 401 && (probe.status < 300 || probe.status >= 400)) {
    throw new CliError(`${forge} is not answering as a gitflare forge (HTTP ${probe.status}).`);
  }

  const pointer = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "");
  // A redirect to Access's login page, with nothing to discover from.
  if (!pointer?.[1] && probe.status !== 401) throw noManagedOAuth(forge);
  let server = forge;
  if (pointer?.[1]) {
    const resource = await parseJson(
      await ctx.fetch(pointer[1], { headers: { accept: "application/json" } }),
      ResourceMetadata,
    );
    if (!resource) throw noManagedOAuth(forge);
    server = (resource.authorization_servers[0] as string).replace(/\/+$/, "");
  }
  const metadata = await parseJson(
    await ctx.fetch(`${server}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      redirect: "manual",
    }),
    ServerMetadata,
  );
  if (!metadata?.registration_endpoint) throw noManagedOAuth(forge);
  return { ...metadata, registration_endpoint: metadata.registration_endpoint };
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
          // RFC 8707's resource, as the research note's flow sends it at
          // registration too. Unverified: whether Access needs it here or
          // ignores it, as RFC 7591 lets a server do with metadata it does not
          // know (live test #12).
          resource: forge,
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

  if (!options.refresh && fresh(ctx, login)) {
    return { authorization: `Bearer ${login.accessToken}` };
  }
  return { authorization: `Bearer ${await refreshLogin(ctx, forge, login)}` };
}

const fresh = (ctx: CliContext, login: OAuthLogin) =>
  login.expiresAt - EXPIRY_MARGIN_MS > ctx.now();

type OAuthLogin = Extract<Login, { kind: "oauth" }>;

/** How long a refused refresh waits for another helper's rotated login to reach the keychain. */
const ROTATION_WAIT_MS = 2_000;
const ROTATION_POLL_MS = 100;

/**
 * Trades the refresh token for a new access token, and returns it. Refresh
 * tokens rotate, and git runs helpers side by side (a push to a fork also
 * pushes checkpoints to the context repository), so two may spend the same
 * refresh token at once. Access refuses the second; the loser then waits for
 * the winner's login to reach the keychain and goes on with that, rather than
 * reporting the sign-in as ended.
 */
async function refreshLogin(ctx: CliContext, forge: string, used: OAuthLogin): Promise<string> {
  const token = await spendRefreshToken(ctx, forge, used);
  if (token) return token;

  for (let waited = 0; ; waited += ROTATION_POLL_MS) {
    const stored = await readLogin(ctx, forge);
    if (stored?.kind !== "oauth") throw signInAgain(forge);
    if (stored.refreshToken !== used.refreshToken) {
      if (fresh(ctx, stored) && stored.accessToken !== used.accessToken) {
        return stored.accessToken;
      }
      // Rotated, but the access token that came with it will not do either.
      const rotated = await spendRefreshToken(ctx, forge, stored);
      if (rotated) return rotated;
      throw signInAgain(forge);
    }
    if (waited >= ROTATION_WAIT_MS) throw signInAgain(forge);
    await ctx.sleep(ROTATION_POLL_MS);
  }
}

/** The new access token, stored with the refresh token that replaces this one; null if refused. */
async function spendRefreshToken(
  ctx: CliContext,
  forge: string,
  login: OAuthLogin,
): Promise<string | null> {
  const response = await requestToken(ctx, login.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    resource: forge,
  });
  const token = await parseJson(response, TokenResponse);
  if (!token) return null;
  await writeLogin(ctx, forge, {
    ...login,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? login.refreshToken,
    expiresAt: ctx.now() + token.expires_in * 1000,
  });
  return token.access_token;
}
