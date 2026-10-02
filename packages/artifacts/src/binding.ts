import { ForgeError } from "@gitflare/core";

// The part of the Artifacts Workers binding this package calls, declared here
// rather than imported, so the package needs no generated Worker types and a
// test can pass a plain object. Signatures are those of
// `@cloudflare/workers-types@5.20261002.1`, as recorded in
// spec/research/artifacts.md; what a live account returned is in
// spec/research/live/artifacts-git.md, section 6.

export interface ArtifactsCreateRepoResultLike {
  name: string;
  defaultBranch: string;
  remote: string;
}

export interface ArtifactsRepoInfoLike {
  name: string;
  defaultBranch: string;
  /** `artifacts:<namespace>/<repo>` for a fork, the URL for an import, otherwise null. */
  source: string | null;
  remote: string;
}

export interface ArtifactsCommitLike {
  hash: string;
  treeHash: string;
  /** One trailing newline removed. */
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  /** Unix seconds. */
  authoredAt: number;
  committedAt: number;
}

export interface ArtifactsTreeEntryLike {
  name: string;
  /** Canonical git mode: `100644`, `40000`. */
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/** What `get()` returns: an RPC stub for one repository, to be disposed after use. */
export interface ArtifactsRepoLike {
  createToken(
    scope?: "write" | "read",
    ttl?: number,
  ): Promise<{ id: string; plaintext: string; scope: "read" | "write"; expiresAt: string }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoInfoLike>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntryLike[] | null>;
  readCommit(hash: string): Promise<ArtifactsCommitLike | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitLike[]>;
  fork(name: string, opts?: { description?: string }): Promise<ArtifactsCreateRepoResultLike>;
  [Symbol.dispose]?(): void;
}

export interface ArtifactsBindingLike {
  create(
    name: string,
    opts?: { description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResultLike>;
  /** Throws `NOT_FOUND`, or `FORK_IN_PROGRESS` / `IMPORT_IN_PROGRESS` while the repo is being copied. */
  get(name: string): Promise<ArtifactsRepoLike>;
  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string } };
  }): Promise<ArtifactsCreateRepoResultLike>;
  delete(name: string): Promise<boolean>;
}

// The documented `ArtifactsErrorCode`s and the numeric codes the REST API pairs them with.
const numericCodes: Record<number, string> = {
  10100: "INVALID_INPUT",
  10101: "INVALID_REPO_NAME",
  10103: "INVALID_TTL",
  10104: "INVALID_URL",
  10106: "REMOTE_AUTH_REQUIRED",
  10200: "NOT_FOUND",
  10201: "ALREADY_EXISTS",
  10302: "IMPORT_IN_PROGRESS",
  10303: "FORK_IN_PROGRESS",
  10400: "INTERNAL_ERROR",
  10401: "UPSTREAM_UNAVAILABLE",
  10402: "MEMORY_LIMIT",
};
const knownCodes = new Set([...Object.values(numericCodes), "CREATE_IN_PROGRESS"]);

/**
 * The `ArtifactsErrorCode` of an error the binding threw, or null for anything
 * else. Reads `code`, then `numericCode`, then the message: whether the two
 * properties survive the RPC boundary on every path was not observed.
 */
export function artifactsErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const { code, numericCode } = error as { code?: unknown; numericCode?: unknown };
  if (typeof code === "string" && knownCodes.has(code)) return code;
  if (typeof numericCode === "number") return numericCodes[numericCode] ?? null;
  return (
    error.message.match(/\b[A-Z]+(?:_[A-Z]+)+\b/g)?.find((word) => knownCodes.has(word)) ?? null
  );
}

/** The repository exists but is still being created, forked or imported. */
export function inProgress(code: string | null): "forking" | "importing" | null {
  if (code === "FORK_IN_PROGRESS") return "forking";
  if (code === "IMPORT_IN_PROGRESS" || code === "CREATE_IN_PROGRESS") return "importing";
  return null;
}

/** An error from the binding as the `ForgeError` a caller can act on; anything unrecognised is returned as it came. */
export function toForgeError(error: unknown, what: string): unknown {
  const code = artifactsErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "NOT_FOUND":
      return new ForgeError("not_found", `${what}: not found`);
    case "ALREADY_EXISTS":
      return new ForgeError("conflict", `${what}: already exists`);
    case "FORK_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "CREATE_IN_PROGRESS":
      return new ForgeError("not_ready", `${what}: the repository is still being copied`);
    case "INVALID_INPUT":
    case "INVALID_REPO_NAME":
    case "INVALID_TTL":
    case "INVALID_URL":
    case "REMOTE_AUTH_REQUIRED":
      return new ForgeError("invalid", `${what}: ${detail}`);
    case "UPSTREAM_UNAVAILABLE":
    case "MEMORY_LIMIT":
      return new ForgeError("unavailable", `${what}: ${detail}`);
    default:
      return error;
  }
}
