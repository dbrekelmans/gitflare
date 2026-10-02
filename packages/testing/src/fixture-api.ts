import {
  type Approval,
  applyDecisionEvent,
  type Change,
  type ChangeCost,
  type ChangeEvent,
  type ChangeEventBody,
  type ChangeId,
  can,
  canRerunStage,
  contextRepoName,
  type Decision,
  type DecisionEvent,
  ForgeError,
  forkRepoName,
  type Id,
  type IdKind,
  isApprovalCurrent,
  latestStageRuns,
  makeId,
  mergeReadiness,
  type Repository,
  type Section,
  type Session,
  type StageRun,
  sectionApprovalState,
  type Thread,
  type ThreadMessage,
  transitionChange,
  transitionThread,
  trustTier,
  type User,
} from "@gitflare/core";
import type {
  ApiContext,
  ChangeDetail,
  ChangeSummary,
  DecisionDetail,
  ForgeApi,
  RepositoryView,
  SectionView,
  SessionView,
  ThreadView,
  UserRef,
} from "@gitflare/core/api";
import { type DemoData, demo } from "./demo";

const REMOTE_BASE = "https://git.example.test/git/gitflare";

function notFound(what: string): never {
  throw new ForgeError("not_found", `${what} not found`);
}

function forbidden(): never {
  throw new ForgeError("forbidden", "You are not allowed to do that.");
}

/**
 * The whole `ForgeApi` over the demo fixture, held in memory. Reads return
 * what a finished backend would; writes change the in-memory copy, so a
 * screen can approve a section or answer a comment and see the result, until
 * the process restarts.
 *
 * Nothing here runs an agent or a pipeline: a posted message gets no reply
 * and a re-run stage stays queued.
 */
export function createFixtureApi(source: DemoData = demo): ForgeApi {
  const data: DemoData = structuredClone(source);
  let counter = 0;
  const now = () => data.now + ++counter * 1000;
  const newId = <K extends IdKind>(kind: K): Id<K> =>
    makeId(kind, `fx${String(++counter).padStart(4, "0")}`);

  const ref = (userId: User["id"]): UserRef => {
    const user = data.users.find((u) => u.id === userId) ?? notFound("User");
    return { id: user.id, name: user.name, email: user.email };
  };
  const repoBySlug = (slug: string) =>
    data.repositories.find((r) => r.slug === slug) ?? notFound("Repository");
  const repoById = (id: Repository["id"]) =>
    data.repositories.find((r) => r.id === id) ?? notFound("Repository");
  const changeById = (id: ChangeId) => data.changes.find((c) => c.id === id) ?? notFound("Change");
  const threadById = (id: Thread["id"]) =>
    data.threads.find((t) => t.id === id) ?? notFound("Thread");
  const sessionById = (id: Session["id"]) =>
    data.sessions.find((s) => s.id === id) ?? notFound("Session");
  const decisionById = (id: Decision["id"]) =>
    data.decisions.find((d) => d.id === id) ?? notFound("Decision");

  const headStages = (change: Change): StageRun[] =>
    Object.values(
      latestStageRuns(data.stageRuns.filter((run) => run.revisionId === change.headRevisionId)),
    );
  const sectionsOf = (changeId: ChangeId): Section[] =>
    data.sections.filter((s) => s.changeId === changeId).sort((a, b) => a.position - b.position);
  const approvalsOf = (changeId: ChangeId): Approval[] =>
    data.approvals.filter((a) => a.changeId === changeId);
  const threadsOf = (changeId: ChangeId): Thread[] =>
    data.threads.filter((t) => t.changeId === changeId).sort((a, b) => a.createdAt - b.createdAt);

  const event = (changeId: ChangeId, body: ChangeEventBody) => {
    const seq = data.changeEvents.filter((e) => e.changeId === changeId).length + 1;
    data.changeEvents.push({ ...body, changeId, seq, at: now() } as ChangeEvent);
  };

  function costOf(changeId: ChangeId): ChangeCost {
    const byAgent: ChangeCost["byAgent"] = {};
    let total = 0;
    for (const call of data.modelCalls) {
      if (call.attribution.changeId !== changeId) continue;
      total += call.costMicroUsd;
      byAgent[call.attribution.agent] = (byAgent[call.attribution.agent] ?? 0) + call.costMicroUsd;
    }
    return { changeId, totalMicroUsd: total, byAgent, estimated: true };
  }

  function sectionView(section: Section): SectionView {
    const approvals = approvalsOf(section.changeId).filter((a) => a.sectionId === section.id);
    const diff = data.sectionDiffs[section.id] ?? [];
    return {
      section,
      approvalState: sectionApprovalState(section, approvals),
      approvals: approvals
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((approval) => ({ ...approval, user: ref(approval.userId) })),
      filesChanged: diff.length,
      insertions: diff.reduce((sum, file) => sum + file.insertions, 0),
      deletions: diff.reduce((sum, file) => sum + file.deletions, 0),
      openComments: threadsOf(section.changeId).filter(
        (t) => t.sectionId === section.id && t.kind === "comment" && t.status === "open",
      ).length,
    };
  }

  function summary(ctx: ApiContext, change: Change): ChangeSummary {
    const sections = sectionsOf(change.id);
    const approvals = approvalsOf(change.id);
    const repository = repoById(change.repositoryId);
    const waiting = sections.filter(
      (s) => !approvals.some((a) => a.userId === ctx.user.id && isApprovalCurrent(a, s)),
    );
    return {
      change,
      repository: { id: repository.id, slug: repository.slug },
      author: ref(change.authorId),
      stages: headStages(change),
      sectionsTotal: sections.length,
      sectionsApproved: sections.filter((s) => sectionApprovalState(s, approvals) === "approved")
        .length,
      openComments: threadsOf(change.id).filter((t) => t.kind === "comment" && t.status === "open")
        .length,
      needsYou: change.status === "ready" && change.authorId !== ctx.user.id && waiting.length > 0,
    };
  }

  function detail(change: Change): ChangeDetail {
    const repository = repoById(change.repositoryId);
    const session = sessionById(change.sessionId);
    const sections = sectionsOf(change.id);
    const stages = headStages(change);
    return {
      change,
      repository: { id: repository.id, slug: repository.slug },
      author: ref(change.authorId),
      session,
      trustTier: trustTier(session.kind),
      revisions: data.revisions
        .filter((r) => r.changeId === change.id)
        .sort((a, b) => a.number - b.number),
      commits: data.commits.filter((c) => c.changeId === change.id),
      stages,
      intent:
        data.intents
          .filter((i) => i.changeId === change.id)
          .sort((a, b) => b.version - a.version)[0] ?? null,
      sections: sections.map(sectionView),
      readiness: mergeReadiness({
        change,
        headStageRuns: stages,
        sections,
        approvals: approvalsOf(change.id),
        threads: threadsOf(change.id),
      }),
      cost: costOf(change.id),
      lastEventSeq: data.changeEvents.filter((e) => e.changeId === change.id).length,
    };
  }

  function threadView(thread: Thread): ThreadView {
    return {
      thread,
      messages: data.messages
        .filter((m) => m.threadId === thread.id)
        .sort((a, b) => a.seq - b.seq)
        .map((m) => ({ ...m, user: m.author.kind === "user" ? ref(m.author.userId) : null })),
    };
  }

  function addMessage(
    thread: Thread,
    author: ThreadMessage["author"],
    body: string,
  ): ThreadMessage {
    const message: ThreadMessage = {
      id: newId("message"),
      threadId: thread.id,
      seq: thread.messageCount + 1,
      author,
      body,
      action: null,
      createdAt: now(),
    };
    data.messages.push(message);
    thread.messageCount = message.seq;
    thread.lastMessageAt = message.createdAt;
    event(thread.changeId, { type: "thread.message", threadId: thread.id, seq: message.seq });
    return message;
  }

  function settle(ctx: ApiContext, thread: Thread, action: Parameters<typeof transitionThread>[1]) {
    const next = transitionThread(thread, action);
    thread.status = next.status;
    thread.dismissal = next.dismissal;
    thread.settledAt = next.status === "open" ? null : now();
    thread.settledBy = next.status === "open" ? null : ctx.user.id;
    event(thread.changeId, { type: "thread.status", threadId: thread.id, status: next.status });
  }

  function repositoryView(repository: Repository): RepositoryView {
    return {
      repository,
      openChanges: data.changes.filter(
        (c) => c.repositoryId === repository.id && c.status !== "merged" && c.status !== "closed",
      ).length,
      activeDecisions: data.decisions.filter(
        (d) => d.repositoryId === repository.id && d.status === "active",
      ).length,
    };
  }

  function sessionView(session: Session): SessionView {
    const repository = repoById(session.repositoryId);
    const change = data.changes.find((c) => c.sessionId === session.id);
    return {
      session,
      repository: { id: repository.id, slug: repository.slug },
      change: change
        ? { id: change.id, number: change.number, title: change.title, status: change.status }
        : null,
      pushRemote: `${REMOTE_BASE}/${session.forkRepo}.git`,
      cloud:
        session.kind === "cloud"
          ? (data.cloudSessions.statuses.find((s) => s.sessionId === session.id) ?? {
              sessionId: session.id,
              state: "starting",
              error: null,
              updatedAt: session.createdAt,
            })
          : null,
    };
  }

  function decisionDetail(decision: Decision): DecisionDetail {
    return {
      decision,
      events: data.decisionEvents
        .filter((e) => e.decisionId === decision.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  function recordDecisionEvent(
    ctx: ApiContext,
    decision: Decision,
    kind: DecisionEvent["kind"],
    wording: Pick<DecisionEvent, "statementBefore" | "statementAfter"> = {
      statementBefore: null,
      statementAfter: null,
    },
  ) {
    const next = applyDecisionEvent(decision, kind);
    data.decisionEvents.push({
      id: newId("decisionEvent"),
      decisionId: decision.id,
      kind,
      changeId: null,
      threadId: null,
      userId: ctx.user.id,
      strengthBefore: decision.strength,
      strengthAfter: next.strength,
      ...wording,
      note: null,
      createdAt: now(),
    });
    decision.strength = next.strength;
    decision.status = next.status;
    decision.updatedAt = now();
  }

  const monthStart = () => {
    const date = new Date(data.now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  };
  const budgetSummary = () => ({
    monthStart: monthStart(),
    budgetMicroUsd: data.organisation.settings.monthlyBudgetMicroUsd,
    spentMicroUsd: data.modelCalls
      .filter((call) => call.createdAt >= monthStart())
      .reduce((sum, call) => sum + call.costMicroUsd, 0),
  });

  return {
    account: {
      async me(ctx) {
        const { id, name, slug } = data.organisation;
        return { user: ctx.user, organisation: { id, name, slug }, budget: budgetSummary() };
      },
      async listMembers() {
        return data.users;
      },
      async setMemberRole(ctx, input) {
        if (!can(ctx.user, { type: "members.manage" })) forbidden();
        const user = data.users.find((u) => u.id === input.userId) ?? notFound("User");
        user.role = input.role;
        return user;
      },
      async getSettings() {
        return data.organisation.settings;
      },
      async updateSettings(ctx, input) {
        if (!can(ctx.user, { type: "settings.manage" })) forbidden();
        data.organisation.settings = { ...data.organisation.settings, ...input };
        return data.organisation.settings;
      },
      async budget() {
        const byAgent = new Map<string, number>();
        const byChange = new Map<ChangeId, number>();
        for (const call of data.modelCalls) {
          if (call.createdAt < monthStart()) continue;
          const { agent, changeId } = call.attribution;
          byAgent.set(agent, (byAgent.get(agent) ?? 0) + call.costMicroUsd);
          if (changeId) byChange.set(changeId, (byChange.get(changeId) ?? 0) + call.costMicroUsd);
        }
        return {
          summary: budgetSummary(),
          perChangeBudgetMicroUsd: data.organisation.settings.perChangeBudgetMicroUsd,
          byAgent: [...byAgent].map(([agent, costMicroUsd]) => ({ agent, costMicroUsd })),
          topChanges: [...byChange]
            .sort((a, b) => b[1] - a[1])
            .map(([changeId, costMicroUsd]) => {
              const { id, number, title } = changeById(changeId);
              return { change: { id, number, title }, costMicroUsd };
            }),
        };
      },
    },

    repositories: {
      async list() {
        return data.repositories.map(repositoryView);
      },
      async get(_ctx, input) {
        const repository = repoBySlug(input.repoSlug);
        return {
          ...repositoryView(repository),
          remote: `${REMOTE_BASE}/${repository.slug}.git`,
          contextRemote: `${REMOTE_BASE}/${contextRepoName(repository.slug)}.git`,
          recentCommits: data.commits
            .filter((c) => data.changes.find((ch) => ch.id === c.changeId)?.status === "merged")
            .map((c) => ({
              sha: c.sha,
              treeSha: c.sha,
              parents: [],
              message: c.message,
              author: { name: c.authorName, email: c.authorEmail },
              committer: { name: "gitflare", email: "gitflare@northwind.example" },
              authoredAt: c.authoredAt,
              committedAt: c.authoredAt,
            })),
        };
      },
      async create(ctx, input) {
        if (!can(ctx.user, { type: "repository.create" })) forbidden();
        if (data.repositories.some((r) => r.slug === input.slug)) {
          throw new ForgeError("conflict", `A repository named ${input.slug} already exists.`);
        }
        const repository: Repository = {
          id: newId("repository"),
          organisationId: data.organisation.id,
          slug: input.slug,
          description: input.description,
          defaultBranch: "main",
          headSha: null,
          captureEnabled: true,
          createdAt: now(),
          archivedAt: null,
        };
        data.repositories.push(repository);
        return repositoryView(repository);
      },
      async gitCredential() {
        return { username: "gitflare", password: "art_v1_fixture", expiresAt: now() + 3_600_000 };
      },
    },

    sessions: {
      async start(ctx, input) {
        const repository = repoBySlug(input.repoSlug);
        const id = newId("session");
        const session: Session = {
          id,
          repositoryId: repository.id,
          userId: ctx.user.id,
          kind: input.kind,
          status: "active",
          title: input.title,
          forkRepo: forkRepoName(repository.slug, id),
          baseSha: repository.headSha ?? "",
          createdAt: now(),
          endedAt: null,
          forkDeletedAt: null,
        };
        data.sessions.push(session);
        if (input.kind === "cloud") {
          data.cloudSessions.statuses.push({
            sessionId: id,
            state: "starting",
            error: null,
            updatedAt: now(),
          });
          data.cloudSessions.events.push({
            sessionId: id,
            seq: 1,
            at: now(),
            type: "prompt",
            text: input.prompt ?? "",
          });
        }
        return sessionView(session);
      },
      async get(_ctx, input) {
        return sessionView(sessionById(input.sessionId));
      },
      async listMine(ctx) {
        return data.sessions
          .filter((s) => s.userId === ctx.user.id)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(sessionView);
      },
      async prompt(ctx, input) {
        const session = sessionById(input.sessionId);
        if (!can(ctx.user, { type: "session.write", session })) forbidden();
        const seq = data.cloudSessions.events.filter((e) => e.sessionId === session.id).length + 1;
        data.cloudSessions.events.push({
          sessionId: session.id,
          seq,
          at: now(),
          type: "prompt",
          text: input.text,
        });
      },
      async events(_ctx, input) {
        return data.cloudSessions.events.filter(
          (e) => e.sessionId === input.sessionId && e.seq > input.after,
        );
      },
      async stop(ctx, input) {
        const session = sessionById(input.sessionId);
        if (!can(ctx.user, { type: "session.write", session })) forbidden();
        const status = data.cloudSessions.statuses.find((s) => s.sessionId === session.id);
        if (status) status.state = "asleep";
        return sessionView(session);
      },
      async abandon(ctx, input) {
        const session = sessionById(input.sessionId);
        if (!can(ctx.user, { type: "session.abandon", session })) forbidden();
        session.status = "abandoned";
        session.endedAt = now();
        const change = data.changes.find((c) => c.sessionId === session.id);
        if (change) {
          change.status = transitionChange(change.status, "closed");
          change.closedAt = now();
        }
        return sessionView(session);
      },
    },

    changes: {
      async list(ctx, input) {
        const repository = input.repoSlug ? repoBySlug(input.repoSlug) : null;
        return data.changes
          .filter((c) => !repository || c.repositoryId === repository.id)
          .filter((c) => !input.statuses || input.statuses.includes(c.status))
          .map((c) => summary(ctx, c))
          .filter((s) =>
            input.scope === "inbox"
              ? s.needsYou
              : input.scope === "mine"
                ? s.change.authorId === ctx.user.id
                : true,
          )
          .sort((a, b) => b.change.openedAt - a.change.openedAt);
      },
      async get(_ctx, input) {
        return detail(changeById(input.changeId));
      },
      async sectionDiff(_ctx, input) {
        changeById(input.changeId);
        return {
          changeId: input.changeId,
          sectionId: input.sectionId,
          files: data.sectionDiffs[input.sectionId] ?? notFound("Section"),
        };
      },
      async approveSection(ctx, input) {
        const change = changeById(input.changeId);
        const section =
          sectionsOf(change.id).find((s) => s.id === input.sectionId) ?? notFound("Section");
        const mine = approvalsOf(change.id).some(
          (a) => a.userId === ctx.user.id && isApprovalCurrent(a, section),
        );
        if (!mine) {
          data.approvals.push({
            id: newId("approval"),
            changeId: change.id,
            sectionId: section.id,
            userId: ctx.user.id,
            contentHash: section.contentHash,
            createdAt: now(),
            withdrawnAt: null,
            withdrawnReason: null,
          });
          event(change.id, {
            type: "section.approved",
            sectionId: section.id,
            userId: ctx.user.id,
          });
        }
        return detail(change);
      },
      async revokeApproval(ctx, input) {
        const change = changeById(input.changeId);
        const section =
          sectionsOf(change.id).find((s) => s.id === input.sectionId) ?? notFound("Section");
        for (const approval of approvalsOf(change.id)) {
          if (approval.userId !== ctx.user.id || !isApprovalCurrent(approval, section)) continue;
          approval.withdrawnAt = now();
          approval.withdrawnReason = "revoked";
          event(change.id, {
            type: "section.approval_withdrawn",
            sectionId: section.id,
            userId: ctx.user.id,
          });
        }
        return detail(change);
      },
      async rerunStage(_ctx, input) {
        const change = changeById(input.changeId);
        const current =
          headStages(change).find((run) => run.stage === input.stage) ?? notFound("Stage");
        if (!canRerunStage(current.status)) {
          throw new ForgeError(
            "conflict",
            `The ${input.stage} stage is already ${current.status}.`,
          );
        }
        const attempt = current.attempt + 1;
        data.stageRuns.push({
          ...current,
          id: newId("stageRun"),
          attempt,
          status: "queued",
          reason: null,
          startedAt: null,
          finishedAt: null,
        });
        change.status = transitionChange(change.status, "stage_rerun");
        event(change.id, {
          type: "stage.status",
          stage: input.stage,
          attempt,
          status: "queued",
          reason: null,
        });
        event(change.id, { type: "change.status", status: change.status });
        return detail(change);
      },
      async merge(ctx, input) {
        const change = changeById(input.changeId);
        const { readiness } = detail(change);
        if (!readiness.ready) {
          throw new ForgeError(
            "not_ready",
            `This change cannot merge yet: ${readiness.blockers.map((b) => b.kind).join(", ")}.`,
          );
        }
        change.status = transitionChange(change.status, "merged");
        change.mergedAt = now();
        change.mergedBy = ctx.user.id;
        change.mergeSha = change.headSha;
        const session = sessionById(change.sessionId);
        session.status = "merged";
        session.endedAt = now();
        event(change.id, { type: "change.merged", mergeSha: change.headSha, userId: ctx.user.id });
        event(change.id, { type: "change.status", status: "merged" });
        return detail(change);
      },
      async close(ctx, input) {
        const change = changeById(input.changeId);
        if (!can(ctx.user, { type: "change.close", change })) forbidden();
        change.status = transitionChange(change.status, "closed");
        change.closedAt = now();
        event(change.id, { type: "change.status", status: "closed" });
        return detail(change);
      },
      async ci(_ctx, input) {
        const change = changeById(input.changeId);
        const run = data.ciRuns.find((r) => r.revisionId === change.headRevisionId) ?? null;
        return {
          run,
          steps: run
            ? data.ciSteps.filter((s) => s.runId === run.id).sort((a, b) => a.position - b.position)
            : [],
        };
      },
      async ciLog(_ctx, input) {
        const step = data.ciSteps.find((s) => s.id === input.stepId) ?? notFound("CI step");
        return { text: step.logTail, complete: false };
      },
    },

    threads: {
      async list(_ctx, input) {
        changeById(input.changeId);
        return threadsOf(input.changeId).map(threadView);
      },
      async open(ctx, input) {
        const change = changeById(input.changeId);
        const thread: Thread = {
          id: newId("thread"),
          changeId: change.id,
          sectionId: input.sectionId ?? null,
          kind: input.kind,
          origin: "human",
          status: "open",
          finding: null,
          anchor: input.anchor ?? null,
          anchorRevisionId: input.anchor ? change.headRevisionId : null,
          dismissal: null,
          decisionId: null,
          createdBy: ctx.user.id,
          createdAt: now(),
          settledAt: null,
          settledBy: null,
          messageCount: 0,
          lastMessageAt: now(),
        };
        data.threads.push(thread);
        event(change.id, { type: "thread.opened", threadId: thread.id });
        addMessage(thread, { kind: "user", userId: ctx.user.id }, input.body);
        return threadView(thread);
      },
      async post(ctx, input) {
        const thread = threadById(input.threadId);
        addMessage(thread, { kind: "user", userId: ctx.user.id }, input.body);
        return threadView(thread);
      },
      async resolve(ctx, input) {
        const thread = threadById(input.threadId);
        settle(ctx, thread, { type: "resolve" });
        return threadView(thread);
      },
      async dismiss(ctx, input) {
        const thread = threadById(input.threadId);
        settle(ctx, thread, { type: "dismiss", classification: input.classification });
        addMessage(thread, { kind: "user", userId: ctx.user.id }, input.reason);
        return threadView(thread);
      },
      async reclassify(ctx, input) {
        const thread = threadById(input.threadId);
        settle(ctx, thread, { type: "reclassify", classification: input.classification });
        return threadView(thread);
      },
      async reopen(ctx, input) {
        const thread = threadById(input.threadId);
        settle(ctx, thread, { type: "reopen" });
        return threadView(thread);
      },
    },

    decisions: {
      async list(_ctx, input) {
        const repository = repoBySlug(input.repoSlug);
        return data.decisions
          .filter((d) => d.repositoryId === repository.id)
          .filter((d) => !input.status || d.status === input.status)
          .sort((a, b) => b.strength - a.strength);
      },
      async get(_ctx, input) {
        return decisionDetail(decisionById(input.decisionId));
      },
      async create(ctx, input) {
        const repository = repoBySlug(input.repoSlug);
        const id = newId("decision");
        const decision: Decision = {
          id,
          repositoryId: repository.id,
          path: `decisions/${input.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")}.md`,
          title: input.title,
          statement: input.statement,
          rationale: input.rationale,
          scope:
            input.globs.length > 0 ? { kind: "paths", globs: input.globs } : { kind: "general" },
          status: "active",
          strength: 0,
          origin: "manual",
          originChangeId: null,
          originThreadId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        data.decisions.push(decision);
        recordDecisionEvent(ctx, decision, "created");
        return decisionDetail(decision);
      },
      async edit(ctx, input) {
        const decision = decisionById(input.decisionId);
        const statementBefore = decision.statement;
        Object.assign(decision, {
          title: input.title,
          statement: input.statement,
          rationale: input.rationale,
        });
        recordDecisionEvent(ctx, decision, "reshaped", {
          statementBefore,
          statementAfter: input.statement,
        });
        return decisionDetail(decision);
      },
      async revert(ctx, input) {
        const decision = decisionById(input.decisionId);
        const reshaped =
          data.decisionEvents.find((e) => e.id === input.eventId && e.decisionId === decision.id) ??
          notFound("Decision event");
        if (reshaped.statementBefore === null) {
          throw new ForgeError("invalid", "That event did not change the wording.");
        }
        const statementBefore = decision.statement;
        decision.statement = reshaped.statementBefore;
        recordDecisionEvent(ctx, decision, "reverted", {
          statementBefore,
          statementAfter: decision.statement,
        });
        return decisionDetail(decision);
      },
      async revive(ctx, input) {
        const decision = decisionById(input.decisionId);
        recordDecisionEvent(ctx, decision, "revived");
        return decisionDetail(decision);
      },
    },

    dev: {
      async simulatePush() {},
    },
  };
}
