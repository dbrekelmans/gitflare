import {
  type ChangeCapture,
  type ChangeId,
  type CheckpointRef,
  type Decision,
  type DecisionId,
  type FileDiff,
  initialDecisionState,
  type Push,
  type RepositoryId,
  type Sha,
  type ThreadId,
} from "@gitflare/core";
import type {
  CapturePort,
  Clock,
  DecisionsPort,
  DiffPort,
  GitHost,
  IdGenerator,
  NewDecision,
  RetrievedDecision,
} from "@gitflare/core/ports";
import { lineDiff } from "../demo/diff";
import { fakeEmbedding } from "./models";

const decoder = new TextDecoder();

/** Captures a test hands it, keyed by change. A change with none has an empty capture. */
export class FakeCapture implements CapturePort {
  readonly captures = new Map<ChangeId, ChangeCapture>();
  readonly checkpoints: CheckpointRef[] = [];
  /** What `missingCheckpoints` answers, per change. */
  readonly missing = new Map<ChangeId, string[]>();

  constructor(private readonly clock: Clock) {}

  /** Makes `read` return this capture for its change. */
  set(capture: ChangeCapture): this {
    this.captures.set(capture.changeId, capture);
    return this;
  }

  async recordCheckpoint(
    repositoryId: RepositoryId,
    checkpointId: string,
    push: Push,
  ): Promise<CheckpointRef> {
    const now = this.clock.now();
    const existing = this.checkpoints.find(
      (ref) => ref.repositoryId === repositoryId && ref.checkpointId === checkpointId,
    );
    if (existing) {
      existing.tipSha = push.after;
      existing.updatedAt = now;
      return existing;
    }
    const ref: CheckpointRef = {
      checkpointId,
      repositoryId,
      ref: push.ref,
      tipSha: push.after,
      firstSeenAt: now,
      updatedAt: now,
    };
    this.checkpoints.push(ref);
    return ref;
  }

  async missingCheckpoints(changeId: ChangeId): Promise<string[]> {
    return this.missing.get(changeId) ?? [];
  }

  async read(changeId: ChangeId): Promise<ChangeCapture> {
    return this.captures.get(changeId) ?? { changeId, sessions: [], missingCheckpointIds: [] };
  }

  condense(capture: ChangeCapture): string {
    return capture.sessions
      .flatMap((session) => session.turns.map((turn) => `[${turn.kind}] ${turn.text}`))
      .join("\n");
  }

  settingsFiles(input: { contextRepoPath: string }): Record<string, string> {
    return {
      ".entire/settings.json": JSON.stringify({
        enabled: true,
        strategy_options: {
          checkpoint_remote: { provider: "artifacts", repo: input.contextRepoPath },
        },
      }),
    };
  }
}

/**
 * A working diff over any `GitHost`: it reads both commits' whole trees and
 * line-diffs what differs. Slow and without rename or binary detection, which
 * is fine for the small repositories tests use. Hashes are the real ones.
 */
export class FakeDiffs implements DiffPort {
  constructor(private readonly git: GitHost) {}

  async between(repo: string, baseSha: Sha, headSha: Sha): Promise<FileDiff[]> {
    const [before, after] = await Promise.all([
      this.files(repo, baseSha),
      this.files(repo, headSha),
    ]);
    return [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => lineDiff(path, before.get(path) ?? null, after.get(path) ?? null));
  }

  async mergeBase(repo: string, a: Sha, b: Sha): Promise<Sha | null> {
    const ancestors = new Set(
      (await this.git.log(repo, { ref: a, limit: 1000 })).map((c) => c.sha),
    );
    for (const commit of await this.git.log(repo, { ref: b, limit: 1000 })) {
      if (ancestors.has(commit.sha)) return commit.sha;
    }
    return null;
  }

  format(diff: FileDiff[]): string {
    return diff
      .map((file) =>
        [
          `--- ${file.status === "added" ? "/dev/null" : `a/${file.path}`}`,
          `+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`,
          ...file.hunks.flatMap((hunk) => [
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            ...hunk.lines.map(
              (line) =>
                `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`,
            ),
          ]),
        ].join("\n"),
      )
      .join("\n");
  }

  private async files(repo: string, sha: Sha): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const commit = await this.git.readCommit(repo, sha);
    const walk = async (treeSha: Sha, prefix: string): Promise<void> => {
      for (const entry of (await this.git.readTree(repo, treeSha)) ?? []) {
        if (entry.type === "tree") {
          await walk(entry.sha, `${prefix}${entry.name}/`);
        } else {
          const blob = await this.git.readBlob(repo, entry.sha);
          out.set(`${prefix}${entry.name}`, blob ? decoder.decode(blob) : "");
        }
      }
    };
    if (commit) await walk(commit.treeSha, "");
    return out;
  }
}

function similarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

/**
 * A decision record in memory. Retrieval ranks by the same word-overlap
 * embedding the model fake uses; everything else is recorded for assertions.
 */
export class FakeDecisions implements DecisionsPort {
  readonly decisions: Decision[] = [];
  readonly links: Parameters<DecisionsPort["link"]>[0][] = [];
  readonly learnedFrom: ThreadId[] = [];
  readonly settled: ChangeId[] = [];
  readonly retrievals: Parameters<DecisionsPort["retrieve"]>[0][] = [];

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Puts existing decisions in the record. */
  add(...decisions: Decision[]): this {
    this.decisions.push(...decisions);
    return this;
  }

  async retrieve(input: Parameters<DecisionsPort["retrieve"]>[0]): Promise<RetrievedDecision[]> {
    this.retrievals.push(input);
    const query = fakeEmbedding(input.query);
    return this.decisions
      .filter((d) => d.repositoryId === input.repositoryId && d.status === "active")
      .map((decision) => ({
        decision,
        similarity: similarity(query, fakeEmbedding(`${decision.title} ${decision.statement}`)),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);
  }

  async record(input: NewDecision): Promise<Decision> {
    const id: DecisionId = this.ids.next("decision");
    const now = this.clock.now();
    const decision: Decision = {
      id,
      repositoryId: input.repositoryId,
      path: `decisions/${id}.md`,
      title: input.title,
      statement: input.statement,
      rationale: input.rationale,
      scope: input.globs.length > 0 ? { kind: "paths", globs: input.globs } : { kind: "general" },
      ...initialDecisionState(),
      origin: input.origin,
      originChangeId: input.changeId,
      originThreadId: input.threadId,
      createdAt: now,
      updatedAt: now,
    };
    this.decisions.push(decision);
    return decision;
  }

  async link(input: Parameters<DecisionsPort["link"]>[0]): Promise<void> {
    this.links.push(input);
  }

  async learnFromThread(threadId: ThreadId): Promise<Decision | null> {
    this.learnedFrom.push(threadId);
    return null;
  }

  async settleChange(changeId: ChangeId): Promise<void> {
    this.settled.push(changeId);
  }
}
