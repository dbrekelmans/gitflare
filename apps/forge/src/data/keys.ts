import type { ListChangesInput } from "@gitflare/core/api";

/**
 * Every query key in the app. Keys nest so that invalidating a prefix
 * refreshes everything under it: `keys.changes.one(id)` covers the change's
 * detail, its section diffs, its threads and its CI, which is what a live
 * event invalidates.
 */
export const keys = {
  account: {
    all: ["account"] as const,
    me: ["account", "me"] as const,
    members: ["account", "members"] as const,
    settings: ["account", "settings"] as const,
    budget: ["account", "budget"] as const,
  },
  repositories: {
    all: ["repositories"] as const,
    list: ["repositories", "list"] as const,
    detail: (repoSlug: string) => ["repositories", repoSlug] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    mine: ["sessions", "mine"] as const,
    one: (sessionId: string) => ["sessions", sessionId] as const,
    detail: (sessionId: string) => ["sessions", sessionId, "detail"] as const,
    events: (sessionId: string) => ["sessions", sessionId, "events"] as const,
  },
  changes: {
    all: ["changes"] as const,
    list: (input: ListChangesInput) => ["changes", "list", input] as const,
    one: (changeId: string) => ["changes", changeId] as const,
    detail: (changeId: string) => ["changes", changeId, "detail"] as const,
    sectionDiff: (changeId: string, sectionId: string) =>
      ["changes", changeId, "sections", sectionId, "diff"] as const,
    threads: (changeId: string) => ["changes", changeId, "threads"] as const,
    ci: (changeId: string) => ["changes", changeId, "ci"] as const,
    ciLog: (changeId: string, stepId: string) => ["changes", changeId, "ci", stepId] as const,
  },
  decisions: {
    all: ["decisions"] as const,
    list: (repoSlug: string, status?: string) =>
      ["decisions", "list", repoSlug, status ?? "all"] as const,
    detail: (decisionId: string) => ["decisions", decisionId] as const,
  },
};
