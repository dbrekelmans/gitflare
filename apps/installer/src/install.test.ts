import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallAnswers } from "./answers.ts";
import { FakeAccount, fakePorts } from "./fakes.ts";
import { runInstall } from "./install.ts";
import { main, parseOptions } from "./main.ts";
import { type InstallPorts, planInstall } from "./plan.ts";
import { BUDGET_WINDOW_SECONDS, links, resources } from "./steps.ts";

const template = readFileSync(
  new URL("../../forge/wrangler.deploy.jsonc", import.meta.url),
  "utf8",
);

function account() {
  const fake = new FakeAccount();
  fake.files.set(resources.template, template);
  fake.files.set("package.json", JSON.stringify({ version: "1.2.3" }));
  return fake;
}

const answers: InstallAnswers = {
  accountId: "acct1",
  organisationName: "Acme",
  domain: null,
  jurisdiction: "eu",
  access: { emailDomains: ["acme.example"], emails: ["guest@other.example"] },
  firstAdminEmail: "ada@acme.example",
  monthlyBudgetUsd: 200,
  billing: "unified",
};

const rulesOf = (fake: FakeAccount) =>
  (fake.gateways[0]?.spend_limits as { rules: { id: string }[] } | undefined)?.rules ?? [];

const token = { CLOUDFLARE_API_TOKEN: "test-token" };
const statuses = (outcome: Awaited<ReturnType<typeof runInstall>>) =>
  Object.fromEntries(outcome.results.map(({ step, result }) => [step.id, result.status]));

afterEach(() => vi.unstubAllGlobals());

describe("--dry-run", () => {
  it("prints every step of the plan, in order, and reaches nothing", async () => {
    const refuse = (what: string) => () => {
      throw new Error(`the dry run reached ${what}`);
    };
    vi.stubGlobal("fetch", refuse("the network"));
    const { prompt, notes } = fakePorts(account());
    const ports: InstallPorts = {
      api: { request: refuse("the API") },
      commands: { run: refuse("a command") },
      files: { read: refuse("the release"), write: refuse("the release") },
      store: { load: async () => answers, save: refuse("the answer store") },
      prompt,
    };

    // No token either: a dry run needs no account.
    expect(await main(parseOptions(["--dry-run"]), ports, {})).toBe(0);

    const steps = planInstall(answers);
    const printed = notes.join("\n").split("\n");
    const lines = steps.map((step) => printed.findIndex((line) => line.endsWith(step.title)));
    expect(lines).not.toContain(-1);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(steps.map((step) => step.id)).toEqual([
      "artifacts-available",
      "zero-trust",
      "hostname",
      "gateway",
      "spend-rule",
      "model-billing",
      "artifacts-namespace",
      "database",
      "one-time-pin",
      "access-application",
      "deploy-config",
      "migrations",
      "deploy",
      "prepare-workspace",
    ]);
  });

  it("asks only for what is not saved", async () => {
    const { ports, asked } = fakePorts(account(), { ...answers, organisationName: undefined }, [
      "Acme",
    ]);
    expect(await main(parseOptions(["--dry-run"]), ports, {})).toBe(0);
    expect(asked).toEqual(["Your organisation's name"]);
  });
});

describe("installing", () => {
  it("creates everything the forge needs and deploys it", async () => {
    const fake = account();
    const { ports, store, notes } = fakePorts(fake);
    store.saved = answers;

    expect(await main(parseOptions([]), ports, token)).toBe(0);

    expect(fake.namespaces).toEqual([{ namespace: "gitflare", jurisdiction: "eu" }]);
    expect(fake.databases).toMatchObject([{ name: "gitflare", jurisdiction: "eu" }]);
    expect(fake.identityProviders.map((idp) => idp.type)).toContain("onetimepin");
    expect(fake.gateways).toMatchObject([
      {
        id: "gitflare",
        authentication: true,
        byok_only: false,
        // Survives the update that added the rule.
        collect_logs: true,
        spend_limits: {
          enabled: true,
          rules: [
            {
              id: "gitflare-monthly",
              limitType: "cost",
              limit: 200,
              window: BUDGET_WINDOW_SECONDS,
              technique: "fixed",
            },
          ],
        },
      },
    ]);
    // One bucket for the deployment: no dimension on the rule.
    const rule = rulesOf(fake)[0];
    expect(rule).not.toHaveProperty("metadata");
    expect(fake.apps).toMatchObject([
      {
        name: "gitflare",
        destinations: [{ type: "public", uri: "gitflare-forge.acme.workers.dev" }],
        policies: [
          {
            decision: "allow",
            include: [
              { email_domain: { domain: "acme.example" } },
              { email: { email: "guest@other.example" } },
            ],
          },
        ],
      },
    ]);

    const config = fake.files.get(resources.config) ?? "";
    expect(config).not.toMatch(/__[A-Z0-9_]+__/);
    expect(config).toContain('"ACCESS_TEAM_DOMAIN": "https://acme.cloudflareaccess.com"');
    expect(config).toContain(`"ACCESS_AUDIENCE": "${fake.apps[0]?.aud}"`);
    expect(config).toContain(`"database_id": "${fake.databases[0]?.uuid}"`);
    expect(config).toContain('"FIRST_ADMIN_EMAIL": "ada@acme.example"');

    expect(fake.migrationsApplied).toBe(true);
    const deploy = fake.commands.at(-1);
    expect(deploy?.args.slice(0, 3)).toEqual(["deploy", "--config", resources.config]);
    expect(deploy?.args).not.toContain("--domain");
    expect(deploy?.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct1" });
    // Access exists before the Worker does.
    expect(fake.deployments).toHaveLength(1);

    // Last of all, what only the administrator can do.
    expect(notes.at(-1)).toContain("https://gitflare-forge.acme.workers.dev/settings");
    expect(notes.at(-1)).toContain("Prepare workspace");
  });

  it("changes nothing on a second run", async () => {
    const fake = account();
    const { ports } = fakePorts(fake);
    const steps = planInstall(answers);

    const first = await runInstall(steps, ports);
    expect(first.blocked).toBeNull();
    expect(Object.values(statuses(first)).filter((status) => status === "done")).toHaveLength(9);
    const before = fake.state();
    fake.forget();

    const second = await runInstall(planInstall(answers), ports);

    expect(second.blocked).toBeNull();
    expect(second.results).toHaveLength(steps.length);
    expect(new Set(Object.values(statuses(second)))).toEqual(new Set(["unchanged"]));
    expect(fake.mutations).toEqual([]);
    expect(fake.writes).toEqual([]);
    // Wrangler was only asked what is left to apply.
    expect(fake.commands.map((command) => command.args.slice(0, 3))).toEqual([
      ["d1", "migrations", "list"],
    ]);
    expect(fake.state()).toEqual(before);
  });

  it("on an upgrade, changes only what the new answers and the new release change", async () => {
    const fake = account();
    const { ports } = fakePorts(fake);
    await runInstall(planInstall(answers), ports);
    fake.forget();

    const budget = await runInstall(planInstall({ ...answers, monthlyBudgetUsd: 500 }), ports);
    expect(Object.entries(statuses(budget)).filter(([, status]) => status === "done")).toEqual([
      ["spend-rule", "done"],
    ]);
    expect(fake.mutations.map((request) => request.method)).toEqual(["PUT"]);
    expect(rulesOf(fake)).toMatchObject([{ id: "gitflare-monthly", limit: 500 }]);

    fake.files.set("package.json", JSON.stringify({ version: "1.3.0" }));
    const release = await runInstall(planInstall({ ...answers, monthlyBudgetUsd: 500 }), ports);
    expect(Object.entries(statuses(release)).filter(([, status]) => status === "done")).toEqual([
      ["deploy", "done"],
    ]);
    expect(fake.deployments).toHaveLength(2);
  });

  it("leaves a spend rule it did not make alone", async () => {
    const fake = account();
    const { ports } = fakePorts(fake);
    const theirs = { id: "per-user", limitType: "cost", limit: 5, window: 3600 };
    fake.gateways.push({
      id: "gitflare",
      authentication: true,
      byok_only: false,
      cache_ttl: 0,
      collect_logs: true,
      rate_limiting_limit: 0,
      spend_limits: { enabled: true, rules: [theirs] },
    });

    await runInstall(planInstall(answers), ports);

    const rules = rulesOf(fake);
    expect(rules.map((rule) => rule.id)).toEqual(["per-user", "gitflare-monthly"]);
  });

  it("deploys to a custom domain when its zone is in the account", async () => {
    const fake = account();
    fake.zones.push({ name: "acme.example", status: "active" });
    const { ports } = fakePorts(fake);

    const outcome = await runInstall(
      planInstall({ ...answers, domain: "git.acme.example" }),
      ports,
    );

    expect(outcome.blocked).toBeNull();
    expect(fake.apps).toMatchObject([{ destinations: [{ uri: "git.acme.example" }] }]);
    const deploy = fake.commands.at(-1)?.args ?? [];
    expect(deploy.slice(deploy.indexOf("--domain"))).toEqual(["--domain", "git.acme.example"]);
  });

  it("lets the first administrator in even when no rule covers them", async () => {
    const fake = account();
    const { ports } = fakePorts(fake);
    await runInstall(
      planInstall({ ...answers, access: { emailDomains: ["other.example"], emails: [] } }),
      ports,
    );
    expect(fake.apps[0]?.policies).toMatchObject([
      {
        include: [
          { email_domain: { domain: "other.example" } },
          { email: { email: "ada@acme.example" } },
        ],
      },
    ]);
  });

  it("refuses a namespace that already has another jurisdiction", async () => {
    const fake = account();
    fake.namespaces.push({ namespace: "gitflare", jurisdiction: "us" });
    const { ports } = fakePorts(fake);
    await expect(runInstall(planInstall(answers), ports)).rejects.toThrow(
      /jurisdiction us, not eu/,
    );
    expect(fake.databases).toEqual([]);
  });
});

describe("a missing precondition stops with a link", () => {
  const cases: {
    name: string;
    step: string;
    url: string;
    with?: Partial<InstallAnswers>;
    arrange: (fake: FakeAccount) => void;
    /** What exists by the time it stops. */
    gateways?: number;
  }[] = [
    {
      name: "the account is not on Workers Paid",
      step: "artifacts-available",
      url: links.workersPlans,
      arrange: (fake) => {
        fake.artifacts = false;
      },
    },
    {
      name: "Zero Trust is not set up",
      step: "zero-trust",
      url: links.zeroTrust,
      arrange: (fake) => {
        fake.teamDomain = null;
      },
    },
    {
      name: "there is no workers.dev subdomain",
      step: "hostname",
      url: links.workersSubdomain,
      arrange: (fake) => {
        fake.subdomain = null;
      },
    },
    {
      name: "the custom domain's zone is not active in the account",
      step: "hostname",
      url: links.addDomain,
      with: { domain: "git.acme.example" },
      arrange: (fake) => {
        fake.zones.push({ name: "acme.example", status: "pending" });
      },
    },
    {
      name: "there are no credits and no stored key",
      step: "model-billing",
      url: links.aiGateway,
      gateways: 1,
      arrange: (fake) => {
        fake.credits = 0;
      },
    },
    {
      name: "billing is by own key and none is stored, whatever the credits",
      step: "model-billing",
      url: links.aiGateway,
      with: { billing: "byok" },
      gateways: 1,
      arrange: (fake) => {
        fake.credits = 100;
      },
    },
    {
      name: "the token may not manage Access",
      step: "one-time-pin",
      url: links.apiTokens,
      gateways: 1,
      arrange: (fake) => {
        fake.forbidden = /\/access\/identity_providers/;
      },
    },
  ];

  it.each(cases)("when $name", async ({ step, url, arrange, gateways = 0, ...rest }) => {
    const fake = account();
    arrange(fake);
    const { ports, store, notes } = fakePorts(fake);
    store.saved = { ...answers, ...rest.with };

    expect(await main(parseOptions(["--yes"]), ports, token)).toBe(1);

    expect(notes.at(-1)).toContain(url);
    expect(notes.at(-1)).toContain("run create-gitflare again");
    // Nothing after the step that stopped was attempted.
    const plan = planInstall(store.saved as InstallAnswers);
    const stoppedAt = plan.findIndex((planned) => planned.id === step);
    const ran = notes.filter((note) => plan.some((planned) => note.includes(`${planned.title}:`)));
    expect(ran).toHaveLength(stoppedAt + 1);
    expect(ran.at(-1)?.startsWith("!")).toBe(true);
    expect(fake.gateways).toHaveLength(gateways);
    expect(fake.apps).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  it("carries on once the precondition is met", async () => {
    const fake = account();
    fake.credits = 0;
    const { ports } = fakePorts(fake);
    expect((await runInstall(planInstall(answers), ports)).blocked?.step.id).toBe("model-billing");

    fake.credits = 10;
    const outcome = await runInstall(planInstall(answers), ports);

    expect(outcome.blocked).toBeNull();
    expect(statuses(outcome)).toMatchObject({ gateway: "unchanged", deploy: "done" });
  });

  it("accepts a stored key in place of credits", async () => {
    const fake = account();
    fake.credits = 0;
    fake.providerKeys.push({ gateway: "gitflare", provider_slug: "anthropic", alias: "default" });
    const { ports } = fakePorts(fake);
    const outcome = await runInstall(planInstall({ ...answers, billing: "byok" }), ports);
    expect(outcome.blocked).toBeNull();
    expect(fake.gateways).toMatchObject([{ byok_only: true }]);
  });

  it("does not take a key under another alias: the binding never uses it", async () => {
    const fake = account();
    fake.credits = 0;
    fake.providerKeys.push({ gateway: "gitflare", provider_slug: "anthropic", alias: "team" });
    const { ports } = fakePorts(fake);
    const outcome = await runInstall(planInstall(answers), ports);
    expect(outcome.blocked?.step.id).toBe("model-billing");
  });

  it("stops before asking anything when there is no API token", async () => {
    const { ports, notes, asked } = fakePorts(account());
    expect(await main(parseOptions([]), ports, {})).toBe(1);
    expect(notes.join("\n")).toContain(links.apiTokens);
    expect(asked).toEqual([]);
  });
});
