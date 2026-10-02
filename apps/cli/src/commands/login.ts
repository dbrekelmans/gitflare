import { httpRoutes, type MeView } from "@gitflare/core/api";
import { forgeOrigin, loginWithCloudflared, loginWithOAuth } from "../auth.ts";
import { type CliContext, UsageError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import { runGit } from "../git.ts";

export async function login(ctx: CliContext, args: string[]): Promise<number> {
  const viaCloudflared = args.includes("--cloudflared");
  const [target, ...rest] = args.filter((arg) => arg !== "--cloudflared");
  if (!target || rest.length > 0) throw new UsageError();
  const forge = forgeOrigin(target);

  let stored = true;
  if (viaCloudflared) await loginWithCloudflared(ctx, forge);
  else stored = await loginWithOAuth(ctx, forge);

  // The login is only worth keeping if the forge accepts it.
  let me: MeView;
  try {
    me = await forgeRequest<MeView>(ctx, forge, httpRoutes.me);
  } catch (error) {
    if (stored) await ctx.secrets.delete(forge);
    throw error;
  }

  // The forge a command asks when it runs outside a clone.
  const saved = await runGit(ctx, ["config", "--global", "gitflare.deployment", forge]);
  if (saved.exitCode !== 0) {
    ctx.stderr(`Could not record ${forge} in your git configuration: ${saved.stderr.trim()}\n`);
  }
  ctx.stdout(`Signed in to ${me.organisation.name} as ${me.user.name} <${me.user.email}>.\n`);
  return 0;
}
