import { httpRoutes, type MeView, type SessionView } from "@gitflare/core/api";
import { type CliContext, CliError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import { configValue, currentBranch, readClone, sessionKey } from "../git.ts";

function describeSession(view: SessionView, branch: string): string[] {
  const { session, change } = view;
  const state =
    session.status !== "active"
      ? session.status
      : session.forkReadyAt
        ? "active"
        : "its fork is still being prepared";
  return [
    `Session: "${session.title}" on ${branch} (${state})`,
    change
      ? `Change: #${change.number} ${change.title} (${change.status})`
      : `Change: none yet. Push ${branch} to open one.`,
  ];
}

export async function status(ctx: CliContext): Promise<number> {
  const clone = await readClone(ctx);
  const forge = clone?.forge ?? (await configValue(ctx, ["--get", "gitflare.deployment"]));
  if (!forge) throw new CliError("You are not signed in. Run `gitflare login <forge-url>`.");

  const me = await forgeRequest<MeView>(ctx, forge, httpRoutes.me);
  const lines = [
    `Signed in to ${me.organisation.name} (${forge}) as ${me.user.name} <${me.user.email}>.`,
  ];

  if (clone) {
    lines.push(`Repository: ${clone.repoSlug}`);
    const branch = await currentBranch(ctx);
    const sessionId = branch && (await configValue(ctx, ["--local", "--get", sessionKey(branch)]));
    if (branch && sessionId) {
      const view = await forgeRequest<SessionView>(ctx, forge, httpRoutes.session(sessionId));
      lines.push(...describeSession(view, branch));
    } else {
      lines.push("Session: none on this branch. Start one with: gitflare start <title>");
    }
  }

  ctx.stdout(`${lines.join("\n")}\n`);
  return 0;
}
