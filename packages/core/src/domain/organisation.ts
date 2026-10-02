import { z } from "zod";
import type { MicroUsd, OrganisationId, Timestamp, UserId } from "../ids";

/**
 * One deployment is one organisation. It is still a record rather than an
 * implicit singleton, so nothing here forbids several of them later.
 */
export interface Organisation {
  id: OrganisationId;
  name: string;
  slug: string;
  settings: OrganisationSettings;
  createdAt: Timestamp;
}

/** Which model each of gitflare's own agents calls, as AI Gateway catalog ids. */
export const ModelSettings = z.object({
  intent: z.string(),
  sections: z.string(),
  review: z.string(),
  thread: z.string(),
  decisions: z.string(),
  session: z.string(),
  embedding: z.string(),
  /** Tried in order when the preferred model is over budget or unavailable. */
  fallbacks: z.array(z.string()),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

/**
 * What every sandbox boots: CI runs and hosted sessions alike. `image` is the
 * managed base image; `snapshot` is that image after `containers/workspace/setup.sh`
 * has installed git, the runtimes, the agent and the capture client. It is
 * null until an administrator has prepared the workspace, and until then
 * nothing that needs a sandbox can run.
 */
export const WorkspaceSettings = z.object({
  image: z.string(),
  snapshot: z.object({ id: z.string(), image: z.string() }).nullable(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const OrganisationSettings = z.object({
  /** The deployment's whole AI budget for a calendar month. */
  monthlyBudgetMicroUsd: z.number().int().nonnegative(),
  /** Platform-agent spend on one change stops here. */
  perChangeBudgetMicroUsd: z.number().int().nonnegative(),
  models: ModelSettings,
  workspace: WorkspaceSettings,
});
export type OrganisationSettings = z.infer<typeof OrganisationSettings>;

export const defaultModelSettings: ModelSettings = {
  intent: "anthropic/claude-sonnet-5",
  sections: "anthropic/claude-sonnet-5",
  review: "anthropic/claude-opus-5.5",
  thread: "anthropic/claude-sonnet-5",
  decisions: "anthropic/claude-sonnet-5",
  session: "anthropic/claude-sonnet-5",
  embedding: "@cf/baai/bge-m3",
  fallbacks: ["anthropic/claude-haiku-4.5"],
};

export const defaultOrganisationSettings: OrganisationSettings = {
  monthlyBudgetMicroUsd: 200_000_000,
  perChangeBudgetMicroUsd: 5_000_000,
  models: defaultModelSettings,
  workspace: { image: "cloudflare/debian-trixie", snapshot: null },
};

export const UserRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;

export interface User {
  id: UserId;
  organisationId: OrganisationId;
  /** The identity provider's stable subject: the Access JWT `sub` in production. */
  subject: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Timestamp;
  lastSeenAt: Timestamp | null;
}

/** What "who is this request from" resolves to, before it is matched to a `User`. */
export interface Identity {
  subject: string;
  email: string;
  name?: string;
}

export interface BudgetSummary {
  monthStart: Timestamp;
  budgetMicroUsd: MicroUsd;
  spentMicroUsd: MicroUsd;
}
