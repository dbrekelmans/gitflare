import type { Thread, ThreadId, User } from "@gitflare/core";
import { type Db, fromThreadMessage, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { renderDecisionFile } from "../file";
import type { DecisionsDeps } from "../store";

export const atlas =
  demo.repositories[0] ??
  (() => {
    throw new Error("the demo has no repository");
  })();

/** The demo's decision files, as the context repo holds them. */
export function demoDecisionFiles(): Record<string, string> {
  return Object.fromEntries(demo.decisions.map((d) => [d.path, renderDecisionFile(d)]));
}

/**
 * The demo deployment with its decision record in both places: the index in
 * a seeded database, and the files on the context repo's `main`.
 */
export async function demoRecord() {
  const db = createTestDb();
  await seedDemo(db);
  const { git, repos } = buildDemoGit(demoDecisionFiles());
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  const deps: DecisionsDeps = {
    db,
    git,
    gitWriter: git,
    models: ports.models,
    clock: ports.clock,
    ids: ports.ids,
  };
  const file = (path: string) => git.text(repos.context, "main", path);
  /** How many commits gitflare has made to the context repo's `main`. */
  const commits = () =>
    git.pushes.filter((p) => p.repoName === repos.context && p.ref === "refs/heads/main").length;
  return { db, deps, git, ports, repos, file, commits };
}

let threads = 0;

/** A comment thread on the demo's change under review, with these messages in order. */
export async function addThread(
  db: Db,
  messages: [author: User | "agent", body: string][],
  overrides: Partial<Thread> = {},
): Promise<ThreadId> {
  const id: ThreadId = `thr_test${++threads}`;
  const at = demo.now;
  const thread: Thread = {
    id,
    changeId: demoChanges.review.id,
    sectionId: null,
    kind: "comment",
    origin: "review",
    status: "resolved",
    finding: { category: "design", severity: "minor", title: "A design point", decisionIds: [] },
    anchor: null,
    anchorRevisionId: null,
    dismissal: null,
    decisionId: null,
    createdBy: null,
    createdAt: at,
    settledAt: at,
    settledBy: null,
    messageCount: messages.length,
    lastMessageAt: at,
    ...overrides,
  };
  await db.insert(schema.threads).values(thread);
  await db.insert(schema.threadMessages).values(
    messages.map(([author, body], index) =>
      fromThreadMessage({
        id: `msg_${id.slice(4)}_${index + 1}`,
        threadId: id,
        seq: index + 1,
        author: author === "agent" ? { kind: "agent" } : { kind: "user", userId: author.id },
        body,
        action: null,
        createdAt: at + index,
      }),
    ),
  );
  return id;
}
