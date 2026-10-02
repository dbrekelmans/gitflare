import {
  type ChangeCapture,
  type ChangeId,
  type CheckpointRef,
  contextRepoName,
  type Push,
  type RepositoryId,
  type Sha,
} from "@gitflare/core";
import type { CapturePort, Clock, GitHost } from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { and, eq, inArray } from "drizzle-orm";
import { readCheckpoint as readCheckpointTree } from "./checkpoint";
import { captureSettingsFiles as buildSettingsFiles } from "./settings";

// @gitflare/capture — reading what Entire's CLI recorded. A commit carries
// `Entire-Checkpoint` trailers; each names a ref in the repository's context
// repo holding the whole session so far. This package finds those refs,
// slices out the part of each transcript that belongs to the change, and
// condenses it for a prompt. Format: spec/research/entire-capture.md.
// Build task: `capture`. Prototype to port: prototypes/derivation/src/transcript.ts.

export interface CaptureDeps {
  db: Db;
  git: GitHost;
  clock: Clock;
}

/**
 * The `CapturePort` the rest of the forge uses, over the functions below.
 * Other packages depend on the port, never on this package.
 */
export function createCapture(deps: CaptureDeps): CapturePort {
  return {
    recordCheckpoint: (repositoryId, checkpointId, push) =>
      recordCheckpointPush(deps, repositoryId, checkpointId, push),
    missingCheckpoints: (changeId) => missingCheckpoints(deps, changeId),
    read: (changeId) => captureChange(deps, changeId),
    condense: (capture) => condense(capture),
    settingsFiles: (input) => captureSettingsFiles(input),
  };
}

// `parseCheckpointTrailers` is in `@gitflare/core`: the pipeline needs it too.

/** Records the new tip of a checkpoint ref. Called for every push the pipeline classifies as `checkpoint`. */
export async function recordCheckpointPush(
  deps: Pick<CaptureDeps, "db" | "clock">,
  repositoryId: RepositoryId,
  checkpointId: string,
  push: Push,
): Promise<CheckpointRef> {
  const { db, clock } = deps;
  const now = clock.now();
  const where = and(
    eq(schema.checkpoints.repositoryId, repositoryId),
    eq(schema.checkpoints.checkpointId, checkpointId),
  );
  const existing = await db.select().from(schema.checkpoints).where(where).limit(1);
  if (existing[0]) {
    await db.update(schema.checkpoints).set({ tipSha: push.after, updatedAt: now }).where(where);
    return { ...existing[0], tipSha: push.after, updatedAt: now };
  }
  const row: CheckpointRef = {
    checkpointId,
    repositoryId,
    ref: push.ref,
    tipSha: push.after,
    firstSeenAt: now,
    updatedAt: now,
  };
  await db.insert(schema.checkpoints).values(row);
  return row;
}

/** Every checkpoint id a change's commits name, in the order its commits carry them, once each. */
async function namedCheckpointIds(db: Db, changeId: ChangeId): Promise<string[]> {
  const rows = await db
    .select({ checkpointIds: schema.changeCommits.checkpointIds })
    .from(schema.changeCommits)
    .where(eq(schema.changeCommits.changeId, changeId))
    .orderBy(schema.changeCommits.position);
  const ids: string[] = [];
  for (const row of rows) {
    for (const id of row.checkpointIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The checkpoints a change's commits name that have not arrived in the context repo yet. */
export async function missingCheckpoints(
  deps: Pick<CaptureDeps, "db">,
  changeId: ChangeId,
): Promise<string[]> {
  const { db } = deps;
  const named = await namedCheckpointIds(db, changeId);
  if (named.length === 0) return [];
  const change = await db
    .select({ repositoryId: schema.changes.repositoryId })
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId))
    .limit(1);
  const repositoryId = change[0]?.repositoryId;
  if (!repositoryId) return named;
  const arrived = await db
    .select({ checkpointId: schema.checkpoints.checkpointId })
    .from(schema.checkpoints)
    .where(
      and(
        eq(schema.checkpoints.repositoryId, repositoryId),
        inArray(schema.checkpoints.checkpointId, named),
      ),
    );
  const arrivedIds = new Set(arrived.map((row) => row.checkpointId));
  return named.filter((id) => !arrivedIds.has(id));
}

async function persistCapturedSessions(db: Db, sessions: ChangeCapture["sessions"]): Promise<void> {
  for (const session of sessions) {
    const row = {
      changeId: session.changeId,
      agentSessionId: session.agentSessionId,
      agent: session.agent,
      model: session.model,
      checkpointIds: session.checkpointIds,
      turnCount: session.turns.length,
      attribution: session.attribution,
    };
    await db
      .insert(schema.capturedSessions)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.capturedSessions.changeId, schema.capturedSessions.agentSessionId],
        set: row,
      });
  }
}

/**
 * Reads the checkpoints behind a change at their current tips, slices each
 * cumulative transcript to the turns this change's commits cover, and stores
 * a `captured_sessions` row per agent session. A change with no checkpoints
 * yields an empty capture, never an error.
 */
export async function captureChange(deps: CaptureDeps, changeId: ChangeId): Promise<ChangeCapture> {
  const { db, git } = deps;
  const named = await namedCheckpointIds(db, changeId);
  if (named.length === 0) return { changeId, sessions: [], missingCheckpointIds: [] };

  const change = await db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId))
    .limit(1);
  const repositoryId = change[0]?.repositoryId;
  if (!repositoryId) return { changeId, sessions: [], missingCheckpointIds: named };

  const repository = await db
    .select({ slug: schema.repositories.slug })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const slug = repository[0]?.slug;
  if (!slug) return { changeId, sessions: [], missingCheckpointIds: named };

  const contextRepo = contextRepoName(slug);
  const refs = await db
    .select()
    .from(schema.checkpoints)
    .where(
      and(
        eq(schema.checkpoints.repositoryId, repositoryId),
        inArray(schema.checkpoints.checkpointId, named),
      ),
    );
  const refByCheckpointId = new Map(refs.map((ref) => [ref.checkpointId, ref]));
  const missingCheckpointIds = named.filter((id) => !refByCheckpointId.has(id));

  // Merging across checkpoints: a later checkpoint of the same agent session
  // only ever contributes its own slice, already sliced by `readCheckpoint`.
  const sessionsById = new Map<string, ChangeCapture["sessions"][number]>();
  for (const checkpointId of named) {
    const ref = refByCheckpointId.get(checkpointId);
    if (!ref) continue;
    const sessions = await readCheckpoint({ git }, contextRepo, ref.tipSha);
    for (const session of sessions) {
      const existing = sessionsById.get(session.agentSessionId);
      if (!existing) {
        sessionsById.set(session.agentSessionId, { ...session, changeId });
        continue;
      }
      existing.turns.push(...session.turns);
      for (const id of session.checkpointIds) {
        if (!existing.checkpointIds.includes(id)) existing.checkpointIds.push(id);
      }
      existing.model = session.model ?? existing.model;
      existing.attribution = session.attribution ?? existing.attribution;
    }
  }

  const sessions = [...sessionsById.values()];
  await persistCapturedSessions(db, sessions);
  return { changeId, sessions, missingCheckpointIds };
}

export interface CondenseOptions {
  maxChars: number;
  maxPromptChars: number;
  maxAssistantChars: number;
}

export const defaultCondenseOptions: CondenseOptions = {
  maxChars: 60_000,
  maxPromptChars: 4_000,
  maxAssistantChars: 1_500,
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? trimmed
    : `${trimmed.slice(0, max)}\n[…${trimmed.length - max} chars elided]`;
}

function condenseSession(
  session: ChangeCapture["sessions"][number],
  options: CondenseOptions,
): string {
  const head = `## session ${session.agentSessionId} (${session.agent})`;
  const body: string[] = [];
  let toolRun: string[] = [];
  const flush = () => {
    if (toolRun.length > 0) {
      body.push(`[tools]\n${toolRun.map((text) => `  - ${clip(text, 300)}`).join("\n")}`);
      toolRun = [];
    }
  };
  for (const turn of session.turns) {
    if (turn.kind === "tool") {
      toolRun.push(turn.text);
      continue;
    }
    flush();
    if (turn.kind === "prompt") body.push(`[user]\n${clip(turn.text, options.maxPromptChars)}`);
    else body.push(`[assistant]\n${clip(turn.text, options.maxAssistantChars)}`);
  }
  flush();
  return [head, ...body].join("\n\n");
}

/**
 * A capture as prompt material: prompts and assistant prose kept, runs of tool
 * calls collapsed to name and target, and the middle elided first when it is
 * too long.
 */
export function condense(
  capture: ChangeCapture,
  options: CondenseOptions = defaultCondenseOptions,
): string {
  const full = capture.sessions.map((session) => condenseSession(session, options)).join("\n\n");
  if (full.length <= options.maxChars) return full;
  // Keep the head and the tail: the opening prompt states the ask, the closing
  // turns state what actually landed. The middle is the most elidable part.
  const keep = Math.floor(options.maxChars / 2);
  return `${full.slice(0, keep)}\n\n[… ${full.length - options.maxChars} chars of mid-session elided …]\n\n${full.slice(-keep)}`;
}

export const captureSettingsFiles = buildSettingsFiles;

/** A checkpoint ref's tree, read at one commit. Exposed for tests and for the review agent's citations. */
export async function readCheckpoint(
  deps: Pick<CaptureDeps, "git">,
  contextRepo: string,
  tipSha: Sha,
): Promise<ChangeCapture["sessions"]> {
  return readCheckpointTree(deps, contextRepo, tipSha);
}
