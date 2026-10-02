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
import { and, eq, isNotNull } from "drizzle-orm";
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
  const existing = await repositoryBySlug(deps.db, input.slug);
  if (existing && !existing.importFailedAt) {
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

  // A failed import holds its slug and nothing else: no session or change can
  // start on a repository that was never ready. What the host kept of the
  // attempt goes first; the record is replaced in the same write that takes
  // the slug, so a request racing this one meets the unique slug.
  if (existing) {
    await deps.git.deleteRepo(mainRepoName(existing.slug));
    await deps.git.deleteRepo(contextRepoName(existing.slug));
  }
  const insert = async (row: Repository): Promise<void> => {
    const values = deps.db.insert(schema.repositories).values(row);
    if (!existing) {
      await values;
      return;
    }
    await deps.db.batch([
      deps.db
        .delete(schema.repositories)
        .where(
          and(
            eq(schema.repositories.id, existing.id),
            isNotNull(schema.repositories.importFailedAt),
          ),
        ),
      values,
    ]);
  };

  if (input.importUrl) {
    await insert(repository);
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
  await insert(ready);
  return ready;
}

/**
 * The provisioning Workflow's import step: checks the source fits the host's
 * size limits, imports it, commits the capture settings files and marks the
 * repository ready. Throws on a failure worth retrying, which includes an
 * import the host has not finished. A source that can never be imported (too
 * large, or not readable) is not retried: the repository is marked failed,
 * with the reason, and returned that way.
 */
export async function completeRepositoryImport(
  deps: ArtifactsDeps,
  repositoryId: Repository["id"],
  url: string,
): Promise<Repository> {
  const repository = await repositoryById(deps.db, repositoryId);
  if (repository.readyAt || repository.importFailedAt) return repository;

  const main = mainRepoName(repository.slug);
  let hosted = await deps.git.getRepo(main);
  if (!hosted) {
    const limit = deps.maxImportBytes ?? MAX_REPOSITORY_BYTES;
    const fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    try {
      if ((await measureRemote(fetch, url, limit)) > limit) {
        return failImport(
          deps,
          repository,
          `${url} is larger than the ${limit} bytes a repository may hold.`,
        );
      }
    } catch (error) {
      if (error instanceof ForgeError && error.code === "invalid") {
        return failImport(deps, repository, error.message);
      }
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

/**
 * Marks an import failed for good, for the Workflow to call once its import
 * step has run out of retries. Leaves a repository that became ready alone.
 */
export async function failRepositoryImport(
  deps: Pick<ArtifactsDeps, "db" | "clock">,
  repositoryId: Repository["id"],
  importError: string,
): Promise<Repository> {
  const repository = await repositoryById(deps.db, repositoryId);
  if (repository.readyAt || repository.importFailedAt) return repository;
  return failImport(deps, repository, importError);
}

/** Records that an import gave up for good, so nothing waits on it and its slug is free again. */
async function failImport(
  deps: Pick<ArtifactsDeps, "db" | "clock">,
  repository: Repository,
  importError: string,
): Promise<Repository> {
  const importFailedAt = deps.clock.now();
  await deps.db
    .update(schema.repositories)
    .set({ importFailedAt, importError })
    .where(eq(schema.repositories.id, repository.id));
  return { ...repository, importFailedAt, importError };
}
