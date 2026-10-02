import {
  ForgeError,
  type GitCommit,
  type GitSignature,
  type GitTokenScope,
  gitObjectId,
  type Push,
  type Sha,
  sha1,
  ZERO_SHA,
} from "@gitflare/core";
import type {
  Clock,
  FileChange,
  GitHost,
  GitWriter,
  HostedRepo,
  MergeResult,
  MintedToken,
  TreeEntry,
} from "@gitflare/core/ports";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface StoredCommit extends GitCommit {
  /** Every file in the commit's tree: path → blob id. */
  files: Map<string, Sha>;
}

interface RepoState {
  info: HostedRepo;
  refs: Map<string, Sha>;
}

export interface IssuedToken extends MintedToken {
  repo: string;
  revoked: boolean;
}

export const fakeAuthor: GitSignature = { name: "Test Author", email: "author@example.com" };

function fullRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

/**
 * An in-memory git host that is also its own writer. It stands in for
 * Artifacts (`GitHost`) and for whatever commits and merges (`GitWriter`),
 * over one shared object store, so a merge done through the writer is
 * readable through the host.
 *
 * Objects get real git ids. Beyond the two ports it has `push`, which does
 * what a developer's `git push` would and returns the push the pipeline
 * should be told about, plus `pushes` and `tokens` for assertions.
 *
 * State lives in this object only. Under `pnpm dev` each Worker isolate builds
 * its own from the same fixture, so anything that must survive a reload or be
 * seen by another isolate belongs in the database, not here.
 */
export class FakeGit implements GitHost, GitWriter {
  private readonly repos = new Map<string, RepoState>();
  private readonly blobs = new Map<Sha, Uint8Array>();
  private readonly trees = new Map<Sha, TreeEntry[]>();
  private readonly commits = new Map<Sha, StoredCommit>();
  /** Every token minted, including revoked ones. */
  readonly tokens: IssuedToken[] = [];
  /** Every ref update, in order, as the push event Artifacts would have sent. */
  readonly pushes: Push[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly host = "https://git.example.test/git/gitflare",
  ) {}

  // --- GitHost ------------------------------------------------------------

  async createRepo(
    name: string,
    options: { description?: string; defaultBranch?: string } = {},
  ): Promise<HostedRepo> {
    return this.addRepo(name, options.defaultBranch ?? "main", null);
  }

  async importRepo(name: string, source: { url: string }): Promise<HostedRepo> {
    return this.addRepo(name, "main", source.url);
  }

  async forkRepo(source: string, name: string): Promise<HostedRepo> {
    const parent = this.repo(source);
    const info = this.addRepo(name, parent.info.defaultBranch, `artifacts:gitflare/${source}`);
    // A fork is a full copy: every branch, tag and other ref of the source.
    for (const [ref, tip] of parent.refs) this.repo(name).refs.set(ref, tip);
    return info;
  }

  async getRepo(name: string): Promise<HostedRepo | null> {
    return this.repos.get(name)?.info ?? null;
  }

  async deleteRepo(name: string): Promise<boolean> {
    for (const token of this.tokens) if (token.repo === name) token.revoked = true;
    return this.repos.delete(name);
  }

  async mintToken(repo: string, scope: GitTokenScope, ttlSeconds: number): Promise<MintedToken> {
    this.repo(repo);
    if (ttlSeconds < 60 || ttlSeconds > 31_536_000) {
      throw new ForgeError("invalid", "token lifetime must be between 60 seconds and one year");
    }
    const n = this.tokens.length + 1;
    const token: IssuedToken = {
      id: `tok_${n}`,
      secret: `art_v1_${sha1(`${repo}:${n}`)}`,
      scope,
      expiresAt: this.clock.now() + ttlSeconds * 1000,
      repo,
      revoked: false,
    };
    this.tokens.push(token);
    return { id: token.id, secret: token.secret, scope, expiresAt: token.expiresAt };
  }

  async revokeToken(repo: string, tokenId: string): Promise<boolean> {
    const token = this.tokens.find((t) => t.repo === repo && t.id === tokenId && !t.revoked);
    if (!token) return false;
    token.revoked = true;
    return true;
  }

  async resolveRef(repo: string, ref: string): Promise<Sha | null> {
    const state = this.repos.get(repo);
    if (!state) return null;
    if (this.commits.has(ref)) return ref;
    return state.refs.get(fullRef(ref)) ?? null;
  }

  async readCommit(_repo: string, sha: Sha): Promise<GitCommit | null> {
    const commit = this.commits.get(sha);
    if (!commit) return null;
    const { files: _files, ...rest } = commit;
    return rest;
  }

  async log(
    repo: string,
    options: { ref: string; limit?: number; offset?: number },
  ): Promise<GitCommit[]> {
    const out: GitCommit[] = [];
    let sha = await this.resolveRef(repo, options.ref);
    while (sha) {
      const commit = await this.readCommit(repo, sha);
      if (!commit) break;
      out.push(commit);
      sha = commit.parents[0] ?? null;
    }
    const offset = options.offset ?? 0;
    return out.slice(offset, offset + (options.limit ?? 50));
  }

  async readTree(_repo: string, treeSha: Sha): Promise<TreeEntry[] | null> {
    return this.trees.get(treeSha) ?? null;
  }

  async readBlob(_repo: string, sha: Sha): Promise<Uint8Array | null> {
    return this.blobs.get(sha) ?? null;
  }

  async readFile(repo: string, at: { ref: string; path: string }): Promise<Uint8Array | null> {
    const sha = await this.resolveRef(repo, at.ref);
    const blob = sha ? this.commits.get(sha)?.files.get(at.path) : undefined;
    return blob ? (this.blobs.get(blob) ?? null) : null;
  }

  // --- GitWriter ----------------------------------------------------------

  async commitFiles(request: {
    repo: string;
    branch: string;
    expectedParent: Sha | null;
    changes: FileChange[];
    message: string;
    author: GitSignature;
  }): Promise<{ sha: Sha }> {
    const state = this.repo(request.repo);
    const ref = fullRef(request.branch);
    const tip = state.refs.get(ref) ?? null;
    if (tip !== request.expectedParent) {
      throw new ForgeError(
        "conflict",
        `${request.repo} ${ref} moved: expected ${request.expectedParent}`,
      );
    }
    const sha = this.writeCommit(
      tip ? [tip] : [],
      request.changes,
      request.message,
      request.author,
    );
    this.setRef(request.repo, ref, sha);
    return { sha };
  }

  async merge(request: {
    target: { repo: string; branch: string };
    source: { repo: string; sha: Sha };
    message: string;
    author: GitSignature;
  }): Promise<MergeResult> {
    const state = this.repo(request.target.repo);
    const ref = fullRef(request.target.branch);
    const ours = state.refs.get(ref);
    const theirs = this.commits.get(request.source.sha);
    if (!theirs) throw new ForgeError("not_found", `commit ${request.source.sha} does not exist`);
    if (!ours) {
      this.setRef(request.target.repo, ref, theirs.sha);
      return { status: "merged", sha: theirs.sha };
    }
    const ancestorsOfTheirs = this.ancestors(theirs.sha);
    if (ancestorsOfTheirs.has(ours)) {
      this.setRef(request.target.repo, ref, theirs.sha);
      return { status: "merged", sha: theirs.sha };
    }
    const ancestorsOfOurs = this.ancestors(ours);
    if (ancestorsOfOurs.has(theirs.sha)) return { status: "up_to_date", sha: ours };

    const baseSha = [...ancestorsOfOurs].find((sha) => ancestorsOfTheirs.has(sha));
    const base = baseSha ? this.files(baseSha) : new Map<string, Sha>();
    const mine = this.files(ours);
    const merged = new Map(mine);
    const conflicts: string[] = [];
    for (const path of new Set([...base.keys(), ...mine.keys(), ...theirs.files.keys()])) {
      const [b, o, t] = [base.get(path), mine.get(path), theirs.files.get(path)];
      if (t === b || t === o) continue;
      if (o !== b) {
        conflicts.push(path);
      } else if (t) {
        merged.set(path, t);
      } else {
        merged.delete(path);
      }
    }
    if (conflicts.length > 0) return { status: "conflict", paths: conflicts.sort() };
    const sha = this.storeCommit([ours, theirs.sha], merged, request.message, request.author);
    this.setRef(request.target.repo, ref, sha);
    return { status: "merged", sha };
  }

  // --- Test helpers ---------------------------------------------------------

  /**
   * Commits `changes` on top of a ref and moves it, as a `git push` of one new
   * commit would. `changes` are relative to the commit it builds on. Returns
   * the push to hand to the pipeline.
   */
  push(
    repo: string,
    ref: string,
    changes: FileChange[] | Record<string, string>,
    options: { message?: string; author?: GitSignature } = {},
  ): Push {
    const state = this.repo(repo);
    const name = fullRef(ref);
    // A new branch starts from the default branch, as `git checkout -b` would.
    // Any other new ref (a checkpoint, say) starts with no history.
    const tip =
      state.refs.get(name) ??
      (name.startsWith("refs/heads/")
        ? state.refs.get(fullRef(state.info.defaultBranch))
        : undefined);
    const list = Array.isArray(changes)
      ? changes
      : Object.entries(changes).map(([path, content]) => ({ path, content }));
    const sha = this.writeCommit(
      tip ? [tip] : [],
      list,
      options.message ?? "Update",
      options.author ?? fakeAuthor,
    );
    return this.setRef(repo, name, sha);
  }

  /** The text of a file at a ref, or null. For assertions. */
  async text(repo: string, ref: string, path: string): Promise<string | null> {
    const bytes = await this.readFile(repo, { ref, path });
    return bytes ? decoder.decode(bytes) : null;
  }

  // The port methods above do their work before their first `await`, so a
  // fixture can call them without awaiting and rely on the result being there.
  private addRepo(name: string, defaultBranch: string, source: string | null): HostedRepo {
    if (this.repos.has(name)) throw new ForgeError("conflict", `repo ${name} already exists`);
    const info: HostedRepo = {
      name,
      remote: `${this.host}/${name}.git`,
      defaultBranch,
      status: "ready",
      source,
    };
    this.repos.set(name, { info, refs: new Map() });
    return info;
  }

  private repo(name: string): RepoState {
    const state = this.repos.get(name);
    if (!state) throw new ForgeError("not_found", `repo ${name} does not exist`);
    return state;
  }

  private files(sha: Sha): Map<string, Sha> {
    return this.commits.get(sha)?.files ?? new Map();
  }

  private ancestors(sha: Sha): Set<Sha> {
    const seen = new Set<Sha>();
    const queue = [sha];
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    return seen;
  }

  private setRef(repo: string, ref: string, sha: Sha): Push {
    const state = this.repo(repo);
    const push: Push = { repoName: repo, ref, before: state.refs.get(ref) ?? ZERO_SHA, after: sha };
    state.refs.set(ref, sha);
    this.pushes.push(push);
    return push;
  }

  private writeCommit(
    parents: Sha[],
    changes: FileChange[],
    message: string,
    author: GitSignature,
  ): Sha {
    const files = new Map(parents[0] ? this.files(parents[0]) : []);
    for (const change of changes) {
      if ("delete" in change) {
        files.delete(change.path);
        continue;
      }
      const bytes =
        typeof change.content === "string" ? encoder.encode(change.content) : change.content;
      const blob = gitObjectId("blob", bytes);
      this.blobs.set(blob, bytes);
      files.set(change.path, blob);
    }
    return this.storeCommit(parents, files, message, author);
  }

  private storeCommit(
    parents: Sha[],
    files: Map<string, Sha>,
    message: string,
    author: GitSignature,
  ): Sha {
    const treeSha = this.storeTree(files, "");
    const at = this.clock.now();
    const seconds = Math.floor(at / 1000);
    const text = [
      `tree ${treeSha}`,
      ...parents.map((parent) => `parent ${parent}`),
      `author ${author.name} <${author.email}> ${seconds} +0000`,
      `committer ${author.name} <${author.email}> ${seconds} +0000`,
      "",
      message,
      "",
    ].join("\n");
    const sha = gitObjectId("commit", encoder.encode(text));
    this.commits.set(sha, {
      sha,
      treeSha,
      parents,
      message,
      author,
      committer: author,
      authoredAt: at,
      committedAt: at,
      files,
    });
    return sha;
  }

  private storeTree(files: Map<string, Sha>, prefix: string): Sha {
    const entries = new Map<string, TreeEntry>();
    for (const [path, blob] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.set(rest, { name: rest, mode: "100644", sha: blob, type: "blob" });
      } else {
        const name = rest.slice(0, slash);
        if (!entries.has(name)) {
          const sha = this.storeTree(files, `${prefix}${name}/`);
          entries.set(name, { name, mode: "40000", sha, type: "tree" });
        }
      }
    }
    const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const listing = sorted.map((entry) => `${entry.mode} ${entry.name}\0${entry.sha}`).join("\n");
    const sha = gitObjectId("tree", encoder.encode(listing));
    this.trees.set(sha, sorted);
    return sha;
  }
}
