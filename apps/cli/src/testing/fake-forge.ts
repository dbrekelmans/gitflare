import { createHash } from "node:crypto";
import { ForgeError, httpStatus, parseRepoName, type User } from "@gitflare/core";
import {
  type ForgeApi,
  type HttpErrorBody,
  httpRoutes,
  type SessionView,
} from "@gitflare/core/api";
import { createFixtureApi } from "@gitflare/testing/fixture-api";

export const FORGE = "https://forge.example.test";
export const TEAM = "https://team.cloudflareaccess.test";
/** Where the fixture's repositories live: `<GIT_HOST>/git/gitflare/<name>.git`. */
export const GIT_HOST = "https://git.example.test";

const ACCESS_TOKEN_SECONDS = 900;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const oauthError = (error: string, status = 400) => json({ error }, status);

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
}

/**
 * A deployment as the CLI sees it over HTTP: the forge's routes (`httpRoutes`)
 * answered by the fixture `ForgeApi`, behind an Access application that
 * speaks Managed OAuth as spec/research/ai-identity.md describes it, PKCE
 * check included. Tokens expire by the clock it is given.
 */
export class FakeForge {
  readonly api: ForgeApi = createFixtureApi();
  /** False for a forge that asks for no login, like `pnpm dev`. */
  protected = true;
  managedOAuth = true;
  /**
   * How Access answers a client without a token when Managed OAuth is off:
   * the live spike's `401` pointing at metadata that has no
   * `registration_endpoint`, or the documented `302` with no metadata.
   */
  withoutManagedOAuth: "401" | "302" = "401";
  /** Every client registration body the CLI sent. */
  readonly registrations: Record<string, unknown>[] = [];
  /** How the next browser visit to the login ends. */
  browser: "approve" | "deny" = "approve";
  /** A token `cloudflared` holds, accepted in the `cf-access-token` header. */
  cloudflaredToken: string | null = null;
  /** How many polls find a new session's fork still being copied. */
  forkReadyAfterReads = 0;
  /** Repositories whose import has not finished. */
  readonly importing = new Set<string>();
  readonly requests: { method: string; url: string; headers: Headers; body: string }[] = [];
  readonly credentialRequests: string[] = [];

  private readonly clients = new Map<string, string[]>();
  private readonly codes = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly pendingForks = new Map<string, number>();
  private counter = 0;
  private refreshHold: { count: number; waiting: (() => void)[] } | null = null;

  constructor(
    readonly user: User,
    private readonly now: () => number,
  ) {}

  /** Ends every grant, as an administrator revoking the session would. */
  revokeEverything(): void {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  /**
   * Holds refresh requests until this many have arrived, then answers them in
   * the order they came: two helpers refreshing at once.
   */
  holdRefreshes(count: number): void {
    this.refreshHold = { count, waiting: [] };
  }

  /** The copies still running finish. */
  finishForks(): void {
    this.pendingForks.clear();
  }

  /** The browser's side of a login: the page Access shows, then the redirect it sends. */
  visit(authorizeUrl: string): URLSearchParams {
    const url = new URL(authorizeUrl);
    const query = url.searchParams;
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    const problem =
      `${url.origin}${url.pathname}` !== `${TEAM}/cdn-cgi/access/oauth/authorization`
        ? "wrong endpoint"
        : query.get("response_type") !== "code"
          ? "unsupported_response_type"
          : !this.clients.get(clientId)?.includes(redirectUri)
            ? "redirect_uri is not registered for this client"
            : query.get("resource") !== FORGE
              ? "invalid_target"
              : query.get("code_challenge_method") !== "S256" || !/^[a-zA-Z0-9]/.test(challenge)
                ? "code_challenge_method must be S256 for public clients"
                : null;
    if (problem) throw new Error(`Access would not show a login page: ${problem}`);

    const answer = new URLSearchParams({ state: query.get("state") ?? "" });
    if (this.browser === "deny") {
      answer.set("error", "access_denied");
      return answer;
    }
    const code = `code-${++this.counter}`;
    this.codes.set(code, { clientId, redirectUri, challenge });
    answer.set("code", code);
    return answer;
  }

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    this.requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    if (url.origin === TEAM) {
      if (new URLSearchParams(body).get("grant_type") === "refresh_token") await this.held();
      return this.access(url, request, body);
    }
    if (url.origin === FORGE) return this.forge(url, request, body);
    throw new Error(`Nothing in this test answers ${request.url}`);
  };

  private async held(): Promise<void> {
    const hold = this.refreshHold;
    if (!hold) return;
    await new Promise<void>((resolve) => {
      hold.waiting.push(resolve);
      if (hold.waiting.length < hold.count) return;
      this.refreshHold = null;
      for (const release of hold.waiting) release();
    });
  }

  private issue(clientId: string): Response {
    const access = `oauth:access-${++this.counter}`;
    const refresh = `oauth:refresh-${++this.counter}`;
    this.accessTokens.set(access, this.now() + ACCESS_TOKEN_SECONDS * 1000);
    this.refreshTokens.set(refresh, clientId);
    return json({
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      scope: "",
      resource: `${FORGE}/`,
      refresh_token: refresh,
    });
  }

  private access(url: URL, request: Request, body: string): Response {
    const base = `${TEAM}/cdn-cgi/access/oauth`;
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: TEAM,
        authorization_endpoint: `${base}/authorization`,
        token_endpoint: `${base}/token`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        ...(this.managedOAuth ? { registration_endpoint: `${base}/registration` } : {}),
      });
    }
    if (url.pathname === "/cdn-cgi/access/oauth/registration" && request.method === "POST") {
      const asked = JSON.parse(body) as {
        redirect_uris?: string[];
        token_endpoint_auth_method?: string;
      };
      this.registrations.push(asked);
      const loopback = (asked.redirect_uris ?? []).every((uri) =>
        ["127.0.0.1", "localhost"].includes(new URL(uri).hostname),
      );
      if (
        !asked.redirect_uris?.length ||
        !loopback ||
        asked.token_endpoint_auth_method !== "none"
      ) {
        return oauthError("invalid_client_metadata");
      }
      const clientId = `client-${++this.counter}`;
      this.clients.set(clientId, asked.redirect_uris);
      return json({ client_id: clientId, redirect_uris: asked.redirect_uris }, 201);
    }
    if (url.pathname === "/cdn-cgi/access/oauth/token" && request.method === "POST") {
      if (request.headers.get("content-type") !== "application/x-www-form-urlencoded") {
        return oauthError("invalid_request");
      }
      const form = new URLSearchParams(body);
      if (form.get("resource") !== FORGE) return oauthError("invalid_target");
      if (form.get("grant_type") === "authorization_code") {
        const grant = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        const valid =
          grant &&
          grant.clientId === form.get("client_id") &&
          grant.redirectUri === form.get("redirect_uri") &&
          grant.challenge === challenge;
        return valid ? this.issue(grant.clientId) : oauthError("invalid_grant");
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        const clientId = this.refreshTokens.get(token);
        if (!clientId || clientId !== form.get("client_id")) return oauthError("invalid_grant");
        // Refresh tokens rotate: the one just used is dead.
        this.refreshTokens.delete(token);
        return this.issue(clientId);
      }
      return oauthError("unsupported_grant_type");
    }
    return new Response("not found", { status: 404 });
  }

  private authenticated(headers: Headers): boolean {
    if (!this.protected) return true;
    const bearer = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
    if (bearer && (this.accessTokens.get(bearer) ?? 0) > this.now()) return true;
    return (
      this.cloudflaredToken !== null && headers.get("cf-access-token") === this.cloudflaredToken
    );
  }

  private async forge(url: URL, request: Request, body: string): Promise<Response> {
    const resource = "/.well-known/cloudflare-access-protected-resource";
    if (url.pathname.startsWith(resource)) {
      return json({ resource: FORGE, protected: true, authorization_servers: [TEAM] });
    }
    if (!this.authenticated(request.headers)) {
      if (!this.managedOAuth && this.withoutManagedOAuth === "302") {
        return new Response(null, {
          status: 302,
          headers: { location: `${TEAM}/cdn-cgi/access/login/forge.example.test` },
        });
      }
      return new Response("<title>401 Unauthorized</title>", {
        status: 401,
        headers: {
          "content-type": "text/html",
          "www-authenticate": `Cloudflare-Access resource_metadata="${FORGE}${resource}${url.pathname}"`,
        },
      });
    }
    try {
      return json(await this.route(url.pathname, request.method, body ? JSON.parse(body) : {}));
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      const answer: HttpErrorBody = { error: { code: error.code, message: error.message } };
      return json(answer, httpStatus(error.code));
    }
  }

  /** A new session's fork is not ready at once; it becomes ready after a few reads. */
  private asProvisioned(view: SessionView): SessionView {
    const left = this.pendingForks.get(view.session.id) ?? 0;
    if (left <= 0) return view;
    this.pendingForks.set(view.session.id, left - 1);
    return { ...view, session: { ...view.session, forkReadyAt: null } };
  }

  private async route(path: string, method: string, body: Record<string, unknown>) {
    const ctx = { user: this.user };
    const segments = path.split("/").filter(Boolean);
    if (path === httpRoutes.me && method === "GET") return this.api.account.me(ctx);
    if (path === httpRoutes.gitCredentials && method === "POST") {
      return this.gitCredential(String(body.remote));
    }
    const [, kind, id, tail] = segments as [string, string, string, string?];
    if (kind === "repos" && !tail && method === "GET") {
      const detail = await this.api.repositories.get(ctx, { repoSlug: id });
      if (!this.importing.has(id)) return detail;
      return { ...detail, repository: { ...detail.repository, readyAt: null } };
    }
    if (kind === "repos" && tail === "sessions" && method === "POST") {
      const view = await this.api.sessions.start(ctx, {
        repoSlug: id,
        kind: body.kind as "local",
        title: String(body.title),
      });
      // The first read is the answer to this request.
      this.pendingForks.set(view.session.id, this.forkReadyAfterReads + 1);
      return this.asProvisioned(view);
    }
    if (kind === "sessions" && !tail && method === "GET") {
      const view = await this.api.sessions.get(ctx, { sessionId: id as `ses_${string}` });
      return this.asProvisioned(view);
    }
    throw new ForgeError("not_found", `No route ${method} ${path}`);
  }

  /**
   * The rule `issueGitCredential` applies: read on a main repository, write on
   * a context repository and on the caller's own ready fork, nothing else. The
   * password says which repository and scope it is for.
   */
  private async gitCredential(remote: string) {
    this.credentialRequests.push(remote);
    const refuse = (): never => {
      throw new ForgeError("forbidden", "You may not use that git remote.");
    };
    const url = new URL(remote);
    const name =
      url.pathname
        .replace(/\.git$/, "")
        .split("/")
        .at(-1) ?? "";
    const repo = parseRepoName(name);
    if (url.origin !== GIT_HOST || !repo) return refuse();
    await this.api.repositories.get({ user: this.user }, { repoSlug: repo.slug });

    let scope = repo.kind === "main" ? "read" : "write";
    if (repo.kind === "fork") {
      const view = await this.api.sessions
        .get({ user: this.user }, { sessionId: repo.sessionId })
        .catch(() => null);
      if (!view || view.session.userId !== this.user.id) return refuse();
      if ((this.pendingForks.get(view.session.id) ?? 0) > 0) {
        throw new ForgeError("not_ready", "The session's fork is still being prepared.");
      }
      scope = "write";
    }
    return {
      username: "gitflare",
      password: `art_v2_${name}_${scope}`,
      expiresAt: this.now() + 3_600_000,
    };
  }
}
