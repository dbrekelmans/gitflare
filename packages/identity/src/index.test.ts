import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createAccessIdentity, provisionUser } from "./index";

const TEAM_DOMAIN = "https://gitflare-test.cloudflareaccess.com";
const AUDIENCE = "aud-tag-for-gitflare";
const KID = "test-key";

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries));
  return { get: (name) => map.get(name) ?? null };
}

describe("createAccessIdentity", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let fetchKeySet: typeof fetch;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    const jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
    fetchKeySet = (async () => new Response(JSON.stringify(jwks), { status: 200 })) as typeof fetch;
  });

  function sign(claims: Record<string, unknown>, options: { expiresIn?: string } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE)
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);
  }

  it("validates a token signed with the test key", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await sign({ sub: "user-sub-1", email: "maya@example.com", name: "Maya" });
    const result = await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }));
    expect(result).toEqual({ subject: "user-sub-1", email: "maya@example.com", name: "Maya" });
  });

  it("falls back to the CF_Authorization cookie", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await sign({ sub: "user-sub-2", email: "jonas@example.com" });
    const result = await identity.identify(
      headers({ Cookie: `other=1; CF_Authorization=${token}; more=2` }),
    );
    expect(result?.subject).toBe("user-sub-2");
  });

  it("returns null for the wrong audience", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await new SignJWT({ sub: "user-sub-3", email: "a@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEAM_DOMAIN)
      .setAudience("some-other-audience")
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();
  });

  it("returns null for the wrong issuer", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await new SignJWT({ sub: "user-sub-4", email: "a@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer("https://someone-else.cloudflareaccess.com")
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await new SignJWT({ sub: "user-sub-5", email: "a@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);
    expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();
  });

  it("returns null for a service token, which carries no user", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const token = await sign({ sub: "", common_name: "a-service-client-id" });
    expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();
  });

  it("returns null when there is no token at all", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    expect(await identity.identify(headers({}))).toBeNull();
  });
});

describe("provisionUser", () => {
  it("makes the first-administrator address an admin, and anyone else a member", async () => {
    const db = createTestDb();
    await db.insert(schema.organisations).values({
      id: "org_000001",
      name: "Acme",
      slug: "acme",
      settings: {
        monthlyBudgetMicroUsd: 0,
        perChangeBudgetMicroUsd: 0,
        models: {
          intent: "m",
          sections: "m",
          review: "m",
          thread: "m",
          decisions: "m",
          session: "m",
          embedding: "m",
          fallbacks: [],
        },
        workspace: { image: "img", snapshot: null },
      },
      createdAt: 0,
    });

    const clock = { now: () => 1000 };
    let nextId = 0;
    const ids = { next: () => `usr_${String(++nextId).padStart(6, "0")}` };
    const deps = { db, clock, ids } as Parameters<typeof provisionUser>[0];

    const admin = await provisionUser(
      deps,
      { subject: "sub-admin", email: "admin@example.com" },
      { firstAdminEmail: "admin@example.com" },
    );
    expect(admin.role).toBe("admin");

    const member = await provisionUser(
      deps,
      { subject: "sub-member", email: "member@example.com" },
      { firstAdminEmail: "admin@example.com" },
    );
    expect(member.role).toBe("member");
  });
});
