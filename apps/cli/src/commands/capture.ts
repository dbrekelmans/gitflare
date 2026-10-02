import { httpRoutes, type RepositoryDetail } from "@gitflare/core/api";
import { type CliContext, CliError, UsageError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import { configureHost, git, requireClone, runGit } from "../git.ts";

// Gitflare commits Entire's settings to every repository, so a clone already
// knows where checkpoints go. What a clone still lacks is the Entire CLI, its
// git hooks, and credentials for the context repository. Facts:
// spec/research/live/entire-on-artifacts.md.

const SETTINGS = ".entire/settings.json";
/** The settings files gitflare commits and `entire enable` may rewrite. */
const COMMITTED = [SETTINGS, ".claude/settings.json"];
const INSTALL_GUIDE = "https://docs.entire.io/cli/installation";

export async function capture(ctx: CliContext, args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== "enable") throw new UsageError();
  const { forge, repoSlug } = await requireClone(ctx);
  const detail = await forgeRequest<RepositoryDetail>(ctx, forge, httpRoutes.repository(repoSlug));

  if ((await runGit(ctx, ["cat-file", "-e", `HEAD:${SETTINGS}`])).exitCode !== 0) {
    throw new CliError(
      `This checkout does not carry gitflare's capture settings (${SETTINGS}). ` +
        `Merge ${detail.repository.defaultBranch} into it and run this again.`,
    );
  }

  // Entire pushes checkpoints to the context repository with git, so git needs
  // this program as its credential helper for that remote too.
  if (!detail.contextRemote) {
    throw new CliError(`${repoSlug} is not ready yet. Try again in a minute.`);
  }
  await configureHost(ctx, forge, detail.contextRemote);
  if (ctx.env.ENTIRE_CHECKPOINT_TOKEN) {
    ctx.stderr(
      "ENTIRE_CHECKPOINT_TOKEN is set and overrides gitflare's credentials. Unset it, " +
        "or checkpoints will not reach the context repository.\n",
    );
  }

  // Only what HEAD carries can be put back. A settings file the repository
  // does not commit is the clone's own, and `entire enable` may create it.
  const committed: string[] = [];
  for (const path of COMMITTED) {
    if ((await runGit(ctx, ["cat-file", "-e", `HEAD:${path}`])).exitCode === 0)
      committed.push(path);
  }

  // Installs the git hooks now. Left alone, Entire installs them on the first
  // agent prompt, and a commit made before that is not linked to its session.
  const unchanged = (await git(ctx, ["status", "--porcelain", "--", ...committed])) === "";
  const enabled = await ctx.exec(
    "entire",
    ["enable", "--agent", "claude-code", "--telemetry=false"],
    {
      cwd: ctx.cwd,
    },
  );
  if (enabled.exitCode === 127) {
    throw new CliError(
      `The Entire CLI is not installed. Install it (${INSTALL_GUIDE}) and run this again.`,
    );
  }
  if (enabled.exitCode !== 0) {
    throw new CliError(`entire enable failed. ${enabled.stderr.trim()}`.trim());
  }
  // The committed settings are gitflare's. If enabling rewrote them, put them back.
  if (unchanged && (await git(ctx, ["status", "--porcelain", "--", ...committed])) !== "") {
    await git(ctx, ["checkout", "HEAD", "--", ...committed]);
  }

  ctx.stdout(
    "Capture is on in this clone: commits are linked to the session that made them, " +
      "and a push carries its checkpoints.\n",
  );
  return 0;
}
