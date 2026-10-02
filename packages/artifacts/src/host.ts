import { ForgeError, type GitCommit, type Sha } from "@gitflare/core";
import type { GitHost, HostedRepo, TreeEntry } from "@gitflare/core/ports";
import {
  type ArtifactsBindingLike,
  type ArtifactsCommitLike,
  type ArtifactsCreateRepoResultLike,
  type ArtifactsRepoLike,
  artifactsErrorCode,
  inProgress,
  toForgeError,
} from "./binding";

const SHA = /^[0-9a-f]{40}$/;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31_536_000;

function toCommit(commit: ArtifactsCommitLike): GitCommit {
  return {
    sha: commit.hash,
    treeSha: commit.treeHash,
    parents: commit.parents,
    message: commit.message,
    author: commit.author,
    committer: commit.committer,
    authoredAt: commit.authoredAt * 1000,
    committedAt: commit.committedAt * 1000,
  };
}

/**
 * The binding resolves a short branch or tag name or a commit id and nothing
 * else: `refs/heads/main` comes back empty. Callers hold both forms, so the
 * two prefixes it can serve are dropped here.
 */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

async function bytes(blob: Blob | null): Promise<Uint8Array | null> {
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** The `GitHost` port over the Artifacts binding. */
export function createArtifactsGitHost(binding: ArtifactsBindingLike): GitHost {
  // `get()` says nothing about a repository that is still being copied, so the
  // remote a create, fork or import call returned is kept for `getRepo` to
  // report until the repository can describe itself. Per isolate: another
  // isolate reports an empty remote until the copy is done.
  const pending = new Map<string, HostedRepo>();

  function created(
    result: ArtifactsCreateRepoResultLike,
    status: HostedRepo["status"],
    source: string | null,
  ): HostedRepo {
    // The initial token every create, fork and import returns is dropped
    // unused: gitflare only hands out tokens it minted and recorded.
    return {
      name: result.name,
      remote: result.remote,
      defaultBranch: result.defaultBranch,
      status,
      source,
    };
  }

  /** Runs `use` on a repository that can be read; `absent` when it does not exist or is still being copied. */
  async function read<T>(
    name: string,
    absent: T,
    use: (repo: ArtifactsRepoLike) => Promise<T>,
  ): Promise<T> {
    let repo: ArtifactsRepoLike;
    try {
      repo = await binding.get(name);
    } catch (error) {
      const code = artifactsErrorCode(error);
      if (code === "NOT_FOUND" || inProgress(code)) return absent;
      throw error;
    }
    try {
      return await use(repo);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  /** As `read`, for operations that need the repository to exist: a missing or unfinished one is an error. */
  async function open<T>(
    name: string,
    what: string,
    use: (repo: ArtifactsRepoLike) => Promise<T>,
  ): Promise<T> {
    let repo: ArtifactsRepoLike;
    try {
      repo = await binding.get(name);
    } catch (error) {
      throw toForgeError(error, `${what} ${name}`);
    }
    try {
      return await use(repo);
    } catch (error) {
      throw toForgeError(error, `${what} ${name}`);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  const host: GitHost = {
    async createRepo(name, options = {}) {
      try {
        const result = await binding.create(name, {
          description: options.description,
          setDefaultBranch: options.defaultBranch,
        });
        return created(result, "ready", null);
      } catch (error) {
        throw toForgeError(error, `create ${name}`);
      }
    },

    async importRepo(name, source) {
      let result: ArtifactsCreateRepoResultLike;
      try {
        result = await binding.import({ source, target: { name } });
      } catch (error) {
        throw toForgeError(error, `import ${name}`);
      }
      pending.set(name, created(result, "importing", source.url));
      return (await host.getRepo(name)) ?? created(result, "importing", source.url);
    },

    async forkRepo(source, name) {
      // `defaultBranchOnly` is not passed: a fork copies every ref whatever it says.
      const result = await open(source, "fork", (repo) => repo.fork(name));
      pending.set(name, created(result, "forking", null));
      return (await host.getRepo(name)) ?? created(result, "forking", null);
    },

    async getRepo(name) {
      let repo: ArtifactsRepoLike;
      try {
        repo = await binding.get(name);
      } catch (error) {
        const code = artifactsErrorCode(error);
        if (code === "NOT_FOUND") return null;
        const status = inProgress(code);
        if (!status) throw error;
        const known = pending.get(name);
        return known
          ? { ...known, status }
          : { name, remote: "", defaultBranch: "main", status, source: null };
      }
      try {
        const info = await repo.info();
        pending.delete(name);
        return {
          name: info.name,
          remote: info.remote,
          defaultBranch: info.defaultBranch,
          status: "ready",
          source: info.source,
        };
      } finally {
        repo[Symbol.dispose]?.();
      }
    },

    async deleteRepo(name) {
      pending.delete(name);
      return binding.delete(name);
    },

    async mintToken(repo, scope, ttlSeconds) {
      if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
        throw new ForgeError("invalid", "token lifetime must be between 60 seconds and one year");
      }
      const token = await open(repo, "mint a token for", (handle) =>
        handle.createToken(scope, ttlSeconds),
      );
      return {
        id: token.id,
        // The token is `<secret>?expires=<unix seconds>`. The server keeps its
        // own record of the expiry and ignores the suffix; the documented
        // Basic password is the secret alone.
        secret: token.plaintext.split("?expires=")[0] ?? token.plaintext,
        scope: token.scope,
        expiresAt: Date.parse(token.expiresAt),
      };
    },

    async revokeToken(repo, tokenId) {
      return read(repo, false, (handle) => handle.revokeToken(tokenId));
    },

    async resolveRef(repo, ref) {
      return read(repo, null, async (handle) => {
        if (SHA.test(ref)) return (await handle.readCommit(ref))?.hash ?? null;
        const [tip] = await handle.log({ ref: shortRef(ref), limit: 1 });
        return tip?.hash ?? null;
      });
    },

    async readCommit(repo, sha) {
      // The binding throws for anything but 40 hex characters; the port answers null.
      if (!SHA.test(sha)) return null;
      return read(repo, null, async (handle) => {
        const commit = await handle.readCommit(sha);
        return commit ? toCommit(commit) : null;
      });
    },

    async log(repo, options) {
      return read(repo, [], async (handle) => {
        const commits = await handle.log({ ...options, ref: shortRef(options.ref) });
        return commits.map(toCommit);
      });
    },

    async readTree(repo, treeSha: Sha) {
      return read(repo, null, async (handle) => {
        const entries = await handle.readTree(treeSha);
        if (!entries) return null;
        return entries.map(
          (entry): TreeEntry => ({
            name: entry.name,
            mode: entry.mode,
            sha: entry.hash,
            type: entry.type,
          }),
        );
      });
    },

    async readBlob(repo, sha) {
      return read(repo, null, async (handle) => bytes(await handle.readBlob(sha)));
    },

    async readFile(repo, at) {
      return read(repo, null, async (handle) =>
        bytes(await handle.readFile({ ref: shortRef(at.ref), path: at.path })),
      );
    },
  };
  return host;
}
