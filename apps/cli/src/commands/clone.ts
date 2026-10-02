import { resolve } from "node:path";
import { RepoSlug } from "@gitflare/core";
import { httpRoutes, type RepositoryDetail } from "@gitflare/core/api";
import { forgeOrigin } from "../auth.ts";
import { type CliContext, CliError, UsageError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import { configureHost, git, hostSettings, runGit } from "../git.ts";

export async function clone(ctx: CliContext, args: string[]): Promise<number> {
  const [target, directory, ...rest] = args;
  if (!target || rest.length > 0) throw new UsageError();
  const forge = forgeOrigin(target);
  // The repository's page in the forge (`/repos/<repository>`) names it as well as the short form.
  const repoSlug = new URL(target).pathname.split("/").filter(Boolean).at(-1);
  if (!repoSlug || !RepoSlug.safeParse(repoSlug).success) throw new UsageError();

  const detail = await forgeRequest<RepositoryDetail>(ctx, forge, httpRoutes.repository(repoSlug));
  const { remote, contextRemote } = detail;
  if (!detail.repository.readyAt || !remote || !contextRemote) {
    throw new CliError(`${repoSlug} is still being imported. Try again in a minute.`);
  }

  const into = directory ?? repoSlug;
  // On the command line as well: the clone needs the credential helper before
  // the new repository has a configuration to read it from.
  const settings = hostSettings(forge, remote).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const cloned = await runGit(ctx, [...settings, "clone", remote, into], {
    showProgress: true,
  });
  if (cloned.exitCode !== 0) {
    throw new CliError(cloned.stderr.trim() || `git could not clone ${repoSlug}.`);
  }

  const cwd = resolve(ctx.cwd, into);
  await configureHost(ctx, forge, remote, cwd);
  await configureHost(ctx, forge, contextRemote, cwd);
  await git(ctx, ["config", "gitflare.deployment", forge], { cwd });
  await git(ctx, ["config", "gitflare.repository", repoSlug], { cwd });

  ctx.stdout(`Cloned ${repoSlug} into ${into}.\nStart work there with: gitflare start <title>\n`);
  return 0;
}
