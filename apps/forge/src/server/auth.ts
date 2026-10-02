import { ForgeError, type User } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { provisionUser } from "@gitflare/identity";
import { eq } from "drizzle-orm";
import type { Services } from "./services";

/**
 * Who a request is from, as a user of this deployment. Every server function
 * and every authenticated server route goes through here; nothing else reads
 * identity headers.
 *
 * Access has already decided the person may log in. A user gitflare has not
 * seen before is created on the spot by `provisionUser`.
 */
export async function authenticate(
  services: Pick<Services, "db" | "identity" | "clock" | "ids">,
  headers: { get(name: string): string | null },
  options: { firstAdminEmail: string | null },
): Promise<User> {
  const identity = await services.identity.identify(headers);
  if (!identity) throw new ForgeError("unauthenticated", "Sign in to continue.");
  const [user] = await services.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.subject, identity.subject))
    .limit(1);
  return user ?? provisionUser(services, identity, options);
}
