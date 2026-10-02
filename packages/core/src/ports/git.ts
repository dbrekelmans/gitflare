import type { GitCommit, GitSignature, GitTokenScope } from "../domain/repository";
import type { Sha, Timestamp } from "../ids";

export interface HostedRepo {
  name: string;
  /** The HTTPS git remote, exactly as the host returned it. Never built by hand. */
  remote: string;
  defaultBranch: string;
  /** Forking and importing are asynchronous: a repo exists before it can be read. */
  status: "ready" | "forking" | "importing";
  /** What it was forked or imported from, if anything. */
  source: string | null;
}

export interface MintedToken {
  /** The host's id for the token; what gitflare stores and later revokes by. */
  id: string;
  /** The value git sends as the HTTP Basic password. */
  secret: string;
  scope: GitTokenScope;
  expiresAt: Timestamp;
}

export interface TreeEntry {
  name: string;
  /** Canonical git mode, e.g. `100644` or `40000`. */
  mode: string;
  sha: Sha;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/**
 * The git host's control plane and object store: Cloudflare Artifacts in
 * production. It can create, fork and delete repositories, mint tokens, and
 * read objects. It cannot diff, merge, list refs, or write content; those are
 * `GitWriter` and gitflare's own code.
 *
 * Repositories are addressed by name within the deployment's one namespace.
 */
export interface GitHost {
  createRepo(
    name: string,
    options?: { description?: string; defaultBranch?: string },
  ): Promise<HostedRepo>;
  importRepo(
    name: string,
    source: { url: string; branch?: string; depth?: number },
  ): Promise<HostedRepo>;
  /**
   * A full copy of the source: every ref, stored in full. It takes seconds for
   * a small repository and most of a minute for one of tens of megabytes, so
   * call it from a background step, never while a person waits. The fork is
   * usable once `getRepo` reports `ready`.
   */
  forkRepo(source: string, name: string): Promise<HostedRepo>;
  getRepo(name: string): Promise<HostedRepo | null>;
  /** Deletes the repo and every token issued for it. False if it did not exist. */
  deleteRepo(name: string): Promise<boolean>;

  /**
   * `ttlSeconds` is between 60 and 31,536,000. Tokens are per repo; there is
   * no per-branch scope, and the host refuses nothing a write token asks for:
   * force pushes and ref deletions included. Who holds a write token is the
   * only protection a repository has.
   */
  mintToken(repo: string, scope: GitTokenScope, ttlSeconds: number): Promise<MintedToken>;
  revokeToken(repo: string, tokenId: string): Promise<boolean>;

  /**
   * The commit a branch or tag points at, by its short name, or the commit
   * itself when given a commit id. Null if it does not resolve. Refs outside
   * `refs/heads` and `refs/tags` cannot be resolved by name: take their tips
   * from push events and read by commit id.
   */
  resolveRef(repo: string, ref: string): Promise<Sha | null>;
  readCommit(repo: string, sha: Sha): Promise<GitCommit | null>;
  /** First-parent history from `ref` (a ref name or a commit), newest first. */
  log(
    repo: string,
    options: { ref: string; limit?: number; offset?: number },
  ): Promise<GitCommit[]>;
  /** The immediate children of one tree. Walking a directory tree is one call per directory. */
  readTree(repo: string, treeSha: Sha): Promise<TreeEntry[] | null>;
  readBlob(repo: string, sha: Sha): Promise<Uint8Array | null>;
  /** The file at `path` as of `ref`; null for a missing path or a directory. */
  readFile(repo: string, at: { ref: string; path: string }): Promise<Uint8Array | null>;
}

export type FileChange =
  | { path: string; content: string | Uint8Array }
  | { path: string; delete: true };

export type MergeResult =
  | { status: "merged"; sha: Sha }
  /** The target already contained the source. */
  | { status: "up_to_date"; sha: Sha }
  | { status: "conflict"; paths: string[] };

/**
 * Everything that writes repository content. In production a commit and a
 * fast-forward merge are done inside the Worker, without cloning; a true merge
 * of a repository too large for the Worker's memory is done with real git in a
 * sandbox. Callers do not know which.
 */
export interface GitWriter {
  /**
   * Commits `changes` on top of `branch`. `expectedParent` is the tip the
   * caller read; if the branch has moved, this throws a `ForgeError` with code
   * `conflict` instead of overwriting. Pass null to create the branch.
   */
  commitFiles(request: {
    repo: string;
    branch: string;
    expectedParent: Sha | null;
    changes: FileChange[];
    message: string;
    author: GitSignature;
  }): Promise<{ sha: Sha }>;

  /**
   * Merges a commit from one repo into a branch of another with a merge
   * commit (fast-forwarding when it can), so the session's commits and their
   * trailers survive in the main repo's history.
   */
  merge(request: {
    target: { repo: string; branch: string };
    source: { repo: string; sha: Sha };
    message: string;
    author: GitSignature;
  }): Promise<MergeResult>;
}
