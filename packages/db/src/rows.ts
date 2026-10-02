import type {
  Change,
  ChangeCommit,
  CloudSessionEvent,
  Decision,
  ModelCall,
  Repository,
  Revision,
  Section,
  ThreadMessage,
} from "@gitflare/core";
import type {
  changeCommits,
  changes,
  cloudSessionEvents,
  decisions,
  modelCalls,
  repositories,
  revisions,
  sections,
  threadMessages,
} from "./schema";

// Most tables hold a core record column for column, and a selected row is
// already that record: `users`, `sessions`, `stage_runs`, `intents`,
// `approvals`, `threads`, `ci_runs`, `ci_steps`, `decision_events`,
// `checkpoints`, `session_launches`, `revision_reviews`. The mappers here are
// for the tables that carry more than the record does, or shape it differently.

export function toRepository(row: typeof repositories.$inferSelect): Repository {
  const { nextChangeNumber: _next, ...repository } = row;
  return repository;
}

export function toChange(row: typeof changes.$inferSelect): Change {
  const { lastEventSeq: _seq, ...change } = row;
  return change;
}

export function toRevision(row: typeof revisions.$inferSelect): Revision {
  const { commits, filesChanged, insertions, deletions, ...revision } = row;
  return { ...revision, stats: { commits, filesChanged, insertions, deletions } };
}

export function fromRevision(revision: Revision): typeof revisions.$inferInsert {
  const { stats, ...row } = revision;
  return { ...row, ...stats };
}

export function toChangeCommit(row: typeof changeCommits.$inferSelect): ChangeCommit {
  const { position: _position, ...commit } = row;
  return commit;
}

export function toSection(row: typeof sections.$inferSelect): Section {
  const { removedAt: _removed, stats: _stats, ...section } = row;
  return section;
}

export function toCloudSessionEvent(
  row: typeof cloudSessionEvents.$inferSelect,
): CloudSessionEvent {
  return { ...row.body, sessionId: row.sessionId, seq: row.seq, at: row.at };
}

export function toThreadMessage(row: typeof threadMessages.$inferSelect): ThreadMessage {
  const { authorKind, authorUserId, ...message } = row;
  return {
    ...message,
    author:
      authorKind === "user" && authorUserId
        ? { kind: "user", userId: authorUserId }
        : { kind: "agent" },
  };
}

export function fromThreadMessage(message: ThreadMessage): typeof threadMessages.$inferInsert {
  const { author, ...row } = message;
  return {
    ...row,
    authorKind: author.kind,
    authorUserId: author.kind === "user" ? author.userId : null,
  };
}

export function toDecision(row: typeof decisions.$inferSelect): Decision {
  const { fileSha: _sha, embedding: _embedding, embeddingModel: _model, ...decision } = row;
  return decision;
}

export function toModelCall(row: typeof modelCalls.$inferSelect): ModelCall {
  const { agent, userId, repositoryId, changeId, sessionId, ...call } = row;
  return {
    ...call,
    attribution: {
      agent,
      ...(userId && { userId }),
      ...(repositoryId && { repositoryId }),
      ...(changeId && { changeId }),
      ...(sessionId && { sessionId }),
    },
  };
}

export function fromModelCall(call: ModelCall): typeof modelCalls.$inferInsert {
  const { attribution, ...row } = call;
  return {
    ...row,
    agent: attribution.agent,
    userId: attribution.userId ?? null,
    repositoryId: attribution.repositoryId ?? null,
    changeId: attribution.changeId ?? null,
    sessionId: attribution.sessionId ?? null,
  };
}
