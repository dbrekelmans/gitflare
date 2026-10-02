import {
  can,
  contextRepoName,
  ForgeError,
  mainRepoName,
  type Repository,
  type Sha,
  type User,
} from "@gitflare/core";
import type { FileChange, GitHost, HostedRepo } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { type ArtifactsDeps, repositoryById, repositoryBySlug, systemAuthor } from "./deps";
import { measureRemote } from "./wire";

/** Artifacts stores at most 1 GB per repository. */
const MAX_REPOSITORY_BYTES = 1024 ** 3;

const decoder = new TextDecoder();

/** A repository on the host, created if an earlier attempt did not get that far. */
async function ensureRepo(git: GitHost, name: string, description?: string): Promise<HostedRepo> {
  return (
    (await git.getRepo(name)) ??
    (await git.createRepo(name, { description, defaultBranch: "main" }))
  );
}

/**
 * `git/<namespace>/<repo>`: how the capture client names a checkpoint remote
 * on the host it already pushes code to. Taken from the remote the host
 * returned, never assembled.
 */
function repoPath(remote: string): string {
  return new URL(remote).pathname.replace(/^\/+/, "").replace(/\.git$/, "");
}

/**
 * Makes sure the context repo exists and the capture client's settings files
 * are on the main repo's default branch, so a fork inherits them and a clone
 * needs no enable step. Returns the branch's tip. Commits nothing when the
 * files are already there, so it is safe to run twice.
 */
async function commitCaptureSettings(
  deps: Pick<ArtifactsDeps, "git" | "gitWriter" | "capture">,
  slug: string,
  branch: string,
): Promise<Sha> {
  const main = mainRepoName(slug);
  const context = await ensureRepo(deps.git, contextRepoName(slug));
  const files = deps.capture.settingsFiles({ contextRepoPath: repoPath(context.remote) });
  const tip = await deps.git.resolveRef(main, branch);
  const changes: FileChange[] = [];
  for (const [path, content] of Object.entries(files)) {
    const current = tip ? await deps.git.readFile(main, { ref: tip, path }) : null;
    if (!current || decoder.decode(current) !== content) changes.push({ path, content });
  }
  if (tip && changes.length === 0) return tip;
  const { sha } = await deps.gitWriter.commitFiles({
    repo: main,
    branch,
    expectedParent: tip,
    changes,
    message: "Turn on session capture",
    author: systemAuthor,
  });
  return sha;
}

/**
 * Creates a repository: the main repo, its context repo, and a first commit
 * with the capture settings files. An import is handed to the provisioner and
 * the repository comes back with `readyAt` null.
 */
export async function provisionRepository(
  deps: ArtifactsDeps,
  user: User,
  input: { slug: string; description: string; importUrl?: string },
): Promise<Repository> {
  if (!can(user, { type: "repository.create" })) {
    throw new ForgeError("forbidden", "Only an administrator can create a repository.");
  }
  if (await repositoryBySlug(deps.db, input.slug)) {
    throw new ForgeError("conflict", `A repository named ${input.slug} already exists.`);
  }
  const repository: Repository = {
    id: deps.ids.next("repository"),
    organisationId: user.organisationId,
    slug: input.slug,
    description: input.description,
    defaultBranch: "main",
    headSha: null,
    captureEnabled: false,
    createdAt: deps.clock.now(),
    readyAt: null,
    importFailedAt: null,
    importError: null,
    archivedAt: null,
  };

  if (input.importUrl) {
    await deps.db.insert(schema.repositories).values(repository);
    await deps.provisioning.importRepository(repository.id, input.importUrl);
    return repository;
  }

  // The record is written last: a failure before it leaves repositories on
  // the host that the next attempt finds and uses, and no slug that is taken
  // by something that does not work.
  const main = await ensureRepo(deps.git, mainRepoName(input.slug), input.description);
  const headSha = await commitCaptureSettings(deps, input.slug, main.defaultBranch);
  const ready: Repository = {
    ...repository,
    defaultBranch: main.defaultBranch,
    headSha,
    captureEnabled: true,
    readyAt: deps.clock.now(),
  };
  await deps.db.insert(schema.repositories).values(ready);
  return ready;
}

/**
 * The provisioning Workflow's import step: checks the source fits the host's
 * size limits, imports it, commits the capture settings files and marks the
 * repository ready. Throws on a failure worth retrying, which includes an
 * import the host has not finished. A source that can never be imported (too
 * large, or not readable) is not retried: the repository is returned as it
 * is, not ready.
 */
export async function completeRepositoryImport(
  deps: ArtifactsDeps,
  repositoryId: Repository["id"],
  url: string,
): Promise<Repository> {
  const repository = await repositoryById(deps.db, repositoryId);
  if (repository.readyAt) return repository;

  const main = mainRepoName(repository.slug);
  let hosted = await deps.git.getRepo(main);
  if (!hosted) {
    const limit = deps.maxImportBytes ?? MAX_REPOSITORY_BYTES;
    const fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    try {
      if ((await measureRemote(fetch, url, limit)) > limit) return repository;
    } catch (error) {
      if (error instanceof ForgeError && error.code === "invalid") return repository;
      throw error;
    }
    hosted = await deps.git.importRepo(main, { url });
  }
  if (hosted.status !== "ready") {
    throw new ForgeError("not_ready", `${main} is still being imported`);
  }

  const headSha = await commitCaptureSettings(deps, repository.slug, hosted.defaultBranch);
  const ready: Repository = {
    ...repository,
    defaultBranch: hosted.defaultBranch,
    headSha,
    captureEnabled: true,
    readyAt: deps.clock.now(),
  };
  await deps.db
    .update(schema.repositories)
    .set({
      defaultBranch: ready.defaultBranch,
      headSha: ready.headSha,
      captureEnabled: true,
      readyAt: ready.readyAt,
    })
    .where(eq(schema.repositories.id, repository.id));
  return ready;
}
