import { z } from "zod";
import type { OrganisationId, RepositoryId, SessionId, Sha, Timestamp, UserId } from "../ids";

/** Lowercase letters, digits and single hyphens. No dots: gitflare uses them as separators. */
export const RepoSlug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens");
export type RepoSlug = z.infer<typeof RepoSlug>;

export interface Repository {
  id: RepositoryId;
  organisationId: OrganisationId;
  slug: string;
  description: string;
  defaultBranch: string;
  /** Tip of the default branch in the main repo, as last written by gitflare. */
  headSha: Sha | null;
  /** Whether the capture client's settings files are committed to the main repo. */
  captureEnabled: boolean;
  createdAt: Timestamp;
  /**
   * When the main repo became usable. Null while an import is still running:
   * importing is slow and can fail, so it happens after the request that asked.
   */
  readyAt: Timestamp | null;
  archivedAt: Timestamp | null;
}

export const SessionKind = z.enum(["local", "cloud"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const SessionStatus = z.enum(["active", "merged", "abandoned"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * A session is one piece of work by one person: a fork, the commits pushed to
 * it and the transcripts that produced them. Where it ran is a property, not a
 * different pipeline.
 */
export interface Session {
  id: SessionId;
  repositoryId: RepositoryId;
  userId: UserId;
  kind: SessionKind;
  status: SessionStatus;
  title: string;
  /** The fork's name in the Artifacts namespace; see `repo-names.ts`. */
  forkRepo: string;
  /** Tip of the main repo's default branch when the fork was made. */
  baseSha: Sha;
  createdAt: Timestamp;
  /** When the fork became usable. Null while it is still being copied. */
  forkReadyAt: Timestamp | null;
  endedAt: Timestamp | null;
  /** Set once the fork has been deleted from Artifacts. */
  forkDeletedAt: Timestamp | null;
}

export const GitTokenScope = z.enum(["read", "write"]);
export type GitTokenScope = z.infer<typeof GitTokenScope>;

/** Artifacts tokens carry no label, so gitflare records who each one was issued to. */
export interface GitTokenGrant {
  /** The id Artifacts returned at mint time. */
  tokenId: string;
  repoName: string;
  /** Null for tokens gitflare minted for itself. */
  userId: UserId | null;
  sessionId: SessionId | null;
  scope: GitTokenScope;
  purpose: "clone" | "session_push" | "checkpoint_push" | "sandbox" | "system";
  expiresAt: Timestamp;
  createdAt: Timestamp;
  revokedAt: Timestamp | null;
}

export interface GitCommit {
  sha: Sha;
  treeSha: Sha;
  parents: Sha[];
  message: string;
  author: GitSignature;
  committer: GitSignature;
  authoredAt: Timestamp;
  committedAt: Timestamp;
}

export interface GitSignature {
  name: string;
  email: string;
}
