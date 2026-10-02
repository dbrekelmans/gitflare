import {
  type ChangeId,
  type Decision,
  type DecisionEvent,
  type DecisionId,
  notImplemented,
  type RepositoryId,
  type ThreadId,
} from "@gitflare/core";
import type {
  Clock,
  DecisionsPort,
  GitHost,
  GitWriter,
  IdGenerator,
  ModelGateway,
  NewDecision,
  RetrievedDecision,
} from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/decisions — the decision record. Each decision is a markdown file
// in the repository's context repo and a row in the index; the row carries its
// strength and an embedding. Reviews are given the decisions closest in
// meaning to the change. Strength moves only through `applyDecisionEvent`.
// Build task: `decisions`.

export interface DecisionsDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  models: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
}

/** The `DecisionsPort` the review and the pipeline use, over the functions below. */
export function createDecisionRecord(_deps: DecisionsDeps): DecisionsPort {
  return notImplemented("@gitflare/decisions createDecisionRecord");
}

/**
 * The active decisions of a repository closest in meaning to `query`, nearest
 * first. Dormant decisions are never returned. Embeds the query, then scans
 * the repository's stored vectors in memory: there is no vector database.
 */
export async function retrieveDecisions(
  _deps: Pick<DecisionsDeps, "db" | "models">,
  _input: { repositoryId: RepositoryId; query: string; limit: number; changeId?: ChangeId },
): Promise<RetrievedDecision[]> {
  return notImplemented("@gitflare/decisions retrieveDecisions");
}

/** Writes the decision's file to the context repo, indexes and embeds it, and records `created`. */
export async function recordDecision(_deps: DecisionsDeps, _input: NewDecision): Promise<Decision> {
  return notImplemented("@gitflare/decisions recordDecision");
}

/**
 * Applies one event to a decision: moves its strength and status, rewrites the
 * file when the wording changed, and stores the event. Every change to a
 * decision goes through here.
 */
export async function recordDecisionEvent(
  _deps: DecisionsDeps,
  _decisionId: DecisionId,
  _event: Pick<DecisionEvent, "kind" | "changeId" | "threadId" | "userId" | "note"> & {
    /** New wording, for `reshaped` and `reverted`. */
    statement?: string;
    title?: string;
    rationale?: string;
  },
): Promise<Decision> {
  return notImplemented("@gitflare/decisions recordDecisionEvent");
}

/**
 * Called when a change merges: every decision the change followed or cited is
 * reinforced, and every one it contradicted — and merged anyway — is weakened.
 */
export async function settleChangeDecisions(
  _deps: DecisionsDeps,
  _changeId: ChangeId,
): Promise<void> {
  return notImplemented("@gitflare/decisions settleChangeDecisions");
}

/** Looks through a settled thread for a decision worth keeping, and records or reinforces it. */
export async function learnFromThread(
  _deps: DecisionsDeps,
  _threadId: ThreadId,
): Promise<Decision | null> {
  return notImplemented("@gitflare/decisions learnFromThread");
}

/** The decision's file: front matter the index can be rebuilt from, then the statement and rationale. */
export function renderDecisionFile(_decision: Decision): string {
  return notImplemented("@gitflare/decisions renderDecisionFile");
}

export function parseDecisionFile(_path: string, _text: string): Omit<Decision, "repositoryId"> {
  return notImplemented("@gitflare/decisions parseDecisionFile");
}

/** Rebuilds a repository's index from the files in its context repo. The files win. */
export async function reindexDecisions(
  _deps: DecisionsDeps,
  _repositoryId: RepositoryId,
): Promise<number> {
  return notImplemented("@gitflare/decisions reindexDecisions");
}
