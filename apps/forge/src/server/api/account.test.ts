import type { ApiContext } from "@gitflare/core/api";
import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock, type RecordingProvisioner } from "@gitflare/testing";
import { describe, expect, it } from "vitest";
import type { Services } from "../services";
import { accountApi } from "./account";

const settings = {
  monthlyBudgetMicroUsd: 1_000_000,
  perChangeBudgetMicroUsd: 100_000,
  models: {
    intent: "m",
    sections: "m",
    review: "m",
    thread: "m",
    decisions: "m",
    session: "m",
    embedding: "m",
    fallbacks: [],
  },
  workspace: { image: "img", snapshot: null },
};

async function setup() {
  const db = createTestDb();
  const clock = new ManualClock();
  const ports = createFakePorts({ clock });
  const services = { db, mode: "dev", ...ports } satisfies Services;

  await db.insert(schema.organisations).values({
    id: "org_000001",
    name: "Acme",
    slug: "acme",
    settings,
    createdAt: clock.now(),
  });
  const admin = {
    id: "usr_admin",
    organisationId: "org_000001",
    subject: "sub-admin",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    createdAt: clock.now(),
    lastSeenAt: null,
  } as const;
  const member = {
    id: "usr_member",
    organisationId: "org_000001",
    subject: "sub-member",
    email: "member@example.com",
    name: "Member",
    role: "member",
    createdAt: clock.now(),
    lastSeenAt: null,
  } as const;
  await db.insert(schema.users).values([admin, member]);

  return { services, admin, member, clock };
}

function ctxFor(user: { id: string; role: string }): ApiContext {
  return { user } as ApiContext;
}

describe("account slice", () => {
  it("me returns the signed-in user, the organisation and the budget", async () => {
    const { services, admin } = await setup();
    const api = accountApi(services as Services);
    const me = await api.me(ctxFor(admin));
    expect(me.user).toEqual(admin);
    expect(me.organisation).toEqual({ id: "org_000001", name: "Acme", slug: "acme" });
    expect(me.budget.budgetMicroUsd).toBe(settings.monthlyBudgetMicroUsd);
    expect(me.budget.spentMicroUsd).toBe(0);
  });

  it("lets an administrator change a member's role", async () => {
    const { services, admin, member } = await setup();
    const api = accountApi(services as Services);
    const updated = await api.setMemberRole(ctxFor(admin), { userId: member.id, role: "admin" });
    expect(updated.role).toBe("admin");
  });

  it("refuses a member changing roles", async () => {
    const { services, admin, member } = await setup();
    const api = accountApi(services as Services);
    await expect(
      api.setMemberRole(ctxFor(member), { userId: admin.id, role: "member" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses demoting the last administrator, including by themselves", async () => {
    const { services, admin } = await setup();
    const api = accountApi(services as Services);
    await expect(
      api.setMemberRole(ctxFor(admin), { userId: admin.id, role: "member" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows demoting an administrator when another one remains", async () => {
    const { services, admin, member } = await setup();
    const api = accountApi(services as Services);
    await api.setMemberRole(ctxFor(admin), { userId: member.id, role: "admin" });
    const demoted = await api.setMemberRole(ctxFor(admin), { userId: admin.id, role: "member" });
    expect(demoted.role).toBe("member");
  });

  it("refuses a member updating settings or preparing the workspace", async () => {
    const { services, member } = await setup();
    const api = accountApi(services as Services);
    await expect(api.updateSettings(ctxFor(member), {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(api.prepareWorkspace(ctxFor(member))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("lets an administrator update settings and prepare the workspace", async () => {
    const { services, admin } = await setup();
    const api = accountApi(services as Services);
    const updated = await api.updateSettings(ctxFor(admin), { perChangeBudgetMicroUsd: 42 });
    expect(updated.perChangeBudgetMicroUsd).toBe(42);
    expect(updated.monthlyBudgetMicroUsd).toBe(settings.monthlyBudgetMicroUsd);

    await api.prepareWorkspace(ctxFor(admin));
    const provisioning = services.provisioning as RecordingProvisioner;
    expect(provisioning.workspacePreparations).toBe(1);
  });

  it("ignores an explicit undefined instead of erasing the field", async () => {
    const { services, admin } = await setup();
    const api = accountApi(services as Services);
    const updated = await api.updateSettings(ctxFor(admin), {
      monthlyBudgetMicroUsd: undefined,
      perChangeBudgetMicroUsd: 7,
    });
    expect(updated.monthlyBudgetMicroUsd).toBe(settings.monthlyBudgetMicroUsd);
    expect(updated.perChangeBudgetMicroUsd).toBe(7);
  });

  it("sums spend by agent and by change for the current month", async () => {
    const { services, admin, clock } = await setup();
    await services.db.insert(schema.changes).values({
      id: "chg_000001",
      repositoryId: "rep_000001",
      sessionId: "ses_000001",
      number: 1,
      title: "Add widgets",
      status: "ready",
      authorId: admin.id,
      headRef: "refs/heads/work",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      headRevisionId: "rev_000001",
      openedAt: clock.now(),
    });
    await services.db.insert(schema.modelCalls).values([
      {
        id: "mdl_000001",
        agent: "review",
        changeId: "chg_000001",
        model: "m",
        requestedModel: "m",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costMicroUsd: 500,
        createdAt: clock.now(),
      },
      {
        id: "mdl_000002",
        agent: "intent",
        changeId: null,
        model: "m",
        requestedModel: "m",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costMicroUsd: 300,
        createdAt: clock.now(),
      },
    ]);

    const api = accountApi(services as Services);
    const budget = await api.budget(ctxFor(admin));
    expect(budget.summary.spentMicroUsd).toBe(800);
    expect(budget.perChangeBudgetMicroUsd).toBe(settings.perChangeBudgetMicroUsd);
    expect(budget.byAgent).toEqual(
      expect.arrayContaining([
        { agent: "review", costMicroUsd: 500 },
        { agent: "intent", costMicroUsd: 300 },
      ]),
    );
    expect(budget.topChanges).toEqual([
      { change: { id: "chg_000001", number: 1, title: "Add widgets" }, costMicroUsd: 500 },
    ]);
  });

  it("skips a model call whose change no longer exists, rather than showing a blank one", async () => {
    const { services, clock } = await setup();
    await services.db.insert(schema.modelCalls).values({
      id: "mdl_000003",
      agent: "review",
      changeId: "chg_dangling",
      model: "m",
      requestedModel: "m",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicroUsd: 999,
      createdAt: clock.now(),
    });

    const api = accountApi(services as Services);
    const budget = await api.budget(ctxFor({ id: "usr_admin", role: "admin" }));
    expect(budget.topChanges).toEqual([]);
    expect(budget.byAgent).toEqual([{ agent: "review", costMicroUsd: 999 }]);
  });
});
