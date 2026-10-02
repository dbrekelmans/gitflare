import type {
  Approval,
  FileDiff,
  Revision,
  Section,
  SectionId,
  StageInput,
  User,
} from "@gitflare/core";
import type { FileChange } from "@gitflare/core/ports";
import { fromRevision, schema, toSection } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SectionsDeps } from "../stage";

// What the tests in this package start from. Not part of the package.

const change = demoChanges.review;
const BRANCH = "rate-limit-invites";

function revisionOf(number: number): Revision {
  const revision = demo.revisions.find((r) => r.changeId === change.id && r.number === number);
  if (!revision) throw new Error(`the demo's change under review has no revision ${number}`);
  return revision;
}

/** The demo's change under review: two pushes, four sections. */
export const review = {
  change,
  first: revisionOf(1),
  second: revisionOf(2),
  /** The sections as the fixture has them after the second push, in reading order. */
  sections: demo.sections.filter((section) => section.changeId === change.id),
};

/** The fixture's sections as a model would have to reply to produce them, in the order given. */
export function divisionReply(diff: readonly FileDiff[], sections: readonly Section[]) {
  return {
    sections: sections.map(({ title, kind, explanation }) => ({ title, kind, explanation })),
    files: Object.fromEntries(
      diff.map((file) => [
        file.path,
        sections.findIndex((section) => section.files.some((f) => f.path === file.path)) + 1,
      ]),
    ),
  };
}

/**
 * The demo deployment, wound back to the moment its change under review was
 * first pushed: the first revision is the head, and nothing has been
 * sectioned or approved yet.
 */
export async function demoAtFirstPush() {
  const db = createTestDb();
  await seedDemo(db);
  const { git, repos } = buildDemoGit();
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  ports.capture.set({
    changeId: change.id,
    sessions: demo.capturedSessions.filter((session) => session.changeId === change.id),
    missingCheckpointIds: [],
  });
  const { capture, diffs, models, live, clock, ids } = ports;
  const deps: SectionsDeps = { db, capture, diffs, models, live, clock, ids };

  await db.delete(schema.sections).where(eq(schema.sections.changeId, change.id));
  await db.delete(schema.approvals).where(eq(schema.approvals.changeId, change.id));

  /** Makes a revision the change's head, as `handlePush` does. */
  const head = (revision: Pick<Revision, "id" | "headSha">) =>
    db
      .update(schema.changes)
      .set({ headRevisionId: revision.id, headSha: revision.headSha })
      .where(eq(schema.changes.id, change.id));
  await head(review.first);

  const [seeded] = await db
    .select({ seq: schema.changes.lastEventSeq })
    .from(schema.changes)
    .where(eq(schema.changes.id, change.id));

  let pushes = 0;
  return {
    db,
    deps,
    ports,
    head,
    input: (revision: Pick<Revision, "id">): StageInput => ({
      changeId: change.id,
      revisionId: revision.id,
      stageRunId: `stg_${revision.id.slice(4)}_sections`,
      attempt: 1,
    }),
    diffAt: (revision: Pick<Revision, "baseSha" | "headSha">) =>
      diffs.between(repos.forks.review, revision.baseSha, revision.headSha),
    /** The change's sections that have not been removed, in reading order. */
    sections: async (): Promise<Section[]> =>
      (
        await db
          .select()
          .from(schema.sections)
          .where(and(eq(schema.sections.changeId, change.id), isNull(schema.sections.removedAt)))
          .orderBy(asc(schema.sections.position))
      ).map(toSection),
    approvals: (): Promise<Approval[]> =>
      db.select().from(schema.approvals).where(eq(schema.approvals.changeId, change.id)),
    /** A person's approval of a section as it stands. */
    approve: async (section: Section, user: User): Promise<Approval> => {
      const approval: Approval = {
        id: ids.next("approval"),
        changeId: change.id,
        sectionId: section.id,
        userId: user.id,
        selfApproval: false,
        contentHash: section.contentHash,
        createdAt: clock.now(),
        withdrawnAt: null,
        withdrawnReason: null,
      };
      await db.insert(schema.approvals).values(approval);
      return approval;
    },
    /** A further push to the change's branch, recorded as its new head revision. */
    push: async (files: FileChange[] | Record<string, string>): Promise<Revision> => {
      const { after } = git.push(repos.forks.review, BRANCH, files, { message: "More work" });
      const revision: Revision = {
        ...review.second,
        id: `rev_test${++pushes}`,
        number: review.second.number + pushes,
        headSha: after,
        pushedAt: clock.now(),
      };
      await db.insert(schema.revisions).values(fromRevision(revision));
      await head(revision);
      return revision;
    },
    /** What the stage has emitted on the change since the test began. */
    events: async () =>
      (
        await db
          .select({ body: schema.changeEvents.body })
          .from(schema.changeEvents)
          .where(
            and(
              eq(schema.changeEvents.changeId, change.id),
              gt(schema.changeEvents.seq, seeded?.seq ?? 0),
            ),
          )
          .orderBy(asc(schema.changeEvents.seq))
      ).map((row) => row.body),
    /** Every row the stage can write, for comparing before and after. */
    snapshot: async () => ({
      sections: await db.select().from(schema.sections),
      approvals: await db.select().from(schema.approvals),
      events: await db.select().from(schema.changeEvents),
    }),
  };
}

export type DemoWorld = Awaited<ReturnType<typeof demoAtFirstPush>>;

/** Looks a section up by the fixture's id for it: the stage gives its sections ids of its own. */
export function fixtureSection(sections: readonly Section[], id: SectionId): Section {
  const path = review.sections.find((section) => section.id === id)?.files[0]?.path;
  const found = sections.find((section) => section.files.some((file) => file.path === path));
  if (!found) throw new Error(`no section presents what the fixture's ${id} does`);
  return found;
}
