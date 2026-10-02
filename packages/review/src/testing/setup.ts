import type { StageInput, Thread, ThreadId, User } from "@gitflare/core";
import type { ThreadHost } from "@gitflare/core/ports";
import { type Db, fromThreadMessage, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { appendMessage } from "../messages";
import type { ReviewDeps } from "../store";

// What the tests in this package start from: the demo deployment in a seeded
// database, its repositories in the fake git host, its captured session and
// its decisions behind the fake ports. Not part of the package.

export const atlas =
  demo.repositories[0] ??
  (() => {
    throw new Error("the demo has no repository");
  })();

/** Change #13: one commit, one file, pushed and not yet reviewed. */
export const unreviewed: StageInput = {
  changeId: demoChanges.cloud.id,
  revisionId: demoChanges.cloud.headRevisionId,
  stageRunId: "stg_demo13a_review",
  attempt: 1,
};
export const unreviewedPath = "src/audit/export.ts";

export async function demoReview() {
  const db = createTestDb();
  await seedDemo(db);
  const { git, repos } = buildDemoGit();
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  for (const session of demo.capturedSessions) {
    ports.capture.set({
      changeId: session.changeId,
      sessions: [session],
      missingCheckpointIds: [],
    });
  }
  ports.decisions.add(...structuredClone(demo.decisions));
  const deps: ReviewDeps = { ...ports, db };
  /** The thread's writer as the forge wires it, without the Durable Object around it. */
  const writer: ThreadHost = {
    post: (threadId, message) => appendMessage(deps, threadId, message),
  };
  return { db, deps, ports, git, repos, writer };
}

let threads = 0;

/** A thread on the demo's change under review, with these messages in order. */
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
    status: "open",
    finding: { category: "design", severity: "minor", title: "A design point", decisionIds: [] },
    anchor: { path: "src/invites/rate-limit.ts", side: "head", startLine: 12, endLine: 19 },
    anchorRevisionId: "rev_demo12a",
    dismissal: null,
    decisionId: null,
    createdBy: null,
    createdAt: at,
    settledAt: null,
    settledBy: null,
    messageCount: messages.length,
    lastMessageAt: at,
    ...overrides,
  };
  await db.insert(schema.threads).values(thread);
  if (messages.length > 0) {
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
  }
  return id;
}
