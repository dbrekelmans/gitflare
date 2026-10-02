import {
  type GitTokenGrant,
  notImplemented,
  type Repository,
  type Session,
  type SessionId,
  type SessionKind,
  type User,
} from "@gitflare/core";
import type { GitCredential } from "@gitflare/core/api";
import type { Clock, GitHost, GitWriter, IdGenerator } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/artifacts — everything that talks to Cloudflare Artifacts, and
// the forge's own rules about repositories on it: one main repo only gitflare
// writes, a sibling context repo, one fork per session, and a record of which
// user every token was issued to. Facts and signatures:
// spec/research/artifacts.md. Build task: `artifacts`.

/**
 * The part of the Artifacts Workers binding this package calls. Declared here
 * rather than imported, so the package needs no generated Worker types and a
 * test can pass a plain object. Copy signatures from the research note.
 */
export interface ArtifactsBindingLike {
  create(
    name: string,
    opts?: { description?: string; setDefaultBranch?: string },
  ): Promise<unknown>;
  get(name: string): Promise<unknown>;
  import(params: unknown): Promise<unknown>;
  delete(name: string): Promise<boolean>;
}

/** The `GitHost` port over the Artifacts binding. */
export function createArtifactsGitHost(_binding: ArtifactsBindingLike): GitHost {
  return notImplemented("@gitflare/artifacts createArtifactsGitHost");
}

/**
 * The `GitWriter` port over a git client in the Worker (isomorphic-git against
 * the repo's HTTPS remote, with a token minted for the purpose). Whether that
 * client can fetch from and merge on Artifacts is on the "Needs a live test"
 * list; the sandbox-backed writer is the fallback behind the same port.
 */
export function createWorkerGitWriter(_deps: { git: GitHost }): GitWriter {
  return notImplemented("@gitflare/artifacts createWorkerGitWriter");
}

export interface ArtifactsDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Creates a repository: the main repo (empty, or imported from a public URL
 * after checking it fits Artifacts' size limits), its context repo, and a
 * first commit with the capture settings files.
 */
export async function provisionRepository(
  _deps: ArtifactsDeps,
  _user: User,
  _input: { slug: string; description: string; importUrl?: string },
): Promise<Repository> {
  return notImplemented("@gitflare/artifacts provisionRepository");
}

/** Forks the main repo for a new session and records the session. */
export async function openSession(
  _deps: ArtifactsDeps,
  _user: User,
  _input: { repository: Repository; kind: SessionKind; title: string },
): Promise<Session> {
  return notImplemented("@gitflare/artifacts openSession");
}

/**
 * The credential for one git remote, for one user: read on a main repo, write
 * on the caller's own active session fork, write on a context repo. Mints a
 * short-lived token and records the grant. Refuses with `forbidden` otherwise.
 */
export async function issueGitCredential(
  _deps: ArtifactsDeps,
  _user: User,
  _remote: string,
): Promise<GitCredential> {
  return notImplemented("@gitflare/artifacts issueGitCredential");
}

/** A token for gitflare's own use, recorded like any other. */
export async function mintSystemToken(
  _deps: ArtifactsDeps,
  _repoName: string,
  _scope: GitTokenGrant["scope"],
  _purpose: GitTokenGrant["purpose"],
): Promise<{ secret: string; grant: GitTokenGrant }> {
  return notImplemented("@gitflare/artifacts mintSystemToken");
}

/** Deletes a finished session's fork, which also revokes its tokens, and records that it is gone. */
export async function deleteSessionFork(
  _deps: ArtifactsDeps,
  _sessionId: SessionId,
): Promise<void> {
  return notImplemented("@gitflare/artifacts deleteSessionFork");
}
