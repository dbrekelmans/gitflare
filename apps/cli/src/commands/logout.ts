import { forgeOrigin, readLogin } from "../auth.ts";
import { type CliContext, CliError, UsageError } from "../context.ts";
import { configValue, readClone, runGit } from "../git.ts";

/**
 * Forgets the login for a forge: the clone's, or the one last signed in to.
 * The refresh token is dropped from the keychain, not revoked: Access's
 * revocation endpoint is in its metadata but has not been tried (live test #12).
 */
export async function logout(ctx: CliContext, args: string[]): Promise<number> {
  if (args.length > 1) throw new UsageError();
  const forge = args[0]
    ? forgeOrigin(args[0])
    : ((await readClone(ctx))?.forge ?? (await configValue(ctx, ["--get", "gitflare.deployment"])));
  if (!forge) throw new CliError("You are not signed in to any forge.");

  const login = await readLogin(ctx, forge);
  await ctx.secrets.delete(forge);
  if ((await configValue(ctx, ["--global", "--get", "gitflare.deployment"])) === forge) {
    await runGit(ctx, ["config", "--global", "--unset", "gitflare.deployment"]);
  }

  if (!login) {
    ctx.stdout(`You were not signed in to ${forge}.\n`);
  } else if (login.kind === "cloudflared") {
    ctx.stdout(`Signed out of ${forge}. cloudflared keeps its own token until its session ends.\n`);
  } else {
    ctx.stdout(`Signed out of ${forge}.\n`);
  }
  return 0;
}
