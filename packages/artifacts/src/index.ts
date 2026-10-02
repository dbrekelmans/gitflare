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
import type {
  CapturePort,
  Clock,
  GitHost,
  GitWriter,
  IdGenerator,
  Provisioner,
  SandboxHost,
} from "@gitflare/core/ports";
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
 * The `GitWriter` port, inside the Worker. A commit is built from binding
 * reads and pushed as a hand-made pack, without cloning; a fast-forward merge
 * relays the fork's pack to the main repo. Both cost tens of milliseconds of
 * CPU whatever the repository's size. A true merge uses isomorphic-git, which
 * holds the repository in memory: above a few tens of megabytes it must hand
 * over to the sandbox-backed writer (`createSandboxGitWriter`).
 */
export function createWorkerGitWriter(_deps: { git: GitHost }): GitWriter {
  return notImplemented("@gitflare/artifacts createWorkerGitWriter");
}

/**
 * The `GitWriter` for what the Worker cannot hold in memory: a true merge of
 * a larger repository, done with real git in a sandbox (shallow clone, fetch
 * the fork, merge, push), with credentials added at the egress.
 */
export function createSandboxGitWriter(_deps: {
  git: GitHost;
  sandboxes: SandboxHost;
  ids: IdGenerator;
}): GitWriter {
  return notImplemented("@gitflare/artifacts createSandboxGitWriter");
}

export interface ArtifactsDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  /** For the capture settings files committed to a new repository. */
  capture: CapturePort;
  /** Forks and imports are started here and finished by the provisioning Workflow. */
  provisioning: Provisioner;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Creates a repository: the main repo, its context repo, and a first commit
 * with the capture settings files. An import is handed to the provisioner and
 * the repository comes back with `readyAt` null.
 */
export async function provisionRepository(
  _deps: ArtifactsDeps,
  _user: User,
  _input: { slug: string; description: string; importUrl?: string },
): Promise<Repository> {
  return notImplemented("@gitflare/artifacts provisionRepository");
}

/**
 * Records a session and asks the provisioner to fork the main repo for it.
 * Forking takes seconds to most of a minute, so this returns before the fork
 * exists: `forkReadyAt` is null until `completeSessionFork` has run.
 */
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

/**
 * The provisioning Workflow's fork step: forks the main repo if the fork does
 * not exist yet, and marks the session's fork ready once the host reports it
 * so. Throws while it is still being copied, so the step is retried.
 */
export async function completeSessionFork(
  _deps: ArtifactsDeps,
  _sessionId: SessionId,
): Promise<Session> {
  return notImplemented("@gitflare/artifacts completeSessionFork");
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

/**
 * The provisioning Workflow's import step: checks the source fits the host's
 * size limits, imports it, commits the capture settings files and marks the
 * repository ready. Throws on a failure worth retrying.
 */
export async function completeRepositoryImport(
  _deps: ArtifactsDeps,
  _repositoryId: Repository["id"],
  _url: string,
): Promise<Repository> {
  return notImplemented("@gitflare/artifacts completeRepositoryImport");
}
