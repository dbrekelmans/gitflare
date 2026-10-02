import { httpRoutes, type RepositoryDetail, type SessionView } from "@gitflare/core/api";
import { type CliContext, CliError, UsageError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import {
  type Clone,
  configureHost,
  configValue,
  currentBranch,
  git,
  requireClone,
  runGit,
  sessionKey,
} from "../git.ts";

const POLL_INTERVAL_MS = 2_000;
/** A fork is a full copy: seconds for a small repository, most of a minute for a large one. */
const READY_TIMEOUT_MS = 5 * 60_000;

/** The session this branch already has, if the forge still counts it as running. */
async function activeSession(
  ctx: CliContext,
  clone: Clone,
  branch: string,
): Promise<SessionView | null> {
  const sessionId = await configValue(ctx, ["--local", "--get", sessionKey(branch)]);
  if (!sessionId) return null;
  try {
    const view = await forgeRequest<SessionView>(ctx, clone.forge, httpRoutes.session(sessionId));
    return view.session.status === "active" ? view : null;
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return null;
    throw error;
  }
}

async function waitForFork(ctx: CliContext, clone: Clone, started: SessionView) {
  let view = started;
  const deadline = ctx.now() + READY_TIMEOUT_MS;
  if (!view.session.forkReadyAt) ctx.stderr("Preparing the session's fork…\n");
  while (!view.session.forkReadyAt) {
    if (view.session.status !== "active") {
      throw new CliError(`The session was ${view.session.status} before its fork was ready.`);
    }
    if (ctx.now() >= deadline) {
      throw new CliError(
        "The fork is still being prepared. Run `gitflare start` again to keep waiting.",
      );
    }
    await ctx.sleep(POLL_INTERVAL_MS);
    view = await forgeRequest<SessionView>(ctx, clone.forge, httpRoutes.session(view.session.id));
  }
  return view;
}

/** A branch name from a session's title: `Tidy the invite form` is `tidy-the-invite-form`. */
export function branchName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

/**
 * Leaves the default branch for a new one named after the session, taking
 * along any uncommitted work. The default branch is the main repository's,
 * which only gitflare writes: kept as it is, it can still be pulled after the
 * change merges, and it never points its pushes at a fork that is deleted then.
 */
async function leaveDefaultBranch(ctx: CliContext, from: string, title: string): Promise<string> {
  const base = branchName(title);
  let branch = base;
  for (let n = 2; ; n++) {
    const taken = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (taken.exitCode !== 0) break;
    branch = `${base}-${n}`;
  }
  await git(ctx, ["switch", "--create", branch]);
  ctx.stderr(`${from} stays as the forge has it. Switched to a new branch, ${branch}.\n`);
  return branch;
}

export async function start(ctx: CliContext, args: string[]): Promise<number> {
  const clone = await requireClone(ctx);
  let branch = await currentBranch(ctx);
  if (!branch) throw new CliError("Check out a branch first: a session's pushes come from one.");

  // The session is recorded before its fork is ready, so running this again
  // goes on waiting for the same fork instead of asking for another.
  let view = await activeSession(ctx, clone, branch);
  if (!view) {
    const title = args.join(" ").trim();
    if (!title) throw new UsageError();
    const { repository } = await forgeRequest<RepositoryDetail>(
      ctx,
      clone.forge,
      httpRoutes.repository(clone.repoSlug),
    );
    if (branch === repository.defaultBranch) {
      branch = await leaveDefaultBranch(ctx, branch, title);
    }
    view = await forgeRequest<SessionView>(
      ctx,
      clone.forge,
      httpRoutes.repositorySessions(clone.repoSlug),
      { kind: "local", title },
    );
    await git(ctx, ["config", sessionKey(branch), view.session.id]);
  }
  view = await waitForFork(ctx, clone, view);
  const { pushRemote } = view;
  if (!pushRemote) throw new CliError("The session's fork is no longer there.");

  const remote = `fork-${view.session.id.slice(-8).toLowerCase()}`;
  await configureHost(ctx, clone.forge, pushRemote);
  const existing = await runGit(ctx, ["remote", "get-url", remote]);
  if (existing.exitCode !== 0) await git(ctx, ["remote", "add", remote, pushRemote]);
  else if (existing.stdout.trim() !== pushRemote) {
    await git(ctx, ["remote", "set-url", remote, pushRemote]);
  }
  await git(ctx, ["config", `branch.${branch}.pushRemote`, remote]);

  ctx.stdout(
    `Session "${view.session.title}" is ready. Pushes from ${branch} go to its fork (${remote}).\n` +
      "The first push opens the change: git push\n",
  );
  return 0;
}
