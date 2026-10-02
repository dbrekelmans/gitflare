import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactsGitHost } from "./host";
import { LocalArtifacts } from "./testing/local-artifacts";

// These tests run real git; a slow machine needs more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const decoder = new TextDecoder();

let artifacts: LocalArtifacts;
beforeEach(() => {
  artifacts = new LocalArtifacts();
});
afterEach(() => artifacts.cleanup());

describe("createArtifactsGitHost", () => {
  it("creates a repository and reports it with the host's own remote", async () => {
    const git = createArtifactsGitHost(artifacts);
    const created = await git.createRepo("app", { defaultBranch: "trunk" });
    expect(created).toEqual({
      name: "app",
      remote: artifacts.remote("app"),
      defaultBranch: "trunk",
      status: "ready",
      source: null,
    });
    expect(await git.getRepo("app")).toEqual(created);
    expect(await git.getRepo("nope")).toBeNull();
    await expect(git.createRepo("app")).rejects.toMatchObject({ code: "conflict" });
  });

  it("reads commits, trees, blobs and files, with times in milliseconds", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("app");
    const first = artifacts.commit("app", "main", { "README.md": "hi\n" }, { at: 1_790_000_000 });
    const second = artifacts.commit(
      "app",
      "main",
      { "src/a.ts": "a\n" },
      { message: "Add a\n\nEntire-Checkpoint: X", at: 1_790_000_100 },
    );

    expect(await git.readCommit("app", second)).toEqual({
      sha: second,
      treeSha: artifacts.git("app", "rev-parse", `${second}^{tree}`),
      parents: [first],
      message: "Add a\n\nEntire-Checkpoint: X",
      author: { name: "Dev", email: "dev@example.com" },
      committer: { name: "Dev", email: "dev@example.com" },
      authoredAt: 1_790_000_100_000,
      committedAt: 1_790_000_100_000,
    });
    expect((await git.log("app", { ref: "main" })).map((c) => c.sha)).toEqual([second, first]);
    expect((await git.log("app", { ref: "main", limit: 1, offset: 1 })).map((c) => c.sha)).toEqual([
      first,
    ]);

    const commit = await git.readCommit("app", second);
    const root = await git.readTree("app", commit?.treeSha ?? "");
    expect(root?.map((entry) => [entry.name, entry.mode, entry.type])).toEqual([
      ["README.md", "100644", "blob"],
      ["src", "40000", "tree"],
    ]);
    const readme = root?.find((entry) => entry.name === "README.md");
    expect(decoder.decode((await git.readBlob("app", readme?.sha ?? "")) ?? undefined)).toBe(
      "hi\n",
    );
    const file = await git.readFile("app", { ref: "main", path: "src/a.ts" });
    expect(decoder.decode(file ?? undefined)).toBe("a\n");
    expect(await git.readFile("app", { ref: "main", path: "src" })).toBeNull();
    expect(await git.readFile("app", { ref: "main", path: "missing" })).toBeNull();
  });

  it("resolves a branch by short or full name and a commit by id, and nothing else", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("app");
    const tip = artifacts.commit("app", "main", { a: "1" });
    artifacts.git("app", "update-ref", "refs/entire/checkpoints/AB/X", tip);

    expect(await git.resolveRef("app", "main")).toBe(tip);
    // The binding itself returns nothing for a full ref name; the adapter shortens it.
    expect(await git.resolveRef("app", "refs/heads/main")).toBe(tip);
    expect(await git.resolveRef("app", tip)).toBe(tip);
    expect(await git.resolveRef("app", "refs/entire/checkpoints/AB/X")).toBeNull();
    expect(await git.resolveRef("app", "0".repeat(40))).toBeNull();
    expect(await git.resolveRef("app", "nope")).toBeNull();
    expect(await git.resolveRef("missing-repo", "main")).toBeNull();
    // A short hash makes the binding throw; the port answers null.
    expect(await git.readCommit("app", tip.slice(0, 7))).toBeNull();
  });

  it("mints a token git accepts as a password, and revokes it", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("app");
    const before = Date.now();
    const token = await git.mintToken("app", "read", 120);
    expect(token.scope).toBe("read");
    expect(token.secret).not.toContain("?expires=");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 121_000);

    const refs = () =>
      artifacts.fetch(`${artifacts.remote("app")}/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${token.secret}` },
      });
    expect((await refs()).status).toBe(200);
    expect(await git.revokeToken("app", token.id)).toBe(true);
    expect((await refs()).status).toBe(403);
    expect(await git.revokeToken("app", token.id)).toBe(false);

    await expect(git.mintToken("app", "read", 30)).rejects.toMatchObject({ code: "invalid" });
    await expect(git.mintToken("nope", "read", 120)).rejects.toMatchObject({ code: "not_found" });
  });

  it("forks every ref, and reports FORK_IN_PROGRESS as a fork that is not ready", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("app");
    const tip = artifacts.commit("app", "main", { a: "1" });
    artifacts.commit("app", "side", { b: "1" }, { from: "main" });

    artifacts.holdCopies = true;
    const fork = await git.forkRepo("app", "app.fork.1");
    expect(fork).toMatchObject({
      name: "app.fork.1",
      status: "forking",
      remote: artifacts.remote("app.fork.1"),
    });
    expect((await git.getRepo("app.fork.1"))?.status).toBe("forking");
    // Nothing can be read from it yet, and that is not an error.
    expect(await git.resolveRef("app.fork.1", "main")).toBeNull();
    expect(await git.log("app.fork.1", { ref: "main" })).toEqual([]);
    await expect(git.mintToken("app.fork.1", "write", 120)).rejects.toMatchObject({
      code: "not_ready",
    });

    artifacts.finish("app.fork.1");
    expect(await git.getRepo("app.fork.1")).toMatchObject({
      status: "ready",
      source: "artifacts:gitflare-test/app",
      defaultBranch: "main",
    });
    expect(await git.resolveRef("app.fork.1", "main")).toBe(tip);
    expect(await git.resolveRef("app.fork.1", "side")).not.toBeNull();
    await expect(git.forkRepo("app", "app.fork.1")).rejects.toMatchObject({ code: "conflict" });
    await expect(git.forkRepo("nope", "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports an in-progress repository another isolate started, without a remote", async () => {
    await createArtifactsGitHost(artifacts).createRepo("app");
    artifacts.holdCopies = true;
    await createArtifactsGitHost(artifacts).forkRepo("app", "app.fork.2");
    const other = createArtifactsGitHost(artifacts);
    expect(await other.getRepo("app.fork.2")).toMatchObject({ status: "forking", remote: "" });
  });

  it("imports, and reports the import while it runs", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("upstream");
    const tip = artifacts.commit("upstream", "main", { a: "1" });
    artifacts.upstreams.set("https://example.com/x.git", "upstream");

    artifacts.holdCopies = true;
    const imported = await git.importRepo("app", { url: "https://example.com/x.git" });
    expect(imported).toMatchObject({ status: "importing", source: "https://example.com/x.git" });
    artifacts.finish("app");
    expect(await git.getRepo("app")).toMatchObject({
      status: "ready",
      source: "https://example.com/x.git",
    });
    expect(await git.resolveRef("app", "main")).toBe(tip);
    await expect(
      git.importRepo("other", { url: "https://example.com/gone.git" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("deletes a repository and its tokens", async () => {
    const git = createArtifactsGitHost(artifacts);
    await git.createRepo("app");
    expect(await git.deleteRepo("app")).toBe(true);
    expect(await git.getRepo("app")).toBeNull();
    expect(await git.deleteRepo("app")).toBe(false);
  });

  it("recognises an error by its numeric code or its message when `code` is lost", async () => {
    const lost = {
      ...artifacts,
      create: artifacts.create.bind(artifacts),
      import: artifacts.import.bind(artifacts),
      delete: artifacts.delete.bind(artifacts),
      get: async (name: string) => {
        if (name === "numeric") throw Object.assign(new Error("busy"), { numericCode: 10303 });
        if (name === "message") throw new Error("FORK_IN_PROGRESS: try again");
        throw new Error("boom");
      },
    };
    const git = createArtifactsGitHost(lost);
    expect((await git.getRepo("numeric"))?.status).toBe("forking");
    expect((await git.getRepo("message"))?.status).toBe("forking");
    await expect(git.getRepo("other")).rejects.toThrow("boom");
  });
});
