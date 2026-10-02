import { describe, expect, it } from "vitest";
import { StartSessionInput } from "../api/inputs";
import { CiConfig } from "./ci";
import { can } from "./permissions";
import { ArtifactsPushEvent, classifyPush, parseCheckpointRef, toPush, ZERO_SHA } from "./push";
import { contextRepoName, forkRepoName, mainRepoName, parseRepoName } from "./repo-names";

const sha = "def789a012def789a012def789a012def789a012";

describe("repository names", () => {
  it("round-trips the three kinds", () => {
    expect(parseRepoName(mainRepoName("atlas-web"))).toEqual({ kind: "main", slug: "atlas-web" });
    expect(parseRepoName(contextRepoName("atlas-web"))).toEqual({
      kind: "context",
      slug: "atlas-web",
    });
    expect(parseRepoName(forkRepoName("atlas-web", "ses_01k6abc"))).toEqual({
      kind: "fork",
      slug: "atlas-web",
      sessionId: "ses_01k6abc",
    });
  });

  it("rejects names gitflare did not make", () => {
    expect(parseRepoName("atlas-web.other")).toBeNull();
    expect(parseRepoName("atlas-web.fork.")).toBeNull();
    expect(parseRepoName(".context")).toBeNull();
    expect(parseRepoName("")).toBeNull();
  });
});

describe("pushes", () => {
  it("parses the documented event and ignores what it does not know", () => {
    const event = ArtifactsPushEvent.parse({
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "ns", repoName: "atlas-web.fork.01k6abc" },
      payload: { ref: "refs/heads/rate-limit", before: ZERO_SHA, after: sha, commits: [] },
      metadata: { eventSchemaVersion: 1 },
    });
    expect(classifyPush(toPush(event))).toEqual({
      kind: "change",
      slug: "atlas-web",
      sessionId: "ses_01k6abc",
      branch: "rate-limit",
    });
  });

  it("recognises checkpoint refs by shape", () => {
    const id = "01M3WE2VX9HQC3NVY9BWYCW6JV";
    expect(parseCheckpointRef(`refs/entire/checkpoints/JV/${id}`)).toBe(id);
    expect(parseCheckpointRef(`refs/entire/checkpoints/XX/${id}`)).toBeNull();
    expect(parseCheckpointRef("refs/entire/checkpoints/v2/main")).toBeNull();
    expect(parseCheckpointRef("refs/entire/checkpoints/c4/a3b2c4d5e6c4")).toBe("a3b2c4d5e6c4");
    const push = { repoName: "atlas-web.context", before: ZERO_SHA, after: sha };
    expect(classifyPush({ ...push, ref: `refs/entire/checkpoints/JV/${id}` })).toEqual({
      kind: "checkpoint",
      slug: "atlas-web",
      checkpointId: id,
    });
    expect(classifyPush({ ...push, ref: "refs/heads/entire/checkpoints/v1" }).kind).toBe(
      "checkpoint_branch",
    );
    expect(classifyPush({ ...push, ref: "refs/heads/main" }).kind).toBe("ignored");
  });

  it("ignores deletions, the main repo, tags and capture branches", () => {
    const fork = { repoName: "atlas-web.fork.01k6abc", before: sha, after: sha };
    expect(classifyPush({ ...fork, ref: "refs/heads/x", after: ZERO_SHA }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, ref: "refs/tags/v1" }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, ref: "refs/heads/entire/a02a31f-821774" }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, repoName: "atlas-web", ref: "refs/heads/main" }).kind).toBe(
      "ignored",
    );
  });
});

describe("permissions", () => {
  const admin = { id: "usr_admin", role: "admin" } as const;
  const member = { id: "usr_member", role: "member" } as const;

  it("keeps administration to administrators", () => {
    expect(can(admin, { type: "members.manage" })).toBe(true);
    expect(can(member, { type: "members.manage" })).toBe(false);
    expect(can(member, { type: "repository.create" })).toBe(false);
    expect(can(member, { type: "change.merge" })).toBe(true);
  });

  it("gives a session's write access to its owner only, while it is active", () => {
    const session = { userId: "usr_member", status: "active" } as const;
    expect(can(member, { type: "session.write", session })).toBe(true);
    expect(can(admin, { type: "session.write", session })).toBe(false);
    expect(can(admin, { type: "session.abandon", session })).toBe(true);
    expect(can(member, { type: "session.write", session: { ...session, status: "merged" } })).toBe(
      false,
    );
  });
});

describe("schemas", () => {
  it("fills CI defaults", () => {
    const config = CiConfig.parse({ steps: [{ name: "test", run: "pnpm test" }] });
    expect(config.instance).toBe("standard-2");
    expect(config.steps[0]).toEqual({
      name: "test",
      run: "pnpm test",
      needs: [],
      timeoutMinutes: 15,
    });
  });

  it("requires a prompt for a cloud session only", () => {
    const base = { repoSlug: "atlas-web", title: "Rate limit invites" };
    expect(StartSessionInput.safeParse({ ...base, kind: "local" }).success).toBe(true);
    expect(StartSessionInput.safeParse({ ...base, kind: "cloud" }).success).toBe(false);
    expect(StartSessionInput.safeParse({ ...base, kind: "cloud", prompt: "do it" }).success).toBe(
      true,
    );
  });
});
