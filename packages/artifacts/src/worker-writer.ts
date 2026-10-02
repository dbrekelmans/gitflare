import { ForgeError, type GitSignature, type Sha, ZERO_SHA } from "@gitflare/core";
import {
  type Clock,
  type FileChange,
  type GitHost,
  type GitWriter,
  type MergeResult,
  systemClock,
  type TreeEntry,
} from "@gitflare/core/ports";
import git, { type GitHttpRequest, type GitHttpResponse, type HttpClient } from "isomorphic-git";
import { relate } from "./ancestry";
import { MemoryFS } from "./memfs";
import { concatBytes, type Fetch, type RemoteAccess, receivePack, uploadPack } from "./wire";

const DIR = "/r";
const encoder = new TextEncoder();
/** How long a token the writer mints for itself lives. It is revoked as soon as the write is done. */
const TOKEN_TTL_SECONDS = 300;
/**
 * A true merge holds what it downloads in memory, about twice over. A 37 MiB
 * pack fitted a 128 MB isolate with 75 MB held; nothing larger was tried.
 */
const DEFAULT_MAX_MERGE_BYTES = 32 * 1024 * 1024;

export interface WorkerGitWriterDeps {
  git: GitHost;
  /** Defaults to the global `fetch`. */
  fetch?: Fetch;
  clock?: Clock;
  /** The most a true merge may download before it gives up with `MergeTooLargeError`. */
  maxMergeBytes?: number;
}

/** The repository is too large to merge in the Worker's memory. The sandbox-backed writer takes over. */
export class MergeTooLargeError extends ForgeError {
  constructor(message: string) {
    super("unavailable", message);
    this.name = "MergeTooLargeError";
  }
}

type Subtree = Map<string, Subtree | Uint8Array | null>;

/** `changes` as a tree of what to write (bytes), delete (null) and descend into. */
function planChanges(changes: FileChange[]): Subtree {
  const root: Subtree = new Map();
  for (const change of changes) {
    const parts = change.path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) {
      throw new ForgeError("invalid", `not a path git can store: ${change.path}`);
    }
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node.get(part);
      if (next instanceof Map) {
        node = next;
      } else {
        const created: Subtree = new Map();
        node.set(part, created);
        node = created;
      }
    }
    const content =
      "delete" in change
        ? null
        : typeof change.content === "string"
          ? encoder.encode(change.content)
          : change.content;
    node.set(parts.at(-1) ?? "", content);
  }
  return root;
}

function writes(node: Subtree): boolean {
  return [...node.values()].some((value) => (value instanceof Map ? writes(value) : value));
}

interface WritableEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** A tree entry as the binding reads it, as isomorphic-git writes it. */
function writable(entry: TreeEntry): WritableEntry {
  if (entry.type === "tree") {
    return { mode: "040000", path: entry.name, oid: entry.sha, type: "tree" };
  }
  if (entry.type === "gitlink") {
    return { mode: "160000", path: entry.name, oid: entry.sha, type: "commit" };
  }
  return { mode: entry.mode, path: entry.name, oid: entry.sha, type: "blob" };
}

function signature(author: GitSignature, clock: Clock) {
  return {
    name: author.name,
    email: author.email,
    timestamp: Math.floor(clock.now() / 1000),
    timezoneOffset: 0,
  };
}

/**
 * isomorphic-git's HTTP client over `fetch`, counting what it downloads
 * against a budget. isomorphic-git can swallow an error thrown while it reads
 * a response, so the overrun is also kept for the caller to ask about.
 */
function countingHttp(fetch: Fetch, budget: number): HttpClient & { exceeded(): boolean } {
  let downloaded = 0;
  return {
    exceeded: () => downloaded > budget,
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.body ?? []) chunks.push(chunk);
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: chunks.length > 0 ? concatBytes(chunks) : undefined,
      });
      const reader = response.body?.getReader();
      async function* body(): AsyncGenerator<Uint8Array> {
        for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
          downloaded += read.value.byteLength;
          if (downloaded > budget) {
            await reader?.cancel();
            throw new MergeTooLargeError("the repository is too large to merge in the Worker");
          }
          yield read.value;
        }
      }
      return {
        url: response.url,
        method: request.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: body(),
      };
    },
  };
}

/**
 * The `GitWriter` port, inside the Worker. A commit is built from binding
 * reads and pushed as a hand-made pack, without cloning; a fast-forward merge
 * relays the fork's pack to the main repo. Both cost tens of milliseconds of
 * CPU whatever the repository's size. A true merge uses isomorphic-git, which
 * holds what it clones in memory: past `maxMergeBytes` it throws
 * `MergeTooLargeError`, and the sandbox-backed writer (`createSandboxGitWriter`)
 * takes over.
 */
export function createWorkerGitWriter(deps: WorkerGitWriterDeps): GitWriter {
  const host = deps.git;
  const clock = deps.clock ?? systemClock;
  const fetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxMergeBytes = deps.maxMergeBytes ?? DEFAULT_MAX_MERGE_BYTES;

  /**
   * Runs `use` with a token for the repository, and revokes it afterwards. A
   * failed revocation is not an error: the write it followed has already
   * happened, and the token dies on its own within minutes.
   */
  async function withAccess<T>(
    name: string,
    scope: "read" | "write",
    use: (remote: RemoteAccess) => Promise<T>,
  ): Promise<T> {
    const repo = await host.getRepo(name);
    if (!repo) throw new ForgeError("not_found", `repo ${name} does not exist`);
    if (repo.status !== "ready") {
      throw new ForgeError("not_ready", `repo ${name} is still being copied`);
    }
    const token = await host.mintToken(name, scope, TOKEN_TTL_SECONDS);
    try {
      return await use({ url: repo.remote, secret: token.secret });
    } finally {
      await host.revokeToken(name, token.id).catch(() => false);
    }
  }

  async function commitFiles(
    request: Parameters<GitWriter["commitFiles"]>[0],
  ): Promise<{ sha: Sha }> {
    const { repo, branch } = request;
    const ref = `refs/heads/${branch}`;
    const plan = planChanges(request.changes);
    const tip = await host.resolveRef(repo, branch);
    if (tip !== request.expectedParent) {
      throw new ForgeError("conflict", `${repo} ${ref} moved: expected ${request.expectedParent}`);
    }
    const parent = tip ? await host.readCommit(repo, tip) : null;

    // Only the new objects are made: the blobs, the trees on their paths and
    // the commit. Every other tree is referred to by the id it already has.
    const fs = new MemoryFS();
    await git.init({ fs, dir: DIR });
    const created = new Set<string>();

    /** The tree with `node` applied to it, or null when that leaves it empty. */
    async function rewrite(treeSha: Sha | null, node: Subtree): Promise<Sha | null> {
      const existing = treeSha ? ((await host.readTree(repo, treeSha)) ?? []) : [];
      const entries = new Map(existing.map((entry) => [entry.name, writable(entry)]));
      for (const [name, value] of node) {
        const current = entries.get(name);
        if (value === null) {
          entries.delete(name);
        } else if (value instanceof Map) {
          // Deleting below a path that is not a directory deletes nothing.
          if (current?.type !== "tree" && !writes(value)) continue;
          const subtree = await rewrite(current?.type === "tree" ? current.oid : null, value);
          if (subtree)
            entries.set(name, { mode: "040000", path: name, oid: subtree, type: "tree" });
          else entries.delete(name);
        } else {
          const oid = await git.writeBlob({ fs, dir: DIR, blob: value });
          created.add(oid);
          // An executable stays executable when its content is replaced.
          const mode = current?.mode === "100755" ? "100755" : "100644";
          entries.set(name, { mode, path: name, oid, type: "blob" });
        }
      }
      if (entries.size === 0) return null;
      const oid = await git.writeTree({ fs, dir: DIR, tree: [...entries.values()] });
      created.add(oid);
      return oid;
    }

    // Git has no empty directories, so one left with nothing is dropped from
    // its parent; only the root may be empty.
    const tree =
      (await rewrite(parent?.treeSha ?? null, plan)) ??
      (await git.writeTree({ fs, dir: DIR, tree: [] }));
    created.add(tree);
    const who = signature(request.author, clock);
    const sha = await git.writeCommit({
      fs,
      dir: DIR,
      commit: {
        message: request.message,
        tree,
        parent: tip ? [tip] : [],
        author: who,
        committer: who,
      },
    });
    created.add(sha);
    const { packfile } = await git.packObjects({ fs, dir: DIR, oids: [...created] });
    if (!packfile) throw new ForgeError("unavailable", "could not build the pack to push");

    await withAccess(repo, "write", (remote) =>
      receivePack(fetch, remote, { ref, old: tip ?? ZERO_SHA, new: sha }, packfile),
    );
    return { sha };
  }

  /** Moves the target's branch to a commit that descends from it, by handing over the pack the fork makes of the difference. */
  async function relay(
    request: Parameters<GitWriter["merge"]>[0],
    ours: Sha | null,
  ): Promise<MergeResult> {
    const { target, source } = request;
    await withAccess(target.repo, "write", (parent) =>
      withAccess(source.repo, "read", async (fork) => {
        // The whole pack is held in memory between the two requests.
        const pack = await uploadPack(fetch, fork, { want: source.sha, haves: ours ? [ours] : [] });
        await receivePack(
          fetch,
          parent,
          { ref: `refs/heads/${target.branch}`, old: ours ?? ZERO_SHA, new: source.sha },
          pack,
        );
      }),
    );
    return { status: "merged", sha: source.sha };
  }

  async function trueMerge(
    request: Parameters<GitWriter["merge"]>[0],
    depth: { ours: number; theirs: number },
  ): Promise<MergeResult> {
    const { target, source } = request;
    return withAccess(target.repo, "write", (parent) =>
      withAccess(source.repo, "read", async (fork): Promise<MergeResult> => {
        const fs = new MemoryFS();
        const http = countingHttp(fetch, maxMergeBytes);
        const auth = (remote: RemoteAccess) => () => ({ username: "x", password: remote.secret });
        // Shallow on both sides, but deep enough to hold the commit the two
        // histories parted at: without it isomorphic-git finds no merge base.
        try {
          await git.clone({
            fs,
            http,
            dir: DIR,
            url: parent.url,
            ref: target.branch,
            singleBranch: true,
            noTags: true,
            noCheckout: true,
            depth: depth.ours,
            onAuth: auth(parent),
          });
          await git.addRemote({ fs, dir: DIR, remote: "fork", url: fork.url });
          await git.fetch({
            fs,
            http,
            dir: DIR,
            remote: "fork",
            ref: source.sha,
            singleBranch: true,
            tags: false,
            depth: depth.theirs,
            onAuth: auth(fork),
          });
        } catch (error) {
          if (http.exceeded()) {
            throw new MergeTooLargeError(
              `${target.repo} is too large to merge in the Worker: more than ${maxMergeBytes} bytes to download`,
            );
          }
          throw error;
        }

        const who = signature(request.author, clock);
        let merged: Awaited<ReturnType<typeof git.merge>>;
        try {
          merged = await git.merge({
            fs,
            dir: DIR,
            ours: target.branch,
            theirs: source.sha,
            abortOnConflict: true,
            author: who,
            committer: who,
            message: request.message,
          });
        } catch (error) {
          if (error instanceof git.Errors.MergeConflictError) {
            return { status: "conflict", paths: [...error.data.filepaths].sort() };
          }
          throw error;
        }
        const sha = merged.oid;
        if (!sha) throw new ForgeError("unavailable", "the merge produced no commit");
        if (merged.alreadyMerged) return { status: "up_to_date", sha };

        try {
          await git.push({
            fs,
            http,
            dir: DIR,
            url: parent.url,
            ref: target.branch,
            onAuth: auth(parent),
          });
        } catch (error) {
          if (
            error instanceof git.Errors.PushRejectedError ||
            error instanceof git.Errors.GitPushError
          ) {
            throw new ForgeError(
              "conflict",
              `${target.repo} ${target.branch} moved during the merge`,
            );
          }
          throw error;
        }
        return { status: "merged", sha };
      }),
    );
  }

  async function merge(request: Parameters<GitWriter["merge"]>[0]): Promise<MergeResult> {
    const { target, source } = request;
    if (!(await host.readCommit(source.repo, source.sha))) {
      throw new ForgeError("not_found", `commit ${source.sha} does not exist`);
    }
    const ours = await host.resolveRef(target.repo, target.branch);
    if (!ours) return relay(request, null);

    // The server accepts any commit as the new tip when the old value is
    // right, so whether this is a fast-forward is decided here.
    const relation = await relate(host, { repo: target.repo, sha: ours }, source);
    switch (relation.kind) {
      case "up_to_date":
        return { status: "up_to_date", sha: ours };
      case "fast_forward":
        return relay(request, ours);
      case "unrelated":
        throw new ForgeError(
          "invalid",
          `${source.sha} shares no history with ${target.repo} ${target.branch}`,
        );
      case "diverged":
        return trueMerge(request, { ours: relation.oursDepth, theirs: relation.theirsDepth });
    }
  }

  return { commitFiles, merge };
}
