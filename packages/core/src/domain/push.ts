import { z } from "zod";
import { parseRepoName, type RepoNameKind } from "./repo-names";

export const ARTIFACTS_PUSH_EVENT = "cf.artifacts.repo.pushed";
export const ZERO_SHA = "0000000000000000000000000000000000000000";
export const CHECKPOINT_REF_PREFIX = "refs/entire/checkpoints/";
/** The legacy single-branch checkpoint store; also the fallback if Artifacts refuses custom refs. */
export const CHECKPOINT_BRANCH_REF = "refs/heads/entire/checkpoints/v1";

/**
 * The documented `cf.artifacts.repo.pushed` payload, loosely: unknown fields
 * pass through, because what a Workflow actually receives from
 * `triggers.events` carries a few more. An event means "this ref moved" and
 * nothing else: there is one per ref, they can arrive out of order, they name
 * no actor, and `commits` is not the list of new commits. Take the repository,
 * `ref` and `after` from it and read everything else from the repository.
 */
export const ArtifactsPushEvent = z.looseObject({
  type: z.literal(ARTIFACTS_PUSH_EVENT),
  source: z.looseObject({
    namespace: z.string(),
    repoName: z.string(),
  }),
  payload: z.looseObject({
    ref: z.string(),
    before: z.string(),
    after: z.string(),
  }),
});
export type ArtifactsPushEvent = z.infer<typeof ArtifactsPushEvent>;

/** A push, reduced to what the pipeline acts on. */
export interface Push {
  repoName: string;
  ref: string;
  before: string;
  after: string;
}

export function toPush(event: ArtifactsPushEvent): Push {
  return {
    repoName: event.source.repoName,
    ref: event.payload.ref,
    before: event.payload.before,
    after: event.payload.after,
  };
}

export type PushKind =
  /** A branch moved in a session's fork: open the change or add a revision. */
  | {
      kind: "change";
      slug: string;
      sessionId: Extract<RepoNameKind, { kind: "fork" }>["sessionId"];
      branch: string;
    }
  /** A checkpoint ref moved in a context repo: record its new tip. */
  | { kind: "checkpoint"; slug: string; checkpointId: string }
  /** The legacy checkpoint branch moved: re-index it. */
  | { kind: "checkpoint_branch"; slug: string }
  /** Gitflare's own writes, and pushes that need no reaction. */
  | { kind: "ignored"; reason: string };

/** Entire's two id shapes: a ULID, or twelve hex characters from the legacy backend. */
const CHECKPOINT_ID = /^(?:[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * `refs/entire/checkpoints/<shard>/<id>`, where the shard is the id's last two
 * characters. Other refs live under the same prefix and are not checkpoints.
 */
export function parseCheckpointRef(ref: string): string | null {
  if (!ref.startsWith(CHECKPOINT_REF_PREFIX)) return null;
  const [shard, id, ...rest] = ref.slice(CHECKPOINT_REF_PREFIX.length).split("/");
  if (!shard || !id || rest.length > 0 || !CHECKPOINT_ID.test(id)) return null;
  return id.slice(-2).toLowerCase() === shard.toLowerCase() ? id : null;
}

export function classifyPush(push: Push): PushKind {
  const repo = parseRepoName(push.repoName);
  if (!repo) return { kind: "ignored", reason: "not a gitflare repository name" };
  if (push.after === ZERO_SHA) return { kind: "ignored", reason: "ref deleted" };

  if (repo.kind === "context") {
    const checkpointId = parseCheckpointRef(push.ref);
    if (checkpointId) return { kind: "checkpoint", slug: repo.slug, checkpointId };
    if (push.ref === CHECKPOINT_BRANCH_REF) return { kind: "checkpoint_branch", slug: repo.slug };
    return { kind: "ignored", reason: "context repo ref that is not a checkpoint" };
  }

  if (repo.kind === "main")
    return { kind: "ignored", reason: "main repo is written only by gitflare" };

  if (!push.ref.startsWith("refs/heads/")) return { kind: "ignored", reason: "not a branch" };
  const branch = push.ref.slice("refs/heads/".length);
  // Entire's shadow branches hold unredacted snapshots; they are never a change.
  if (branch.startsWith("entire/")) return { kind: "ignored", reason: "capture client branch" };
  return { kind: "change", slug: repo.slug, sessionId: repo.sessionId, branch };
}
