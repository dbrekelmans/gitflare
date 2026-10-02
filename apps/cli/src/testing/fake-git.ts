import { resolve } from "node:path";
import type { ExecOptions, ExecOutput } from "../context.ts";

type Entry = [key: string, value: string];

interface FakeRepo {
  config: Entry[];
  branch: string | null;
  remotes: Map<string, string>;
  /** Paths committed at HEAD. */
  committed: Set<string>;
  /** Committed paths whose working copy differs. */
  modified: Set<string>;
}

const ok = (stdout = ""): ExecOutput => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode: number, stderr = ""): ExecOutput => ({ exitCode, stdout: "", stderr });

/**
 * The part of git the CLI drives, held in memory: configuration at global,
 * repository and command-line level, remotes, the current branch, and a clone
 * that authenticates the way git does. An invocation it does not know throws,
 * so a command cannot quietly start using git differently.
 */
export class FakeGit {
  readonly global: Entry[] = [];
  readonly repos = new Map<string, FakeRepo>();
  /** What a clone of any remote checks out. */
  committed = [".entire/settings.json", ".entire/.gitignore", ".claude/settings.json", "README.md"];
  readonly clones: { remote: string; directory: string }[] = [];

  init(directory: string, branch: string | null = "main"): FakeRepo {
    const repo: FakeRepo = {
      config: [],
      branch,
      remotes: new Map(),
      committed: new Set(this.committed),
      modified: new Set(),
    };
    this.repos.set(directory, repo);
    return repo;
  }

  /** Every value of a key in a repository's own configuration, in order. */
  values(directory: string, key: string): string[] {
    return (this.repos.get(directory)?.config ?? [])
      .filter(([candidate]) => candidate === key)
      .map(([, value]) => value);
  }

  async exec(args: string[], options: ExecOptions = {}): Promise<ExecOutput> {
    const cwd = options.cwd ?? "/";
    const inline: Entry[] = [];
    let rest = args;
    while (rest[0] === "-c") {
      const setting = rest[1] ?? "";
      const equals = setting.indexOf("=");
      inline.push([setting.slice(0, equals), setting.slice(equals + 1)]);
      rest = rest.slice(2);
    }
    const repo = this.repos.get(cwd);
    const [command, ...argv] = rest;

    if (command === "clone") {
      const [remote, directory] = argv as [string, string];
      // Git has only the command line to go on until the new repository exists.
      if (!this.helpsWith([...this.global, ...inline], remote)) {
        return fail(128, `fatal: could not read Username for '${new URL(remote).origin}'`);
      }
      this.init(resolve(cwd, directory)).remotes.set("origin", remote);
      this.clones.push({ remote, directory });
      return ok();
    }
    if (command === "config") return this.config(argv, repo, inline);
    if (!repo) return fail(128, "fatal: not a git repository");

    const line = argv.join(" ");
    if (command === "symbolic-ref" && line === "--quiet --short HEAD") {
      return repo.branch ? ok(`${repo.branch}\n`) : fail(1);
    }
    if (command === "remote") {
      const [action, name, url] = argv as [string, string, string];
      if (action === "get-url") {
        const found = repo.remotes.get(name);
        return found ? ok(`${found}\n`) : fail(2, `error: No such remote '${name}'`);
      }
      if (action === "add" && repo.remotes.has(name)) {
        return fail(3, `error: remote ${name} already exists.`);
      }
      if (action === "add" || action === "set-url") {
        repo.remotes.set(name, url);
        return ok();
      }
    }
    if (command === "cat-file" && argv[0] === "-e" && argv[1]?.startsWith("HEAD:")) {
      return repo.committed.has(argv[1].slice("HEAD:".length)) ? ok() : fail(128);
    }
    if (command === "status" && line.startsWith("--porcelain -- ")) {
      const dirty = argv.slice(2).filter((path) => repo.modified.has(path));
      return ok(dirty.map((path) => ` M ${path}\n`).join(""));
    }
    if (command === "checkout" && line.startsWith("HEAD -- ")) {
      for (const path of argv.slice(2)) repo.modified.delete(path);
      return ok();
    }
    throw new Error(`FakeGit does not know: git ${args.join(" ")}`);
  }

  /** Whether git, reading this configuration, would get a credential for the remote from gitflare. */
  private helpsWith(config: Entry[], remote: string): boolean {
    const origin = new URL(remote).origin;
    const helpers = config
      .filter(([key]) => key === `credential.${origin}.helper`)
      .map(([, value]) => value);
    const perPath = config.some(
      ([key, value]) => key === `credential.${origin}.useHttpPath` && value === "true",
    );
    return helpers.at(-1) === "!gitflare credential" && perPath;
  }

  private config(argv: string[], repo: FakeRepo | undefined, inline: Entry[]): ExecOutput {
    const flags = argv.filter((arg) => arg.startsWith("--"));
    const [key, value] = argv.filter((arg) => !arg.startsWith("--")) as [string, string?];
    const scope = flags.includes("--global") ? this.global : repo?.config;
    const local = flags.includes("--local");
    // Later wins: global, then the repository, then the command line.
    const readable = local
      ? (repo?.config ?? [])
      : [...this.global, ...(repo?.config ?? []), ...inline];

    if (flags.includes("--get-urlmatch")) {
      const [section, variable] = key.split(".") as [string, string];
      const matches = readable
        .map(([candidate, found]) => {
          if (candidate === key) return { length: 0, found };
          const prefix = `${section}.`;
          const suffix = `.${variable}`;
          if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return null;
          const url = candidate.slice(prefix.length, -suffix.length);
          const target = value ?? "";
          const under = target === url || target.startsWith(`${url.replace(/\/$/, "")}/`);
          return under ? { length: url.length, found } : null;
        })
        .filter((match) => match !== null)
        .sort((a, b) => b.length - a.length);
      return matches[0] ? ok(`${matches[0].found}\n`) : fail(1);
    }
    if (flags.includes("--get")) {
      if (local && !repo)
        return fail(128, "fatal: --local can only be used inside a git repository");
      const found = readable.filter(([candidate]) => candidate === key).at(-1);
      return found ? ok(`${found[1]}\n`) : fail(1);
    }

    if (value === undefined) throw new Error(`FakeGit does not know: git config ${argv.join(" ")}`);
    if (!scope) return fail(128, "fatal: not in a git directory");
    if (!flags.includes("--add")) {
      const kept = scope.filter(([candidate]) => candidate !== key);
      scope.length = 0;
      scope.push(...kept);
    }
    scope.push([key, value]);
    return ok();
  }
}
