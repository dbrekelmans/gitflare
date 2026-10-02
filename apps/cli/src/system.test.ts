import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCli } from "../scripts/build.ts";
import type { CliContext } from "./context.ts";
import { configureHost, hostSettings } from "./git.ts";
import { createSecretStore, exec, listenForRedirect } from "./system.ts";

// The real context, and the built file run by the real git.

describe("the built file", () => {
  const home = mkdtempSync(join(tmpdir(), "gitflare-cli-"));
  const bundle = join(home, "dist", "gitflare.js");
  const clone = join(home, "clone");
  const GIT_HOST = "https://git.example.test";
  const asked: { remote: string; authorization: string | undefined }[] = [];
  let server: Server;
  let forge: string;
  let env: NodeJS.ProcessEnv;

  /**
   * Runs git the way a developer's shell would, with `gitflare` on the PATH
   * and no other configuration. Never synchronously: the forge it reaches
   * through the helper is served by this process.
   */
  const git = (args: string[], input = "", cwd = clone) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile("git", args, { cwd, env, timeout: 10_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout),
      );
      child.stdin?.end(input);
    });

  beforeAll(async () => {
    await buildCli(bundle);

    // The forge: it hands out a token that names the repository it was asked about.
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.method === "GET") {
          // The repository, for `capture enable`.
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              repository: { slug: "atlas-web", defaultBranch: "main" },
              remote: `${GIT_HOST}/git/ns/atlas-web.git`,
              contextRemote: `${GIT_HOST}/git/ns/atlas-web.context.git`,
            }),
          );
          return;
        }
        const { remote } = JSON.parse(body) as { remote: string };
        asked.push({ remote, authorization: request.headers.authorization });
        const name = new URL(remote).pathname
          .replace(/\.git$/, "")
          .split("/")
          .at(-1);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            username: "gitflare",
            password: `token-for-${name}`,
            expiresAt: 1_800_000_000_000,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    forge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gitflare"),
      `#!/bin/sh\nexec "${process.execPath}" "${bundle}" "$@"\n`,
    );
    chmodSync(join(bin, "gitflare"), 0o755);
    // Entire's CLI, doing what the reviewer saw `entire enable` do: write the agent's settings.
    writeFileSync(
      join(bin, "entire"),
      `#!/bin/sh\nmkdir -p .claude && printf '{"hooks":{}}\\n' > .claude/settings.json\n`,
    );
    chmodSync(join(bin, "entire"), 0o755);
    const secrets = join(home, "secrets.json");
    writeFileSync(
      secrets,
      JSON.stringify({
        [forge]: JSON.stringify({
          kind: "oauth",
          clientId: "client",
          tokenEndpoint: "https://team.cloudflareaccess.test/token",
          refreshToken: "oauth:refresh",
          accessToken: "oauth:access",
          expiresAt: Date.now() + 600_000,
        }),
      }),
    );
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GITFLARE_SECRETS_FILE: secrets,
    };
    mkdirSync(clone);
    await git(["init", "--quiet"]);
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("is one file that runs where there is nothing to import from", () => {
    expect(readdirSync(join(home, "dist"))).toEqual(["gitflare.js"]);
    const usage = execFileSync(bundle, ["help"], { cwd: home, encoding: "utf8" });
    expect(usage).toContain("Usage: gitflare <command> [arguments]");
    expect(statSync(bundle).mode & 0o111).not.toBe(0);
  });

  it("answers git for main, fork and context remotes, each with its own token", async () => {
    // The same code that `gitflare clone` runs, writing to a real repository's configuration.
    await configureHost(
      { exec, cwd: clone } as CliContext,
      forge,
      `${GIT_HOST}/git/ns/atlas-web.git`,
    );

    for (const name of ["atlas-web", "atlas-web.context", "atlas-web.fork.01hzx"]) {
      const filled = await git(["credential", "fill"], `url=${GIT_HOST}/git/ns/${name}.git\n\n`);
      expect(filled).toContain("username=gitflare\n");
      expect(filled).toContain(`password=token-for-${name}\n`);
    }
    expect(asked.map((request) => request.remote)).toEqual([
      `${GIT_HOST}/git/ns/atlas-web.git`,
      `${GIT_HOST}/git/ns/atlas-web.context.git`,
      `${GIT_HOST}/git/ns/atlas-web.fork.01hzx.git`,
    ]);
    expect(new Set(asked.map((request) => request.authorization))).toEqual(
      new Set(["Bearer oauth:access"]),
    );
  });

  it("is given the same settings on the command line during a clone, before the repository has any", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gitflare-cli-outside-"));
    const settings = hostSettings(forge, `${GIT_HOST}/git/ns/atlas-web.git`).flatMap(
      ([key, value]) => ["-c", `${key}=${value}`],
    );
    const filled = await git(
      [...settings, "credential", "fill"],
      `url=${GIT_HOST}/git/ns/atlas-web.git\n\n`,
      outside,
    );
    expect(filled).toContain("password=token-for-atlas-web\n");
  });

  it("turns capture on in a repository that does not commit the agent's settings", async () => {
    const repo = mkdtempSync(join(tmpdir(), "gitflare-cli-capture-"));
    await git(["init", "--quiet", "--initial-branch=main"], "", repo);
    mkdirSync(join(repo, ".entire"));
    writeFileSync(join(repo, ".entire", "settings.json"), "{}\n");
    await git(["add", "."], "", repo);
    await git(
      ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init"],
      "",
      repo,
    );
    await git(["config", "gitflare.deployment", forge], "", repo);
    await git(["config", "gitflare.repository", "atlas-web"], "", repo);

    const enabled = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        join(home, "bin", "gitflare"),
        ["capture", "enable"],
        { cwd: repo, env },
        (error, _o, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr }),
      );
    });

    expect(enabled).toEqual({ code: 0, stderr: "" });
    expect(await git(["status", "--porcelain"], "", repo)).toBe("?? .claude/\n");
  });

  it("stays silent for other hosts, even as a helper for every host", async () => {
    const before = asked.length;
    await git(["config", "credential.helper", "!gitflare credential"]);
    // Git has no answer from any helper and may not prompt, so it gives up.
    await expect(
      git(["credential", "fill"], "url=https://github.com/acme/widgets.git\n\n"),
    ).rejects.toThrow(/terminal prompts disabled/);
    expect(asked).toHaveLength(before);
  });
});

describe("the keychain", () => {
  const login = '{"kind":"oauth","refreshToken":"oauth:refresh \\"quoted\\""}';

  it("never puts a secret in a program's arguments, on macOS or Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const calls: { command: string; args: string[]; input?: string }[] = [];
      const store = createSecretStore(platform, {}, async (command, args, options) => {
        calls.push({ command, args, input: options?.input });
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      await store.set("https://forge.example.test", login);

      expect(calls).toHaveLength(1);
      const hex = Buffer.from(login).toString("hex");
      expect(calls[0]?.input).toContain(hex);
      expect(calls[0]?.args.join(" ")).not.toContain(hex);
      expect(calls[0]?.args.join(" ")).not.toContain("oauth:refresh");
    }
  });

  it("reads back what it stored, and nothing for a key it does not have", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const hex = Buffer.from(login).toString("hex");
      const store = createSecretStore(platform, {}, async (_command, args) =>
        args.includes("https://forge.example.test")
          ? { exitCode: 0, stdout: `${hex}\n`, stderr: "" }
          : { exitCode: platform === "darwin" ? 44 : 1, stdout: "", stderr: "not found" },
      );
      expect(await store.get("https://forge.example.test")).toBe(login);
      expect(await store.get("https://other.example.test")).toBeNull();
    }
  });

  it("keeps the login in a file only its owner can read, when told to", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitflare-secrets-")), "nested", "secrets.json");
    const store = createSecretStore("linux", { GITFLARE_SECRETS_FILE: path });
    await store.set("a", login);
    await store.set("b", "second");
    expect(await store.get("a")).toBe(login);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBe("second");
  });

  it("refuses to store a login where there is no keychain it knows", async () => {
    const store = createSecretStore("win32", {});
    expect(await store.get("a")).toBeNull();
    await expect(store.set("a", "b")).rejects.toThrow(/GITFLARE_SECRETS_FILE/);
  });
});

describe("exec", () => {
  it("returns what a program printed and how it exited, and feeds it its input", async () => {
    const result = await exec(
      process.execPath,
      [
        "-e",
        "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => { console.error('warned'); process.exit(3); })",
      ],
      { input: "hello" },
    );
    expect(result).toEqual({ exitCode: 3, stdout: "HELLO", stderr: "warned\n" });
  });

  it("reports a program that is not installed as exit code 127", async () => {
    expect((await exec("gitflare-no-such-program", [])).exitCode).toBe(127);
  });
});

describe("the loopback listener", () => {
  it("hands over the query the browser came back with", async () => {
    const listener = await listenForRedirect();
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const waiting = listener.wait();

    expect((await fetch(listener.redirectUri.replace("/callback", "/favicon.ico"))).status).toBe(
      404,
    );
    const page = await fetch(`${listener.redirectUri}?code=abc&state=xyz`);
    expect(await page.text()).toContain("You can close this tab");

    const query = await waiting;
    expect([query.get("code"), query.get("state")]).toEqual(["abc", "xyz"]);
    await listener.close();
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
  });

  it("gives up when nobody comes back", async () => {
    const listener = await listenForRedirect(20);
    await expect(listener.wait()).rejects.toThrow("Nobody finished signing in");
    await listener.close();
  });
});
