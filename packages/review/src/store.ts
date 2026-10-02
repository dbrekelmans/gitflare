import {
  type Change,
  type ChangeId,
  type DismissalClass,
  defaultModelSettings,
  type FindingCategory,
  ForgeError,
  type GitSignature,
  type Intent,
  type ModelSettings,
  type Repository,
  type RepositoryId,
  type Revision,
  type RevisionId,
  type Section,
  type Session,
  type SessionId,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type User,
  type UserId,
} from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  DecisionsPort,
  DiffPort,
  GitHost,
  GitWriter,
  IdGenerator,
  ModelGateway,
  ThreadHost,
} from "@gitflare/core/ports";
import {
  type Db,
  schema,
  toChange,
  toRepository,
  toRevision,
  toSection,
  toThreadMessage,
} from "@gitflare/db";
import { asc, desc, eq, inArray } from "drizzle-orm";

export interface ReviewDeps {
  db: Db;
  capture: CapturePort;
  diffs: DiffPort;
  decisions: DecisionsPort;
  git: GitHost;
  gitWriter: GitWriter;
  models: ModelGateway;
  threads: ThreadHost;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

export type DismissalTally = Partial<
  Record<FindingCategory, { raised: number; notAProblem: number }>
>;

export type SettleAction =
  | { type: "resolve" }
  | { type: "dismiss"; classification: DismissalClass; reason: string }
  | { type: "reclassify"; classification: DismissalClass }
  | { type: "reopen" };

/** Who commits a fix the agent pushes to a session's fork. */
export const agentAuthor: GitSignature = { name: "gitflare", email: "noreply@gitflare.invalid" };

/** How much of a session's condensed transcript a prompt carries. */
const MAX_SESSION_CHARS = 30_000;

export async function requireThread(db: Db, threadId: ThreadId): Promise<Thread> {
  const [row] = await db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Thread ${threadId} does not exist.`);
  return row;
}

export async function requireChange(db: Db, changeId: ChangeId): Promise<Change> {
  const [row] = await db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Change ${changeId} does not exist.`);
  return toChange(row);
}

export async function requireRevision(db: Db, revisionId: RevisionId): Promise<Revision> {
  const [row] = await db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.id, revisionId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Revision ${revisionId} does not exist.`);
  return toRevision(row);
}

export async function requireRepository(db: Db, repositoryId: RepositoryId): Promise<Repository> {
  const [row] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Repository ${repositoryId} does not exist.`);
  return toRepository(row);
}

export async function requireSession(db: Db, sessionId: SessionId): Promise<Session> {
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Session ${sessionId} does not exist.`);
  return row;
}

/** The models the repository's organisation has chosen. */
export async function modelSettings(
  db: Db,
  repository: Pick<Repository, "organisationId">,
): Promise<ModelSettings> {
  const [organisation] = await db
    .select({ settings: schema.organisations.settings })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, repository.organisationId))
    .limit(1);
  return organisation?.settings.models ?? defaultModelSettings;
}

/** Every thread of a change, oldest first. */
export async function changeThreads(db: Db, changeId: ChangeId): Promise<Thread[]> {
  return db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.changeId, changeId))
    .orderBy(asc(schema.threads.createdAt), asc(schema.threads.id));
}

export async function messagesOf(db: Db, threadIds: ThreadId[]): Promise<ThreadMessage[]> {
  if (threadIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.threadMessages)
    .where(inArray(schema.threadMessages.threadId, threadIds))
    .orderBy(asc(schema.threadMessages.threadId), asc(schema.threadMessages.seq));
  return rows.map(toThreadMessage);
}

/** The people who wrote these messages, by id. */
export async function authorsOf(
  db: Db,
  messages: readonly ThreadMessage[],
): Promise<Map<UserId, Pick<User, "id" | "name" | "email" | "role">>> {
  const ids = [
    ...new Set(messages.flatMap((m) => (m.author.kind === "user" ? [m.author.userId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(rows.map((user) => [user.id, user]));
}

/** The sections a change currently has, in reading order. */
export async function currentSections(db: Db, changeId: ChangeId): Promise<Section[]> {
  const rows = await db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.changeId, changeId))
    .orderBy(asc(schema.sections.position));
  return rows.filter((row) => row.removedAt === null).map(toSection);
}

/** The newest version of the change's intent. Null until the intent stage has run: stages run in parallel. */
export async function latestIntent(db: Db, changeId: ChangeId): Promise<Intent | null> {
  const [row] = await db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.changeId, changeId))
    .orderBy(desc(schema.intents.version))
    .limit(1);
  return row ?? null;
}

/** The first line of each of the change's commit messages, oldest first. */
export async function commitSubjects(db: Db, changeId: ChangeId): Promise<string[]> {
  const rows = await db
    .select({ message: schema.changeCommits.message })
    .from(schema.changeCommits)
    .where(eq(schema.changeCommits.changeId, changeId))
    .orderBy(asc(schema.changeCommits.position));
  return rows.map((row) => row.message.split("\n", 1)[0] ?? "");
}

/** The session behind the change as prompt material, or null when nothing was captured. */
export async function sessionTranscript(
  deps: Pick<ReviewDeps, "capture">,
  changeId: ChangeId,
): Promise<string | null> {
  const capture = await deps.capture.read(changeId);
  if (capture.sessions.length === 0) return null;
  return clip(deps.capture.condense(capture), MAX_SESSION_CHARS);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut short]` : text;
}
