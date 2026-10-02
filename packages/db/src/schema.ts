import {
  type AgentAction,
  AgentName,
  type ApprovalId,
  ApprovalWithdrawalReason,
  type Attribution,
  type ChangeEventBody,
  type ChangeId,
  ChangeStatus,
  type CiRunId,
  CiStatus,
  type CiStepId,
  type CloudSessionEventBody,
  type Decision,
  type DecisionEvent,
  type DecisionEventId,
  DecisionEventKind,
  type DecisionId,
  DecisionOrigin,
  DecisionRelation,
  DecisionStatus,
  DismissalClass,
  type Finding,
  GitTokenScope,
  IntentGrade,
  type IntentId,
  type MessageId,
  type ModelCallId,
  type ModelUsage,
  type OrganisationId,
  type OrganisationSettings,
  type RepositoryId,
  type RevisionId,
  type SectionFile,
  type SectionId,
  SectionKind,
  type SectionStats,
  type SessionId,
  SessionKind,
  SessionStatus,
  StageName,
  type StageRunId,
  StageStatus,
  type ThreadAnchor,
  type ThreadId,
  ThreadKind,
  ThreadStatus,
  type UserId,
  UserRole,
} from "@gitflare/core";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Conventions: ids are the prefixed strings from `@gitflare/core`; every time
// is integer milliseconds since the epoch; money is integer micro-dollars;
// structured values are JSON text typed with the core type they hold. There
// are no foreign-key constraints: D1 applies migrations without interactive
// transactions, and rows here are never deleted.

const id = <T extends string>(name: string) => text(name).$type<T>();
const time = (name: string) => integer(name);
/** A zod enum's members, as the non-empty tuple Drizzle wants for a text enum. */
const values = <T extends string>(e: { options: readonly T[] }) => e.options as [T, ...T[]];
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const organisations = sqliteTable("organisations", {
  id: id<OrganisationId>("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: json<OrganisationSettings>("settings").notNull(),
  createdAt: time("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: id<UserId>("id").primaryKey(),
    organisationId: id<OrganisationId>("organisation_id").notNull(),
    subject: text("subject").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: values(UserRole) }).notNull(),
    createdAt: time("created_at").notNull(),
    lastSeenAt: time("last_seen_at"),
  },
  (t) => [uniqueIndex("users_subject").on(t.subject), index("users_email").on(t.email)],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: id<RepositoryId>("id").primaryKey(),
    organisationId: id<OrganisationId>("organisation_id").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    defaultBranch: text("default_branch").notNull().default("main"),
    headSha: text("head_sha"),
    captureEnabled: integer("capture_enabled", { mode: "boolean" }).notNull().default(false),
    /** The next change number to hand out. */
    nextChangeNumber: integer("next_change_number").notNull().default(1),
    createdAt: time("created_at").notNull(),
    readyAt: time("ready_at"),
    importFailedAt: time("import_failed_at"),
    importError: text("import_error"),
    archivedAt: time("archived_at"),
  },
  (t) => [uniqueIndex("repositories_slug").on(t.slug)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: id<SessionId>("id").primaryKey(),
    repositoryId: id<RepositoryId>("repository_id").notNull(),
    userId: id<UserId>("user_id").notNull(),
    kind: text("kind", { enum: values(SessionKind) }).notNull(),
    status: text("status", { enum: values(SessionStatus) }).notNull(),
    title: text("title").notNull(),
    forkRepo: text("fork_repo").notNull(),
    baseSha: text("base_sha").notNull(),
    createdAt: time("created_at").notNull(),
    forkReadyAt: time("fork_ready_at"),
    endedAt: time("ended_at"),
    forkDeletedAt: time("fork_deleted_at"),
  },
  (t) => [
    uniqueIndex("sessions_fork_repo").on(t.forkRepo),
    index("sessions_user").on(t.userId, t.status),
    index("sessions_repository").on(t.repositoryId, t.status),
  ],
);

/**
 * A hosted session's first prompt, waiting for its fork. Written with the
 * session by the request that starts it; `launchedAt` is set by the
 * provisioning step that hands the prompt to the `cloudSessions` port.
 */
export const sessionLaunches = sqliteTable("session_launches", {
  sessionId: id<SessionId>("session_id").primaryKey(),
  prompt: text("prompt").notNull(),
  requestedAt: time("requested_at").notNull(),
  launchedAt: time("launched_at"),
});

/**
 * What a hosted session's agent did, kept so the conversation outlives the
 * sandbox it ran in. `seq` is gap-free per session and keeps counting across
 * a stop and a resume.
 */
export const cloudSessionEvents = sqliteTable(
  "cloud_session_events",
  {
    sessionId: id<SessionId>("session_id").notNull(),
    seq: integer("seq").notNull(),
    body: json<CloudSessionEventBody>("body").notNull(),
    at: time("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/** Which user each Artifacts token was issued to. Artifacts itself records nothing about that. */
export const gitTokens = sqliteTable(
  "git_tokens",
  {
    tokenId: text("token_id").primaryKey(),
    repoName: text("repo_name").notNull(),
    userId: id<UserId>("user_id"),
    sessionId: id<SessionId>("session_id"),
    scope: text("scope", { enum: values(GitTokenScope) }).notNull(),
    purpose: text("purpose", {
      enum: ["clone", "session_push", "checkpoint_push", "sandbox", "system"],
    }).notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull(),
    revokedAt: time("revoked_at"),
  },
  (t) => [index("git_tokens_repo").on(t.repoName), index("git_tokens_user").on(t.userId)],
);

export const changes = sqliteTable(
  "changes",
  {
    id: id<ChangeId>("id").primaryKey(),
    repositoryId: id<RepositoryId>("repository_id").notNull(),
    sessionId: id<SessionId>("session_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: values(ChangeStatus) }).notNull(),
    authorId: id<UserId>("author_id").notNull(),
    headRef: text("head_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    headRevisionId: id<RevisionId>("head_revision_id").notNull(),
    openedAt: time("opened_at").notNull(),
    readyAt: time("ready_at"),
    mergedAt: time("merged_at"),
    mergedBy: id<UserId>("merged_by"),
    mergeSha: text("merge_sha"),
    closedAt: time("closed_at"),
    /** The sequence number of the newest row in `change_events`. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
  },
  (t) => [
    uniqueIndex("changes_session").on(t.sessionId),
    uniqueIndex("changes_repository_number").on(t.repositoryId, t.number),
    index("changes_status").on(t.status, t.openedAt),
    index("changes_author").on(t.authorId, t.status),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: id<RevisionId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    number: integer("number").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    pushedAt: time("pushed_at").notNull(),
    commits: integer("commits").notNull(),
    filesChanged: integer("files_changed").notNull(),
    insertions: integer("insertions").notNull(),
    deletions: integer("deletions").notNull(),
  },
  (t) => [
    uniqueIndex("revisions_change_number").on(t.changeId, t.number),
    // The same head pushed twice is the same revision: this is what makes push handling idempotent.
    uniqueIndex("revisions_change_head").on(t.changeId, t.headSha),
  ],
);

export const changeCommits = sqliteTable(
  "change_commits",
  {
    changeId: id<ChangeId>("change_id").notNull(),
    sha: text("sha").notNull(),
    revisionId: id<RevisionId>("revision_id").notNull(),
    position: integer("position").notNull(),
    message: text("message").notNull(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    authoredAt: time("authored_at").notNull(),
    checkpointIds: json<string[]>("checkpoint_ids").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.sha] })],
);

export const stageRuns = sqliteTable(
  "stage_runs",
  {
    id: id<StageRunId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    revisionId: id<RevisionId>("revision_id").notNull(),
    stage: text("stage", { enum: values(StageName) }).notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: values(StageStatus) }).notNull(),
    reason: text("reason"),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
  },
  (t) => [
    uniqueIndex("stage_runs_attempt").on(t.revisionId, t.stage, t.attempt),
    index("stage_runs_change").on(t.changeId),
  ],
);

/** The append-only log behind a change's live connection. `seq` is gap-free per change. */
export const changeEvents = sqliteTable(
  "change_events",
  {
    changeId: id<ChangeId>("change_id").notNull(),
    seq: integer("seq").notNull(),
    body: json<ChangeEventBody>("body").notNull(),
    at: time("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.seq] })],
);

/** Tips of the checkpoint refs in each repository's context repo, as pushes report them. */
export const checkpoints = sqliteTable(
  "checkpoints",
  {
    repositoryId: id<RepositoryId>("repository_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    ref: text("ref").notNull(),
    tipSha: text("tip_sha").notNull(),
    firstSeenAt: time("first_seen_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.checkpointId] })],
);

/** One agent session's part in one change, without the turns: those are re-read from the context repo. */
export const capturedSessions = sqliteTable(
  "captured_sessions",
  {
    changeId: id<ChangeId>("change_id").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    agent: text("agent").notNull(),
    model: text("model"),
    checkpointIds: json<string[]>("checkpoint_ids").notNull(),
    turnCount: integer("turn_count").notNull(),
    attribution: json<Attribution>("attribution"),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.agentSessionId] })],
);

export const intents = sqliteTable(
  "intents",
  {
    id: id<IntentId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    revisionId: id<RevisionId>("revision_id").notNull(),
    version: integer("version").notNull(),
    attempt: integer("attempt").notNull(),
    statement: text("statement").notNull(),
    grade: text("grade", { enum: values(IntentGrade) }).notNull(),
    checkpointIds: json<string[]>("checkpoint_ids").notNull(),
    model: text("model"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("intents_change_version").on(t.changeId, t.version),
    // One attempt produces one version: a retried attempt cannot add a second.
    uniqueIndex("intents_revision_attempt").on(t.revisionId, t.attempt),
  ],
);

/** One row per review stage attempt that finished reviewing a revision, findings or none. */
export const revisionReviews = sqliteTable(
  "revision_reviews",
  {
    revisionId: id<RevisionId>("revision_id").notNull(),
    attempt: integer("attempt").notNull(),
    changeId: id<ChangeId>("change_id").notNull(),
    findings: integer("findings").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.attempt] }),
    index("revision_reviews_change").on(t.changeId),
  ],
);

export const sections = sqliteTable(
  "sections",
  {
    id: id<SectionId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    kind: text("kind", { enum: values(SectionKind) }).notNull(),
    explanation: text("explanation").notNull(),
    files: json<SectionFile[]>("files").notNull(),
    contentHash: text("content_hash").notNull(),
    createdRevisionId: id<RevisionId>("created_revision_id").notNull(),
    updatedRevisionId: id<RevisionId>("updated_revision_id").notNull(),
    /**
     * `sectionStats` of the diff at `updatedRevisionId`, written with
     * `contentHash`. Null on a section written before this column existed:
     * readers then compute it from the diff.
     */
    stats: json<SectionStats>("stats"),
    /** Set when a later push left the section with nothing to show. It keeps its approvals' history. */
    removedAt: time("removed_at"),
  },
  (t) => [index("sections_change").on(t.changeId, t.position)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: id<ApprovalId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    sectionId: id<SectionId>("section_id").notNull(),
    userId: id<UserId>("user_id").notNull(),
    selfApproval: integer("self_approval", { mode: "boolean" }).notNull().default(false),
    contentHash: text("content_hash").notNull(),
    createdAt: time("created_at").notNull(),
    withdrawnAt: time("withdrawn_at"),
    withdrawnReason: text("withdrawn_reason", { enum: values(ApprovalWithdrawalReason) }),
  },
  (t) => [index("approvals_change").on(t.changeId), index("approvals_section").on(t.sectionId)],
);

export const threads = sqliteTable(
  "threads",
  {
    id: id<ThreadId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    sectionId: id<SectionId>("section_id"),
    kind: text("kind", { enum: values(ThreadKind) }).notNull(),
    origin: text("origin", { enum: ["review", "human"] }).notNull(),
    status: text("status", { enum: values(ThreadStatus) }).notNull(),
    finding: json<Finding>("finding"),
    anchor: json<ThreadAnchor>("anchor"),
    anchorRevisionId: id<RevisionId>("anchor_revision_id"),
    dismissal: text("dismissal", { enum: values(DismissalClass) }),
    decisionId: id<DecisionId>("decision_id"),
    createdBy: id<UserId>("created_by"),
    createdAt: time("created_at").notNull(),
    settledAt: time("settled_at"),
    settledBy: id<UserId>("settled_by"),
    learnedAt: time("learned_at"),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: time("last_message_at").notNull(),
  },
  (t) => [index("threads_change").on(t.changeId, t.createdAt)],
);

/** Settled messages. The thread's Durable Object is the only writer; `seq` is its order. */
export const threadMessages = sqliteTable(
  "thread_messages",
  {
    id: id<MessageId>("id").primaryKey(),
    threadId: id<ThreadId>("thread_id").notNull(),
    seq: integer("seq").notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent"] }).notNull(),
    authorUserId: id<UserId>("author_user_id"),
    body: text("body").notNull(),
    action: json<AgentAction>("action"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [uniqueIndex("thread_messages_seq").on(t.threadId, t.seq)],
);

export const ciRuns = sqliteTable(
  "ci_runs",
  {
    id: id<CiRunId>("id").primaryKey(),
    changeId: id<ChangeId>("change_id").notNull(),
    revisionId: id<RevisionId>("revision_id").notNull(),
    stageRunId: id<StageRunId>("stage_run_id").notNull(),
    status: text("status", { enum: values(CiStatus) }).notNull(),
    reason: text("reason"),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
  },
  (t) => [
    uniqueIndex("ci_runs_stage_run").on(t.stageRunId),
    index("ci_runs_change").on(t.changeId),
  ],
);

export const ciSteps = sqliteTable(
  "ci_steps",
  {
    id: id<CiStepId>("id").primaryKey(),
    runId: id<CiRunId>("run_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    status: text("status", { enum: values(CiStatus) }).notNull(),
    exitCode: integer("exit_code"),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
    logTail: text("log_tail").notNull().default(""),
  },
  (t) => [uniqueIndex("ci_steps_run_name").on(t.runId, t.name)],
);

/**
 * The index of the decision files in each context repo. The files are the
 * source of truth for wording; strength, status and the embedding live here.
 */
export const decisions = sqliteTable(
  "decisions",
  {
    id: id<DecisionId>("id").primaryKey(),
    repositoryId: id<RepositoryId>("repository_id").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    statement: text("statement").notNull(),
    rationale: text("rationale").notNull().default(""),
    scope: json<Decision["scope"]>("scope").notNull(),
    status: text("status", { enum: values(DecisionStatus) }).notNull(),
    strength: real("strength").notNull(),
    origin: text("origin", { enum: values(DecisionOrigin) }).notNull(),
    originChangeId: id<ChangeId>("origin_change_id"),
    originThreadId: id<ThreadId>("origin_thread_id"),
    /** The commit in the context repo that last wrote the file. */
    fileSha: text("file_sha"),
    /** A unit-length vector of the title and statement, for retrieval by meaning. */
    embedding: json<number[]>("embedding"),
    embeddingModel: text("embedding_model"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("decisions_repository_path").on(t.repositoryId, t.path),
    index("decisions_repository_status").on(t.repositoryId, t.status),
  ],
);

export const decisionEvents = sqliteTable(
  "decision_events",
  {
    id: id<DecisionEventId>("id").primaryKey(),
    decisionId: id<DecisionId>("decision_id").notNull(),
    kind: text("kind", { enum: values(DecisionEventKind) }).notNull(),
    changeId: id<ChangeId>("change_id"),
    threadId: id<ThreadId>("thread_id"),
    userId: id<UserId>("user_id"),
    strengthBefore: real("strength_before").notNull(),
    strengthAfter: real("strength_after").notNull(),
    wording: json<NonNullable<DecisionEvent["wording"]>>("wording"),
    note: text("note"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [index("decision_events_decision").on(t.decisionId, t.createdAt)],
);

export const changeDecisions = sqliteTable(
  "change_decisions",
  {
    changeId: id<ChangeId>("change_id").notNull(),
    decisionId: id<DecisionId>("decision_id").notNull(),
    relation: text("relation", { enum: values(DecisionRelation) }).notNull(),
    similarity: real("similarity").notNull(),
    threadId: id<ThreadId>("thread_id"),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.decisionId] })],
);

export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: id<ModelCallId>("id").primaryKey(),
    agent: text("agent", { enum: values(AgentName) }).notNull(),
    userId: id<UserId>("user_id"),
    repositoryId: id<RepositoryId>("repository_id"),
    changeId: id<ChangeId>("change_id"),
    sessionId: id<SessionId>("session_id"),
    model: text("model").notNull(),
    requestedModel: text("requested_model").notNull(),
    gatewayLogId: text("gateway_log_id"),
    usage: json<ModelUsage>("usage").notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [index("model_calls_change").on(t.changeId), index("model_calls_created").on(t.createdAt)],
);
