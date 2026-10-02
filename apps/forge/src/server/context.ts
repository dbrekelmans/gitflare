import { env } from "cloudflare:workers";
import type { ApiContext } from "@gitflare/core/api";
import { authenticate } from "./auth";
import { ensureDevDatabase } from "./dev";
import { getServices } from "./services";

/**
 * The caller of the current request, ready to pass to a `ForgeApi` operation.
 * Server functions get it from the `authed` middleware and server routes from
 * `apiRoute`; both end up here.
 */
export async function requestContext(headers: Headers): Promise<ApiContext> {
  const services = getServices();
  if (services.mode === "dev") await ensureDevDatabase(services, env.DB);
  const user = await authenticate(services, headers, {
    firstAdminEmail: services.mode === "dev" ? null : (env.FIRST_ADMIN_EMAIL ?? null),
  });
  return { user };
}
