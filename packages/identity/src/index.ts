import { type Identity, notImplemented, type User } from "@gitflare/core";
import type { Clock, IdentityProvider, IdGenerator } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/identity — who a request is from, and the user record that
// identity maps to. Production validates the Cloudflare Access JWT itself
// (`ctx.access` is not available to a Worker with static assets); local
// development uses a fixed identity. Facts and signatures:
// spec/research/ai-identity.md. Build task: `identity`.

export interface AccessOptions {
  /** `https://<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  /** Replaces the global `fetch` for the key set request, in tests. */
  fetch?: typeof fetch;
}

/**
 * Validates the `Cf-Access-Jwt-Assertion` header against the team's published
 * keys, issuer and audience, falling back to the `CF_Authorization` cookie.
 * Returns null for a missing, expired or forged token, and for a service
 * token, which carries no user.
 */
export function createAccessIdentity(_options: AccessOptions): IdentityProvider {
  return notImplemented("@gitflare/identity createAccessIdentity");
}

/**
 * The matching `User` for an identity nobody has seen before: created as a
 * member, or as an administrator when the address is the configured first
 * administrator. Access has already decided this person may log in.
 */
export async function provisionUser(
  _deps: { db: Db; clock: Clock; ids: IdGenerator },
  _identity: Identity,
  _options: { firstAdminEmail: string | null },
): Promise<User> {
  return notImplemented("@gitflare/identity provisionUser");
}
