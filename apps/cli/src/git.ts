import { type CliContext, CliError, type ExecOptions, type ExecOutput } from "./context.ts";

/** How git is told to run this program. Git appends the action: `get`, `store` or `erase`. */
export const CREDENTIAL_HELPER = "!gitflare credential";

/** Runs git in the current directory and returns whatever came of it. */
export function runGit(
  ctx: CliContext,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecOutput> {
  return ctx.exec("git", args, { cwd: ctx.cwd, ...options });
}

/** Runs git and returns what it printed; a failure is git's own message. */
export async function git(
  ctx: CliContext,
  args: string[],
  options: ExecOptions = {},
): Promise<string> {
  const result = await runGit(ctx, args, options);
  if (result.exitCode === 127) throw new CliError("git is not installed.");
  if (result.exitCode !== 0) {
    throw new CliError(result.stderr.trim() || `git ${args[0]} failed.`);
  }
  return result.stdout.trim();
}

/** One value from git's configuration, or null when it is not set. */
export async function configValue(ctx: CliContext, args: string[]): Promise<string | null> {
  const result = await runGit(ctx, ["config", ...args]);
  const value = result.stdout.trim();
  return result.exitCode === 0 && value ? value : null;
}

/**
 * The git configuration that makes one git host gitflare's: this program is
 * its only credential helper, it is asked per repository, and the host is
 * tied to the forge that issues its tokens. In the order git must read them.
 */
export function hostSettings(forge: string, remote: string): [key: string, value: string][] {
  const origin = new URL(remote).origin;
  return [
    // An empty helper clears the ones configured more widely. A keychain helper
    // would store a short-lived token and offer it again after it has expired.
    [`credential.${origin}.helper`, ""],
    [`credential.${origin}.helper`, CREDENTIAL_HELPER],
    // Main, fork and context repositories share a host and take different tokens.
    [`credential.${origin}.useHttpPath`, "true"],
    [`gitflare.${origin}.forge`, forge],
  ];
}

/** Writes `hostSettings` to a clone's own configuration. Safe to repeat. */
export async function configureHost(
  ctx: CliContext,
  forge: string,
  remote: string,
  cwd: string = ctx.cwd,
): Promise<void> {
  const written = new Set<string>();
  for (const [key, value] of hostSettings(forge, remote)) {
    await git(ctx, ["config", written.has(key) ? "--add" : "--replace-all", key, value], { cwd });
    written.add(key);
  }
}

/** The forge whose tokens a git remote takes, or null when the remote is not gitflare's. */
export function forgeForRemote(ctx: CliContext, remote: string): Promise<string | null> {
  return configValue(ctx, ["--get-urlmatch", "gitflare.forge", remote]);
}

/** What `gitflare clone` records in a clone: where it came from. */
export interface Clone {
  forge: string;
  repoSlug: string;
}

export async function readClone(ctx: CliContext): Promise<Clone | null> {
  const forge = await configValue(ctx, ["--local", "--get", "gitflare.deployment"]);
  const repoSlug = await configValue(ctx, ["--local", "--get", "gitflare.repository"]);
  return forge && repoSlug ? { forge, repoSlug } : null;
}

export async function requireClone(ctx: CliContext): Promise<Clone> {
  const clone = await readClone(ctx);
  if (clone) return clone;
  throw new CliError(
    "This is not a gitflare clone. Get one with `gitflare clone <forge-url>/<repository>`.",
  );
}

/** The branch that is checked out, or null on a detached HEAD or outside a repository. */
export async function currentBranch(ctx: CliContext): Promise<string | null> {
  const result = await runGit(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch ? branch : null;
}

/** The session a branch belongs to is kept with the branch, so deleting the branch forgets it. */
export const sessionKey = (branch: string) => `branch.${branch}.gitflareSession`;
