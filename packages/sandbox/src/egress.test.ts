import { ForgeError } from "@gitflare/core";
import type { EgressGrant } from "@gitflare/core/ports";
import { createFakePorts } from "@gitflare/testing";
import { describe, expect, it } from "vitest";
import {
  createGitTokenCache,
  decideEgress,
  type EgressDeps,
  type EgressTargets,
  egressMode,
  forwardEgress,
  type ModelEgressCall,
  resolveEgressTargets,
} from "./egress";

const HOST = "https://0123456789abcdef.artifacts.cloudflare.net";
const FORK = "forge.fork.01ABC";
const forkRemote = `${HOST}/git/gitflare/${FORK}.git`;
const mainRemote = `${HOST}/git/gitflare/forge.git`;

const targets: EgressTargets = {
  gitRemotes: { [FORK]: forkRemote, forge: mainRemote },
  models: { host: "gateway.ai.cloudflare.com", gatewayId: "gitflare" },
};

const forkWrite: EgressGrant = { kind: "git", repo: FORK, scope: "write" };
const mainRead: EgressGrant = { kind: "git", repo: "forge", scope: "read" };
const models: EgressGrant = {
  kind: "models",
  attribution: { agent: "session", userId: "usr_1", sessionId: "ses_1" },
};
const registry: EgressGrant = { kind: "host", host: "registry.npmjs.org" };

const allows = (grants: EgressGrant[], method: string, url: string) =>
  decideEgress(grants, { method, url }, targets).allow;

describe("git", () => {
  it("allows a fetch from a repository granted for reading, with a read token", () => {
    for (const [method, path] of [
      ["GET", "info/refs?service=git-upload-pack"],
      ["POST", "git-upload-pack"],
    ] as const) {
      expect(decideEgress([mainRead], { method, url: `${mainRemote}/${path}` }, targets)).toEqual({
        allow: true,
        removeHeaders: ["authorization", "x-api-key", "cf-aig-authorization"],
        credential: { kind: "git", repo: "forge", scope: "read" },
      });
    }
  });

  it("allows a push only where the grant is for writing, and asks for a write token only then", () => {
    const advertise = `info/refs?service=git-receive-pack`;
    expect(allows([mainRead], "GET", `${mainRemote}/${advertise}`)).toBe(false);
    expect(allows([mainRead], "POST", `${mainRemote}/git-receive-pack`)).toBe(false);

    expect(
      decideEgress([forkWrite], { method: "POST", url: `${forkRemote}/git-receive-pack` }, targets)
        .credential,
    ).toEqual({ kind: "git", repo: FORK, scope: "write" });
    expect(allows([forkWrite], "GET", `${forkRemote}/${advertise}`)).toBe(true);
    // A fetch under a write grant still gets the weaker token.
    expect(
      decideEgress([forkWrite], { method: "POST", url: `${forkRemote}/git-upload-pack` }, targets)
        .credential,
    ).toEqual({ kind: "git", repo: FORK, scope: "read" });
  });

  it("scopes a grant to its repository: a session cannot reach the repository it was forked from", () => {
    expect(allows([forkWrite], "GET", `${mainRemote}/info/refs?service=git-upload-pack`)).toBe(
      false,
    );
    expect(allows([forkWrite], "POST", `${mainRemote}/git-receive-pack`)).toBe(false);
    // Nor a repository whose name merely starts the same way, or one that is not gitflare's.
    expect(allows([mainRead], "POST", `${HOST}/git/gitflare/forge.git.evil/git-upload-pack`)).toBe(
      false,
    );
    expect(
      allows([mainRead], "POST", `${HOST}/git/gitflare/forge.context.git/git-upload-pack`),
    ).toBe(false);
    expect(allows([mainRead], "POST", `${HOST}/git/other/forge.git/git-upload-pack`)).toBe(false);
  });

  it("holds a repository to its own grant when several are granted", () => {
    const grants = [mainRead, forkWrite];
    expect(allows(grants, "POST", `${mainRemote}/git-upload-pack`)).toBe(true);
    expect(allows(grants, "POST", `${forkRemote}/git-receive-pack`)).toBe(true);
    expect(allows(grants, "POST", `${mainRemote}/git-receive-pack`)).toBe(false);
  });

  it("allows nothing on the git host but the four smart HTTP requests", () => {
    const refused: [string, string][] = [
      ["GET", `${forkRemote}/info/refs`],
      ["GET", `${forkRemote}/info/refs?service=git-upload-archive`],
      ["POST", `${forkRemote}/info/refs?service=git-upload-pack`],
      ["GET", `${forkRemote}/git-upload-pack`],
      ["DELETE", `${forkRemote}/git-receive-pack`],
      ["GET", `${forkRemote}/HEAD`],
      ["GET", `${forkRemote}/objects/info/packs`],
      ["GET", `${forkRemote}`],
      ["GET", `${HOST}/v1/api/repos`],
      ["POST", `${forkRemote}/../forge.git/git-receive-pack`],
      ["POST", `${forkRemote}/%2e%2e/forge.git/git-receive-pack`],
    ];
    for (const [method, url] of refused)
      expect([url, allows([forkWrite], method, url)]).toEqual([url, false]);
  });

  it("never adds a token on another host, another port, or plain HTTP", () => {
    const path = `/git/gitflare/${FORK}.git/git-upload-pack`;
    for (const origin of [
      "https://evil.example",
      "https://0123456789abcdef.artifacts.cloudflare.net.evil.example",
      "https://0123456789abcdef.artifacts.cloudflare.net:8443",
      "http://0123456789abcdef.artifacts.cloudflare.net",
    ]) {
      const decision = decideEgress(
        [forkWrite],
        { method: "POST", url: `${origin}${path}` },
        targets,
      );
      expect([origin, decision.allow, decision.credential]).toEqual([origin, false, undefined]);
    }
  });

  it("does not let a host grant open the git host", () => {
    const wide: EgressGrant = { kind: "host", host: "*.artifacts.cloudflare.net" };
    expect(
      allows([wide, forkWrite], "GET", `${mainRemote}/info/refs?service=git-upload-pack`),
    ).toBe(false);
    expect(allows([wide, forkWrite], "GET", `${HOST}/anything`)).toBe(false);
  });
});

describe("model calls", () => {
  const url = "https://gateway.ai.cloudflare.com/v1/acct/gitflare/anthropic/v1/messages?beta=true";

  it("allows a call to the deployment's gateway and names who it is for", () => {
    expect(decideEgress([models], { method: "POST", url }, targets)).toEqual({
      allow: true,
      removeHeaders: ["authorization", "x-api-key", "cf-aig-authorization"],
      credential: {
        kind: "models",
        attribution: { agent: "session", userId: "usr_1", sessionId: "ses_1" },
        provider: "anthropic",
        endpoint: "v1/messages?beta=true",
      },
    });
  });

  it("refuses them without a model grant, whatever else is granted", () => {
    const wide: EgressGrant = { kind: "host", host: "*.cloudflare.com" };
    expect(allows([forkWrite, registry, wide], "POST", url)).toBe(false);
  });

  it("refuses another gateway, another method, and a path that is not a provider call", () => {
    const base = "https://gateway.ai.cloudflare.com";
    expect(allows([models], "POST", `${base}/v1/acct/someone-elses/anthropic/v1/messages`)).toBe(
      false,
    );
    expect(allows([models], "GET", url)).toBe(false);
    expect(allows([models], "HEAD", `${base}/api/hello`)).toBe(false);
    expect(allows([models], "POST", `${base}/v1/acct/gitflare/anthropic`)).toBe(false);
    expect(allows([models], "POST", `${base}/v1/acct/gitflare`)).toBe(false);
    expect(allows([models], "POST", url.replace("https:", "http:"))).toBe(false);
  });
});

describe("hosts", () => {
  it("allows reading from a granted host and adds nothing", () => {
    expect(
      decideEgress(
        [registry],
        { method: "GET", url: "https://registry.npmjs.org/left-pad" },
        targets,
      ),
    ).toEqual({ allow: true });
    expect(allows([registry], "HEAD", "https://registry.npmjs.org/left-pad")).toBe(true);
    expect(allows([registry], "get", "https://REGISTRY.npmjs.org/left-pad")).toBe(true);
  });

  it("refuses every other host", () => {
    for (const url of [
      "https://example.com/",
      "https://npmjs.org/",
      "https://registry.npmjs.org.evil.example/left-pad",
      "https://evil.example/registry.npmjs.org",
      "https://registry.npmjs.org:8443/left-pad",
      "http://registry.npmjs.org/left-pad",
    ]) {
      expect([url, allows([registry], "GET", url)]).toEqual([url, false]);
    }
  });

  it("refuses the methods that send data out", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT"]) {
      expect([
        method,
        allows([registry], method, "https://registry.npmjs.org/-/npm/v1/security/audits"),
      ]).toEqual([method, false]);
    }
  });

  it("matches a glob against whole host names", () => {
    const glob: EgressGrant = { kind: "host", host: "*.npmjs.org" };
    expect(allows([glob], "GET", "https://registry.npmjs.org/x")).toBe(true);
    expect(allows([glob], "GET", "https://a.b.npmjs.org/x")).toBe(true);
    expect(allows([glob], "GET", "https://npmjs.org/x")).toBe(false);
    expect(allows([glob], "GET", "https://registry.npmjs.org.evil.example/x")).toBe(false);
    // A dot in a pattern is a dot.
    expect(allows([{ kind: "host", host: "a.example" }], "GET", "https://axexample/")).toBe(false);
  });

  it("reads only a leading *. as a glob, even in a grant that skipped validation", () => {
    for (const host of ["**", "*.*", "*", "*npmjs.org", "registry.*"]) {
      for (const url of ["https://registry.npmjs.org/x", "https://evil.example/x"]) {
        expect([host, url, allows([{ kind: "host", host }], "GET", url)]).toEqual([
          host,
          url,
          false,
        ]);
      }
    }
  });

  it("allows nothing with no grants, and nothing that is not a URL", () => {
    expect(allows([], "GET", "https://registry.npmjs.org/left-pad")).toBe(false);
    expect(allows([registry], "GET", "registry.npmjs.org")).toBe(false);
    // Without targets no request can earn a credential.
    expect(
      decideEgress([forkWrite, models], { method: "POST", url: `${forkRemote}/git-upload-pack` })
        .allow,
    ).toBe(false);
  });
});

describe("the network mode", () => {
  it("is intercepted unless open Internet access is asked for by name", () => {
    expect(egressMode({ egress: [] })).toBe("intercepted");
    expect(egressMode({ egress: [forkWrite, models, registry] })).toBe("intercepted");
    expect(egressMode({ egress: [{ kind: "host", host: "*.npmjs.org" }] })).toBe("intercepted");
    expect(egressMode({ egress: [], openInternet: true })).toBe("open");
  });

  it("refuses a grant of every host, which used to mean open", () => {
    expect(() => egressMode({ egress: [{ kind: "host", host: "*" }] })).toThrow(ForgeError);
    expect(() => egressMode({ egress: [{ kind: "host", host: "*" }, registry] })).toThrow(
      ForgeError,
    );
  });

  it("refuses every other pattern that is not a host name, or one with a leading *.", () => {
    for (const host of [
      "**",
      "*.*",
      "*.",
      "* ",
      "*.*.org",
      "registry.*",
      "*npmjs.org",
      "re*.npmjs.org",
      "localhost",
      "",
    ]) {
      expect(() => egressMode({ egress: [{ kind: "host", host }] }), host).toThrow(ForgeError);
    }
  });

  it("is never open for a sandbox that is also handed a grant", () => {
    for (const grant of [forkWrite, models, registry]) {
      expect(() => egressMode({ egress: [grant], openInternet: true })).toThrow(ForgeError);
    }
  });
});

describe("forwarding", () => {
  function setup(overrides: Partial<EgressDeps> = {}) {
    const fetched: Request[] = [];
    const modelCalls: ModelEgressCall[] = [];
    const minted: string[] = [];
    const deps: EgressDeps = {
      gitToken: async (repo, scope) => {
        minted.push(`${scope} ${repo}`);
        return `token-for-${repo}`;
      },
      models: async (call) => {
        modelCalls.push(call);
        return Response.json({ type: "message" });
      },
      fetch: async (request) => {
        fetched.push(request);
        return new Response("upstream");
      },
      ...overrides,
    };
    return { deps, fetched, modelCalls, minted };
  }

  it("adds the repository's token to a git request and passes the body through", async () => {
    const { deps, fetched, minted } = setup();
    const request = new Request(`${forkRemote}/git-receive-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        authorization: "Basic c3RvbGVuOnRva2Vu",
      },
      body: "0000PACK",
    });

    const response = await forwardEgress(deps, { grants: [forkWrite], targets }, request);

    expect(await response.text()).toBe("upstream");
    expect(minted).toEqual([`write ${FORK}`]);
    const [sent] = fetched;
    expect(sent?.url).toBe(`${forkRemote}/git-receive-pack`);
    expect(sent?.method).toBe("POST");
    // The container's own credential is replaced, never forwarded alongside.
    expect(sent?.headers.get("authorization")).toBe(`Bearer token-for-${FORK}`);
    expect(sent?.headers.get("content-type")).toBe("application/x-git-receive-pack-request");
    expect(await sent?.text()).toBe("0000PACK");
  });

  it("answers 403 without minting or fetching when the request is not granted", async () => {
    const { deps, fetched, minted, modelCalls } = setup();
    const request = new Request(`${mainRemote}/git-receive-pack`, { method: "POST", body: "x" });

    const response = await forwardEgress(deps, { grants: [forkWrite], targets }, request);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Forbidden by gitflare");
    expect([fetched, minted, modelCalls]).toEqual([[], [], []]);
  });

  it("makes a model call with the forge's authorisation and the grant's attribution", async () => {
    const { deps, fetched, modelCalls } = setup();
    const body = { model: "claude-sonnet-5", max_tokens: 16, messages: [] };
    const request = new Request(
      "https://gateway.ai.cloudflare.com/v1/acct/gitflare/anthropic/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "provided-by-worker",
          "cf-aig-metadata": '{"userId":"usr_someone_else"}',
          "user-agent": "claude-cli",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await forwardEgress(deps, { grants: [models], targets }, request);

    expect(await response.json()).toEqual({ type: "message" });
    expect(fetched).toEqual([]);
    // The placeholder key and the container's own metadata stay behind.
    expect(modelCalls).toEqual([
      {
        provider: "anthropic",
        endpoint: "v1/messages",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body,
        attribution: { agent: "session", userId: "usr_1", sessionId: "ses_1" },
      },
    ]);
  });

  it("refuses a model call without a JSON body", async () => {
    const { deps, modelCalls } = setup();
    const request = new Request(
      "https://gateway.ai.cloudflare.com/v1/acct/gitflare/anthropic/v1/messages",
      { method: "POST", body: "not json" },
    );
    expect((await forwardEgress(deps, { grants: [models], targets }, request)).status).toBe(400);
    expect(modelCalls).toEqual([]);
  });

  it("passes a request to a granted host through unchanged", async () => {
    const { deps, fetched, minted } = setup();
    const request = new Request("https://registry.npmjs.org/left-pad", {
      headers: { accept: "application/json", authorization: "Bearer the-users-own" },
    });

    await forwardEgress(deps, { grants: [registry], targets }, request);

    expect(minted).toEqual([]);
    expect(fetched[0]?.url).toBe("https://registry.npmjs.org/left-pad");
    expect(fetched[0]?.headers.get("authorization")).toBe("Bearer the-users-own");
  });

  describe("a redirect", () => {
    /** `fetch` as the runtime does it: a `follow` request is followed with every header it had. */
    function redirecting(location: string) {
      const sent: Request[] = [];
      const fetch = async (request: Request): Promise<Response> => {
        sent.push(request);
        if (sent.length > 1) return new Response("followed");
        const moved = new Response(null, { status: 302, headers: { location } });
        if (request.redirect !== "follow") return moved;
        return fetch(new Request(location, request));
      };
      return { sent, fetch };
    }

    it("goes back to the container, so a git token never follows it to another host", async () => {
      const { deps, minted } = setup();
      const { sent, fetch } = redirecting("https://evil.example/steal");
      const request = new Request(`${forkRemote}/info/refs?service=git-upload-pack`);

      const response = await forwardEgress(
        { ...deps, fetch },
        { grants: [forkWrite], targets },
        request,
      );

      expect(minted).toEqual([`read ${FORK}`]);
      expect(sent.map((one) => one.url)).toEqual([
        `${forkRemote}/info/refs?service=git-upload-pack`,
      ]);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://evil.example/steal");
    });

    it("from a granted host is not followed to a host nobody granted", async () => {
      const { deps } = setup();
      const { sent, fetch } = redirecting("https://evil.example/payload");
      const request = new Request("https://registry.npmjs.org/left-pad");

      const response = await forwardEgress(
        { ...deps, fetch },
        { grants: [registry], targets },
        request,
      );

      expect(sent.map((one) => one.url)).toEqual(["https://registry.npmjs.org/left-pad"]);
      expect(response.status).toBe(302);
      // Followed by the container, the next request meets the policy again.
      const next = await forwardEgress(
        deps,
        { grants: [registry], targets },
        new Request(response.headers.get("location") ?? ""),
      );
      expect(next.status).toBe(403);
    });
  });

  it("answers 502 when the request cannot be forwarded", async () => {
    const { deps } = setup({
      gitToken: async () => {
        throw new Error("Namespace is not active");
      },
    });
    const request = new Request(`${forkRemote}/info/refs?service=git-upload-pack`);
    const response = await forwardEgress(deps, { grants: [forkWrite], targets }, request);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Namespace is not active");
  });
});

describe("resolving targets", () => {
  it("takes each granted repository's remote from the git host", async () => {
    const { git } = createFakePorts();
    const fork = await git.createRepo(FORK);
    const main = await git.createRepo("forge");
    const gateway = { host: "gateway.ai.cloudflare.com", gatewayId: "gitflare" };

    const resolved = await resolveEgressTargets(
      { git },
      [forkWrite, mainRead, models, registry, forkWrite],
      gateway,
    );

    expect(resolved).toEqual({
      gitRemotes: { [FORK]: fork.remote, forge: main.remote },
      models: gateway,
    });
    // And what it resolved is what the policy then recognises.
    expect(
      decideEgress(
        [forkWrite],
        { method: "POST", url: `${fork.remote}/git-receive-pack` },
        resolved,
      ).allow,
    ).toBe(true);
    expect(
      decideEgress(
        [forkWrite],
        { method: "POST", url: `${main.remote}/git-receive-pack` },
        resolved,
      ).allow,
    ).toBe(false);
  });

  it("refuses a grant for a repository that does not exist", async () => {
    const { git } = createFakePorts();
    await expect(resolveEgressTargets({ git }, [forkWrite])).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("the token cache", () => {
  function setup() {
    let now = 1_000_000;
    const minted: [string, string][] = [];
    const gitToken = createGitTokenCache({
      mint: async (repo, scope) => {
        minted.push([repo, scope]);
        return { secret: `secret-${minted.length}`, expiresAt: now + 600_000 };
      },
      clock: { now: () => now },
    });
    return { gitToken, minted, advance: (ms: number) => (now += ms) };
  }

  it("mints once for the requests of one clone, and separately per repository and scope", async () => {
    const { gitToken, minted } = setup();
    expect(await gitToken("forge", "read")).toBe("secret-1");
    expect(await gitToken("forge", "read")).toBe("secret-1");
    expect(await gitToken("forge", "write")).toBe("secret-2");
    expect(await gitToken(FORK, "read")).toBe("secret-3");
    expect(minted.map(([repo, scope]) => `${scope} ${repo}`)).toEqual([
      "read forge",
      "write forge",
      `read ${FORK}`,
    ]);
  });

  it("mints again before a token expires, not after", async () => {
    const { gitToken, advance } = setup();
    await gitToken("forge", "read");
    advance(8 * 60_000);
    expect(await gitToken("forge", "read")).toBe("secret-1");
    advance(90_000);
    expect(await gitToken("forge", "read")).toBe("secret-2");
  });

  it("does not keep a failed mint", async () => {
    let attempts = 0;
    const gitToken = createGitTokenCache({
      mint: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("upstream unavailable");
        return { secret: "secret", expiresAt: 10_000_000 };
      },
      clock: { now: () => 0 },
    });
    await expect(gitToken("forge", "read")).rejects.toThrow("upstream unavailable");
    expect(await gitToken("forge", "read")).toBe("secret");
  });
});
