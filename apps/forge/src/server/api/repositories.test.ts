import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createDemoPorts } from "@gitflare/testing";
import { demo, demoUsers } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, it } from "vitest";
import type { Services } from "../services";
import { repositoriesApi } from "./repositories";

const REMOTE = "https://git.example.test/git/gitflare";
const { maya, jonas, priya } = demoUsers;

/** The demo deployment: its records in a database and its repositories in the fake git host. */
async function demoServices() {
  const ports = createDemoPorts();
  const db = createTestDb();
  await seedDemo(db);
  const services = { ...ports, db, mode: "dev" } satisfies Services;
  return { ...ports, db, api: repositoriesApi(services) };
}

describe("repositories slice", () => {
  it("lists the repositories with their open changes and active decisions", async () => {
    const { api } = await demoServices();
    const list = await api.list({ user: jonas });
    const atlas = demo.repositories[0];
    expect(list.map((view) => view.repository.slug)).toEqual(["atlas-web", "billing-worker"]);
    expect(list[0]).toEqual({
      repository: atlas,
      // Changes #12 and #13; #11 is merged.
      openChanges: 2,
      activeDecisions: demo.decisions.filter(
        (decision) => decision.repositoryId === atlas?.id && decision.status === "active",
      ).length,
    });
    expect(list[0]?.activeDecisions).toBeGreaterThan(0);
    expect(list[1]).toMatchObject({ openChanges: 0, activeDecisions: 0 });
  });

  it("leaves an archived repository out", async () => {
    const { api, db } = await demoServices();
    await db.update(schema.repositories).set({ archivedAt: 1 });
    expect(await api.list({ user: maya })).toEqual([]);
    await expect(api.get({ user: maya }, { repoSlug: "atlas-web" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("describes a repository with the host's remotes and the main branch's history", async () => {
    const { api } = await demoServices();
    const detail = await api.get({ user: jonas }, { repoSlug: "atlas-web" });
    expect(detail.remote).toBe(`${REMOTE}/atlas-web.git`);
    expect(detail.contextRemote).toBe(`${REMOTE}/atlas-web.context.git`);
    expect(detail.recentCommits.map((commit) => commit.sha)).toEqual([
      demo.git.shas.base,
      demo.git.shas.initial,
    ]);
    expect(detail.openChanges).toBe(2);
    await expect(api.get({ user: jonas }, { repoSlug: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("creates a repository for an administrator only", async () => {
    const { api, git } = await demoServices();
    await expect(
      api.create({ user: jonas }, { slug: "docs", description: "" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const view = await api.create({ user: maya }, { slug: "docs", description: "The handbook." });
    expect(view).toMatchObject({
      repository: { slug: "docs", description: "The handbook.", captureEnabled: true },
      openChanges: 0,
      activeDecisions: 0,
    });
    expect(view.repository.headSha).toBe(await git.resolveRef("docs", "main"));
    expect((await api.list({ user: maya })).map((v) => v.repository.slug)).toContain("docs");
    expect((await api.get({ user: maya }, { repoSlug: "docs" })).remote).toBe(`${REMOTE}/docs.git`);
  });

  it("shows an import as not ready, with nothing to clone yet", async () => {
    const { api, provisioning } = await demoServices();
    const view = await api.create(
      { user: maya },
      { slug: "legacy", description: "", importUrl: "https://example.com/legacy.git" },
    );
    expect(view.repository.readyAt).toBeNull();
    expect(provisioning.imports).toEqual([
      { repositoryId: view.repository.id, url: "https://example.com/legacy.git" },
    ]);
    expect(await api.get({ user: maya }, { repoSlug: "legacy" })).toMatchObject({
      remote: null,
      recentCommits: [],
    });
  });

  it("issues a credential for the caller's own fork and refuses someone else's", async () => {
    const { api, db, git } = await demoServices();
    const remote = `${REMOTE}/${demo.git.repos.forks.review}.git`;
    const credential = await api.gitCredential({ user: jonas }, { remote });
    expect(credential.password).toBe(git.tokens.at(-1)?.secret);
    expect(await db.select().from(schema.gitTokens)).toMatchObject([
      { userId: jonas.id, repoName: demo.git.repos.forks.review, scope: "write" },
    ]);

    await expect(api.gitCredential({ user: priya }, { remote })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await db.select().from(schema.gitTokens)).toHaveLength(1);
  });
});
