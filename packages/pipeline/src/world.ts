import {
  type ChangeId,
  forkRepoName,
  type Session,
  type StageHandler,
  type StageName,
  sectionContentHash,
  type Thread,
  type User,
} from "@gitflare/core";
import { schema, toChange } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts } from "@gitflare/testing";
import { eq } from "drizzle-orm";
import { handlePush, type PipelineDeps, type PushResult, runStage, settleChange } from "./index";

// What the tests in this package start from: one repository with a main
// branch, three people, and one session with its fork. Not part of the package.

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld() {
  const db = createTestDb();
  const ports = createFakePorts();
  const { git, clock, ids } = ports;
  const deps = { ...ports, db };

  const person = (name: string, role: User["role"]): User => ({
    id: ids.next("user"),
    organisationId: "org_test",
    subject: `test|${name}`,
    email: `${name}@example.com`,
    name,
    role,
    createdAt: clock.now(),
    lastSeenAt: null,
  });
  const author = person("ada", "member");
  const reviewer = person("grace", "member");
  const admin = person("root", "admin");
  await db.insert(schema.users).values([author, reviewer, admin]);

  await git.createRepo("app");
  const base = git.push(
    "app",
    "main",
    { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" },
    { message: "Start" },
  ).after;
  const repository = {
    id: ids.next("repository"),
    organisationId: "org_test" as const,
    slug: "app",
    headSha: base,
    createdAt: clock.now(),
    readyAt: clock.now(),
  };
  await db.insert(schema.repositories).values(repository);

  const startSession = async (user: User = author, title = "Add b"): Promise<Session> => {
    const id = ids.next("session");
    const session: Session = {
      id,
      repositoryId: repository.id,
      userId: user.id,
      kind: "local",
      status: "active",
      title,
      forkRepo: forkRepoName("app", id),
      baseSha: base,
      createdAt: clock.now(),
      forkReadyAt: clock.now(),
      endedAt: null,
      forkDeletedAt: null,
    };
    await git.forkRepo("app", session.forkRepo);
    await db.insert(schema.sessions).values(session);
    return session;
  };
  const session = await startSession();

  return {
    db,
    ports,
    deps,
    author,
    reviewer,
    admin,
    repository,
    base,
    session,
    startSession,
    /** A `git push` of one commit to the session's branch. Returns the event to hand to `handlePush`. */
    push: (files: Record<string, string>, message = "Work", on: Session = session) =>
      git.push(on.forkRepo, "work", files, { message }),
    change: async (changeId: ChangeId) => {
      const [row] = await db.select().from(schema.changes).where(eq(schema.changes.id, changeId));
      if (!row) throw new Error(`no change ${changeId}`);
      return toChange(row);
    },
    stageRuns: (changeId: ChangeId) =>
      db.select().from(schema.stageRuns).where(eq(schema.stageRuns.changeId, changeId)),
    sessionRow: async (id = session.id) => {
      const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id));
      if (!row) throw new Error(`no session ${id}`);
      return row;
    },
  };
}

export const succeed: StageHandler<unknown> = async () => ({ status: "succeeded" });

/** A sectioning stage without a model: one section per changed file, hashed the real way. */
export const sectionPerFile: StageHandler<PipelineDeps> = async (deps, input) => {
  const { db } = deps;
  const [change] = await db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, input.changeId));
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, change?.sessionId ?? "ses_none"));
  if (!change || !session) throw new Error("nothing to section");
  const diff = await deps.diffs.between(session.forkRepo, change.baseSha, change.headSha);
  const existing = await db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.changeId, change.id));
  for (const [position, file] of diff.entries()) {
    const files = [{ path: file.path, hunkHashes: [] }];
    const contentHash = sectionContentHash(diff, files);
    const known = existing.find((section) => section.title === file.path);
    if (known) {
      await db
        .update(schema.sections)
        .set({ contentHash, updatedRevisionId: input.revisionId })
        .where(eq(schema.sections.id, known.id));
    } else {
      await db.insert(schema.sections).values({
        id: deps.ids.next("section"),
        changeId: change.id,
        position,
        title: file.path,
        kind: "behaviour",
        explanation: `What changed in ${file.path}.`,
        files,
        contentHash,
        createdRevisionId: input.revisionId,
        updatedRevisionId: input.revisionId,
      });
    }
  }
  return { status: "succeeded" };
};

/** A review stage that raises one finding on `path`, not yet placed in a section. */
export function findingOn(path: string): StageHandler<PipelineDeps> {
  return async (deps, input) => {
    const thread: Thread = {
      id: deps.ids.next("thread"),
      changeId: input.changeId,
      sectionId: null,
      kind: "comment",
      origin: "review",
      status: "open",
      finding: { category: "correctness", severity: "important", title: "Look", decisionIds: [] },
      anchor: { path, side: "head", startLine: 1, endLine: 1 },
      anchorRevisionId: input.revisionId,
      dismissal: null,
      decisionId: null,
      createdBy: null,
      createdAt: deps.clock.now(),
      settledAt: null,
      settledBy: null,
      learnedAt: null,
      messageCount: 0,
      lastMessageAt: deps.clock.now(),
    };
    await deps.db.insert(schema.threads).values(thread);
    return { status: "succeeded" };
  };
}

/** Runs every queued stage of a push through its handler, settling after each, as the Workflow does. */
export async function runStages(
  world: World,
  result: PushResult,
  handlers: Partial<Record<StageName, StageHandler<PipelineDeps>>> = {},
): Promise<void> {
  if (result.kind !== "change") throw new Error(`the push was ${result.kind}`);
  for (const run of result.stages) {
    await runStage(world.deps, handlers[run.stage] ?? succeed, world.deps, {
      changeId: run.changeId,
      revisionId: run.revisionId,
      stageRunId: run.id,
      attempt: run.attempt,
      stage: run.stage,
    });
    await settleChange(world.deps, run.changeId);
  }
}

/** A change pushed, sectioned and through every stage: `ready`, with one section per file. */
export async function readyChange(
  world: World,
  files: Record<string, string>,
  handlers: Partial<Record<StageName, StageHandler<PipelineDeps>>> = {},
) {
  const result = await handlePush(world.deps, world.push(files));
  if (result.kind !== "change") throw new Error(`the push was ${result.kind}`);
  await runStages(world, result, { sections: sectionPerFile, ...handlers });
  return result;
}
