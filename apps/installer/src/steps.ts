import { createHash } from "node:crypto";
import type { InstallAnswers } from "./answers.ts";
import { CloudflareApiError, lookup } from "./cloudflare.ts";
import { type DeployValues, renderDeployConfig } from "./config.ts";
import type { InstallStep, StepOutputs } from "./plan.ts";

// Every step looks its resource up by name before creating it. The paths and
// bodies are from spec/research/installer.md, ai-identity.md and
// live/gateway-access.md, checked against Cloudflare's OpenAPI description.

/**
 * What the installer calls the things it creates. Fixed, not asked: it finds
 * its own resources again by these names. One deployment per account.
 */
export const resources = {
  /** The `name` in the forge's deploy config. */
  worker: "gitflare-forge",
  database: "gitflare",
  namespace: "gitflare",
  gateway: "gitflare",
  accessApp: "gitflare",
  accessPolicy: "gitflare members",
  spendRule: "gitflare-monthly",
  /** The forge's deploy config, in the release, with placeholders. */
  template: "wrangler.deploy.jsonc",
  /** The same, filled in. Beside the template: its paths are relative. Never committed. */
  config: "wrangler.gitflare.jsonc",
} as const;

/**
 * A spend rule's window is a number of seconds and a fixed window is the only
 * kind that resets, so "a month" is thirty days.
 */
export const BUDGET_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Dashboard deep links: `:account` lets the dashboard ask which account. */
export const links = {
  apiTokens: "https://dash.cloudflare.com/profile/api-tokens",
  workersPlans: "https://dash.cloudflare.com/?to=/:account/workers/plans",
  workersSubdomain: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
  zeroTrust: "https://one.dash.cloudflare.com/",
  aiGateway: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
  addDomain: "https://dash.cloudflare.com/?to=/:account/add-site",
} as const;

function need(outputs: StepOutputs, key: string): string {
  const value = outputs[key];
  if (value === undefined) throw new Error(`no earlier step reported ${key}`);
  return value;
}

/** The include rules of the Access policy: the allowed domains and addresses, and always the first administrator. */
export function accessRules(answers: InstallAnswers): Record<string, unknown>[] {
  const domains = answers.access.emailDomains.map((domain) => domain.toLowerCase());
  const emails = new Set(answers.access.emails.map((email) => email.toLowerCase()));
  const admin = answers.firstAdminEmail.toLowerCase();
  if (!domains.includes(admin.slice(admin.lastIndexOf("@") + 1))) emails.add(admin);
  return [
    ...domains.map((domain) => ({ email_domain: { domain } })),
    ...[...emails].map((email) => ({ email: { email } })),
  ];
}

// ---- preconditions ----

export function artifactsAvailable(answers: InstallAnswers): InstallStep {
  return {
    id: "artifacts-available",
    kind: "check",
    title: "Check the account can use Artifacts (Workers Paid plan)",
    async run({ api }) {
      try {
        await api.request("GET", `/accounts/${answers.accountId}/artifacts/namespaces?limit=1`);
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
        return {
          status: "blocked",
          detail: `Artifacts is not available on this account (${error.message}). It needs the Workers Paid plan, and an API token with Artifacts > Edit.`,
          url: links.workersPlans,
        };
      }
      return { status: "unchanged", detail: "Artifacts is available" };
    },
  };
}

export function zeroTrust(answers: InstallAnswers): InstallStep {
  return {
    id: "zero-trust",
    kind: "check",
    title: "Check Zero Trust is set up (people log in through Cloudflare Access)",
    async run({ api }) {
      const organisation = await lookup<{ auth_domain?: string }>(
        api,
        `/accounts/${answers.accountId}/access/organizations`,
      );
      if (!organisation?.auth_domain) {
        return {
          status: "blocked",
          detail:
            "Zero Trust is not set up on this account. Choose a team name and a plan (the free plan will do).",
          url: links.zeroTrust,
        };
      }
      return {
        status: "unchanged",
        detail: `team domain ${organisation.auth_domain}`,
        outputs: { ACCESS_TEAM_DOMAIN: `https://${organisation.auth_domain}` },
      };
    },
  };
}

export function hostname(answers: InstallAnswers): InstallStep {
  const { accountId, domain } = answers;
  if (domain === null) {
    return {
      id: "hostname",
      kind: "check",
      title: "Find the account's workers.dev address for the forge",
      async run({ api }) {
        const found = await lookup<{ subdomain?: string }>(
          api,
          `/accounts/${accountId}/workers/subdomain`,
        );
        if (!found?.subdomain) {
          return {
            status: "blocked",
            detail: "This account has no workers.dev subdomain yet. Choose one.",
            url: links.workersSubdomain,
          };
        }
        const host = `${resources.worker}.${found.subdomain}.workers.dev`;
        return { status: "unchanged", detail: host, outputs: { HOSTNAME: host } };
      },
    };
  }
  return {
    id: "hostname",
    kind: "check",
    title: `Check ${domain} is on a zone in this account`,
    async run({ api }) {
      // The zone is some suffix of the hostname; ask for each, longest first.
      const labels = domain.split(".");
      for (let from = 0; from <= labels.length - 2; from++) {
        const zone = labels.slice(from).join(".");
        const zones = await api.request<{ name: string; status?: string }[]>(
          "GET",
          `/zones?account.id=${accountId}&name=${encodeURIComponent(zone)}`,
        );
        if (zones.some((z) => z.name === zone && z.status === "active")) {
          return { status: "unchanged", detail: `zone ${zone}`, outputs: { HOSTNAME: domain } };
        }
      }
      return {
        status: "blocked",
        detail: `No active zone in this account covers ${domain}. Add the domain to the account, or run again and leave the hostname empty to use workers.dev.`,
        url: links.addDomain,
      };
    },
  };
}

// ---- models ----

interface SpendRule {
  id?: string;
  limit: number;
  limitType: string;
  window: number;
  technique?: string;
  enabled?: boolean;
}

interface Gateway {
  id: string;
  authentication?: boolean;
  byok_only?: boolean;
  spend_limits?: { enabled?: boolean; rules?: SpendRule[] };
  [setting: string]: unknown;
}

function gatewayPath(answers: InstallAnswers): string {
  return `/accounts/${answers.accountId}/ai-gateway/gateways`;
}

/** An update replaces the gateway's settings, so it sends back what is there. */
function gatewaySettings(existing: Gateway): Record<string, unknown> {
  const { id: _id, created_at: _c, modified_at: _m, is_default: _d, ...settings } = existing;
  return settings;
}

export function gateway(answers: InstallAnswers): InstallStep {
  const byokOnly = answers.billing === "byok";
  return {
    id: "gateway",
    kind: "create",
    title: `Create the AI Gateway "${resources.gateway}" (authenticated, logging on)`,
    async run({ api }) {
      const outputs = { AI_GATEWAY_ID: resources.gateway };
      const existing = await lookup<Gateway>(api, `${gatewayPath(answers)}/${resources.gateway}`);
      if (!existing) {
        await api.request("POST", gatewayPath(answers), {
          id: resources.gateway,
          cache_invalidate_on_update: true,
          cache_ttl: 0,
          collect_logs: true,
          rate_limiting_interval: 0,
          rate_limiting_limit: 0,
          authentication: true,
          byok_only: byokOnly,
        });
        return { status: "done", detail: "created", outputs };
      }
      if (existing.authentication === true && (existing.byok_only ?? false) === byokOnly) {
        return { status: "unchanged", detail: "exists", outputs };
      }
      await api.request("PUT", `${gatewayPath(answers)}/${resources.gateway}`, {
        ...gatewaySettings(existing),
        authentication: true,
        byok_only: byokOnly,
      });
      return { status: "done", detail: "updated its authentication and billing", outputs };
    },
  };
}

export function spendRule(answers: InstallAnswers): InstallStep {
  // No metadata, model or provider dimension: one bucket for the whole deployment.
  const wanted: SpendRule = {
    id: resources.spendRule,
    limitType: "cost",
    limit: answers.monthlyBudgetUsd,
    window: BUDGET_WINDOW_SECONDS,
    technique: "fixed",
    enabled: true,
  };
  return {
    id: "spend-rule",
    kind: "create",
    title: `Limit model spend to $${answers.monthlyBudgetUsd} per 30 days, with one spend rule on the gateway`,
    async run({ api }) {
      const path = `${gatewayPath(answers)}/${resources.gateway}`;
      const existing = await api.request<Gateway>("GET", path);
      const rules = existing.spend_limits?.rules ?? [];
      const current = rules.find((rule) => rule.id === wanted.id);
      const same =
        existing.spend_limits?.enabled === true &&
        current !== undefined &&
        current.limitType === wanted.limitType &&
        current.limit === wanted.limit &&
        current.window === wanted.window &&
        current.technique === wanted.technique &&
        current.enabled !== false;
      if (same) return { status: "unchanged", detail: `$${wanted.limit} per 30 days` };
      await api.request("PUT", path, {
        ...gatewaySettings(existing),
        spend_limits: {
          enabled: true,
          rules: [...rules.filter((rule) => rule.id !== wanted.id), wanted],
        },
      });
      return {
        status: "done",
        detail: current ? `changed to $${wanted.limit} per 30 days` : "created",
      };
    },
  };
}

export function modelBilling(answers: InstallAnswers): InstallStep {
  return {
    id: "model-billing",
    kind: "check",
    title:
      answers.billing === "byok"
        ? "Check the gateway has a stored Anthropic key"
        : "Check the gateway has prepaid credits, or a stored Anthropic key",
    async run({ api }) {
      const keys = await api.request<{ provider_slug: string; alias: string }[]>(
        "GET",
        `${gatewayPath(answers)}/${resources.gateway}/provider_configs`,
      );
      // The AI binding only ever uses the key stored under the `default` alias.
      if (keys.some((key) => key.provider_slug === "anthropic" && key.alias === "default")) {
        return { status: "unchanged", detail: "a stored Anthropic key" };
      }
      if (answers.billing === "byok") {
        return {
          status: "blocked",
          detail: `The gateway has no Anthropic key, so every model call would fail. Add one under AI Gateway > ${resources.gateway} > Provider Keys, with the alias "default".`,
          url: links.aiGateway,
        };
      }
      const credits = await api.request<{ balance: number }>(
        "GET",
        `/accounts/${answers.accountId}/ai-gateway/billing/credit-balance`,
      );
      if (!(credits.balance > 0)) {
        return {
          status: "blocked",
          detail:
            "The account has no AI Gateway credits, so every model call would fail. Load credits under AI Gateway > Credits Available > Manage > Top-up credits.",
          url: links.aiGateway,
        };
      }
      return { status: "unchanged", detail: "prepaid credits" };
    },
  };
}

// ---- storage ----

export function artifactsNamespace(answers: InstallAnswers): InstallStep {
  const { accountId, jurisdiction } = answers;
  return {
    id: "artifacts-namespace",
    kind: "create",
    title: `Create the Artifacts namespace "${resources.namespace}" (jurisdiction: ${jurisdiction}; this cannot be changed later)`,
    async run({ api }) {
      const outputs = { ARTIFACTS_NAMESPACE: resources.namespace };
      const path = `/accounts/${accountId}/artifacts/namespaces`;
      const existing = await lookup<{ jurisdiction?: string }>(
        api,
        `${path}/${resources.namespace}`,
      );
      if (existing) {
        if (existing.jurisdiction !== undefined && existing.jurisdiction !== jurisdiction) {
          throw new Error(
            `the Artifacts namespace "${resources.namespace}" already exists with jurisdiction ${existing.jurisdiction}, not ${jurisdiction}, and a namespace's jurisdiction cannot be changed`,
          );
        }
        return { status: "unchanged", detail: "exists", outputs };
      }
      // Created before any repository: a namespace created implicitly has no jurisdiction.
      await api.request("POST", path, {
        namespace: resources.namespace,
        ...(jurisdiction === "unrestricted" ? {} : { jurisdiction }),
      });
      return { status: "done", detail: "created", outputs };
    },
  };
}

export function database(answers: InstallAnswers): InstallStep {
  const { accountId, jurisdiction } = answers;
  return {
    id: "database",
    kind: "create",
    title: `Create the D1 database "${resources.database}"`,
    async run({ api }) {
      const path = `/accounts/${accountId}/d1/database`;
      const found = await api.request<{ name: string; uuid: string }[]>(
        "GET",
        `${path}?name=${resources.database}`,
      );
      // The `name` filter is not documented as exact.
      const existing = found.find((db) => db.name === resources.database);
      const outputs = (uuid: string) => ({
        D1_DATABASE_NAME: resources.database,
        D1_DATABASE_ID: uuid,
      });
      if (existing)
        return { status: "unchanged", detail: "exists", outputs: outputs(existing.uuid) };
      const created = await api.request<{ uuid: string }>("POST", path, {
        name: resources.database,
        ...(jurisdiction === "unrestricted" ? {} : { jurisdiction }),
      });
      return { status: "done", detail: "created", outputs: outputs(created.uuid) };
    },
  };
}

// ---- who may log in ----

export function oneTimePin(answers: InstallAnswers): InstallStep {
  return {
    id: "one-time-pin",
    kind: "create",
    title: "Add one-time PIN login, so people who are not Cloudflare account members can log in",
    async run({ api }) {
      const path = `/accounts/${answers.accountId}/access/identity_providers`;
      const providers = await api.request<{ type: string }[]>("GET", path);
      if (providers.some((provider) => provider.type === "onetimepin")) {
        return { status: "unchanged", detail: "exists" };
      }
      await api.request("POST", path, {
        name: "One-time PIN login",
        type: "onetimepin",
        config: {},
      });
      return { status: "done", detail: "added" };
    },
  };
}

interface AccessApp {
  id: string;
  name: string;
  aud: string;
  destinations?: { type: string; uri?: string }[];
  policies?: { name?: string; decision?: string; include?: unknown }[];
}

export function accessApplication(answers: InstallAnswers): InstallStep {
  const include = accessRules(answers);
  const who = [...answers.access.emailDomains, ...answers.access.emails].join(", ");
  return {
    id: "access-application",
    kind: "create",
    title: `Protect the forge with an Access application: ${who || answers.firstAdminEmail} may log in`,
    async run({ api }, outputs) {
      const host = need(outputs, "HOSTNAME");
      const path = `/accounts/${answers.accountId}/access/apps`;
      // By hostname, not by Worker: a Worker-level application is documented to refuse WebSockets.
      const wanted = {
        type: "self_hosted",
        name: resources.accessApp,
        session_duration: "24h",
        destinations: [{ type: "public", uri: host }],
        policies: [{ name: resources.accessPolicy, decision: "allow", include }],
      };
      const found = await api.request<AccessApp[]>(
        "GET",
        `${path}?name=${resources.accessApp}&exact=true`,
      );
      const existing = found.find((app) => app.name === resources.accessApp);
      if (!existing) {
        const created = await api.request<AccessApp>("POST", path, wanted);
        return { status: "done", detail: "created", outputs: { ACCESS_AUDIENCE: created.aud } };
      }
      const policy = existing.policies?.find((p) => p.name === resources.accessPolicy);
      const same =
        existing.destinations?.length === 1 &&
        existing.destinations[0]?.uri === host &&
        JSON.stringify(policy?.include) === JSON.stringify(include);
      if (same) {
        return {
          status: "unchanged",
          detail: "exists",
          outputs: { ACCESS_AUDIENCE: existing.aud },
        };
      }
      const updated = await api.request<AccessApp>("PUT", `${path}/${existing.id}`, wanted);
      return {
        status: "done",
        detail: "updated its hostname and who may log in",
        outputs: { ACCESS_AUDIENCE: updated.aud ?? existing.aud },
      };
    },
  };
}

// ---- the Worker ----

export function deployConfig(answers: InstallAnswers): InstallStep {
  return {
    id: "deploy-config",
    kind: "create",
    title: `Write the deploy config, ${resources.config}, from the answers and the resources above`,
    async run({ files }, outputs) {
      const template = await files.read(resources.template);
      if (template === null) throw new Error(`the release has no ${resources.template}`);
      const values: DeployValues = {
        ACCESS_TEAM_DOMAIN: need(outputs, "ACCESS_TEAM_DOMAIN"),
        ACCESS_AUDIENCE: need(outputs, "ACCESS_AUDIENCE"),
        FIRST_ADMIN_EMAIL: answers.firstAdminEmail,
        ORGANISATION_NAME: answers.organisationName,
        AI_GATEWAY_ID: need(outputs, "AI_GATEWAY_ID"),
        ARTIFACTS_NAMESPACE: need(outputs, "ARTIFACTS_NAMESPACE"),
        D1_DATABASE_NAME: need(outputs, "D1_DATABASE_NAME"),
        D1_DATABASE_ID: need(outputs, "D1_DATABASE_ID"),
      };
      const rendered = renderDeployConfig(template, values);
      if ((await files.read(resources.config)) === rendered) {
        return { status: "unchanged", detail: "up to date" };
      }
      await files.write(resources.config, rendered);
      return { status: "done", detail: "written" };
    },
  };
}

/** Wrangler reads the token from the installer's own environment; the account is ours to say. */
function wranglerEnv(answers: InstallAnswers) {
  return { env: { CLOUDFLARE_ACCOUNT_ID: answers.accountId } };
}

export function migrations(answers: InstallAnswers): InstallStep {
  return {
    id: "migrations",
    kind: "deploy",
    title: "Apply the database migrations that have not been applied yet",
    async run({ commands }) {
      const d1 = (verb: string) =>
        commands.run(
          "wrangler",
          ["d1", "migrations", verb, resources.database, "--remote", "--config", resources.config],
          wranglerEnv(answers),
        );
      const listed = await d1("list");
      if (listed.exitCode !== 0) {
        throw new Error(`wrangler d1 migrations list failed: ${listed.stderr || listed.stdout}`);
      }
      // Anything else, a wording change included, falls through to `apply`, which is safe to repeat.
      if (/no migrations to apply/i.test(listed.stdout)) {
        return { status: "unchanged", detail: "nothing to apply" };
      }
      const applied = await d1("apply");
      if (applied.exitCode !== 0) {
        throw new Error(`wrangler d1 migrations apply failed: ${applied.stderr || applied.stdout}`);
      }
      return { status: "done", detail: "applied" };
    },
  };
}

interface Deployments {
  deployments?: { annotations?: { "workers/message"?: string } }[];
}

export function deployWorker(answers: InstallAnswers): InstallStep {
  return {
    id: "deploy",
    kind: "deploy",
    title: `Deploy the forge as the Worker "${resources.worker}"${answers.domain ? ` on ${answers.domain}` : ""}`,
    async run({ api, commands, files }, outputs) {
      const host = need(outputs, "HOSTNAME");
      const config = await files.read(resources.config);
      if (config === null) throw new Error(`${resources.config} has not been written`);
      const manifest = await files.read("package.json");
      const version = manifest ? String(JSON.parse(manifest).version) : "unknown";
      // The same release with the same config is the same deployment.
      const fingerprint = createHash("sha256").update(`${version}\n${config}`).digest("hex");
      const message = `gitflare ${version} ${fingerprint.slice(0, 16)}`;

      const found = await lookup<Deployments>(
        api,
        `/accounts/${answers.accountId}/workers/scripts/${resources.worker}/deployments`,
      );
      if (found?.deployments?.[0]?.annotations?.["workers/message"] === message) {
        return { status: "unchanged", detail: `https://${host}` };
      }
      const deployed = await commands.run(
        "wrangler",
        [
          "deploy",
          "--config",
          resources.config,
          "--message",
          message,
          ...(answers.domain ? ["--domain", answers.domain] : []),
        ],
        wranglerEnv(answers),
      );
      if (deployed.exitCode !== 0) {
        throw new Error(`wrangler deploy failed: ${deployed.stderr || deployed.stdout}`);
      }
      return { status: "done", detail: `https://${host}` };
    },
  };
}

// ---- afterwards ----

export function prepareWorkspace(answers: InstallAnswers): InstallStep {
  return {
    id: "prepare-workspace",
    kind: "manual",
    title:
      "Tell the administrator to prepare the workspace in Settings (CI and hosted sessions need it; the installer has no session with the forge)",
    async run(_ports, outputs) {
      return {
        status: "unchanged",
        detail: `Yours to do: open https://${need(outputs, "HOSTNAME")}/settings, log in as ${answers.firstAdminEmail}, and choose "Prepare workspace". Until then CI and hosted sessions cannot start.`,
      };
    },
  };
}
