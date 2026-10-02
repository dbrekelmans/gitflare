import { ForgeError } from "@gitflare/core";
import { schema, toDecision } from "@gitflare/db";
import { demo } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { renderDecisionFile } from "./file";
import { reindexDecisions } from "./reindex";
import { retrieveDecisions } from "./retrieve";
import { atlas, demoRecord } from "./testing/setup";

const byId = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

describe("reindexDecisions", () => {
  it("rebuilds the demo's index from the context repo", async () => {
    const { deps, db, repos, git } = await demoRecord();
    await db.delete(schema.decisions);

    expect(await reindexDecisions(deps, atlas.id)).toBe(demo.decisions.length);

    const rows = await db.select().from(schema.decisions);
    expect(byId(rows.map(toDecision))).toEqual(byId(demo.decisions));
    const tip = await git.resolveRef(repos.context, "main");
    for (const row of rows) {
      expect(row.embedding).toHaveLength(32);
      expect(row.embeddingModel).toBe(demo.organisation.settings.models.embedding);
      expect(row.fileSha).toBe(tip);
    }

    // The rebuilt index answers as the original did: nearest first, the dormant one never.
    const found = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: "a counter that is incremented and compared, kept in KV",
      limit: 10,
    });
    expect(found[0]?.decision.id).toBe("dec_counters_in_durable_objects");
    expect(found.map((entry) => entry.decision.id)).not.toContain("dec_moment_for_dates");
  });

  it("lets the files win over an index that disagrees, and leaves history alone", async () => {
    const { deps, db, repos, git } = await demoRecord();
    const [thin] = demo.decisions.filter((d) => d.id === "dec_thin_routes");
    if (!thin) throw new Error("the demo has no thin-routes decision");
    const events = await db.select().from(schema.decisionEvents);

    await db
      .update(schema.decisions)
      .set({ strength: 0.01, status: "dormant", title: "Drifted" })
      .where(eq(schema.decisions.id, thin.id));
    const edited = {
      ...thin,
      statement: "Handlers validate input with zod and call one function.",
    };
    git.push(repos.context, "main", { [thin.path]: renderDecisionFile(edited) });

    await reindexDecisions(deps, atlas.id);
    const [row] = await db.select().from(schema.decisions).where(eq(schema.decisions.id, thin.id));
    expect(row && toDecision(row)).toEqual(edited);
    expect(await db.select().from(schema.decisionEvents)).toEqual(events);
    // It is found by the words in the file, not the words the index had.
    const [nearest] = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: "handlers validate input with zod",
      limit: 1,
    });
    expect(nearest?.decision.id).toBe(thin.id);
  });

  it("does not trust a file's status over its strength", async () => {
    const { deps, db, repos, git } = await demoRecord();
    const [moment] = demo.decisions.filter((d) => d.id === "dec_moment_for_dates");
    if (!moment) throw new Error("the demo has no dormant decision");
    git.push(repos.context, "main", {
      [moment.path]: renderDecisionFile(moment).replace("status: dormant", "status: active"),
    });
    await reindexDecisions(deps, atlas.id);
    const [row] = await db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, moment.id));
    expect(row).toMatchObject({ strength: 0.11, status: "dormant" });
  });

  it("indexes a file it has never seen, and keeps a decision that has no file", async () => {
    const { deps, db, repos, git } = await demoRecord();
    const added = {
      ...(demo.decisions[0] as (typeof demo.decisions)[number]),
      id: "dec_from_a_file" as const,
      path: "decisions/from-a-file.md",
      title: "Written by hand",
    };
    git.push(repos.context, "main", [
      { path: added.path, content: renderDecisionFile(added) },
      { path: "decisions/thin-routes.md", delete: true },
      { path: "decisions/notes.txt", content: "not a decision" },
    ]);

    expect(await reindexDecisions(deps, atlas.id)).toBe(demo.decisions.length);
    const rows = await db.select().from(schema.decisions);
    expect(rows).toHaveLength(demo.decisions.length + 1);
    expect(rows.find((row) => row.id === added.id)).toMatchObject({
      repositoryId: atlas.id,
      title: "Written by hand",
    });
    expect(rows.find((row) => row.id === "dec_thin_routes")).toMatchObject({ strength: 0.74 });
  });

  it("indexes what it can and then fails, naming each file it could not read", async () => {
    const { deps, db, repos, git } = await demoRecord();
    await db.delete(schema.decisions);
    git.push(repos.context, "main", {
      "decisions/broken.md": "# No front matter\n\nJust words.\n",
      "decisions/copy.md": renderDecisionFile(demo.decisions[0] as (typeof demo.decisions)[number]),
    });

    const failure = await reindexDecisions(deps, atlas.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForgeError);
    expect((failure as ForgeError).message).toContain("decisions/broken.md: no front matter");
    expect((failure as ForgeError).message).toMatch(/dec_fixed_windows is also decisions\//);
    expect(await db.select().from(schema.decisions)).toHaveLength(demo.decisions.length);
  });

  it("indexes nothing for a context repo with no decisions", async () => {
    const { deps, db } = await demoRecord();
    const { git } = (await import("@gitflare/testing/demo")).buildDemoGit();
    expect(await reindexDecisions({ ...deps, git, gitWriter: git }, atlas.id)).toBe(0);
    expect(await db.select().from(schema.decisions)).toHaveLength(demo.decisions.length);
  });
});
