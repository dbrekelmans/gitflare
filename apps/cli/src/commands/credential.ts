import { type GitCredential, httpRoutes } from "@gitflare/core/api";
import { type CliContext, CliError } from "../context.ts";
import { forgeRequest } from "../forge.ts";
import { forgeForRemote } from "../git.ts";

/** Git's credential protocol: `key=value` lines, ended by a blank line. */
function parseRequest(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1).replace(/\r$/, ""));
  }
  return fields;
}

/**
 * Git runs this before it talks to a remote. For a gitflare remote it answers
 * with a short-lived token for that one repository; for anything else it says
 * nothing, and git goes on to whatever it would have done.
 */
export async function credential(ctx: CliContext, args: string[]): Promise<number> {
  // Tokens are minted per use and kept nowhere, so there is nothing to store or erase.
  if (args[0] !== "get") return 0;

  const request = parseRequest(await ctx.stdin());
  const host = request.get("host");
  if (request.get("protocol") !== "https" || !host) return 0;
  const path = request.get("path");
  const remote = `https://${host}/${path ?? ""}`;
  const forge = await forgeForRemote(ctx, remote);
  if (!forge) return 0;

  try {
    if (!path) {
      throw new CliError(
        `git did not say which repository on ${host} it wants. ` +
          `Set it up with: git config credential.https://${host}.useHttpPath true`,
      );
    }
    const issued = await forgeRequest<GitCredential>(ctx, forge, httpRoutes.gitCredentials, {
      remote,
    });
    if (/[\n\r\0]/.test(issued.username + issued.password)) {
      throw new CliError(`${forge} issued a credential git cannot be given.`);
    }
    ctx.stdout(
      `username=${issued.username}\n` +
        `password=${issued.password}\n` +
        `password_expiry_utc=${Math.floor(issued.expiresAt / 1000)}\n`,
    );
    return 0;
  } catch (error) {
    // Without this git would ask for a username at the terminal, which no one has.
    ctx.stdout("quit=true\n");
    ctx.stderr(`gitflare: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
