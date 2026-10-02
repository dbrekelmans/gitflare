import {
  type AgentName,
  type Approval,
  type CapturedSession,
  type Change,
  type ChangeCommit,
  type ChangeDecisionLink,
  type ChangeEvent,
  type ChangeEventBody,
  type ChangeId,
  type CheckpointRef,
  type CiRun,
  type CiStep,
  type CloudSessionEvent,
  type CloudSessionStatus,
  type Decision,
  type DecisionEvent,
  defaultOrganisationSettings,
  type FileDiff,
  type Intent,
  type ModelCall,
  type Organisation,
  type Repository,
  type Revision,
  type RevisionId,
  type Section,
  type SectionId,
  type Session,
  type StageName,
  type StageRun,
  type StageStatus,
  sectionContentHash,
  stageNames,
  type Thread,
  type ThreadMessage,
  type Timestamp,
  type User,
} from "@gitflare/core";
import { diffFiles } from "./diff";
import { demoFiles } from "./files";
import {
  buildDemoGit,
  DEMO_AGENT_SESSION_ID,
  DEMO_CHECKPOINT_ID,
  DEMO_SLUG,
  demoSessionIds,
  minutes,
} from "./git";

export { demoFiles } from "./files";
export { buildDemoGit, DEMO_CHECKPOINT_ID, DEMO_SLUG, DEMO_T0 } from "./git";

// One small, believable deployment, used three ways: the fixture API serves it
// to screens, the seed writes it into the local database, and tests start
// from it. The story it tells is in the records' own text; start at change #12.

const git = buildDemoGit();

// --- People ---------------------------------------------------------------

const organisation: Organisation = {
  id: "org_northwind",
  name: "Northwind Studio",
  slug: "northwind",
  settings: defaultOrganisationSettings,
  createdAt: minutes(-60 * 24 * 30),
};

function user(id: string, name: string, role: User["role"]): User {
  const first = name.split(" ")[0]?.toLowerCase() ?? id;
  return {
    id: `usr_${id}`,
    organisationId: organisation.id,
    subject: `demo|${first}`,
    email: `${first}@northwind.example`,
    name,
    role,
    createdAt: organisation.createdAt,
    lastSeenAt: minutes(150),
  };
}

const maya = user("maya", "Maya Okafor", "admin");
const jonas = user("jonas", "Jonas Lindqvist", "member");
const priya = user("priya", "Priya Raman", "member");

// --- Repositories and sessions --------------------------------------------

const atlas: Repository = {
  id: "rep_atlas",
  organisationId: organisation.id,
  slug: DEMO_SLUG,
  description: "The customer portal.",
  defaultBranch: "main",
  headSha: git.shas.base,
  captureEnabled: true,
  createdAt: minutes(-60 * 24 * 21),
  readyAt: minutes(-60 * 24 * 21),
  archivedAt: null,
};

const billing: Repository = {
  id: "rep_billing",
  organisationId: organisation.id,
  slug: "billing-worker",
  description: "Invoices and usage metering.",
  defaultBranch: "main",
  headSha: null,
  captureEnabled: false,
  createdAt: minutes(-60 * 24 * 3),
  readyAt: minutes(-60 * 24 * 3),
  archivedAt: null,
};

const sessions: Session[] = [
  {
    id: demoSessionIds.merged,
    repositoryId: atlas.id,
    userId: priya.id,
    kind: "local",
    status: "merged",
    title: "Move invite emails to the queue",
    forkRepo: git.repos.forks.merged,
    baseSha: git.shas.initial,
    createdAt: minutes(-600),
    forkReadyAt: minutes(-600),
    endedAt: minutes(-420),
    forkDeletedAt: minutes(-419),
  },
  {
    id: demoSessionIds.review,
    repositoryId: atlas.id,
    userId: jonas.id,
    kind: "local",
    status: "active",
    title: "Rate-limit the invite endpoint",
    forkRepo: git.repos.forks.review,
    baseSha: git.shas.base,
    createdAt: minutes(10),
    forkReadyAt: minutes(10),
    endedAt: null,
    forkDeletedAt: null,
  },
  {
    id: demoSessionIds.cloud,
    repositoryId: atlas.id,
    userId: maya.id,
    kind: "cloud",
    status: "active",
    title: "Add audit log export",
    forkRepo: git.repos.forks.cloud,
    baseSha: git.shas.base,
    createdAt: minutes(140),
    forkReadyAt: minutes(140),
    endedAt: null,
    forkDeletedAt: null,
  },
];

// --- Changes ----------------------------------------------------------------

const [firstSha, secondSha, headSha] = git.shas.review;

const mergedChange: Change = {
  id: "chg_demo11",
  repositoryId: atlas.id,
  sessionId: demoSessionIds.merged,
  number: 11,
  title: "Move invite emails to the queue",
  status: "merged",
  authorId: priya.id,
  headRef: "refs/heads/queue-invite-emails",
  baseSha: git.shas.initial,
  headSha: git.shas.base,
  headRevisionId: "rev_demo11a",
  openedAt: minutes(-590),
  readyAt: minutes(-580),
  mergedAt: minutes(-420),
  mergedBy: maya.id,
  mergeSha: git.shas.base,
  closedAt: null,
};

const reviewChange: Change = {
  id: "chg_demo12",
  repositoryId: atlas.id,
  sessionId: demoSessionIds.review,
  number: 12,
  title: "Rate-limit the invite endpoint",
  status: "ready",
  authorId: jonas.id,
  headRef: "refs/heads/rate-limit-invites",
  baseSha: git.shas.base,
  headSha,
  headRevisionId: "rev_demo12b",
  openedAt: minutes(29),
  readyAt: minutes(104),
  mergedAt: null,
  mergedBy: null,
  mergeSha: null,
  closedAt: null,
};

const cloudChange: Change = {
  id: "chg_demo13",
  repositoryId: atlas.id,
  sessionId: demoSessionIds.cloud,
  number: 13,
  title: "Add audit log export",
  status: "processing",
  authorId: maya.id,
  headRef: "refs/heads/audit-log-export",
  baseSha: git.shas.base,
  headSha: git.shas.cloud,
  headRevisionId: "rev_demo13a",
  openedAt: minutes(148),
  readyAt: null,
  mergedAt: null,
  mergedBy: null,
  mergeSha: null,
  closedAt: null,
};

const rev1Diff = diffFiles(demoFiles.base, demoFiles.rev1);
const headDiff = diffFiles(demoFiles.base, demoFiles.head);

function statsOf(diff: FileDiff[], commits: number): Revision["stats"] {
  return {
    commits,
    filesChanged: diff.length,
    insertions: diff.reduce((sum, file) => sum + file.insertions, 0),
    deletions: diff.reduce((sum, file) => sum + file.deletions, 0),
  };
}

const revisions: Revision[] = [
  {
    id: "rev_demo11a",
    changeId: mergedChange.id,
    number: 1,
    baseSha: git.shas.initial,
    headSha: git.shas.base,
    pushedAt: minutes(-590),
    stats: { commits: 1, filesChanged: 1, insertions: 5, deletions: 0 },
  },
  {
    id: "rev_demo12a",
    changeId: reviewChange.id,
    number: 1,
    baseSha: git.shas.base,
    headSha: secondSha,
    pushedAt: minutes(29),
    stats: statsOf(rev1Diff, 2),
  },
  {
    id: "rev_demo12b",
    changeId: reviewChange.id,
    number: 2,
    baseSha: git.shas.base,
    headSha,
    pushedAt: minutes(96),
    stats: statsOf(headDiff, 3),
  },
  {
    id: "rev_demo13a",
    changeId: cloudChange.id,
    number: 1,
    baseSha: git.shas.base,
    headSha: git.shas.cloud,
    pushedAt: minutes(148),
    stats: { commits: 1, filesChanged: 1, insertions: 10, deletions: 0 },
  },
];

const commits: ChangeCommit[] = [
  {
    changeId: mergedChange.id,
    revisionId: "rev_demo11a",
    sha: git.shas.base,
    message: "Move invite emails to the queue",
    authorName: priya.name,
    authorEmail: priya.email,
    authoredAt: minutes(-600),
    checkpointIds: [],
  },
  {
    changeId: reviewChange.id,
    revisionId: "rev_demo12a",
    sha: firstSha,
    message: `Rate-limit invites per hour\n\nEntire-Checkpoint: ${DEMO_CHECKPOINT_ID}`,
    authorName: jonas.name,
    authorEmail: jonas.email,
    authoredAt: minutes(10),
    checkpointIds: [DEMO_CHECKPOINT_ID],
  },
  {
    changeId: reviewChange.id,
    revisionId: "rev_demo12a",
    sha: secondSha,
    message: `Test the invite limit\n\nEntire-Checkpoint: ${DEMO_CHECKPOINT_ID}`,
    authorName: jonas.name,
    authorEmail: jonas.email,
    authoredAt: minutes(28),
    checkpointIds: [DEMO_CHECKPOINT_ID],
  },
  {
    changeId: reviewChange.id,
    revisionId: "rev_demo12b",
    sha: headSha,
    message: "Count invites per workspace\n\nRequested in review of change #12.",
    authorName: "gitflare",
    authorEmail: "gitflare@northwind.example",
    authoredAt: minutes(95),
    checkpointIds: [],
  },
  {
    changeId: cloudChange.id,
    revisionId: "rev_demo13a",
    sha: git.shas.cloud,
    message: "Add audit log export",
    authorName: maya.name,
    authorEmail: maya.email,
    authoredAt: minutes(140),
    checkpointIds: [],
  },
];

// --- Stages -----------------------------------------------------------------

function stageRunsFor(
  changeId: ChangeId,
  revisionId: RevisionId,
  startedAt: Timestamp,
  statuses: Partial<Record<StageName, [StageStatus, string?]>>,
): StageRun[] {
  return stageNames.map((stage, index) => {
    const [status, reason] = statuses[stage] ?? ["succeeded"];
    const settled = status === "succeeded" || status === "failed" || status === "skipped";
    return {
      id: `stg_${revisionId.slice(4)}_${stage}`,
      changeId,
      revisionId,
      stage,
      attempt: 1,
      status,
      reason: reason ?? null,
      startedAt: status === "queued" || status === "skipped" ? null : startedAt,
      finishedAt: settled ? startedAt + (index + 1) * 90_000 : null,
    };
  });
}

const stageRuns: StageRun[] = [
  ...stageRunsFor(mergedChange.id, "rev_demo11a", minutes(-590), {}),
  ...stageRunsFor(reviewChange.id, "rev_demo12a", minutes(29), {}),
  ...stageRunsFor(reviewChange.id, "rev_demo12b", minutes(96), {
    intent: ["skipped", "Intent is derived once, when the change opens."],
  }),
  ...stageRunsFor(cloudChange.id, "rev_demo13a", minutes(148), {
    sections: ["running"],
    review: ["running"],
    ci: ["running"],
  }),
];

const intents: Intent[] = [
  {
    id: "int_demo11",
    changeId: mergedChange.id,
    revisionId: "rev_demo11a",
    version: 1,
    statement:
      "Send invite emails through the queue so a slow mail provider no longer holds the invite request open.",
    grade: "diff",
    checkpointIds: [],
    model: "anthropic/claude-sonnet-5",
    createdAt: minutes(-589),
  },
  {
    id: "int_demo12",
    changeId: reviewChange.id,
    revisionId: "rev_demo12a",
    version: 1,
    statement:
      "Stop a single workspace from sending invites without bound: cap invites at twenty per workspace per hour, and tell the client when it may try again. Asked for after support saw three workspaces send thousands in a week.",
    grade: "transcript",
    checkpointIds: [DEMO_CHECKPOINT_ID],
    model: "anthropic/claude-sonnet-5",
    createdAt: minutes(30),
  },
  {
    id: "int_demo13",
    changeId: cloudChange.id,
    revisionId: "rev_demo13a",
    version: 1,
    statement:
      "Let a workspace owner download their audit log as CSV, for a customer who needs it for a compliance review.",
    grade: "transcript",
    checkpointIds: [],
    model: "anthropic/claude-sonnet-5",
    createdAt: minutes(149),
  },
];

// --- Sections and approvals ---------------------------------------------------

function contentHash(diff: FileDiff[], paths: string[]): string {
  return sectionContentHash(
    diff,
    paths.map((path) => ({ path, hunkHashes: [] })),
  );
}

const demo11Diff = diffFiles(
  {},
  { "src/invites/email.ts": demoFiles.base["src/invites/email.ts"] ?? "" },
);
const demo11Hash = contentHash(demo11Diff, ["src/invites/email.ts"]);

const sectionPlan = [
  {
    id: "sec_demo12limit",
    title: "Limit invites per workspace",
    kind: "behaviour",
    paths: ["src/invites/rate-limit.ts", "src/invites/send-invite.ts", "src/invites/counter.ts"],
    explanation:
      "`sendInvite` now asks `takeInviteSlot` before it writes anything. The slot comes from a counter held in a Durable Object named for the workspace and the current hour, so the count is exact and the response can say when the hour ends. When the limit is reached nothing is inserted and no email is queued.",
  },
  {
    id: "sec_demo12route",
    title: "Answer a limited request with 429",
    kind: "behaviour",
    paths: ["src/routes/invites.ts"],
    explanation:
      "The route turns a limited result into `429 Too Many Requests` with a `Retry-After` header carrying the seconds left in the window. The success path is unchanged.",
  },
  {
    id: "sec_demo12tests",
    title: "Tests for the limit",
    kind: "tests",
    paths: ["test/invites/rate-limit.test.ts"],
    explanation:
      "Two tests: the twenty-first invite in an hour is refused with a positive retry time, and one workspace reaching its limit does not affect another.",
  },
  {
    id: "sec_demo12config",
    title: "Bindings and configuration",
    kind: "mechanical",
    paths: ["src/env.ts", "wrangler.jsonc"],
    explanation:
      "Declares the `InviteCounter` Durable Object and its binding. No behaviour of its own.",
  },
] as const;

const sections: Section[] = [
  {
    id: "sec_demo11queue",
    changeId: mergedChange.id,
    position: 0,
    title: "Queue the invite email",
    kind: "behaviour",
    explanation:
      "`sendInvite` hands the email to the `invite-emails` queue instead of calling the mail provider.",
    files: [{ path: "src/invites/email.ts", hunkHashes: [] }],
    contentHash: demo11Hash,
    createdRevisionId: "rev_demo11a",
    updatedRevisionId: "rev_demo11a",
  },
  ...sectionPlan.map((plan, position): Section => {
    const changedInRev2 =
      contentHash(rev1Diff, [...plan.paths]) !== contentHash(headDiff, [...plan.paths]);
    return {
      id: plan.id,
      changeId: reviewChange.id,
      position,
      title: plan.title,
      kind: plan.kind,
      explanation: plan.explanation,
      files: plan.paths.map((path) => ({ path, hunkHashes: [] })),
      contentHash: contentHash(headDiff, [...plan.paths]),
      createdRevisionId: "rev_demo12a",
      updatedRevisionId: changedInRev2 ? "rev_demo12b" : "rev_demo12a",
    };
  }),
];

const sectionDiffs: Record<SectionId, FileDiff[]> = { sec_demo11queue: demo11Diff };
for (const plan of sectionPlan) {
  sectionDiffs[plan.id] = plan.paths.flatMap((path) =>
    headDiff.filter((file) => file.path === path),
  );
}

const rev1Hash = (id: (typeof sectionPlan)[number]["id"]) =>
  contentHash(rev1Diff, [...(sectionPlan.find((plan) => plan.id === id)?.paths ?? [])]);
const headHash = (id: SectionId) =>
  sections.find((section) => section.id === id)?.contentHash ?? "";

const approvals: Approval[] = [
  {
    id: "apr_demo11",
    changeId: mergedChange.id,
    sectionId: "sec_demo11queue",
    userId: maya.id,
    selfApproval: false,
    contentHash: demo11Hash,
    createdAt: minutes(-430),
    withdrawnAt: null,
    withdrawnReason: null,
  },
  // Priya approved the limit before the fix; the second push changed it, so she approved it again.
  {
    id: "apr_demo12a",
    changeId: reviewChange.id,
    sectionId: "sec_demo12limit",
    userId: priya.id,
    selfApproval: false,
    contentHash: rev1Hash("sec_demo12limit"),
    createdAt: minutes(52),
    withdrawnAt: minutes(96),
    withdrawnReason: "content_changed",
  },
  {
    id: "apr_demo12b",
    changeId: reviewChange.id,
    sectionId: "sec_demo12limit",
    userId: priya.id,
    selfApproval: false,
    contentHash: headHash("sec_demo12limit"),
    createdAt: minutes(118),
    withdrawnAt: null,
    withdrawnReason: null,
  },
  // Maya approved the tests at the first push. The second push added a test, which withdrew it.
  {
    id: "apr_demo12c",
    changeId: reviewChange.id,
    sectionId: "sec_demo12tests",
    userId: maya.id,
    selfApproval: false,
    contentHash: rev1Hash("sec_demo12tests"),
    createdAt: minutes(60),
    withdrawnAt: minutes(96),
    withdrawnReason: "content_changed",
  },
  {
    id: "apr_demo12d",
    changeId: reviewChange.id,
    sectionId: "sec_demo12config",
    userId: priya.id,
    selfApproval: false,
    contentHash: headHash("sec_demo12config"),
    createdAt: minutes(53),
    withdrawnAt: null,
    withdrawnReason: null,
  },
];

// --- Decisions ----------------------------------------------------------------

function decision(
  id: string,
  title: string,
  statement: string,
  rationale: string,
  strength: number,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id: `dec_${id}`,
    repositoryId: atlas.id,
    path: `decisions/${id.replaceAll("_", "-")}.md`,
    title,
    statement,
    rationale,
    scope: { kind: "general" },
    status: strength < 0.2 ? "dormant" : "active",
    strength,
    origin: "dismissed_finding",
    originChangeId: null,
    originThreadId: null,
    createdAt: minutes(-60 * 24 * 14),
    updatedAt: minutes(-60 * 24 * 2),
    ...overrides,
  };
}

const decisions: Decision[] = [
  decision(
    "fixed_windows",
    "Fixed windows for user-facing rate limits",
    "A limit a person can hit uses a fixed window, so the response can say exactly when it resets. Token buckets are for machine-to-machine limits.",
    "Support has to be able to tell a customer when they can try again.",
    0.5,
    {
      originChangeId: reviewChange.id,
      originThreadId: "thr_demo12window",
      createdAt: minutes(75),
      updatedAt: minutes(75),
    },
  ),
  decision(
    "no_secrets_in_logs",
    "Never log access tokens or invite codes",
    "Log the id of a token or invite, never its value, at any log level.",
    "An invite code in a log line was replayed from a shared dashboard in March.",
    0.83,
    { origin: "review_reply" },
  ),
  decision(
    "thin_routes",
    "Route handlers stay thin",
    "A route parses the request and shapes the response. What the request does lives in a function under src/<domain> that takes env and plain arguments.",
    "Lets the same logic run from a queue consumer or a test without a Request.",
    0.74,
  ),
  decision(
    "counters_in_durable_objects",
    "Counters live in Durable Objects, not KV",
    "Anything that is incremented and then compared goes in a Durable Object. KV is for values that tolerate being a minute stale.",
    "A KV-backed quota let a workspace exceed its plan during a burst.",
    0.66,
    { origin: "chat" },
  ),
  decision(
    "moment_for_dates",
    "Use moment for date handling",
    "Format and compare dates with moment.",
    "It was already a dependency.",
    0.11,
    { origin: "manual", updatedAt: minutes(-60 * 24 * 5) },
  ),
];

function decisionEvent(
  id: string,
  decisionId: Decision["id"],
  kind: DecisionEvent["kind"],
  at: Timestamp,
  before: number,
  after: number,
  extra: Partial<DecisionEvent> = {},
): DecisionEvent {
  return {
    id: `dev_${id}`,
    decisionId,
    kind,
    changeId: null,
    threadId: null,
    userId: null,
    strengthBefore: before,
    strengthAfter: after,
    statementBefore: null,
    statementAfter: null,
    note: null,
    createdAt: at,
    ...extra,
  };
}

const decisionEvents: DecisionEvent[] = [
  decisionEvent("fw1", "dec_fixed_windows", "created", minutes(75), 0.5, 0.5, {
    changeId: reviewChange.id,
    threadId: "thr_demo12window",
    userId: jonas.id,
    note: "Recorded from a dismissed review comment.",
  }),
  decisionEvent("ns1", "dec_no_secrets_in_logs", "created", minutes(-60 * 24 * 14), 0.5, 0.5),
  decisionEvent("ns2", "dec_no_secrets_in_logs", "cited", minutes(-60 * 24 * 9), 0.5, 0.575, {
    userId: priya.id,
  }),
  decisionEvent("ns3", "dec_no_secrets_in_logs", "confirmed", minutes(-60 * 24 * 6), 0.575, 0.68, {
    userId: maya.id,
  }),
  decisionEvent("ns4", "dec_no_secrets_in_logs", "reshaped", minutes(-60 * 24 * 6), 0.68, 0.68, {
    statementBefore: "Never log access tokens.",
    statementAfter: "Log the id of a token or invite, never its value, at any log level.",
    note: "Widened to invite codes after a chat on change #9.",
  }),
  decisionEvent("ns5", "dec_no_secrets_in_logs", "followed", minutes(-60 * 24 * 2), 0.68, 0.83, {
    changeId: mergedChange.id,
  }),
  decisionEvent("tr1", "dec_thin_routes", "created", minutes(-60 * 24 * 14), 0.5, 0.5),
  decisionEvent("tr2", "dec_thin_routes", "followed", minutes(-60 * 24 * 8), 0.5, 0.55),
  decisionEvent("tr3", "dec_thin_routes", "confirmed", minutes(-60 * 24 * 4), 0.55, 0.66),
  decisionEvent("tr4", "dec_thin_routes", "followed", minutes(-420), 0.66, 0.74, {
    changeId: mergedChange.id,
  }),
  decisionEvent(
    "cd1",
    "dec_counters_in_durable_objects",
    "created",
    minutes(-60 * 24 * 10),
    0.5,
    0.5,
  ),
  decisionEvent(
    "cd2",
    "dec_counters_in_durable_objects",
    "confirmed",
    minutes(-60 * 24 * 3),
    0.5,
    0.66,
  ),
  decisionEvent("md1", "dec_moment_for_dates", "created", minutes(-60 * 24 * 20), 0.5, 0.5, {
    userId: maya.id,
  }),
  decisionEvent(
    "md2",
    "dec_moment_for_dates",
    "contradiction_accepted",
    minutes(-60 * 24 * 12),
    0.5,
    0.3,
  ),
  decisionEvent(
    "md3",
    "dec_moment_for_dates",
    "contradiction_accepted",
    minutes(-60 * 24 * 7),
    0.3,
    0.18,
  ),
  decisionEvent(
    "md4",
    "dec_moment_for_dates",
    "contradiction_accepted",
    minutes(-60 * 24 * 5),
    0.18,
    0.11,
  ),
];

const changeDecisions: ChangeDecisionLink[] = [
  {
    changeId: reviewChange.id,
    decisionId: "dec_thin_routes",
    relation: "followed",
    similarity: 0.71,
    threadId: null,
  },
  {
    changeId: reviewChange.id,
    decisionId: "dec_counters_in_durable_objects",
    relation: "followed",
    similarity: 0.83,
    threadId: null,
  },
  {
    changeId: reviewChange.id,
    decisionId: "dec_no_secrets_in_logs",
    relation: "retrieved",
    similarity: 0.42,
    threadId: null,
  },
  {
    changeId: reviewChange.id,
    decisionId: "dec_fixed_windows",
    relation: "cited",
    similarity: 0.9,
    threadId: "thr_demo12window",
  },
];

// --- Threads ------------------------------------------------------------------

type DemoThread = Omit<Thread, "messageCount" | "lastMessageAt" | "createdAt" | "changeId"> & {
  messages: [
    author: User | "agent",
    minute: number,
    body: string,
    action?: ThreadMessage["action"],
  ][];
};

const demoThreads: DemoThread[] = [
  {
    id: "thr_demo12key",
    sectionId: "sec_demo12limit",
    kind: "comment",
    origin: "review",
    status: "resolved",
    finding: {
      category: "correctness",
      severity: "blocking",
      title: "The counter is shared by every workspace",
      decisionIds: [],
    },
    anchor: { path: "src/invites/rate-limit.ts", side: "head", startLine: 15, endLine: 15 },
    anchorRevisionId: "rev_demo12a",
    dismissal: null,
    decisionId: null,
    createdBy: null,
    settledAt: minutes(97),
    settledBy: null,
    messages: [
      [
        "agent",
        34,
        "The counter is named `invites:${window}`, without the workspace. Every workspace increments the same counter, so the twenty-first invite across the whole deployment is refused. The intent says the cap is per workspace.",
      ],
      [jonas, 88, "Good catch. Put the workspace in the key and add a test for two workspaces."],
      [
        "agent",
        96,
        "Done: the key is now `invites:${workspaceId}:${window}`, with a test that one workspace reaching its limit leaves another unaffected. Pushed to your fork.",
        { type: "pushed_fix", sha: headSha },
      ],
      [
        "agent",
        97,
        "CI is green on the new commit, so I have resolved this.",
        { type: "resolved" },
      ],
    ],
  },
  {
    id: "thr_demo12window",
    sectionId: "sec_demo12limit",
    kind: "comment",
    origin: "review",
    status: "dismissed",
    finding: {
      category: "design",
      severity: "minor",
      title: "A fixed window, where the queue uses a token bucket",
      decisionIds: [],
    },
    anchor: { path: "src/invites/rate-limit.ts", side: "head", startLine: 12, endLine: 19 },
    anchorRevisionId: "rev_demo12a",
    dismissal: "design_decision",
    decisionId: "dec_fixed_windows",
    createdBy: null,
    settledAt: minutes(75),
    settledBy: jonas.id,
    messages: [
      [
        "agent",
        35,
        "`src/queue/limiter.ts` already limits with a token bucket. This adds a second mechanism, a fixed hourly window, which allows forty invites in two minutes across a window boundary. Was a different approach intended here?",
      ],
      [
        jonas,
        74,
        "Yes, on purpose. Anything a user can hit gets a fixed window, because support has to be able to say exactly when it resets. The token bucket is for machine traffic.",
      ],
      [
        "agent",
        75,
        "Understood. I have dismissed this as a design decision and recorded it: **Fixed windows for user-facing rate limits**. Later reviews of this repository will be given it. Tell me if the wording should be narrower.",
        { type: "dismissed", classification: "design_decision" },
      ],
    ],
  },
  {
    id: "thr_demo12rollover",
    sectionId: "sec_demo12tests",
    kind: "comment",
    origin: "review",
    status: "open",
    finding: {
      category: "tests",
      severity: "important",
      title: "Nothing tests the window rolling over",
      decisionIds: [],
    },
    anchor: { path: "test/invites/rate-limit.test.ts", side: "head", startLine: 5, endLine: 13 },
    anchorRevisionId: "rev_demo12b",
    dismissal: null,
    decisionId: null,
    createdBy: null,
    settledAt: null,
    settledBy: null,
    messages: [
      [
        "agent",
        36,
        "The tests cover reaching the limit, but not that a refused workspace is allowed again in the next hour. `retryAfter` is computed from the window arithmetic and is never checked against a real boundary.",
      ],
      [
        jonas,
        110,
        "Fair. I would rather not fake timers in this suite though. Is there a cheaper way?",
      ],
      [
        "agent",
        111,
        "`takeInviteSlot` could take the current time as an argument with `Date.now()` as its default, and the test passes two times an hour apart. No fake timers. Shall I push that?",
      ],
    ],
  },
  {
    id: "thr_demo12queue",
    sectionId: null,
    kind: "chat",
    origin: "human",
    status: "open",
    finding: null,
    anchor: null,
    anchorRevisionId: null,
    dismissal: null,
    decisionId: null,
    createdBy: priya.id,
    settledAt: null,
    settledBy: null,
    messages: [
      [priya, 115, "Why not reuse the queue's limiter instead of adding a counter object?"],
      [
        "agent",
        116,
        "The session considered it first. The queue's limiter bounds how fast emails are delivered; it lets every invite be created and only delays the email. The request was to cap how many invites a workspace can create, so the check has to sit before the insert. Jonas also asked in the session to keep the counter out of KV, which is why it is a Durable Object.",
      ],
    ],
  },
];

const threads: Thread[] = [];
const messages: ThreadMessage[] = [];
for (const { messages: script, ...thread } of demoThreads) {
  script.forEach(([author, minute, body, action], index) => {
    messages.push({
      id: `msg_${thread.id.slice(4)}_${index + 1}`,
      threadId: thread.id,
      seq: index + 1,
      author: author === "agent" ? { kind: "agent" } : { kind: "user", userId: author.id },
      body,
      action: action ?? null,
      createdAt: minutes(minute),
    });
  });
  threads.push({
    ...thread,
    changeId: reviewChange.id,
    createdAt: minutes(script[0]?.[1] ?? 0),
    messageCount: script.length,
    lastMessageAt: minutes(script.at(-1)?.[1] ?? 0),
  });
}

// --- CI ---------------------------------------------------------------------------

function ciRunWithSteps(
  id: string,
  changeId: ChangeId,
  revisionId: RevisionId,
  startedAt: Timestamp,
  steps: [name: string, status: CiStep["status"], tail: string][],
): { run: CiRun; steps: CiStep[] } {
  const running = steps.some(([, status]) => status === "running" || status === "queued");
  return {
    run: {
      id: `cir_${id}`,
      changeId,
      revisionId,
      status: running ? "running" : "succeeded",
      startedAt,
      finishedAt: running ? null : startedAt + steps.length * 40_000,
    },
    steps: steps.map(([name, status, logTail], position) => ({
      id: `cis_${id}_${name}`,
      runId: `cir_${id}`,
      position,
      name,
      command: `pnpm ${name}`,
      status,
      exitCode: status === "succeeded" ? 0 : null,
      startedAt: status === "queued" ? null : startedAt + position * 40_000,
      finishedAt: status === "succeeded" ? startedAt + (position + 1) * 40_000 : null,
      logTail,
    })),
  };
}

const ci = [
  ciRunWithSteps("demo12a", reviewChange.id, "rev_demo12a", minutes(30), [
    ["typecheck", "succeeded", "$ tsc --noEmit\n"],
    ["lint", "succeeded", "$ biome check .\nChecked 41 files in 38ms. No fixes applied.\n"],
    ["test", "succeeded", " Test Files  7 passed (7)\n      Tests  31 passed (31)\n"],
  ]),
  ciRunWithSteps("demo12b", reviewChange.id, "rev_demo12b", minutes(97), [
    ["typecheck", "succeeded", "$ tsc --noEmit\n"],
    ["lint", "succeeded", "$ biome check .\nChecked 41 files in 36ms. No fixes applied.\n"],
    ["test", "succeeded", " Test Files  7 passed (7)\n      Tests  32 passed (32)\n"],
  ]),
  ciRunWithSteps("demo13a", cloudChange.id, "rev_demo13a", minutes(149), [
    ["typecheck", "succeeded", "$ tsc --noEmit\n"],
    ["lint", "running", "$ biome check .\n"],
    ["test", "queued", ""],
  ]),
];

// --- Capture, cost, events ---------------------------------------------------------

const checkpoints: CheckpointRef[] = [
  {
    checkpointId: DEMO_CHECKPOINT_ID,
    repositoryId: atlas.id,
    ref: git.checkpointRef,
    tipSha: git.shas.checkpoint,
    firstSeenAt: minutes(28),
    updatedAt: minutes(28),
  },
];

const capturedSessions: CapturedSession[] = [
  {
    changeId: reviewChange.id,
    agentSessionId: DEMO_AGENT_SESSION_ID,
    agent: "claude-code",
    model: "claude-sonnet-5",
    checkpointIds: [DEMO_CHECKPOINT_ID],
    turns: [
      {
        kind: "prompt",
        text: "Support had three workspaces send thousands of invites last week. Cap invites at 20 an hour per workspace and tell the client when it can retry.",
        at: minutes(12),
      },
      {
        kind: "assistant",
        text: "The queue already has a token-bucket limiter, but it limits delivery, not how many invites a workspace may create. I'll add a fixed hourly window in front of sendInvite so the response can say exactly when the window resets.",
        at: minutes(13),
      },
      { kind: "tool", text: "Write: src/invites/rate-limit.ts", at: minutes(13) },
      {
        kind: "prompt",
        text: "Keep the counter out of KV, we got bitten by its consistency before.",
        at: minutes(20),
      },
      {
        kind: "assistant",
        text: "Using a Durable Object per window for the counter, and returning 429 with Retry-After from the route.",
        at: minutes(21),
      },
      { kind: "tool", text: "Bash: pnpm test test/invites", at: minutes(21) },
    ],
    attribution: { agentLines: 73, humanLines: 4, agentPercentage: 94.8 },
  },
];

function call(
  id: string,
  agent: AgentName,
  changeId: ChangeId,
  minute: number,
  microUsd: number,
  model = "anthropic/claude-sonnet-5",
): ModelCall {
  return {
    id: `mdl_${id}`,
    attribution: { agent, changeId, repositoryId: atlas.id },
    model,
    requestedModel: model,
    gatewayLogId: `log_${id}`,
    usage: {
      inputTokens: Math.round(microUsd / 3),
      outputTokens: Math.round(microUsd / 40),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    costMicroUsd: microUsd,
    createdAt: minutes(minute),
  };
}

const modelCalls: ModelCall[] = [
  call("demo11intent", "intent", mergedChange.id, -589, 90_000),
  call("demo11review", "review", mergedChange.id, -588, 410_000, "anthropic/claude-opus-5.5"),
  call("demo12intent", "intent", reviewChange.id, 30, 212_000),
  call("demo12sections", "sections", reviewChange.id, 31, 338_000),
  call("demo12review", "review", reviewChange.id, 34, 921_000, "anthropic/claude-opus-5.5"),
  call("demo12thread1", "thread", reviewChange.id, 75, 64_000),
  call("demo12decision", "decisions", reviewChange.id, 75, 38_000),
  call("demo12thread2", "thread", reviewChange.id, 96, 187_000),
  call("demo12sections2", "sections", reviewChange.id, 97, 121_000),
  call("demo12review2", "review", reviewChange.id, 98, 402_000, "anthropic/claude-opus-5.5"),
  call("demo12thread3", "thread", reviewChange.id, 111, 71_000),
  call("demo12thread4", "thread", reviewChange.id, 116, 83_000),
  call("demo13intent", "intent", cloudChange.id, 149, 104_000),
  {
    ...call("demo13session", "session", cloudChange.id, 147, 1_460_000),
    attribution: {
      agent: "session",
      changeId: cloudChange.id,
      repositoryId: atlas.id,
      sessionId: demoSessionIds.cloud,
      userId: maya.id,
    },
  },
];

function eventLog(
  changeId: ChangeId,
  entries: [minute: number, body: ChangeEventBody][],
): ChangeEvent[] {
  return entries.map(([minute, body], index) => ({
    ...body,
    changeId,
    seq: index + 1,
    at: minutes(minute),
  })) as ChangeEvent[];
}

const changeEvents: ChangeEvent[] = [
  ...eventLog(reviewChange.id, [
    [29, { type: "change.status", status: "processing" }],
    [30, { type: "intent.updated" }],
    [32, { type: "sections.updated" }],
    [34, { type: "thread.opened", threadId: "thr_demo12key" }],
    [35, { type: "thread.opened", threadId: "thr_demo12window" }],
    [36, { type: "thread.opened", threadId: "thr_demo12rollover" }],
    [37, { type: "change.status", status: "ready" }],
    [52, { type: "section.approved", sectionId: "sec_demo12limit", userId: priya.id }],
    [53, { type: "section.approved", sectionId: "sec_demo12config", userId: priya.id }],
    [60, { type: "section.approved", sectionId: "sec_demo12tests", userId: maya.id }],
    [75, { type: "thread.status", threadId: "thr_demo12window", status: "dismissed" }],
    [96, { type: "revision.pushed", revisionId: "rev_demo12b", number: 2 }],
    [96, { type: "section.approval_withdrawn", sectionId: "sec_demo12limit", userId: priya.id }],
    [96, { type: "section.approval_withdrawn", sectionId: "sec_demo12tests", userId: maya.id }],
    [96, { type: "change.status", status: "processing" }],
    [97, { type: "thread.status", threadId: "thr_demo12key", status: "resolved" }],
    [104, { type: "change.status", status: "ready" }],
    [115, { type: "thread.opened", threadId: "thr_demo12queue" }],
    [118, { type: "section.approved", sectionId: "sec_demo12limit", userId: priya.id }],
  ]),
  ...eventLog(cloudChange.id, [
    [148, { type: "change.status", status: "processing" }],
    [149, { type: "intent.updated" }],
  ]),
];

const cloudStatus: CloudSessionStatus = {
  sessionId: demoSessionIds.cloud,
  state: "idle",
  error: null,
  updatedAt: minutes(148),
};

const cloudEvents: CloudSessionEvent[] = (
  [
    [140, { type: "state", state: "starting" }],
    [
      141,
      {
        type: "prompt",
        text: "A customer needs their audit log as CSV for a compliance review. Add an export function; the route can come later.",
      },
    ],
    [141, { type: "state", state: "working" }],
    [142, { type: "tool", name: "Grep", summary: "audit_log" }],
    [144, { type: "tool", name: "Write", summary: "src/audit/export.ts" }],
    [
      146,
      {
        type: "assistant",
        text: "Added `exportAuditLog`, which returns the workspace's audit rows as CSV in time order. I left the route out as asked. Pushing now.",
      },
    ],
    [147, { type: "pushed", sha: git.shas.cloud }],
    [148, { type: "state", state: "idle" }],
  ] as const
).map(([minute, event], index) => ({
  ...event,
  sessionId: demoSessionIds.cloud,
  seq: index + 1,
  at: minutes(minute),
}));

export const demo = {
  /** "Now" in the demo: a little after the last thing that happened. */
  now: minutes(152),
  /** Who is looking: the identity local development signs every request in as. */
  viewer: maya,
  organisation,
  users: [maya, jonas, priya],
  repositories: [atlas, billing],
  sessions,
  changes: [mergedChange, reviewChange, cloudChange],
  revisions,
  commits,
  stageRuns,
  intents,
  sections,
  /** The diff each section presents, at the change's head. */
  sectionDiffs,
  approvals,
  threads,
  messages,
  ciRuns: ci.map((entry) => entry.run),
  ciSteps: ci.flatMap((entry) => entry.steps),
  decisions,
  decisionEvents,
  changeDecisions,
  checkpoints,
  capturedSessions,
  modelCalls,
  changeEvents,
  cloudSessions: { statuses: [cloudStatus], events: cloudEvents },
  /** The repositories as the fake git host names them, and the commits the records refer to. */
  git: { repos: git.repos, shas: git.shas, checkpointRef: git.checkpointRef },
};

export type DemoData = typeof demo;

/** The three changes by what they are for, so a test does not index into an array. */
export const demoChanges = { merged: mergedChange, review: reviewChange, cloud: cloudChange };
export const demoUsers = { maya, jonas, priya };
