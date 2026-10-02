import {
  approvalsWithdrawnByPush,
  type ChangeEventBody,
  type ChangeId,
  defaultModelSettings,
  type FileDiff,
  ForgeError,
  type ModelAttribution,
  type OrganisationId,
  type Section,
  type SectionId,
  SectionKind,
  type StageHandler,
  type StageInput,
  sectionContentHash,
  sectionStats,
  selectDiff,
} from "@gitflare/core";
import {
  type CapturePort,
  type ChangeLive,
  type Clock,
  type DiffPort,
  type IdGenerator,
  ModelError,
  type ModelGateway,
} from "@gitflare/core/ports";
import {
  changeEventStatements,
  type Db,
  publishChangeEvent,
  schema,
  storedChangeEvent,
  toSection,
} from "@gitflare/db";
import { and, asc, eq, isNull, not, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { type FoldResult, foldRevision } from "./fold";
import { changeMaterial, fileMaterial } from "./material";
import { divideMessage, divideSystem, divisionSchema } from "./prompts/divide";
import { newSectionLabel, placeMessage, placementSchema, placeSystem } from "./prompts/place";
import { reviseMessage, reviseSystem, revisionSchema } from "./prompts/revise";
import type { ChangeMaterial, NewSectionText, SectionMaterial } from "./prompts/shared";

const { approvals, changes, organisations, repositories, revisions, sections, sessions } = schema;

export interface SectionsDeps {
  db: Db;
  capture: CapturePort;
  diffs: DiffPort;
  models: ModelGateway;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

/** Room for a title, an explanation and a path per file of a large change. */
const DIVIDE_OUTPUT_TOKENS = 12_000;
const PLACE_OUTPUT_TOKENS = 6_000;
const REVISE_OUTPUT_TOKENS = 6_000;

/** One run of the stage: what it is sectioning, and how it asks a model. */
interface Run {
  deps: SectionsDeps;
  input: StageInput;
  diff: FileDiff[];
  model: string;
  attribution: ModelAttribution;
  /** Read once, and only by a run that asks a model something. */
  material: () => Promise<ChangeMaterial>;
}

async function startRun(deps: SectionsDeps, input: StageInput) {
  const { db } = deps;
  const [change] = await db.select().from(changes).where(eq(changes.id, input.changeId));
  if (!change) throw new ForgeError("not_found", `Change ${input.changeId} does not exist.`);
  const [[revision], [session], [repository]] = await Promise.all([
    db
      .select()
      .from(revisions)
      .where(and(eq(revisions.id, input.revisionId), eq(revisions.changeId, change.id))),
    db.select().from(sessions).where(eq(sessions.id, change.sessionId)),
    db.select().from(repositories).where(eq(repositories.id, change.repositoryId)),
  ]);
  if (!revision) throw new ForgeError("not_found", `Revision ${input.revisionId} does not exist.`);
  if (!session) throw new ForgeError("not_found", `Session ${change.sessionId} does not exist.`);
  if (!repository) {
    throw new ForgeError("not_found", `Repository ${change.repositoryId} does not exist.`);
  }
  return { change, revision, session, repository };
}

async function sectionsModel(db: Db, organisationId: OrganisationId): Promise<string> {
  const [organisation] = await db
    .select({ settings: organisations.settings })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  return (organisation?.settings.models ?? defaultModelSettings).sections;
}

/**
 * Asks the model for one structured reply and validates it here: the gateway
 * does not guarantee the shape it was asked for. A reply that does not
 * validate fails the stage, with a reason a reviewer can read.
 */
async function ask<T>(
  run: Run,
  request: {
    name: string;
    /** Completes "The model's reply could not be used to …". */
    purpose: string;
    schema: z.ZodType<T>;
    system: string;
    message: string;
    maxOutputTokens: number;
  },
): Promise<T> {
  const unusable = (detail: string) =>
    new ModelError(
      "invalid_output",
      `The model's reply could not be used to ${request.purpose}. Re-run the stage to ask again. (${detail.slice(0, 400)})`,
    );
  let output: unknown;
  try {
    const reply = await run.deps.models.generate({
      model: run.model,
      system: request.system,
      messages: [{ role: "user", content: request.message }],
      maxOutputTokens: request.maxOutputTokens,
      attribution: run.attribution,
      output: { name: request.name, schema: request.schema },
    });
    output = reply.output;
  } catch (error) {
    if (error instanceof ModelError && error.code === "invalid_output") {
      throw unusable(error.message);
    }
    throw error;
  }
  const parsed = request.schema.safeParse(output);
  if (!parsed.success) throw unusable(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Behaviour first, mechanical last; within a kind, the order given. */
function inReadingOrder<T extends { kind: SectionKind }>(items: readonly T[]): T[] {
  const rank = (item: T) => SectionKind.options.indexOf(item.kind);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function rehashed(section: Section, diff: readonly FileDiff[]): Section {
  const contentHash = sectionContentHash(diff, section.files);
  return contentHash === section.contentHash ? section : { ...section, contentHash };
}

function newSection(run: Run, text: NewSectionText): Section {
  return {
    id: run.deps.ids.next("section"),
    changeId: run.input.changeId,
    position: 0,
    title: text.title,
    kind: text.kind,
    explanation: text.explanation,
    files: [],
    contentHash: "",
    createdRevisionId: run.input.revisionId,
    updatedRevisionId: run.input.revisionId,
  };
}

/** The first division of a change: the model groups whole files and explains each group. */
async function divide(run: Run): Promise<Section[]> {
  const { diff } = run;
  const division = await ask(run, {
    name: "section_division",
    purpose: "divide this change into sections",
    schema: divisionSchema(diff.map((file) => file.path)),
    system: divideSystem,
    message: divideMessage({
      change: await run.material(),
      files: fileMaterial(run.deps.diffs, diff),
    }),
    maxOutputTokens: DIVIDE_OUTPUT_TOKENS,
  });
  const drafts = division.sections.map((text, index) => ({
    ...newSection(run, text),
    files: diff
      .filter((file) => division.files[file.path] === index + 1)
      .map((file) => ({ path: file.path, hunkHashes: [] })),
  }));
  return inReadingOrder(drafts).map((draft, position) => rehashed({ ...draft, position }, diff));
}

/**
 * Gives one section a part of the diff nobody presented. A whole file is
 * taken out of every other section's list first, where it can only be a stale
 * claim on hunks that are gone, so that the file is in one section only.
 */
function present(
  all: readonly Section[],
  target: SectionId,
  part: FileDiff,
  diff: readonly FileDiff[],
): Section[] {
  const whole = part.hunks.length === diff.find((file) => file.path === part.path)?.hunks.length;
  const hashes = part.hunks.map((hunk) => hunk.hash);
  return all.map((section) => {
    let files = section.files;
    if (whole && files.some((file) => file.path === part.path)) {
      files = files.filter((file) => file.path !== part.path);
    }
    if (section.id === target) {
      const named = whole ? -1 : files.findIndex((file) => file.path === part.path);
      files =
        named === -1
          ? [...files, { path: part.path, hunkHashes: whole ? [] : hashes }]
          : files.map((file, index) =>
              index === named ? { ...file, hunkHashes: [...file.hunkHashes, ...hashes] } : file,
            );
    }
    return files === section.files ? section : { ...section, files };
  });
}

/** A section as a prompt shows it: with the files it presents now, not the ones a push took away. */
function describe(section: Section, label: string, diff: readonly FileDiff[]): SectionMaterial {
  const { kind, title, explanation } = section;
  const paths = selectDiff(diff, section.files).map((file) => file.path);
  return { label, kind, title, explanation, paths };
}

/**
 * A later revision: the fold has already decided which sections moved. The
 * model is asked only where the parts no section presents belong, and for new
 * wording for the sections whose content changed. A push that leaves every
 * section as it was asks nothing.
 */
async function refold(
  run: Run,
  before: readonly Section[],
  folded: FoldResult,
): Promise<Section[]> {
  const { diff } = run;
  const { revisionId } = run.input;
  const labels = new Map(folded.sections.map((section, index) => [section.id, `s${index + 1}`]));
  const label = (section: Section) => labels.get(section.id) ?? "";
  let after = folded.sections;

  if (folded.unplaced.length > 0) {
    const placement = await ask(run, {
      name: "section_placement",
      purpose: "place the files this push added",
      schema: placementSchema(
        after.map(label),
        folded.unplaced.map((part) => part.path),
      ),
      system: placeSystem,
      message: placeMessage({
        change: await run.material(),
        sections: after.map((section) => describe(section, label(section), diff)),
        files: fileMaterial(run.deps.diffs, folded.unplaced),
      }),
      maxOutputTokens: PLACE_OUTPUT_TOKENS,
    });
    const created = placement.newSections.map((text) => newSection(run, text));
    const targets = new Map<string, SectionId>([
      ...after.map((section) => [label(section), section.id] as const),
      ...created.map((section, index) => [newSectionLabel(index), section.id] as const),
    ]);
    after = [...after, ...created];
    for (const part of folded.unplaced) {
      const target = targets.get(placement.placements[part.path] ?? "");
      if (!target) throw new Error(`"${part.path}" was placed in a section that does not exist`);
      after = present(after, target, part, diff);
    }
    after = after.map((section) => rehashed(section, diff));
    if (created.length > 0) {
      after = inReadingOrder(after).map((section, position) =>
        section.position === position ? section : { ...section, position },
      );
    }
  }

  const hashBefore = new Map(before.map((section) => [section.id, section.contentHash]));
  const changed = after.filter(
    (section) => labels.has(section.id) && hashBefore.get(section.id) !== section.contentHash,
  );
  if (changed.length === 0) return after;

  const revision = await ask(run, {
    name: "section_revision",
    purpose: "bring the changed sections' explanations up to date",
    schema: revisionSchema(changed.map(label)),
    system: reviseSystem,
    message: reviseMessage({
      change: await run.material(),
      changed: changed.map((section) => ({
        ...describe(section, label(section), diff),
        files: fileMaterial(run.deps.diffs, selectDiff(diff, section.files)),
      })),
      others: after.filter((section) => !changed.includes(section)),
    }),
    maxOutputTokens: REVISE_OUTPUT_TOKENS,
  });
  return after.map((section) => {
    const wording = changed.includes(section) ? revision.sections[label(section)] : undefined;
    return wording ? { ...section, ...wording, updatedRevisionId: revisionId } : section;
  });
}

type SectionRow = typeof sections.$inferSelect;

function liveSections(db: Db, changeId: ChangeId): Promise<SectionRow[]> {
  return db
    .select()
    .from(sections)
    .where(and(eq(sections.changeId, changeId), isNull(sections.removedAt)))
    .orderBy(asc(sections.position));
}

/**
 * The sections as they are stored: listing only the files they present now,
 * so a path a push renamed or reverted does not linger, and numbered from 0
 * without the gaps a removed section leaves.
 */
function tidied(after: readonly Section[], diff: readonly FileDiff[]): Section[] {
  return after.map((section, position) => {
    const files = section.files.filter((file) => selectDiff(diff, [file]).length > 0);
    const tidy = files.length === section.files.length ? section : { ...section, files };
    return tidy.position === position ? tidy : { ...tidy, position };
  });
}

/**
 * The statement that makes a batch fail unless the revision is still the
 * change's head and its live sections are still `before`: it copies the
 * change's row onto itself, which the primary key refuses. A failed statement
 * takes the whole batch back, writes and events alike.
 */
function unlessStill(db: Db, changeId: ChangeId, revisionId: string, before: readonly Section[]) {
  const expected = JSON.stringify(
    before.map((section) => [
      section.id,
      section.position,
      section.contentHash,
      section.updatedRevisionId,
    ]),
  );
  const still = sql`(
    (select ${changes.headRevisionId} from ${changes} where ${changes.id} = ${changeId}) = ${revisionId}
    and (select count(*) from ${sections} where ${sections.changeId} = ${changeId} and ${sections.removedAt} is null) = ${before.length}
    and (select count(*) from json_each(${expected}) as expected join ${sections}
      on ${sections.id} = json_extract(expected.value, '$[0]')
      and ${sections.position} = json_extract(expected.value, '$[1]')
      and ${sections.contentHash} = json_extract(expected.value, '$[2]')
      and ${sections.updatedRevisionId} = json_extract(expected.value, '$[3]')
      and ${sections.removedAt} is null) = ${before.length}
  )`;
  return db.insert(changes).select(
    db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), not(still))),
  );
}

/**
 * Writes what the run changed, with the events that say so, in one batch. A
 * run that changed nothing writes nothing and emits nothing, which is what
 * makes the stage safe to run twice: the second run finds the sections
 * already as it would leave them.
 *
 * A model call takes seconds, and a push or another run of this revision can
 * land in them. So the batch commits only if the revision is still the
 * change's head and the sections are still what the run started from
 * (`unlessStill`). Returns false when a later push won, and the run wrote
 * nothing; throws when another run of this revision did.
 */
async function persist(
  deps: SectionsDeps,
  input: StageInput,
  stored: readonly SectionRow[],
  after: readonly Section[],
  diff: readonly FileDiff[],
): Promise<boolean> {
  const { db } = deps;
  const { changeId, revisionId } = input;
  const now = deps.clock.now();
  const before = stored.map(toSection);
  const known = new Map(stored.map((row) => [row.id, row]));
  const kept = new Set(after.map((section) => section.id));

  const writes: BatchItem<"sqlite">[] = [];
  let sectionsChanged = false;
  for (const section of after) {
    const stats = sectionStats(diff, section.files);
    const row = known.get(section.id);
    if (!row) {
      writes.push(db.insert(sections).values({ ...section, stats }));
      sectionsChanged = true;
      continue;
    }
    const moved = JSON.stringify(toSection(row)) !== JSON.stringify(section);
    // A section stored before sizes were is given its size, without saying the sections changed.
    if (!moved && JSON.stringify(row.stats) === JSON.stringify(stats)) continue;
    const { position, title, kind, explanation, files, contentHash, updatedRevisionId } = section;
    writes.push(
      db
        .update(sections)
        .set({ position, title, kind, explanation, files, contentHash, updatedRevisionId, stats })
        .where(eq(sections.id, section.id)),
    );
    sectionsChanged ||= moved;
  }
  for (const section of before) {
    if (kept.has(section.id)) continue;
    writes.push(db.update(sections).set({ removedAt: now }).where(eq(sections.id, section.id)));
    sectionsChanged = true;
  }

  const standing = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.changeId, changeId), isNull(approvals.withdrawnAt)));
  const events: ChangeEventBody[] = [];
  for (const withdrawal of approvalsWithdrawnByPush(after, standing)) {
    const approval = standing.find((candidate) => candidate.id === withdrawal.approvalId);
    if (!approval) continue;
    writes.push(
      db
        .update(approvals)
        .set({ withdrawnAt: now, withdrawnReason: withdrawal.reason })
        .where(and(eq(approvals.id, approval.id), isNull(approvals.withdrawnAt))),
    );
    events.push({
      type: "section.approval_withdrawn",
      sectionId: withdrawal.sectionId,
      userId: approval.userId,
    });
  }
  if (sectionsChanged) events.push({ type: "sections.updated" });
  if (writes.length === 0) return true;

  // What the run decided was decided about `before`. If the sections are no
  // longer that, another run got there first and these writes would add to its.
  const raced = async () => {
    const [current] = await db
      .select({ head: changes.headRevisionId })
      .from(changes)
      .where(eq(changes.id, changeId));
    if (current?.head !== revisionId) return "superseded";
    const live = (await liveSections(db, changeId)).map(toSection);
    return JSON.stringify(live) === JSON.stringify(before) ? null : "overtaken";
  };
  const overtaken = () =>
    new Error(
      "The change's sections were changed by another run of this stage while this one was working. Re-run the stage.",
    );
  const early = await raced();
  if (early === "superseded") return false;
  if (early === "overtaken") throw overtaken();

  const eventStatements = events.map((body) => changeEventStatements(db, changeId, body, now));
  let results: unknown[];
  try {
    results = await db.batch([
      unlessStill(db, changeId, revisionId, before),
      ...writes,
      ...eventStatements.flat(),
    ]);
  } catch (error) {
    const late = await raced();
    if (late === "superseded") return false;
    if (late === "overtaken") throw overtaken();
    throw error;
  }
  const eventResults = results.slice(1 + writes.length);
  for (const [index, body] of events.entries()) {
    const rows = eventResults[index * 2 + 1] as { seq: number }[];
    await publishChangeEvent(deps.live, storedChangeEvent(changeId, body, now, rows));
  }
  return true;
}

/**
 * The sectioning stage. On a change's first revision it divides the diff. On a
 * later one it folds the new diff into the sections that exist, withdraws the
 * approvals of the sections whose content changed (`approvalsWithdrawnByPush`),
 * and emits the events for both.
 */
export const runSectionsStage: StageHandler<SectionsDeps> = async (deps, input) => {
  const { change, revision, session, repository } = await startRun(deps, input);
  const superseded = { status: "skipped", reason: "A later push replaced this revision." } as const;
  // Folding an older revision over a newer one would move the sections backwards.
  if (change.headRevisionId !== input.revisionId) return superseded;

  const diff = await deps.diffs.between(session.forkRepo, revision.baseSha, revision.headSha);
  const stored = await liveSections(deps.db, change.id);
  const before = stored.map(toSection);
  if (before.length === 0 && diff.length === 0) {
    return {
      status: "skipped",
      reason: "This revision changes no files, so there is nothing to divide.",
    };
  }

  let material: Promise<ChangeMaterial> | undefined;
  const run: Run = {
    deps,
    input,
    diff,
    model: await sectionsModel(deps.db, repository.organisationId),
    attribution: {
      agent: "sections",
      userId: change.authorId,
      repositoryId: repository.id,
      changeId: change.id,
      sessionId: session.id,
    },
    material: () => {
      material ??= changeMaterial(deps, change, repository.slug, input.revisionId);
      return material;
    },
  };

  const folded = foldRevision(before, diff);
  // With no section left standing there is nothing to fold into: the diff is divided afresh.
  const after =
    folded.sections.length > 0
      ? await refold(run, before, folded)
      : diff.length > 0
        ? await divide(run)
        : [];
  return (await persist(deps, input, stored, tidied(after, diff), diff))
    ? { status: "succeeded" }
    : superseded;
};
