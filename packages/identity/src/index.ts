import { ForgeError, type Identity, type User, type UserRole } from "@gitflare/core";
import type { Clock, IdentityProvider, IdGenerator } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

// @gitflare/identity — who a request is from, and the user record that
// identity maps to. Production validates the Cloudflare Access JWT itself
// (`ctx.access` is not available to a Worker with static assets); local
// development uses a fixed identity. Facts and signatures:
// spec/research/ai-identity.md. Build task: `identity`.

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE = "CF_Authorization";

export interface AccessOptions {
  /** `https://<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  /** Replaces the global `fetch` for the key set request, in tests. */
  fetch?: typeof fetch;
}

function tokenFromHeaders(headers: { get(name: string): string | null }): string | null {
  const header = headers.get(ACCESS_HEADER);
  if (header) return header;
  const cookie = headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === ACCESS_COOKIE) return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * Validates the `Cf-Access-Jwt-Assertion` header against the team's published
 * keys, issuer and audience, falling back to the `CF_Authorization` cookie.
 * Returns null for a missing, expired or forged token, and for a service
 * token, which carries no user.
 */
export function createAccessIdentity(options: AccessOptions): IdentityProvider {
  const jwks = createRemoteJWKSet(
    new URL(`${options.teamDomain}/cdn-cgi/access/certs`),
    options.fetch ? { [customFetch]: options.fetch } : undefined,
  );

  return {
    async identify(headers) {
      const token = tokenFromHeaders(headers);
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: options.teamDomain,
          audience: options.audience,
        });
        // A service-token request carries an empty `sub` and no user.
        if (!payload.sub) return null;
        if (typeof payload.email !== "string") return null;
        const identity: Identity = { subject: payload.sub, email: payload.email };
        if (typeof payload.name === "string") identity.name = payload.name;
        return identity;
      } catch (error) {
        // Never throws for a bad token, but a key-set fetch failure or a
        // misconfigured `teamDomain` looks identical to a forged token
        // without this: worth a log line to tell them apart. Only the code:
        // jose's claim errors carry the token's payload, `email` included.
        const reason =
          error instanceof errors.JOSEError
            ? error.code
            : error instanceof Error
              ? error.name
              : typeof error;
        console.error(`@gitflare/identity: token did not validate: ${reason}`);
        return null;
      }
    },
  };
}

/**
 * The matching `User` for an identity nobody has seen before: created as a
 * member, or as an administrator when the address is the configured first
 * administrator. Access has already decided this person may log in.
 */
export async function provisionUser(
  deps: { db: Db; clock: Clock; ids: IdGenerator },
  identity: Identity,
  options: { firstAdminEmail: string | null },
): Promise<User> {
  const [organisation] = await deps.db.select().from(schema.organisations).limit(1);
  if (!organisation) throw new ForgeError("not_found", "No organisation for this deployment.");

  const role: UserRole =
    options.firstAdminEmail &&
    identity.email.toLowerCase() === options.firstAdminEmail.toLowerCase()
      ? "admin"
      : "member";
  const now = deps.clock.now();
  const user: User = {
    id: deps.ids.next("user"),
    organisationId: organisation.id,
    subject: identity.subject,
    email: identity.email,
    name: identity.name ?? identity.email,
    role,
    createdAt: now,
    lastSeenAt: now,
  };
  // Two concurrent requests for the same unseen identity both reach here;
  // only one insert wins the `users_subject` unique index, so the loser
  // re-reads instead of surfacing a constraint failure.
  await deps.db
    .insert(schema.users)
    .values(user)
    .onConflictDoNothing({ target: schema.users.subject });
  const [stored] = await deps.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.subject, identity.subject))
    .limit(1);
  if (!stored) throw new ForgeError("unavailable", "Could not provision the user.");
  return stored;
}
