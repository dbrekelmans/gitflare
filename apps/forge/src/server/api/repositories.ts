import { issueGitCredential, provisionRepository } from "@gitflare/artifacts";
import { can, contextRepoName, ForgeError, mainRepoName, type Repository } from "@gitflare/core";
import type { ForgeApi, RepositoryView } from "@gitflare/core/api";
import { schema, toRepository } from "@gitflare/db";
import { and, asc, count, eq, isNull, notInArray } from "drizzle-orm";
import type { Services } from "../services";

const RECENT_COMMITS = 20;

/**
 * Repositories, and the git credentials the forge issues for them.
 * Build task: `artifacts`.
 */
export function repositoriesApi(services: Services): ForgeApi["repositories"] {
  const { db, git } = services;

  /** Counts once, then turns any repository into its view. */
  async function viewer(): Promise<(repository: Repository) => RepositoryView> {
    const [open, active] = await Promise.all([
      db
        .select({ repositoryId: schema.changes.repositoryId, n: count() })
        .from(schema.changes)
        .where(notInArray(schema.changes.status, ["merged", "closed"]))
        .groupBy(schema.changes.repositoryId),
      db
        .select({ repositoryId: schema.decisions.repositoryId, n: count() })
        .from(schema.decisions)
        .where(eq(schema.decisions.status, "active"))
        .groupBy(schema.decisions.repositoryId),
    ]);
    const openChanges = new Map(open.map((row) => [row.repositoryId, row.n]));
    const activeDecisions = new Map(active.map((row) => [row.repositoryId, row.n]));
    return (repository) => ({
      repository,
      openChanges: openChanges.get(repository.id) ?? 0,
      activeDecisions: activeDecisions.get(repository.id) ?? 0,
    });
  }

  function mayRead(ctx: Parameters<ForgeApi["repositories"]["list"]>[0]): void {
    if (!can(ctx.user, { type: "repository.read" })) {
      throw new ForgeError("forbidden", "You are not allowed to do that.");
    }
  }

  return {
    async list(ctx) {
      mayRead(ctx);
      const rows = await db
        .select()
        .from(schema.repositories)
        .where(isNull(schema.repositories.archivedAt))
        .orderBy(asc(schema.repositories.slug));
      return rows.map(toRepository).map(await viewer());
    },

    async get(ctx, input) {
      mayRead(ctx);
      const [row] = await db
        .select()
        .from(schema.repositories)
        .where(
          and(eq(schema.repositories.slug, input.repoSlug), isNull(schema.repositories.archivedAt)),
        )
        .limit(1);
      if (!row) throw new ForgeError("not_found", "Repository not found");
      const repository = toRepository(row);
      const [view, main, context] = await Promise.all([
        viewer(),
        git.getRepo(mainRepoName(repository.slug)),
        git.getRepo(contextRepoName(repository.slug)),
      ]);
      return {
        ...view(repository),
        // Null while an import is still running: the host has no remote to report yet.
        remote: main?.remote ?? null,
        contextRemote: context?.remote ?? null,
        recentCommits:
          main?.status === "ready"
            ? await git.log(main.name, { ref: repository.defaultBranch, limit: RECENT_COMMITS })
            : [],
      };
    },

    async create(ctx, input) {
      const repository = await provisionRepository(services, ctx.user, input);
      return (await viewer())(repository);
    },

    gitCredential: (ctx, input) => issueGitCredential(services, ctx.user, input.remote),
  };
}
