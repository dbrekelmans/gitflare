import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ArtifactsBindingLike,
  ArtifactsCommitLike,
  ArtifactsCreateRepoResultLike,
  ArtifactsRepoLike,
  ArtifactsTreeEntryLike,
} from "../binding";

const HOST = "https://artifacts.test";
const NAMESPACE = "gitflare-test";
const SHA = /^[0-9a-f]{40}$/;

// The user's own git configuration (commit signing, hooks, a credential
// helper) must not reach these repositories.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
};

function artifactsError(code: string, numericCode: number, message = code): Error {
  return Object.assign(new Error(message), { name: "ArtifactsError", code, numericCode });
}

interface StubToken {
  id: string;
  plaintext: string;
  repo: string;
  scope: "read" | "write";
  expiresAt: number;
  revoked: boolean;
}

interface StubRepo {
  dir: string;
  defaultBranch: string;
  source: string | null;
  /** Set while a held fork or import is "still being copied". */
  copying: "FORK_IN_PROGRESS" | "IMPORT_IN_PROGRESS" | null;
}

/**
 * A stub of the Artifacts binding over real bare repositories in a temporary
 * directory, with a `fetch` that serves them over git's smart HTTP protocol by
 * running `git upload-pack` and `git receive-pack`. What the adapter and the
 * writers send is therefore checked by git itself. It reproduces what a live
 * account did (spec/research/live/artifacts-git.md): `log()` resolves short
 * names and commit ids only, tokens are per repository, a write needs a write
 * token, and a reply without side-band ends in a stray flush-pkt.
 */
export class LocalArtifacts implements ArtifactsBindingLike {
  private readonly root = mkdtempSync(join(tmpdir(), "gitflare-artifacts-"));
  private readonly repos = new Map<string, StubRepo>();
  /** URLs `import()` can copy from: a URL to the name of a repository here. */
  readonly upstreams = new Map<string, string>();
  readonly tokens: StubToken[] = [];
  /** Every smart HTTP request served, as `<METHOD> <repo> <service>`. */
  readonly requests: string[] = [];
  /** Forks and imports stay in progress until `finish(name)`. */
  holdCopies = false;
  /** Repositories anyone may fetch from, as a public remote elsewhere would allow. */
  readonly publicRead = new Set<string>();

  // --- The binding ----------------------------------------------------------

  async create(
    name: string,
    opts: { setDefaultBranch?: string } = {},
  ): Promise<ArtifactsCreateRepoResultLike> {
    if (this.repos.has(name)) throw artifactsError("ALREADY_EXISTS", 10201);
    const dir = join(this.root, `${name}.git`);
    const defaultBranch = opts.setDefaultBranch ?? "main";
    execFileSync("git", ["init", "-q", "--bare", `--initial-branch=${defaultBranch}`, dir], {
      env,
    });
    this.repos.set(name, { dir, defaultBranch, source: null, copying: null });
    this.configure(name);
    return this.result(name);
  }

  async get(name: string): Promise<ArtifactsRepoLike> {
    const repo = this.repos.get(name);
    if (!repo) throw artifactsError("NOT_FOUND", 10200, "Repository not found");
    if (repo.copying)
      throw artifactsError(repo.copying, repo.copying === "FORK_IN_PROGRESS" ? 10303 : 10302);
    return this.handle(name, repo);
  }

  async import(params: {
    source: { url: string };
    target: { name: string };
  }): Promise<ArtifactsCreateRepoResultLike> {
    const upstream = this.upstreams.get(params.source.url);
    if (!upstream) throw artifactsError("UPSTREAM_UNAVAILABLE", 10401);
    return this.copy(upstream, params.target.name, params.source.url, "IMPORT_IN_PROGRESS");
  }

  async delete(name: string): Promise<boolean> {
    const repo = this.repos.get(name);
    if (!repo) return false;
    rmSync(repo.dir, { recursive: true, force: true });
    this.repos.delete(name);
    for (const token of this.tokens) if (token.repo === name) token.revoked = true;
    return true;
  }

  // --- Test helpers ---------------------------------------------------------

  /** Ends a held fork or import. */
  finish(name: string): void {
    const repo = this.repos.get(name);
    if (repo) repo.copying = null;
  }

  remote(name: string): string {
    return `${HOST}/git/${NAMESPACE}/${name}.git`;
  }

  /** Runs git in a repository and returns what it printed, trimmed. */
  git(name: string, ...args: string[]): string {
    return this.gitWith(name, "", ...args);
  }

  /** As `git`, with `input` on its standard input. */
  gitWith(name: string, input: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: this.path(name), env, input, encoding: "utf8" }).trim();
  }

  /** Where a repository is on disk. */
  path(name: string): string {
    const repo = this.repos.get(name);
    if (!repo) throw new Error(`no repository ${name}`);
    return repo.dir;
  }

  /**
   * Commits `files` (a null deletes) on top of a branch with real git and
   * returns the new tip. A new branch starts from `from`, or from nothing.
   */
  commit(
    name: string,
    branch: string,
    files: Record<string, string | null>,
    options: { message?: string; from?: string; at?: number } = {},
  ): string {
    const work = mkdtempSync(join(this.root, "work-"));
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: work,
        env: options.at
          ? {
              ...env,
              GIT_AUTHOR_DATE: `@${options.at} +0000`,
              GIT_COMMITTER_DATE: `@${options.at} +0000`,
            }
          : env,
        encoding: "utf8",
      }).trim();
    run("init", "-q", `--initial-branch=${branch}`);
    run("remote", "add", "origin", this.path(name));
    const exists = this.tip(name, branch) !== null;
    const start = exists ? branch : options.from;
    if (start) {
      run("fetch", "-q", "origin", start);
      run("reset", "-q", "--hard", "FETCH_HEAD");
    }
    for (const [path, content] of Object.entries(files)) {
      const target = join(work, path);
      if (content === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    run("add", "-A");
    run("commit", "-q", "--allow-empty", "-m", options.message ?? "Update");
    run("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const sha = run("rev-parse", "HEAD");
    rmSync(work, { recursive: true, force: true });
    return sha;
  }

  /** The commit a branch points at, or null. */
  tip(name: string, branch: string): string | null {
    return this.rev(name, `refs/heads/${branch}`);
  }

  /** Removes every repository from disk. */
  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Git's smart HTTP protocol for the repositories here, authenticated like Artifacts. */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/git\/[^/]+\/([^/]+)\.git\/(.+)$/);
    const [, name = "", path = ""] = match ?? [];
    const repo = this.repos.get(name);
    const service = url.searchParams.get("service") ?? path;
    this.requests.push(`${request.method} ${name} ${service}`);

    const anonymous = this.publicRead.has(name) && service === "git-upload-pack";
    const token = this.authenticate(request.headers.get("authorization"), name);
    if (url.origin !== HOST || !repo || repo.copying || (!token && !anonymous)) {
      return new Response("Invalid or expired token", { status: token === null ? 401 : 403 });
    }
    if (service === "git-receive-pack" && token?.scope !== "write") {
      return new Response("Insufficient permissions", { status: 403 });
    }
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return new Response("not found", { status: 404 });
    }
    const command = service.slice("git-".length);

    if (request.method === "GET" && path === "info/refs") {
      const refs = execFileSync("git", [command, "--stateless-rpc", "--advertise-refs", repo.dir], {
        env,
      });
      const announce = `# service=${service}\n`;
      const header = `${(announce.length + 4).toString(16).padStart(4, "0")}${announce}0000`;
      return new Response(Buffer.concat([Buffer.from(header), refs]), {
        headers: { "content-type": `application/x-${service}-advertisement` },
      });
    }

    const body = Buffer.from(await request.arrayBuffer());
    let reply: Buffer;
    try {
      reply = execFileSync("git", [command, "--stateless-rpc", repo.dir], {
        env,
        input: body,
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return new Response("Internal Server Error", { status: 500 });
    }
    // Observed live: a reply that carries a raw pack ends in a flush-pkt.
    const sideBand = body.includes("side-band");
    if (service === "git-upload-pack" && !sideBand && reply.includes("PACK")) {
      reply = Buffer.concat([reply, Buffer.from("0000")]);
    }
    return new Response(new Uint8Array(reply), {
      headers: { "content-type": `application/x-${service}-result` },
    });
  };

  // --- Internals ------------------------------------------------------------

  private configure(name: string): void {
    // Artifacts advertises `allow-tip-sha1-in-want allow-reachable-sha1-in-want`.
    this.git(name, "config", "uploadpack.allowAnySHA1InWant", "true");
    this.git(name, "config", "http.receivepack", "true");
  }

  private result(name: string): ArtifactsCreateRepoResultLike & { token: string } {
    const repo = this.repos.get(name);
    return {
      name,
      defaultBranch: repo?.defaultBranch ?? "main",
      remote: this.remote(name),
      token: this.mint(name, "write", 86_400).plaintext,
    };
  }

  private copy(
    from: string,
    name: string,
    source: string,
    copying: StubRepo["copying"],
  ): ArtifactsCreateRepoResultLike {
    if (this.repos.has(name)) throw artifactsError("ALREADY_EXISTS", 10201);
    const parent = this.repos.get(from);
    if (!parent) throw artifactsError("NOT_FOUND", 10200);
    const dir = join(this.root, `${name}.git`);
    // A fork is a full copy: every branch, tag and other ref.
    cpSync(parent.dir, dir, { recursive: true });
    this.repos.set(name, {
      dir,
      defaultBranch: parent.defaultBranch,
      source,
      copying: this.holdCopies ? copying : null,
    });
    return this.result(name);
  }

  private mint(repo: string, scope: "read" | "write", ttl: number): StubToken {
    const n = this.tokens.length + 1;
    const expiresAt = Date.now() + ttl * 1000;
    const token: StubToken = {
      id: `tok_${n}`,
      plaintext: `art_v2_x_${String(n).padStart(40, "0")}?expires=${Math.floor(expiresAt / 1000)}`,
      repo,
      scope,
      expiresAt,
      revoked: false,
    };
    this.tokens.push(token);
    return token;
  }

  /** Null when no credentials were sent; undefined when they are not valid for the repository. */
  private authenticate(header: string | null, repo: string): StubToken | null | undefined {
    if (!header) return null;
    const [scheme, value = ""] = header.split(" ");
    const presented =
      scheme === "Basic" ? (Buffer.from(value, "base64").toString().split(":")[1] ?? "") : value;
    const secret = presented.split("?expires=")[0];
    return this.tokens.find(
      (token) =>
        token.repo === repo &&
        !token.revoked &&
        token.expiresAt > Date.now() &&
        token.plaintext.split("?expires=")[0] === secret,
    );
  }

  /** Git's output, or null when it fails; its complaint is not printed. */
  private tryGit(name: string, ...args: string[]): string | null {
    try {
      return execFileSync("git", args, {
        cwd: this.path(name),
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  private rev(name: string, spec: string): string | null {
    return this.tryGit(name, "rev-parse", "--verify", "-q", `${spec}^{commit}`);
  }

  /** What the binding's `ref` accepts: a short branch or tag name, or a commit id. Nothing else resolves. */
  private resolve(name: string, ref: string): string | null {
    if (SHA.test(ref)) return this.rev(name, ref);
    if (ref.includes("/") && ref.startsWith("refs/")) return null;
    return this.rev(name, `refs/heads/${ref}`) ?? this.rev(name, `refs/tags/${ref}`);
  }

  private type(name: string, object: string): string | null {
    return this.tryGit(name, "cat-file", "-t", object);
  }

  private readCommit(name: string, hash: string): ArtifactsCommitLike | null {
    if (this.type(name, hash) !== "commit") return null;
    const raw = execFileSync("git", ["cat-file", "commit", hash], {
      cwd: this.path(name),
      env,
      encoding: "utf8",
    });
    const split = raw.indexOf("\n\n");
    const headers = raw.slice(0, split).split("\n");
    const field = (key: string) =>
      headers
        .filter((line) => line.startsWith(`${key} `))
        .map((line) => line.slice(key.length + 1));
    const person = (line = "") => {
      const [, who = "", email = "", seconds = "0"] =
        line.match(/^(.*) <(.*)> (\d+) [+-]\d{4}$/) ?? [];
      return { name: who, email, at: Number(seconds) };
    };
    const author = person(field("author")[0]);
    const committer = person(field("committer")[0]);
    return {
      hash,
      treeHash: field("tree")[0] ?? "",
      message: raw.slice(split + 2).replace(/\n$/, ""),
      author: { name: author.name, email: author.email },
      committer: { name: committer.name, email: committer.email },
      parents: field("parent"),
      authoredAt: author.at,
      committedAt: committer.at,
    };
  }

  private handle(name: string, repo: StubRepo): ArtifactsRepoLike {
    const blob = (object: string): Blob | null => {
      if (this.type(name, object) !== "blob") return null;
      const data = execFileSync("git", ["cat-file", "blob", object], { cwd: repo.dir, env });
      return new Blob([new Uint8Array(data)]);
    };
    return {
      createToken: async (scope = "write", ttl = 86_400) => {
        if (ttl < 60 || ttl > 31_536_000) {
          throw artifactsError("INVALID_TTL", 10103, "ttl must be between 60 and 31536000 seconds");
        }
        const token = this.mint(name, scope, ttl);
        return {
          id: token.id,
          plaintext: token.plaintext,
          scope,
          expiresAt: new Date(token.expiresAt).toISOString(),
        };
      },
      revokeToken: async (tokenOrId) => {
        const token = this.tokens.find(
          (t) => t.repo === name && !t.revoked && (t.id === tokenOrId || t.plaintext === tokenOrId),
        );
        if (token) token.revoked = true;
        return Boolean(token);
      },
      info: async () => ({
        name,
        defaultBranch: repo.defaultBranch,
        source: repo.source,
        remote: this.remote(name),
      }),
      readBlob: async (hash) => blob(hash),
      readTree: async (hash) => {
        const type = this.type(name, hash);
        if (type === "commit") throw artifactsError("INTERNAL_ERROR", 10400);
        if (type !== "tree") return null;
        const listing = this.git(name, "ls-tree", hash);
        if (!listing) return [];
        return listing.split("\n").map((line): ArtifactsTreeEntryLike => {
          const [meta = "", entryName = ""] = line.split("\t");
          const [mode = "", kind, entryHash = ""] = meta.split(" ");
          const type =
            kind === "tree"
              ? "tree"
              : kind === "commit"
                ? "gitlink"
                : mode === "100755"
                  ? "exec"
                  : mode === "120000"
                    ? "symlink"
                    : "blob";
          return { name: entryName, mode: mode.replace(/^0/, ""), hash: entryHash, type };
        });
      },
      readCommit: async (hash) => {
        if (!SHA.test(hash)) {
          throw artifactsError(
            "INVALID_INPUT",
            10100,
            "Invalid hash: expected a 40-character SHA-1 hex hash.",
          );
        }
        return this.readCommit(name, hash);
      },
      readFile: async ({ ref, path }) => {
        const commit = this.resolve(name, ref);
        return commit ? blob(`${commit}:${path}`) : null;
      },
      log: async ({ ref = repo.defaultBranch, limit = 50, offset = 0 } = {}) => {
        const tip = this.resolve(name, ref);
        if (!tip) return [];
        const hashes = this.git(
          name,
          "rev-list",
          "--first-parent",
          `--skip=${offset}`,
          `--max-count=${limit}`,
          tip,
        );
        return hashes
          .split("\n")
          .filter(Boolean)
          .flatMap((hash) => this.readCommit(name, hash) ?? []);
      },
      fork: async (forkName) => {
        const source = `artifacts:${NAMESPACE}/${name}`;
        return this.copy(name, forkName, source, "FORK_IN_PROGRESS");
      },
    };
  }
}
