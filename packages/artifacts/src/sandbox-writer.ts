import { ForgeError, type Sha, type WorkspaceSettings } from "@gitflare/core";
import {
  type ExecResult,
  type GitHost,
  type GitWriter,
  type IdGenerator,
  type MergeResult,
  type SandboxHost,
  workspaceStart,
} from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";
import { relate } from "./ancestry";
import { createWorkerGitWriter, MergeTooLargeError } from "./worker-writer";

/** Where the merge happens inside the sandbox. Nothing is checked out there. */
const DIR = "/tmp/gitflare-merge";
const FETCH_TIMEOUT_SECONDS = 600;

export interface SandboxGitWriterDeps {
  git: GitHost;
  /** For the default worker writer, which records the tokens it mints. */
  db: Db;
  sandboxes: SandboxHost;
  ids: IdGenerator;
  /** The deployment's prepared workspace: the snapshot is where git is installed. */
  workspace: () => Promise<WorkspaceSettings>;
  /** What does everything that fits in the Worker. Defaults to `createWorkerGitWriter({ git, db })`. */
  worker?: GitWriter;
}

/**
 * The `GitWriter` for what the Worker cannot hold in memory. Commits,
 * fast-forwards and small merges are done by the Worker's own writer; a true
 * merge it gives up on as too large is done with real git in a sandbox:
 * shallow fetches of both sides, a merge that checks nothing out, and a push,
 * with credentials added at the egress.
 */
export function createSandboxGitWriter(deps: SandboxGitWriterDeps): GitWriter {
  const { git } = deps;
  const worker = deps.worker ?? createWorkerGitWriter({ git, db: deps.db });

  async function remoteOf(name: string): Promise<string> {
    const repo = await git.getRepo(name);
    if (!repo) throw new ForgeError("not_found", `repo ${name} does not exist`);
    if (repo.status !== "ready") {
      throw new ForgeError("not_ready", `repo ${name} is still being copied`);
    }
    return repo.remote;
  }

  async function mergeInSandbox(
    request: Parameters<GitWriter["merge"]>[0],
    ours: Sha,
    depth: { ours: number; theirs: number },
  ): Promise<MergeResult> {
    const { target, source, author } = request;
    const [targetRemote, sourceRemote] = await Promise.all([
      remoteOf(target.repo),
      remoteOf(source.repo),
    ]);
    const sandbox = deps.sandboxes.get(deps.ids.next("sandbox"));
    await sandbox.start({
      ...workspaceStart(await deps.workspace()),
      instance: "standard-1",
      // No credential enters the container: the egress adds a token of each scope.
      egress: [
        { kind: "git", repo: target.repo, scope: "write" },
        { kind: "git", repo: source.repo, scope: "read" },
      ],
    });

    const run = (args: string[], timeoutSeconds = 120): Promise<ExecResult> =>
      sandbox.exec(["git", ...args], {
        cwd: DIR,
        timeoutSeconds,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      });
    const must = async (args: string[], timeoutSeconds?: number): Promise<string> => {
      const result = await run(args, timeoutSeconds);
      if (result.exitCode !== 0) {
        throw new ForgeError(
          "unavailable",
          `git ${args[0]} failed in the sandbox (${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
      return result.stdout.trim();
    };

    try {
      const init = await sandbox.exec(["git", "init", "-q", "--bare", DIR]);
      if (init.exitCode !== 0) {
        throw new ForgeError(
          "unavailable",
          `git init failed in the sandbox: ${init.stderr.trim()}`,
        );
      }
      // A full clone of a large repository takes a minute; a fetch only as deep
      // as the commit the histories parted at takes a second or two.
      await must(
        ["fetch", "-q", `--depth=${depth.ours}`, targetRemote, ours],
        FETCH_TIMEOUT_SECONDS,
      );
      await must(
        ["fetch", "-q", `--depth=${depth.theirs}`, sourceRemote, source.sha],
        FETCH_TIMEOUT_SECONDS,
      );

      // Exit 0 prints the merged tree; exit 1 prints a tree with conflict
      // markers and then the paths that conflict.
      const merged = await run([
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        ours,
        source.sha,
      ]);
      const [tree = "", ...paths] = merged.stdout.trim().split("\n");
      if (merged.exitCode === 1) {
        return { status: "conflict", paths: paths.filter(Boolean).sort() };
      }
      if (merged.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(tree)) {
        throw new ForgeError(
          "unavailable",
          `git merge-tree failed in the sandbox (${merged.exitCode}): ${merged.stderr.trim()}`,
        );
      }

      const sha = await must([
        "commit-tree",
        tree,
        "-p",
        ours,
        "-p",
        source.sha,
        "-m",
        request.message,
      ]);
      // A plain push: git itself refuses it if the branch no longer points at
      // an ancestor of the merge, which is the case when someone else moved it.
      const push = await run(
        ["push", "-q", targetRemote, `${sha}:refs/heads/${target.branch}`],
        FETCH_TIMEOUT_SECONDS,
      );
      if (push.exitCode !== 0) {
        const moved = /rejected|fetch first|non-fast-forward|stale/.test(push.stderr);
        throw new ForgeError(
          moved ? "conflict" : "unavailable",
          moved
            ? `${target.repo} ${target.branch} moved during the merge`
            : `git push failed in the sandbox (${push.exitCode}): ${push.stderr.trim()}`,
        );
      }
      return { status: "merged", sha };
    } finally {
      await sandbox.stop();
    }
  }

  return {
    commitFiles: (request) => worker.commitFiles(request),

    async merge(request) {
      try {
        return await worker.merge(request);
      } catch (error) {
        if (!(error instanceof MergeTooLargeError)) throw error;
      }
      const { target, source } = request;
      const ours = await git.resolveRef(target.repo, target.branch);
      const relation = ours ? await relate(git, { repo: target.repo, sha: ours }, source) : null;
      // The branch moved while the Worker was trying, and what is left is no
      // longer a true merge: that is the Worker's to do.
      if (!ours || relation?.kind !== "diverged") return worker.merge(request);
      return mergeInSandbox(request, ours, {
        ours: relation.oursDepth,
        theirs: relation.theirsDepth,
      });
    },
  };
}
