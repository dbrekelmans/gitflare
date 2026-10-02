import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { ManualClock, SequentialIds } from "@gitflare/testing";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  describe("the log line for a token that does not validate", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      ["an expired token", { expiresIn: "-30m" }, "ERR_JWT_EXPIRED"],
      [
        "a token for another audience",
        { audience: "someone-else" },
        "ERR_JWT_CLAIM_VALIDATION_FAILED",
      ],
    ])("names the error for %s and prints none of its claims", async (_name, bad, code) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const identity = createAccessIdentity({
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetch: fetchKeySet,
      });
      const token = await new SignJWT({ sub: "user-sub-secret", email: "private@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuedAt()
        .setIssuer(TEAM_DOMAIN)
        .setAudience("audience" in bad ? bad.audience : AUDIENCE)
        .setExpirationTime("expiresIn" in bad ? bad.expiresIn : "5m")
        .sign(privateKey);

      expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();

      expect(logged).toHaveBeenCalledOnce();
      const printed =
        logged.mock.calls[0]
          ?.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
          .join(" ") ?? "";
      expect(printed).toContain(code);
      expect(printed).not.toContain("private@example.com");
      expect(printed).not.toContain("user-sub-secret");
      expect(logged.mock.calls[0]).toHaveLength(1);
    });
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

  it("returns null for a token forged with a different key", async () => {
    const identity = createAccessIdentity({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: fetchKeySet,
    });
    const forger = await generateKeyPair("RS256");
    // Signed with the right claims and the right `kid`, but the wrong key:
    // the published JWKS entry for `kid` still points at the real public key.
    const token = await new SignJWT({ sub: "user-sub-6", email: "a@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(forger.privateKey);
    expect(await identity.identify(headers({ "Cf-Access-Jwt-Assertion": token }))).toBeNull();
  });
});

describe("provisionUser", () => {
  async function setup() {
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
    return { db, clock: new ManualClock(1000), ids: new SequentialIds() };
  }

  async function userBySubject(db: Awaited<ReturnType<typeof setup>>["db"], subject: string) {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.subject, subject));
    return row;
  }

  it("makes the first-administrator address an admin, and anyone else a member", async () => {
    const deps = await setup();

    const admin = await provisionUser(
      deps,
      { subject: "sub-admin", email: "admin@example.com" },
      { firstAdminEmail: "admin@example.com" },
    );
    expect(admin.role).toBe("admin");
    // A test that only checks the returned role still passes if the insert
    // never happened; check the row landed in the database too.
    await expect(userBySubject(deps.db, "sub-admin")).resolves.toMatchObject({ role: "admin" });

    const member = await provisionUser(
      deps,
      { subject: "sub-member", email: "member@example.com" },
      { firstAdminEmail: "admin@example.com" },
    );
    expect(member.role).toBe("member");
    await expect(userBySubject(deps.db, "sub-member")).resolves.toMatchObject({ role: "member" });
  });

  it("matches the first-administrator address regardless of case", async () => {
    const deps = await setup();
    const admin = await provisionUser(
      deps,
      { subject: "sub-admin", email: "Ada@Acme.example" },
      { firstAdminEmail: "ada@acme.example" },
    );
    expect(admin.role).toBe("admin");
  });

  it("provisions exactly one user for concurrent requests from the same identity", async () => {
    const deps = await setup();
    const identity = { subject: "sub-concurrent", email: "concurrent@example.com" };
    const [a, b, c] = await Promise.all([
      provisionUser(deps, identity, { firstAdminEmail: null }),
      provisionUser(deps, identity, { firstAdminEmail: null }),
      provisionUser(deps, identity, { firstAdminEmail: null }),
    ]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    const rows = await deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.subject, "sub-concurrent"));
    expect(rows).toHaveLength(1);
  });
});
