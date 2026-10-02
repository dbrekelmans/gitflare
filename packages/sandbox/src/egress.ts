import { ForgeError, type GitTokenScope, type ModelAttribution } from "@gitflare/core";
import {
  type Clock,
  checkStartOptions,
  type EgressGrant,
  type GitHost,
  type SandboxStartOptions,
} from "@gitflare/core/ports";

/**
 * How a sandbox's network is set up. `intercepted`: Internet access is off
 * and every HTTPS request arrives at the forge, which forwards what the
 * grants allow. `open`: Internet access is on and nothing is intercepted,
 * which is what preparing the workspace needs (apt speaks plain HTTP).
 */
export type EgressMode = "open" | "intercepted";

/**
 * The network is open only when the start options ask for it by name
 * (`openInternet`). That excludes every grant: with Internet access on, a
 * container that can reach anything must not also be handed a credential on
 * the way out. A host grant of `*` is refused, not read as "open".
 */
export function egressMode(
  options: Pick<SandboxStartOptions, "egress" | "openInternet">,
): EgressMode {
  checkStartOptions(options);
  return options.openInternet ? "open" : "intercepted";
}

/** Where the forge's own services are, so a request for one can be recognised. */
export interface EgressTargets {
  /** The HTTPS remote of each granted repository, by name, exactly as the git host returned it. */
  gitRemotes: Record<string, string>;
  /** The deployment's AI gateway: `https://<host>/v1/<account>/<gatewayId>/<provider>/<endpoint>`. */
  models?: { host: string; gatewayId: string };
}

/** The credential the forge adds outside the container before forwarding. */
export type EgressCredential =
  | { kind: "git"; repo: string; scope: GitTokenScope }
  | { kind: "models"; attribution: ModelAttribution; provider: string; endpoint: string };

export interface EgressDecision {
  /** Forward the request, with these headers set and these removed. */
  allow: boolean;
  /** Why it was refused. */
  reason?: string;
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
  credential?: EgressCredential;
}

const GIT_SERVICES = ["git-upload-pack", "git-receive-pack"];

/** Headers a container may have set to authenticate itself; none of them is forwarded. */
const CONTAINER_CREDENTIALS = ["authorization", "x-api-key", "cf-aig-authorization"];

function deny(reason: string): EgressDecision {
  return { allow: false, reason };
}

function matchesHost(pattern: string, host: string): boolean {
  const expression = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(host);
}

/** The git remote without a trailing slash, or null when it is not an HTTPS URL. */
function parseRemote(remote: string): URL | null {
  if (!URL.canParse(remote)) return null;
  const url = new URL(remote);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.protocol === "https:" ? url : null;
}

function decideGit(
  grants: EgressGrant[],
  request: { method: string; url: URL },
  remotes: [string, URL][],
): EgressDecision {
  const { method, url } = request;
  const match = remotes.find(
    ([, remote]) => remote.host === url.host && url.pathname.startsWith(`${remote.pathname}/`),
  );
  if (!match) return deny("no grant for this repository");
  const [repo, remote] = match;
  const scopes = grants.flatMap((grant) =>
    grant.kind === "git" && grant.repo === repo ? [grant.scope] : [],
  );
  if (scopes.length === 0) return deny("no grant for this repository");

  // Smart HTTP is two requests per operation: the ref advertisement, then the service itself.
  const path = url.pathname.slice(remote.pathname.length + 1);
  let service: string | null;
  if (path === "info/refs" && method === "GET") service = url.searchParams.get("service");
  else if (GIT_SERVICES.includes(path) && method === "POST") service = path;
  else return deny("not a git smart HTTP request");
  if (service === null || !GIT_SERVICES.includes(service)) return deny("not a git service");

  const scope: GitTokenScope = service === "git-receive-pack" ? "write" : "read";
  if (scope === "write" && !scopes.includes("write")) {
    return deny("this repository is granted for reading only");
  }
  return {
    allow: true,
    removeHeaders: CONTAINER_CREDENTIALS,
    credential: { kind: "git", repo, scope },
  };
}

function decideModels(
  grants: EgressGrant[],
  request: { method: string; url: URL },
  gatewayId: string,
): EgressDecision {
  const grant = grants.find((candidate) => candidate.kind === "models");
  if (!grant) return deny("no grant for model calls");
  const { method, url } = request;
  const [, version, , gateway, provider, ...endpoint] = url.pathname.split("/");
  if (version !== "v1" || gateway !== gatewayId || !provider || endpoint.join("") === "") {
    return deny("not this deployment's model gateway");
  }
  if (method !== "POST") return deny("model calls are POST requests");
  return {
    allow: true,
    removeHeaders: CONTAINER_CREDENTIALS,
    credential: {
      kind: "models",
      attribution: grant.attribution,
      provider,
      endpoint: `${endpoint.join("/")}${url.search}`,
    },
  };
}

/**
 * Decides what happens to one outbound request from a sandbox, given its
 * grants. Pure: the Worker entrypoint that intercepts the traffic calls this
 * (through `forwardEgress`) and then adds the credential the decision names.
 *
 * Nothing leaves that a grant does not cover. A git grant covers the smart
 * HTTP requests of one repository, and pushing only with `write`. A model
 * grant covers POSTs to the deployment's own gateway. A host grant covers
 * reading (GET and HEAD) from hosts matching its pattern, with no credential.
 * The git host and the gateway host are reachable through their own grants
 * only, whatever a host grant says.
 */
export function decideEgress(
  grants: EgressGrant[],
  request: { method: string; url: string },
  targets: EgressTargets = { gitRemotes: {} },
): EgressDecision {
  if (!URL.canParse(request.url)) return deny("not a URL");
  const url = new URL(request.url);
  // A credential added to plain HTTP would cross the Internet unencrypted.
  if (url.protocol !== "https:") return deny("only HTTPS leaves a sandbox");
  const method = request.method.toUpperCase();

  const remotes = Object.entries(targets.gitRemotes).flatMap(([repo, remote]) => {
    const parsed = parseRemote(remote);
    return parsed ? [[repo, parsed] as [string, URL]] : [];
  });
  if (remotes.some(([, remote]) => remote.host === url.host)) {
    return decideGit(grants, { method, url }, remotes);
  }
  if (targets.models && url.host === targets.models.host) {
    return decideModels(grants, { method, url }, targets.models.gatewayId);
  }

  if (method !== "GET" && method !== "HEAD") return deny("a host grant allows GET and HEAD only");
  const granted = grants.some(
    (grant) => grant.kind === "host" && url.port === "" && matchesHost(grant.host, url.hostname),
  );
  return granted ? { allow: true } : deny("no grant for this host");
}

/** Looks up the remote of every repository the grants name, for `decideEgress`. */
export async function resolveEgressTargets(
  deps: { git: Pick<GitHost, "getRepo"> },
  grants: EgressGrant[],
  models?: EgressTargets["models"],
): Promise<EgressTargets> {
  const gitRemotes: Record<string, string> = {};
  for (const grant of grants) {
    if (grant.kind !== "git" || gitRemotes[grant.repo]) continue;
    const repo = await deps.git.getRepo(grant.repo);
    if (!repo) {
      throw new ForgeError("not_found", `The repository ${grant.repo} does not exist.`);
    }
    gitRemotes[grant.repo] = repo.remote;
  }
  return { gitRemotes, models };
}

/** What the intercepting entrypoint is registered with: plain data, fixed when the sandbox starts. */
export interface EgressProps {
  grants: EgressGrant[];
  targets: EgressTargets;
}

/** A model call to make through the gateway on the sandbox's behalf. */
export interface ModelEgressCall {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  attribution: ModelAttribution;
}

export interface EgressDeps {
  /** A token for one repository, as git's Bearer credential. */
  gitToken(repo: string, scope: GitTokenScope): Promise<string>;
  /** Makes the call with the forge's own gateway authorisation. */
  models(call: ModelEgressCall): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}

/** The headers of a model request that reach the provider. Everything else stays behind. */
const MODEL_HEADERS = ["accept", "anthropic-beta", "anthropic-version", "content-type"];

function refuse(status: number, message: string): Response {
  return new Response(`${message}\n`, { status });
}

/**
 * Handles one intercepted request: refuses it with `403`, or forwards it with
 * the credential its grant calls for. A git body is passed through unread, so
 * a pack of any size streams.
 */
export async function forwardEgress(
  deps: EgressDeps,
  props: EgressProps,
  request: Request,
): Promise<Response> {
  const decision = decideEgress(props.grants, request, props.targets);
  if (!decision.allow) return refuse(403, `Forbidden by gitflare: ${decision.reason}.`);

  const headers = new Headers(request.headers);
  for (const name of decision.removeHeaders ?? []) headers.delete(name);
  for (const [name, value] of Object.entries(decision.setHeaders ?? {})) headers.set(name, value);

  const { credential } = decision;
  try {
    if (credential?.kind === "models") {
      const body: unknown = await request.json().catch(() => undefined);
      if (body === undefined) return refuse(400, "A model call needs a JSON body.");
      const forwarded: Record<string, string> = {};
      for (const name of MODEL_HEADERS) {
        const value = headers.get(name);
        if (value !== null) forwarded[name] = value;
      }
      const { attribution, provider, endpoint } = credential;
      return await deps.models({ provider, endpoint, headers: forwarded, body, attribution });
    }
    if (credential?.kind === "git") {
      const token = await deps.gitToken(credential.repo, credential.scope);
      headers.set("Authorization", `Bearer ${token}`);
    }
    return await deps.fetch(new Request(request, { headers }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(502, `gitflare could not forward the request: ${message}`);
  }
}

/** How close to its expiry a token stops being reused. */
const TOKEN_MARGIN_MS = 60_000;

/**
 * `EgressDeps.gitToken` over a function that mints: one token per repository
 * and scope, reused until shortly before it expires, so a clone's handful of
 * requests costs one mint.
 */
export function createGitTokenCache(deps: {
  mint(repo: string, scope: GitTokenScope): Promise<{ secret: string; expiresAt: number }>;
  clock: Clock;
}): EgressDeps["gitToken"] {
  const tokens = new Map<string, Promise<{ secret: string; expiresAt: number }>>();
  return async (repo, scope) => {
    const key = `${scope} ${repo}`;
    const cached = await tokens.get(key)?.catch(() => undefined);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > deps.clock.now()) return cached.secret;
    const minting = deps.mint(repo, scope);
    tokens.set(key, minting);
    return (await minting).secret;
  };
}
