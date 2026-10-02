import type { HttpErrorBody } from "@gitflare/core/api";
import { accessHeaders, readLogin } from "./auth.ts";
import { type CliContext, CliError } from "./context.ts";

function notSignedIn(forge: string): CliError {
  return new CliError(
    `You are not signed in to ${forge}. Run \`gitflare login ${forge}\`.`,
    "unauthenticated",
  );
}

/**
 * One call to the forge's HTTP surface (`httpRoutes`), as the signed-in user.
 * A refused token is refreshed and tried once more; any other failure is the
 * forge's own message.
 */
export async function forgeRequest<T>(
  ctx: CliContext,
  forge: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const send = async (refresh: boolean) =>
    ctx.fetch(`${forge}${path}`, {
      method: body === undefined ? "GET" : "POST",
      // Access answers a request it does not know with a redirect to its login page.
      redirect: "manual",
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(await accessHeaders(ctx, forge, { refresh })),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const refused = (response: Response) =>
    response.status === 401 || (response.status >= 300 && response.status < 400);

  let response = await send(false);
  if (refused(response) && (await readLogin(ctx, forge))?.kind === "oauth") {
    response = await send(true);
  }
  if (refused(response)) throw notSignedIn(forge);
  if (response.status === 204) return undefined as T;

  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (answer as Partial<HttpErrorBody> | undefined)?.error;
    throw new CliError(
      error?.message ?? `${forge} answered HTTP ${response.status}.`,
      error?.code ?? "unavailable",
    );
  }
  if (answer === undefined) throw new CliError(`${forge} did not answer with JSON.`, "unavailable");
  return answer as T;
}
