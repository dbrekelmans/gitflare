import { createHash } from "node:crypto";
import { forkRepoName } from "@gitflare/core";
import { demo } from "@gitflare/testing/demo";
import { describe, expect, it } from "vitest";
import { createPkce } from "./auth.ts";
import { branchName } from "./commands/start.ts";
import { run } from "./run.ts";
import { createFakeCli, type FakeCli } from "./testing/fake-context.ts";
import { FORGE, GIT_HOST } from "./testing/fake-forge.ts";

function the<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the demo fixture lacks what this test reads");
  return value;
}
const jonas = the(demo.users[1]);
const repo = the(demo.repositories[0]).slug;
/** Jonas's session, with a change under review. */
const review = the(demo.sessions[1]);
const remote = (name: string) => `${GIT_HOST}/git/gitflare/${name}.git`;
const CLONE = `/work/${repo}`;
const HOST_HELPER = `credential.${GIT_HOST}.helper`;

/** A fresh machine: a new context in a directory, sharing git, forge and keychain. */
function at(cli: FakeCli, cwd: string): FakeCli {
  return { ...cli, ctx: { ...cli.ctx, cwd } };
}

async function signedIn(options: Parameters<typeof createFakeCli>[0] = {}) {
  const cli = createFakeCli(options);
  expect(await run(cli.ctx, ["login", FORGE])).toBe(0);
  return cli;
}

/** Signed in, with the demo repository cloned and the context standing in the clone. */
async function cloned(options: Parameters<typeof createFakeCli>[0] = {}) {
  const cli = await signedIn(options);
  expect(await run(cli.ctx, ["clone", `${FORGE}/${repo}`])).toBe(0);
  const out = cli.out();
  cli.clear();
  return { ...at(cli, CLONE), cloneOutput: out };
}

/** What git writes to a helper's standard input before `get`. */
function asks(url: string): string {
  const { host, pathname } = new URL(url);
  return `protocol=https\nhost=${host}\npath=${pathname.slice(1)}\n\n`;
}

async function credentialFor(cli: FakeCli, url: string) {
  const before = { out: cli.out().length, err: cli.err().length };
  cli.stdin(asks(url));
  const exitCode = await run(cli.ctx, ["credential", "get"]);
  return { exitCode, out: cli.out().slice(before.out), err: cli.err().slice(before.err) };
}

describe("gitflare login", () => {
  it("signs in through the browser and keeps the refresh token in the keychain", async () => {
    const cli = await signedIn();

    expect(cli.out()).toBe(
      "Signed in to Northwind Studio as Maya Okafor <maya@northwind.example>.\n",
    );
    expect(cli.opened).toHaveLength(1);
    const stored = JSON.parse(cli.secrets.get(FORGE) ?? "{}");
    expect(stored.refreshToken).toMatch(/^oauth:refresh-/);
    // The token is in the keychain and nowhere a person or a log would see it.
    expect(cli.out() + cli.err() + cli.ran.join("\n")).not.toContain("oauth:");
    expect(cli.git.global).toContainEqual(["gitflare.deployment", FORGE]);
  });

  it("sends the forge the token it was given, and only the forge", async () => {
    const cli = await signedIn();
    const bearing = cli.forge.requests.filter((request) => request.headers.has("authorization"));
    expect(bearing.length).toBeGreaterThan(0);
    for (const request of bearing) expect(new URL(request.url).origin).toBe(FORGE);
  });

  it("stores nothing when the sign-in is refused in the browser", async () => {
    const cli = createFakeCli();
    cli.forge.browser = "deny";
    expect(await run(cli.ctx, ["login", FORGE])).toBe(1);
    expect(cli.err()).toContain("The sign-in was refused: access_denied");
    expect(cli.secrets.size).toBe(0);
  });

  it.each([
    ["metadata without a registration endpoint (the live spike)", "401"],
    ["a redirect with no metadata (the documented answer)", "302"],
  ] as const)(
    "names the fallback when the deployment has no Managed OAuth: %s",
    async (_, answer) => {
      const cli = createFakeCli();
      cli.forge.managedOAuth = false;
      cli.forge.withoutManagedOAuth = answer;
      expect(await run(cli.ctx, ["login", FORGE])).toBe(1);
      expect(cli.err()).toContain(`gitflare login --cloudflared ${FORGE}`);
      expect(cli.opened).toEqual([]);
      expect(cli.secrets.size).toBe(0);
    },
  );

  it("names the forge as the resource when it registers", async () => {
    const cli = await signedIn();
    expect(cli.forge.registrations).toMatchObject([{ resource: FORGE }]);
  });

  it("keeps no login the forge refuses", async () => {
    const cli = createFakeCli();
    cli.forge.managedOAuth = false;
    cli.forge.cloudflaredToken = "the-forge-wants-this";
    cli.programs.set("cloudflared", (args) => ({
      exitCode: 0,
      stdout: args[1] === "token" ? "cloudflared-has-this\n" : "",
      stderr: "",
    }));
    expect(await run(cli.ctx, ["login", "--cloudflared", FORGE])).toBe(1);
    expect(cli.secrets.size).toBe(0);
    expect(cli.git.global).toEqual([]);
  });

  it("signs in through cloudflared when asked to, and asks it for the token on every call", async () => {
    const cli = createFakeCli();
    cli.forge.managedOAuth = false;
    cli.forge.cloudflaredToken = "jwt-from-cloudflared";
    cli.programs.set("cloudflared", (args) => ({
      exitCode: 0,
      stdout: args[1] === "token" ? "jwt-from-cloudflared\n" : "",
      stderr: "",
    }));

    expect(await run(cli.ctx, ["login", "--cloudflared", FORGE])).toBe(0);
    expect(cli.ran).toContain(`cloudflared access login ${FORGE}`);
    expect(cli.out()).toContain("Maya Okafor");

    cli.forge.cloudflaredToken = "rotated";
    expect(await run(cli.ctx, ["status"])).toBe(1);
    expect(cli.err()).toContain(`gitflare login ${FORGE}`);
  });

  it("needs no browser for a forge that asks for no login", async () => {
    const cli = createFakeCli();
    cli.forge.protected = false;
    expect(await run(cli.ctx, ["login", FORGE])).toBe(0);
    expect(cli.opened).toEqual([]);
    expect(cli.secrets.size).toBe(0);
    expect(cli.out()).toContain("Signed in to Northwind Studio");
  });

  it("refuses a forge that is not https, before anything is sent", async () => {
    const cli = createFakeCli();
    expect(await run(cli.ctx, ["login", "http://forge.example.test"])).toBe(1);
    expect(cli.err()).toContain("must be an https URL");
    expect(cli.forge.requests).toEqual([]);
  });

  it("refreshes an expired token, and keeps the refresh token that replaces the used one", async () => {
    const cli = await signedIn();
    const first = JSON.parse(cli.secrets.get(FORGE) ?? "{}").refreshToken;

    cli.advance(16 * 60_000);
    expect(await run(cli.ctx, ["status"])).toBe(0);
    const second = JSON.parse(cli.secrets.get(FORGE) ?? "{}").refreshToken;
    expect(second).not.toBe(first);

    // The first refresh token is dead; only the stored replacement can do this.
    cli.advance(16 * 60_000);
    expect(await run(cli.ctx, ["status"])).toBe(0);
  });

  it("lets two helpers refresh at once, though the refresh token rotates", async () => {
    const cli = await cloned();
    cli.advance(16 * 60_000);
    cli.forge.holdRefreshes(2);

    cli.stdin(asks(remote(repo)));
    const [one, two] = await Promise.all([
      run(cli.ctx, ["credential", "get"]),
      run(cli.ctx, ["credential", "get"]),
    ]);

    expect(cli.err()).toBe("");
    expect([one, two]).toEqual([0, 0]);
    expect(cli.out().match(/password=/g)).toHaveLength(2);
    // What the keychain holds still works.
    cli.advance(16 * 60_000);
    expect(await run(cli.ctx, ["status"])).toBe(0);
  });

  it("says to sign in again once the grant has ended", async () => {
    const cli = await signedIn();
    cli.forge.revokeEverything();
    expect(await run(cli.ctx, ["status"])).toBe(1);
    expect(cli.err()).toContain(
      `Your sign-in to ${FORGE} has ended. Run \`gitflare login ${FORGE}\`.`,
    );
  });

  it("never offers a PKCE challenge that begins with - or _, which Access refuses", async () => {
    const challengeOf = (bytes: Uint8Array) =>
      createHash("sha256").update(Buffer.from(bytes).toString("base64url")).digest("base64url");
    const candidates = Array.from({ length: 2000 }, (_, i) =>
      new Uint8Array(32).fill(i % 256, 0, 1 + (i >> 8)),
    );
    const refused = candidates.find((bytes) => /^[-_]/.test(challengeOf(bytes)));
    const accepted = candidates.find((bytes) => /^[a-zA-Z0-9]/.test(challengeOf(bytes)));
    if (!refused || !accepted) throw new Error("no candidate bytes found");

    const queue = [refused, accepted];
    const pkce = await createPkce(() => queue.shift() as Uint8Array);
    expect(pkce.challenge).toBe(challengeOf(accepted));
    expect(pkce.verifier).toBe(Buffer.from(accepted).toString("base64url"));
  });
});

describe("gitflare credential", () => {
  it("answers git's get for the main repository with a read token for it", async () => {
    const cli = await cloned();
    const answer = await credentialFor(cli, remote(repo));
    expect(answer).toEqual({
      exitCode: 0,
      out: `username=gitflare\npassword=art_v2_${repo}_read\npassword_expiry_utc=${Math.floor((cli.ctx.now() + 3_600_000) / 1000)}\n`,
      err: "",
    });
  });

  it("answers for the context repository with a different, write token", async () => {
    const cli = await cloned();
    const answer = await credentialFor(cli, remote(`${repo}.context`));
    expect(answer.exitCode).toBe(0);
    expect(answer.out).toContain(`password=art_v2_${repo}.context_write\n`);
  });

  it("answers for the session's fork once the session has started", async () => {
    const cli = await cloned();
    expect(await run(cli.ctx, ["start", "Tidy the invite form"])).toBe(0);
    const fork = cli.git.repos
      .get(CLONE)
      ?.remotes.get(cli.git.values(CLONE, "branch.tidy-the-invite-form.pushRemote")[0] ?? "");
    expect(fork).toMatch(new RegExp(`/${repo}\\.fork\\.`));

    const answer = await credentialFor(cli, fork as string);
    expect(answer.exitCode).toBe(0);
    expect(answer.out).toMatch(new RegExp(`password=art_v2_${repo}\\.fork\\.[^_]+_write\n`));
  });

  it("stays silent for a host that is not gitflare's, without calling anyone", async () => {
    const cli = await cloned();
    const requests = cli.forge.requests.length;
    for (const url of [
      "https://github.com/acme/widgets.git",
      "https://git.example.test.evil.example/git/gitflare/x.git",
    ]) {
      expect(await credentialFor(cli, url)).toEqual({ exitCode: 0, out: "", err: "" });
    }
    cli.stdin("protocol=ssh\nhost=git.example.test\npath=git/gitflare/atlas-web.git\n\n");
    expect(await run(cli.ctx, ["credential", "get"])).toBe(0);
    expect(cli.forge.requests).toHaveLength(requests);
    expect(cli.forge.credentialRequests).toEqual([]);
  });

  it("stays silent outside a clone, where nothing ties the host to a forge", async () => {
    const cli = at(await cloned(), "/elsewhere");
    expect(await credentialFor(cli, remote(repo))).toEqual({ exitCode: 0, out: "", err: "" });
  });

  it("has nothing to store or erase", async () => {
    const cli = await cloned();
    const requests = cli.forge.requests.length;
    cli.stdin(`${asks(remote(repo)).trimEnd()}\nusername=gitflare\npassword=secret\n\n`);
    const out = cli.out();
    expect(await run(cli.ctx, ["credential", "store"])).toBe(0);
    expect(await run(cli.ctx, ["credential", "erase"])).toBe(0);
    expect(cli.out()).toBe(out);
    expect(cli.forge.requests).toHaveLength(requests);
  });

  it("stops git, with the forge's reason, when the forge refuses the remote", async () => {
    const cli = await cloned();
    expect(review.userId).toBe(jonas.id);
    const answer = await credentialFor(cli, remote(forkRepoName(repo, review.id)));
    expect(answer).toEqual({
      exitCode: 1,
      out: "quit=true\n",
      err: "gitflare: You may not use that git remote.\n",
    });
  });

  it("says how to sign in when there is no login", async () => {
    const cli = await cloned();
    cli.secrets.clear();
    const answer = await credentialFor(cli, remote(repo));
    expect(answer.out).toBe("quit=true\n");
    expect(answer.err).toContain(`Run \`gitflare login ${FORGE}\`.`);
  });

  it("explains itself when git does not send the repository's path", async () => {
    const cli = await cloned();
    cli.stdin("protocol=https\nhost=git.example.test\n\n");
    expect(await run(cli.ctx, ["credential", "get"])).toBe(1);
    expect(cli.err()).toContain("useHttpPath true");
    expect(cli.forge.credentialRequests).toEqual([]);
  });
});

describe("gitflare clone", () => {
  it("clones with gitflare as the host's only credential helper, and records where it came from", async () => {
    const cli = await cloned();

    expect(cli.git.clones).toEqual([{ remote: remote(repo), directory: repo }]);
    // The empty value first: it is what removes the helpers configured more widely.
    expect(cli.git.values(CLONE, HOST_HELPER)).toEqual(["", "!gitflare credential"]);
    expect(cli.git.values(CLONE, `credential.${GIT_HOST}.useHttpPath`)).toEqual(["true"]);
    expect(cli.git.values(CLONE, "gitflare.deployment")).toEqual([FORGE]);
    expect(cli.git.values(CLONE, "gitflare.repository")).toEqual([repo]);
    expect(cli.cloneOutput).toContain(`Cloned ${repo} into ${repo}.`);
  });

  it("takes the repository's page in the forge and a directory", async () => {
    const cli = await signedIn();
    expect(await run(cli.ctx, ["clone", `${FORGE}/repos/${repo}`, "portal"])).toBe(0);
    expect(cli.git.clones).toEqual([{ remote: remote(repo), directory: "portal" }]);
    expect(cli.git.values("/work/portal", "gitflare.repository")).toEqual([repo]);
  });

  it("does not clone a repository that is still being imported", async () => {
    const cli = await signedIn();
    cli.forge.importing.add(repo);
    expect(await run(cli.ctx, ["clone", `${FORGE}/${repo}`])).toBe(1);
    expect(cli.err()).toContain("still being imported");
    expect(cli.git.clones).toEqual([]);
  });

  it("reports the forge's answer for a repository that does not exist", async () => {
    const cli = await signedIn();
    expect(await run(cli.ctx, ["clone", `${FORGE}/no-such-repo`])).toBe(1);
    expect(cli.err()).toMatch(/gitflare clone: .*not found/i);
    expect(cli.git.clones).toEqual([]);
  });

  it("prints its usage for a target that names no repository", async () => {
    const cli = await signedIn();
    cli.clear();
    expect(await run(cli.ctx, ["clone", FORGE])).toBe(1);
    expect(cli.err()).toBe("Usage: gitflare clone <forge-url>/<repository> [directory]\n");
  });
});

describe("gitflare start", () => {
  it("starts a local session, waits for its fork, and points the branch's pushes at it", async () => {
    const cli = await cloned();
    cli.forge.forkReadyAfterReads = 3;

    expect(await run(cli.ctx, ["start", "Tidy", "the", "invite", "form"])).toBe(0);

    const posted = cli.forge.requests.filter(
      (request) => request.method === "POST" && request.url.endsWith("/sessions"),
    );
    expect(posted.map((request) => [request.url, JSON.parse(request.body)])).toEqual([
      [`${FORGE}/api/repos/${repo}/sessions`, { kind: "local", title: "Tidy the invite form" }],
    ]);
    expect(cli.slept).toEqual([2000, 2000, 2000, 2000]);

    const branch = "tidy-the-invite-form";
    const [sessionId] = cli.git.values(CLONE, `branch.${branch}.gitflareSession`);
    const [pushRemote] = cli.git.values(CLONE, `branch.${branch}.pushRemote`);
    expect(cli.git.repos.get(CLONE)?.remotes.get(pushRemote as string)).toBe(
      remote(forkRepoName(repo, sessionId as `ses_${string}`)),
    );
    expect(cli.git.repos.get(CLONE)?.remotes.get("origin")).toBe(remote(repo));
    expect(cli.out()).toContain(
      `Session "Tidy the invite form" is ready. Pushes from ${branch} go to its fork`,
    );
  });

  it("leaves the default branch for a new one, so main keeps following the forge", async () => {
    const cli = await cloned();
    const clone = cli.git.repos.get(CLONE);
    clone?.branches.add("tidy-the-invite-form");

    expect(await run(cli.ctx, ["start", "Tidy the invite form"])).toBe(0);

    expect(clone?.branch).toBe("tidy-the-invite-form-2");
    expect(cli.err()).toContain("main stays as the forge has it");
    expect(cli.git.values(CLONE, "branch.main.pushRemote")).toEqual([]);
    expect(cli.git.values(CLONE, "branch.main.gitflareSession")).toEqual([]);
    expect(cli.git.values(CLONE, "branch.tidy-the-invite-form-2.pushRemote")).toHaveLength(1);
  });

  it("stays on a branch that is not the default", async () => {
    const cli = await cloned();
    const clone = cli.git.repos.get(CLONE) as { branch: string | null; branches: Set<string> };
    clone.branch = "invite-form";
    clone.branches.add("invite-form");

    expect(await run(cli.ctx, ["start", "Tidy the invite form"])).toBe(0);

    expect(clone.branch).toBe("invite-form");
    expect(clone.branches).not.toContain("tidy-the-invite-form");
    expect(cli.git.values(CLONE, "branch.invite-form.pushRemote")).toHaveLength(1);
  });

  it("names a branch from any title", () => {
    expect(branchName("Tidy the invite form")).toBe("tidy-the-invite-form");
    expect(branchName("  Réduire l'écart: 2×  ")).toBe("reduire-l-ecart-2");
    expect(branchName("日本語")).toBe("session");
    expect(branchName("x".repeat(80))).toHaveLength(48);
  });

  it("gives up waiting after five minutes, and a second run waits for the same fork", async () => {
    const cli = await cloned();
    cli.forge.forkReadyAfterReads = 100_000;

    expect(await run(cli.ctx, ["start", "Slow fork"])).toBe(1);
    expect(cli.err()).toContain("Run `gitflare start` again to keep waiting.");
    expect(cli.slept.reduce((sum, ms) => sum + ms, 0)).toBe(5 * 60_000);
    expect(cli.git.values(CLONE, "branch.slow-fork.pushRemote")).toEqual([]);
    const [sessionId] = cli.git.values(CLONE, "branch.slow-fork.gitflareSession");
    expect(sessionId).toMatch(/^ses_/);

    cli.forge.finishForks();
    expect(await run(cli.ctx, ["start"])).toBe(0);
    expect(cli.git.values(CLONE, "branch.slow-fork.gitflareSession")).toEqual([sessionId]);
    expect(cli.git.values(CLONE, "branch.slow-fork.pushRemote")).toHaveLength(1);
    expect(cli.forge.requests.filter((request) => request.url.endsWith("/sessions"))).toHaveLength(
      1,
    );
    expect(cli.out()).toContain('Session "Slow fork" is ready.');
  });

  it("refuses outside a gitflare clone, on a detached HEAD, and without a title", async () => {
    const outside = at(await signedIn(), "/elsewhere");
    expect(await run(outside.ctx, ["start", "x"])).toBe(1);
    expect(outside.err()).toContain("This is not a gitflare clone.");

    const detached = await cloned();
    (detached.git.repos.get(CLONE) as { branch: string | null }).branch = null;
    expect(await run(detached.ctx, ["start", "x"])).toBe(1);
    expect(detached.err()).toContain("Check out a branch first");

    const untitled = await cloned();
    expect(await run(untitled.ctx, ["start"])).toBe(1);
    expect(untitled.err()).toBe("Usage: gitflare start <title>\n");
    expect(
      untitled.forge.requests.filter(
        (request) => request.method === "POST" && request.url.endsWith("/sessions"),
      ),
    ).toEqual([]);
  });
});

describe("gitflare capture enable", () => {
  const entire = (cli: FakeCli, effect: () => void = () => undefined) =>
    cli.programs.set("entire", () => {
      effect();
      return { exitCode: 0, stdout: "", stderr: "" };
    });

  it("installs Entire's hooks in the clone, with gitflare's credentials for the context repository", async () => {
    const cli = await cloned();
    entire(cli);
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(0);
    expect(cli.ran).toContain("entire enable --agent claude-code --telemetry=false");
    expect(cli.git.values(CLONE, HOST_HELPER)).toEqual(["", "!gitflare credential"]);
    expect(cli.out()).toContain("Capture is on in this clone");
    expect(cli.err()).toBe("");
  });

  it("puts back the committed settings if enabling rewrote them, and leaves a person's own edits", async () => {
    const cli = await cloned();
    const modified = cli.git.repos.get(CLONE)?.modified as Set<string>;
    entire(cli, () => modified.add(".claude/settings.json"));
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(0);
    expect([...modified]).toEqual([]);

    modified.add(".entire/settings.json");
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(0);
    expect([...modified].sort()).toEqual([".claude/settings.json", ".entire/settings.json"]);
  });

  it("leaves alone a settings file the repository does not commit and enabling created", async () => {
    const cli = await cloned();
    const clone = cli.git.repos.get(CLONE);
    clone?.committed.delete(".claude/settings.json");
    entire(cli, () => clone?.untracked.add(".claude/settings.json"));

    expect(await run(cli.ctx, ["capture", "enable"])).toBe(0);
    expect(cli.err()).toBe("");
    expect([...(clone?.untracked ?? [])]).toEqual([".claude/settings.json"]);
  });

  it("says where to get the Entire CLI when it is not installed", async () => {
    const cli = await cloned();
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(1);
    expect(cli.err()).toContain(
      "The Entire CLI is not installed. Install it (https://docs.entire.io/cli/installation)",
    );
  });

  it("does not enable a checkout that lacks the committed capture settings", async () => {
    const cli = await cloned();
    entire(cli);
    cli.git.repos.get(CLONE)?.committed.delete(".entire/settings.json");
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(1);
    expect(cli.err()).toContain("Merge main into it and run this again.");
    expect(cli.ran.filter((line) => line.startsWith("entire"))).toEqual([]);
  });

  it("warns about the variable that overrides the credential helper", async () => {
    const cli = await cloned();
    entire(cli);
    cli.ctx.env.ENTIRE_CHECKPOINT_TOKEN = "anything";
    expect(await run(cli.ctx, ["capture", "enable"])).toBe(0);
    expect(cli.err()).toContain("ENTIRE_CHECKPOINT_TOKEN is set");
  });

  it("knows only `enable`", async () => {
    const cli = await cloned();
    expect(await run(cli.ctx, ["capture"])).toBe(1);
    expect(cli.err()).toBe("Usage: gitflare capture enable\n");
  });
});

describe("gitflare logout", () => {
  it("forgets the login and the forge it was for", async () => {
    const cli = await signedIn();
    cli.clear();
    expect(await run(cli.ctx, ["logout"])).toBe(0);
    expect(cli.out()).toBe(`Signed out of ${FORGE}.\n`);
    expect(cli.secrets.size).toBe(0);
    expect(cli.git.global).toEqual([]);

    expect(await run(cli.ctx, ["status"])).toBe(1);
    expect(cli.err()).toContain("You are not signed in.");
  });

  it("forgets the clone's forge from inside it, and says so when there was no login", async () => {
    const cli = await cloned();
    expect(await run(cli.ctx, ["logout"])).toBe(0);
    expect(cli.secrets.size).toBe(0);
    expect(await run(cli.ctx, ["logout", FORGE])).toBe(0);
    expect(cli.out()).toContain(`You were not signed in to ${FORGE}.`);
  });
});

describe("gitflare status", () => {
  it("says who is signed in, outside a clone", async () => {
    const cli = await signedIn();
    const before = cli.out().length;
    expect(await run(cli.ctx, ["status"])).toBe(0);
    expect(cli.out().slice(before)).toBe(
      `Signed in to Northwind Studio (${FORGE}) as Maya Okafor <maya@northwind.example>.\n`,
    );
  });

  it("shows the clone's repository and that its branch has no session yet", async () => {
    const cli = await cloned();
    const before = cli.out().length;
    expect(await run(cli.ctx, ["status"])).toBe(0);
    expect(cli.out().slice(before)).toBe(
      `Signed in to Northwind Studio (${FORGE}) as Maya Okafor <maya@northwind.example>.\n` +
        `Repository: ${repo}\n` +
        "Session: none on this branch. Start one with: gitflare start <title>\n",
    );
  });

  it("shows a started session, and the change its pushes opened", async () => {
    const started = await cloned();
    await run(started.ctx, ["start", "Tidy the invite form"]);
    const before = started.out().length;
    expect(await run(started.ctx, ["status"])).toBe(0);
    expect(started.out().slice(before)).toContain(
      'Session: "Tidy the invite form" on tidy-the-invite-form (active)\n' +
        "Change: none yet. Push tidy-the-invite-form to open one.\n",
    );

    const reviewing = await cloned({ user: jonas });
    reviewing.git.repos.get(CLONE)?.config.push(["branch.main.gitflareSession", review.id]);
    expect(await run(reviewing.ctx, ["status"])).toBe(0);
    expect(reviewing.out()).toContain(
      'Session: "Rate-limit the invite endpoint" on main (active)\nChange: #12 Rate-limit the invite endpoint (',
    );
  });

  it("says how to sign in when no forge is known", async () => {
    const cli = createFakeCli();
    expect(await run(cli.ctx, ["status"])).toBe(1);
    expect(cli.err()).toContain("You are not signed in. Run `gitflare login <forge-url>`.");
  });
});
