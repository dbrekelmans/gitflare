import type { InstallAnswers } from "./answers.ts";
import { CloudflareApiError } from "./cloudflare.ts";
import type {
  AnswerStore,
  CloudflareApi,
  CommandRunner,
  InstallPorts,
  Prompter,
  ReleaseFiles,
} from "./plan.ts";

type Json = Record<string, unknown>;

/**
 * A Cloudflare account in memory, for tests: the REST API the installer calls,
 * Wrangler, and the release's files. It answers like the documented API: a
 * `404` for what is not there, a `409` for a second create of the same name.
 * A path it does not know fails the test.
 */
export class FakeAccount {
  readonly id = "acct1";

  // What the dashboard, not the installer, decides.
  /** False: the account is not on Workers Paid, and Artifacts refuses. */
  artifacts = true;
  /** The Zero Trust team domain, or null before onboarding. */
  teamDomain: string | null = "acme.cloudflareaccess.com";
  subdomain: string | null = "acme";
  zones: { name: string; status: string }[] = [];
  credits = 25;
  /** Stored provider keys, by gateway. */
  providerKeys: { gateway: string; provider_slug: string; alias: string }[] = [];
  /** Paths the token may not touch. */
  forbidden: RegExp | null = null;
  /** Paths that answer with this status instead: a bad token, a rate limit, an outage. */
  failing: { path: RegExp; status: number } | null = null;
  /**
   * Where `wrangler deploy --message` is recorded. The docs say both; a real
   * account has not been read back, so tests try the version alone too.
   */
  messageOn: "deployment-and-version" | "version" = "deployment-and-version";

  // What the installer creates.
  namespaces: Json[] = [];
  databases: Json[] = [];
  gateways: Json[] = [];
  identityProviders: Json[] = [{ type: "cloudflare", name: "Cloudflare" }];
  apps: Json[] = [];
  /** Newest first, as the API lists them. */
  deployments: Json[] = [];
  versions = new Map<string, Json>();
  migrationsApplied = false;
  files = new Map<string, string>();

  // What was asked of it.
  requests: { method: string; path: string; body?: unknown }[] = [];
  commands: { command: string; args: string[]; env?: Record<string, string> }[] = [];
  writes: string[] = [];

  private ids = 0;

  /** Everything the installer could have changed, for comparing before and after. */
  state() {
    return structuredClone({
      namespaces: this.namespaces,
      databases: this.databases,
      gateways: this.gateways,
      identityProviders: this.identityProviders,
      apps: this.apps,
      deployments: this.deployments,
      versions: [...this.versions],
      migrationsApplied: this.migrationsApplied,
      files: [...this.files],
    });
  }

  /** Requests that were not reads. */
  get mutations() {
    return this.requests.filter((request) => request.method !== "GET");
  }

  forget() {
    this.requests = [];
    this.commands = [];
    this.writes = [];
  }

  readonly api: CloudflareApi = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      this.requests.push({ method, path, body });
      if (this.forbidden?.test(path)) {
        throw new CloudflareApiError(403, [{ code: 10000, message: "Authentication error" }]);
      }
      if (this.failing?.path.test(path)) {
        throw new CloudflareApiError(this.failing.status, [
          { code: 10000, message: `HTTP ${this.failing.status} from the fake` },
        ]);
      }
      return structuredClone(this.route(method, new URL(path, "https://api.test"), body)) as T;
    },
  };

  readonly commandRunner: CommandRunner = {
    run: async (command, args, options) => {
      this.commands.push({ command, args, env: options?.env });
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (command !== "wrangler") throw new Error(`fake: no such command ${command}`);
      if (args[0] === "d1" && args[1] === "migrations" && args[2] === "list") {
        return ok(this.migrationsApplied ? "✅ No migrations to apply!" : "0000_initial.sql");
      }
      if (args[0] === "d1" && args[1] === "migrations" && args[2] === "apply") {
        this.migrationsApplied = true;
        return ok("applied");
      }
      if (args[0] === "deploy" && args.includes("--dry-run")) {
        // The bundle is built from the release's source; the config is not in it.
        const outdir = args[args.indexOf("--outdir") + 1];
        this.files.set(`${outdir}/index.js`, `bundled: ${this.files.get("src/server.ts") ?? ""}`);
        return ok("--dry-run: exiting now.");
      }
      if (args[0] === "deploy") {
        const message = args[args.indexOf("--message") + 1];
        const id = `version-${++this.ids}`;
        const annotations = { "workers/message": message };
        this.versions.set(id, { id, annotations });
        this.deployments.unshift({
          versions: [{ version_id: id, percentage: 100 }],
          ...(this.messageOn === "version" ? {} : { annotations }),
        });
        return ok("deployed");
      }
      throw new Error(`fake: wrangler ${args.join(" ")}`);
    },
  };

  readonly releaseFiles: ReleaseFiles = {
    read: async (name) => this.files.get(name) ?? null,
    write: async (name, text) => {
      this.writes.push(name);
      this.files.set(name, text);
    },
    remove: async (name) => {
      for (const key of this.files.keys()) {
        if (key === name || key.startsWith(`${name}/`)) this.files.delete(key);
      }
    },
    digest: async (directory) =>
      [...this.files]
        .filter(([key]) => key.startsWith(`${directory}/`))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, text]) => `${key}=${text}`)
        .join("\n"),
  };

  private route(method: string, url: URL, body: unknown): unknown {
    const notFound = () => new CloudflareApiError(404, [{ code: 7003, message: "not found" }]);
    const conflict = () => new CloudflareApiError(409, [{ code: 7002, message: "already exists" }]);
    const json = (body ?? {}) as Json;
    const route = `${method} ${url.pathname}`;
    const account = `/accounts/${this.id}`;

    if (route === "GET /zones") {
      const name = url.searchParams.get("name");
      return url.searchParams.get("account.id") === this.id
        ? this.zones.filter((zone) => zone.name === name)
        : [];
    }

    if (url.pathname.startsWith(`${account}/artifacts/`) && !this.artifacts) {
      throw new CloudflareApiError(403, [{ code: 10000, message: "not entitled" }]);
    }
    if (route === `GET ${account}/artifacts/namespaces`) return this.namespaces;
    if (route === `POST ${account}/artifacts/namespaces`) {
      if (this.namespaces.some((ns) => ns.namespace === json.namespace)) throw conflict();
      const created = {
        namespace: json.namespace,
        jurisdiction: json.jurisdiction ?? "unrestricted",
      };
      this.namespaces.push(created);
      return created;
    }
    const namespace = route.match(`^GET ${account}/artifacts/namespaces/([^/]+)$`);
    if (namespace) {
      const found = this.namespaces.find((ns) => ns.namespace === namespace[1]);
      if (!found) throw notFound();
      return found;
    }

    if (route === `GET ${account}/access/organizations`) {
      if (!this.teamDomain) throw notFound();
      return { auth_domain: this.teamDomain, name: "Acme" };
    }
    if (route === `GET ${account}/access/identity_providers`) return this.identityProviders;
    if (route === `POST ${account}/access/identity_providers`) {
      this.identityProviders.push(json);
      return json;
    }
    if (route === `GET ${account}/access/apps`) {
      const name = url.searchParams.get("name");
      return this.apps.filter((app) => name === null || app.name === name);
    }
    if (route === `POST ${account}/access/apps`) {
      if (this.apps.some((app) => app.name === json.name)) throw conflict();
      const id = `app${++this.ids}`;
      const created = { ...json, id, aud: `aud-${id}` };
      this.apps.push(created);
      return created;
    }
    const app = route.match(`^PUT ${account}/access/apps/([^/]+)$`);
    if (app) {
      const index = this.apps.findIndex((app) => app.id === app[1]);
      const existing = this.apps[index];
      if (!existing) throw notFound();
      this.apps[index] = { ...json, id: existing.id, aud: existing.aud };
      return this.apps[index];
    }

    if (route === `GET ${account}/workers/subdomain`) {
      if (!this.subdomain) throw notFound();
      return { subdomain: this.subdomain };
    }
    const script = route.match(`^GET ${account}/workers/scripts/([^/]+)/deployments$`);
    if (script) {
      if (this.deployments.length === 0) throw notFound();
      return { deployments: this.deployments };
    }
    const version = route.match(`^GET ${account}/workers/scripts/([^/]+)/versions/([^/]+)$`);
    if (version) {
      const found = this.versions.get(version[2] ?? "");
      if (!found) throw notFound();
      return found;
    }

    if (route === `GET ${account}/d1/database`) {
      const name = url.searchParams.get("name") ?? "";
      // A substring match, like the real filter.
      return this.databases.filter((db) => String(db.name).includes(name));
    }
    if (route === `POST ${account}/d1/database`) {
      if (this.databases.some((db) => db.name === json.name)) throw conflict();
      const created = { ...json, uuid: `d1-${++this.ids}` };
      this.databases.push(created);
      return created;
    }

    if (route === `GET ${account}/ai-gateway/billing/credit-balance`) {
      return { balance: this.credits, first_topup_success: this.credits > 0 };
    }
    if (route === `POST ${account}/ai-gateway/gateways`) {
      if (this.gateways.some((gateway) => gateway.id === json.id)) throw conflict();
      const created = { ...json, created_at: "2026-10-02", modified_at: "2026-10-02" };
      this.gateways.push(created);
      return created;
    }
    const keys = route.match(`^GET ${account}/ai-gateway/gateways/([^/]+)/provider_configs$`);
    if (keys) {
      return this.providerKeys.filter((key) => key.gateway === keys[1]);
    }
    const one = route.match(`^(GET|PUT) ${account}/ai-gateway/gateways/([^/]+)$`);
    if (one) {
      const index = this.gateways.findIndex((gateway) => gateway.id === one[2]);
      const existing = this.gateways[index];
      if (!existing) throw notFound();
      if (method === "GET") return existing;
      for (const field of ["cache_ttl", "collect_logs", "rate_limiting_limit"]) {
        if (!(field in json)) {
          throw new CloudflareApiError(400, [{ code: 7001, message: `${field} is required` }]);
        }
      }
      // A PUT replaces: what the body leaves out is gone.
      this.gateways[index] = {
        ...json,
        id: existing.id,
        created_at: existing.created_at,
        modified_at: "later",
      };
      return this.gateways[index];
    }

    throw new Error(`fake: no route for ${route}`);
  }
}

/** Answers in the order they are asked for; running out fails the test. */
export function scriptedPrompter(replies: string[] = []) {
  const notes: string[] = [];
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`no scripted reply for: ${question}`);
    return reply;
  };
  const prompt: Prompter = {
    text: async (question, options) => next(question) || (options?.default ?? ""),
    select: async (question, choices) => {
      const reply = next(question);
      const choice = choices.find((c) => c.value === reply);
      if (!choice) throw new Error(`"${reply}" is not a choice for: ${question}`);
      return choice.value;
    },
    confirm: async () => true,
    note: (message) => void notes.push(message),
  };
  return { prompt, notes, asked };
}

export function memoryStore(saved: Partial<InstallAnswers> | null = null) {
  const store: AnswerStore & { saved: Partial<InstallAnswers> | null } = {
    saved,
    load: async () => store.saved,
    save: async (answers) => {
      store.saved = answers;
    },
  };
  return store;
}

export function fakePorts(
  account: FakeAccount,
  saved: Partial<InstallAnswers> | null = null,
  replies: string[] = [],
) {
  const scripted = scriptedPrompter(replies);
  const store = memoryStore(saved);
  const ports: InstallPorts = {
    api: account.api,
    commands: account.commandRunner,
    prompt: scripted.prompt,
    store,
    files: account.releaseFiles,
  };
  return { ports, store, ...scripted };
}
