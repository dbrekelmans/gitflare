import {
  CHECKPOINT_REF_PREFIX,
  contextRepoName,
  forkRepoName,
  type GitSignature,
  mainRepoName,
  type Sha,
} from "@gitflare/core";
import type { FileChange } from "@gitflare/core/ports";
import { FakeGit } from "../fakes/git";
import { ManualClock } from "../fakes/runtime";
import { demoFiles } from "./files";

export const DEMO_T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
export const minutes = (n: number) => DEMO_T0 + n * 60_000;

export const DEMO_SLUG = "atlas-web";
export const DEMO_CHECKPOINT_ID = "01M3YB2T7QH8ZK4N5V6W9XACD1";
export const DEMO_AGENT_SESSION_ID = "5f0c2a9e-7d41-4b7e-9c35-2f6a1d8e4b90";

export const demoSessionIds = {
  merged: "ses_01k6priya",
  review: "ses_01k6jonas",
  cloud: "ses_01k6maya",
} as const;

const gitflare: GitSignature = { name: "gitflare", email: "gitflare@northwind.example" };
const jonas: GitSignature = { name: "Jonas Lindqvist", email: "jonas@northwind.example" };
const priya: GitSignature = { name: "Priya Raman", email: "priya@northwind.example" };
const maya: GitSignature = { name: "Maya Okafor", email: "maya@northwind.example" };

function changesBetween(
  before: Record<string, string>,
  after: Record<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of Object.entries(after)) {
    if (before[path] !== content) changes.push({ path, content });
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) changes.push({ path, delete: true });
  }
  return changes;
}

const trailer = `\n\nEntire-Checkpoint: ${DEMO_CHECKPOINT_ID}`;

/** The compact transcript Entire stores as `transcript.jsonl`, one JSON object per line. */
const transcriptLines = [
  {
    type: "user",
    ts: "2026-10-01T09:12:00.000Z",
    content: [
      {
        text: "Support had three workspaces send thousands of invites last week. Cap invites at 20 an hour per workspace and tell the client when it can retry.",
      },
    ],
  },
  {
    type: "assistant",
    ts: "2026-10-01T09:12:40.000Z",
    content: [
      {
        type: "text",
        text: "The queue already has a token-bucket limiter, but it limits delivery, not how many invites a workspace may create. I'll add a fixed hourly window in front of sendInvite so the response can say exactly when the window resets.",
      },
      {
        type: "tool_use",
        name: "Write",
        input: { file_path: "src/invites/rate-limit.ts" },
        result: { output: "created", status: "success" },
      },
    ],
  },
  {
    type: "user",
    ts: "2026-10-01T09:20:00.000Z",
    content: [{ text: "Keep the counter out of KV, we got bitten by its consistency before." }],
  },
  {
    type: "assistant",
    ts: "2026-10-01T09:21:10.000Z",
    content: [
      {
        type: "text",
        text: "Using a Durable Object per window for the counter, and returning 429 with Retry-After from the route.",
      },
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "pnpm test test/invites" },
        result: { output: "1 passed", status: "success" },
      },
    ],
  },
].map((line) => JSON.stringify({ v: 1, agent: "claude-code", cli_version: "0.11.3", ...line }));

function checkpointFiles(): Record<string, string> {
  const base = {
    cli_version: "0.11.3",
    checkpoint_id: DEMO_CHECKPOINT_ID,
    strategy: "manual-commit",
    branch: "rate-limit-invites",
    checkpoints_count: 2,
    files_touched: Object.keys(demoFiles.rev1).filter(
      (path) => demoFiles.base[path] !== demoFiles.rev1[path],
    ),
  };
  return {
    "metadata.json": JSON.stringify(
      {
        ...base,
        sessions: [
          {
            metadata: "/0/metadata.json",
            transcript: "/0/full.jsonl",
            compact_transcript: "/0/transcript.jsonl",
            content_hash: "/0/content_hash.txt",
            prompt: "/0/prompt.txt",
          },
        ],
      },
      null,
      2,
    ),
    "0/metadata.json": JSON.stringify(
      {
        ...base,
        session_id: DEMO_AGENT_SESSION_ID,
        created_at: "2026-10-01T09:30:00.000Z",
        agent: "Claude Code",
        model: "claude-sonnet-5",
        checkpoint_transcript_start: 0,
        compact_transcript_start: 0,
        initial_attribution: {
          calculated_at: "2026-10-01T09:30:00.000Z",
          agent_lines: 71,
          agent_removed: 2,
          human_added: 4,
          human_modified: 0,
          human_removed: 0,
          total_committed: 75,
          total_lines_changed: 77,
          agent_percentage: 94.8,
          metric_version: 2,
        },
      },
      null,
      2,
    ),
    "0/full.jsonl": `${transcriptLines.join("\n")}\n`,
    "0/transcript.jsonl": `${transcriptLines.join("\n")}\n`,
    "0/prompt.txt":
      "Support had three workspaces send thousands of invites last week. Cap invites at 20 an hour per workspace and tell the client when it can retry.\n\n---\n\nKeep the counter out of KV, we got bitten by its consistency before.",
    "0/content_hash.txt": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
}

export interface DemoGit {
  git: FakeGit;
  repos: { main: string; context: string; forks: Record<keyof typeof demoSessionIds, string> };
  checkpointRef: string;
  shas: {
    /** The initial import of the main repo. */
    initial: Sha;
    /** Change #11, fast-forwarded into main: the base the other two forked from. */
    base: Sha;
    /** Change #12's three commits, oldest first. */
    review: [Sha, Sha, Sha];
    /** Change #13's one commit. */
    cloud: Sha;
    checkpoint: Sha;
  };
}

/**
 * Builds the demo's repositories in a fresh fake git host. The same calls in
 * the same order give the same commit ids every time, so records elsewhere in
 * the fixture can name them.
 */
export function buildDemoGit(decisionFiles: Record<string, string> = {}): DemoGit {
  const clock = new ManualClock(DEMO_T0 - 86_400_000);
  const git = new FakeGit(clock);
  const main = mainRepoName(DEMO_SLUG);
  const context = contextRepoName(DEMO_SLUG);
  const forks = {
    merged: forkRepoName(DEMO_SLUG, demoSessionIds.merged),
    review: forkRepoName(DEMO_SLUG, demoSessionIds.review),
    cloud: forkRepoName(DEMO_SLUG, demoSessionIds.cloud),
  };
  const create = (name: string) => void git.createRepo(name);
  const fork = (name: string) => void git.forkRepo(main, name);

  create(main);
  create(context);

  const { "src/invites/email.ts": _email, ...beforeQueue } = demoFiles.base;
  const initial = git.push(main, "main", beforeQueue, {
    message: "Import atlas-web",
    author: gitflare,
  }).after;

  clock.set(minutes(-600));
  fork(forks.merged);
  const base = git.push(
    forks.merged,
    "queue-invite-emails",
    changesBetween(beforeQueue, demoFiles.base),
    {
      message: "Move invite emails to the queue",
      author: priya,
    },
  ).after;
  // Gitflare's merge of change #11 was a fast-forward.
  void git.merge({
    target: { repo: main, branch: "main" },
    source: { repo: forks.merged, sha: base },
    message: "Merge change #11",
    author: gitflare,
  });

  clock.set(minutes(10));
  fork(forks.review);
  const { "test/invites/rate-limit.test.ts": test, ...rev1WithoutTest } = demoFiles.rev1;
  const first = git.push(
    forks.review,
    "rate-limit-invites",
    changesBetween(demoFiles.base, rev1WithoutTest),
    {
      message: `Rate-limit invites per hour${trailer}`,
      author: jonas,
    },
  ).after;
  clock.set(minutes(28));
  const second = git.push(
    forks.review,
    "rate-limit-invites",
    { "test/invites/rate-limit.test.ts": test ?? "" },
    { message: `Test the invite limit${trailer}`, author: jonas },
  ).after;
  clock.set(minutes(95));
  const third = git.push(
    forks.review,
    "rate-limit-invites",
    changesBetween(demoFiles.rev1, demoFiles.head),
    {
      message: "Count invites per workspace\n\nRequested in review of change #12.",
      author: gitflare,
    },
  ).after;

  clock.set(minutes(30));
  const checkpointRef = `${CHECKPOINT_REF_PREFIX}${DEMO_CHECKPOINT_ID.slice(-2)}/${DEMO_CHECKPOINT_ID}`;
  const checkpoint = git.push(context, checkpointRef, checkpointFiles(), {
    message: `Checkpoint: ${DEMO_CHECKPOINT_ID}\n\nEntire-Session: ${DEMO_AGENT_SESSION_ID}\nEntire-Strategy: manual-commit\nEntire-Agent: Claude Code`,
    author: jonas,
  }).after;
  if (Object.keys(decisionFiles).length > 0) {
    git.push(context, "main", decisionFiles, { message: "Record decisions", author: gitflare });
  }

  clock.set(minutes(140));
  fork(forks.cloud);
  const cloud = git.push(
    forks.cloud,
    "audit-log-export",
    {
      "src/audit/export.ts": `import type { Env } from "../env";

export async function exportAuditLog(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare(
    "select at, actor, action from audit_log where workspace_id = ? order by at",
  )
    .bind(workspaceId)
    .all<{ at: number; actor: string; action: string }>();
  return results.map((row) => [new Date(row.at).toISOString(), row.actor, row.action].join(",")).join("\\n");
}
`,
    },
    { message: "Add audit log export", author: maya },
  ).after;

  return {
    git,
    repos: { main, context, forks },
    checkpointRef,
    shas: { initial, base, review: [first, second, third], cloud, checkpoint },
  };
}
