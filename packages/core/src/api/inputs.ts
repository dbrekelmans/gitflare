import { z } from "zod";
import { ChangeStatus, StageName } from "../domain/change";
import { DecisionStatus } from "../domain/decision";
import { OrganisationSettings, UserRole } from "../domain/organisation";
import { RepoSlug, SessionKind } from "../domain/repository";
import { DismissalClass, ThreadAnchor, ThreadKind } from "../domain/thread";
import { type Id, type IdKind, isId } from "../ids";

/** A string schema typed as, and checked for, one kind of id. */
export function idSchema<K extends IdKind>(kind: K) {
  return z.custom<Id<K>>((value) => typeof value === "string" && isId(kind, value), {
    message: `expected a ${kind} id`,
  });
}

const text = (max: number) => z.string().trim().min(1).max(max);

// Each schema below is the input of one operation in `ForgeApi`. They are used
// three times: by the server function as its validator, by forms as their
// submit validator, and by tests.

export const ChangeRef = z.object({ changeId: idSchema("change") });
export const SectionRef = z.object({
  changeId: idSchema("change"),
  sectionId: idSchema("section"),
});
export const ThreadRef = z.object({ threadId: idSchema("thread") });
export const SessionRef = z.object({ sessionId: idSchema("session") });
export const DecisionRef = z.object({ decisionId: idSchema("decision") });
export const RepoRef = z.object({ repoSlug: RepoSlug });
export const CiStepRef = z.object({ stepId: idSchema("ciStep") });

export const ListChangesInput = z.object({
  repoSlug: RepoSlug.optional(),
  statuses: z.array(ChangeStatus).optional(),
  /**
   * `inbox`  changes waiting on the caller: ready, not theirs, with a section they have not approved
   * `mine`   changes the caller authored
   * `all`    every change they can see
   */
  scope: z.enum(["inbox", "mine", "all"]).default("all"),
});

export const RerunStageInput = z.object({ changeId: idSchema("change"), stage: StageName });

export const OpenThreadInput = z.object({
  changeId: idSchema("change"),
  kind: ThreadKind,
  sectionId: idSchema("section").optional(),
  anchor: ThreadAnchor.optional(),
  body: text(20_000),
});

export const PostMessageInput = z.object({ threadId: idSchema("thread"), body: text(20_000) });

export const DismissThreadInput = z.object({
  threadId: idSchema("thread"),
  classification: DismissalClass,
  /** Why, in the dismisser's words. For a design decision this becomes its rationale. */
  reason: text(4_000),
});

export const ReclassifyThreadInput = z.object({
  threadId: idSchema("thread"),
  classification: DismissalClass,
});

export const CreateRepositoryInput = z.object({
  slug: RepoSlug,
  description: z.string().trim().max(280).default(""),
  /** A public HTTPS git URL to import. Omit to create an empty repository. */
  importUrl: z.url({ protocol: /^https$/ }).optional(),
});

export const StartSessionInput = z
  .object({
    repoSlug: RepoSlug,
    kind: SessionKind,
    title: text(120),
    /** The first instruction for a hosted agent. Required for a cloud session. */
    prompt: text(100_000).optional(),
  })
  .refine((input) => input.kind === "local" || input.prompt !== undefined, {
    path: ["prompt"],
    message: "A cloud session starts with a prompt.",
  });

export const PromptSessionInput = z.object({ sessionId: idSchema("session"), text: text(100_000) });

export const SessionEventsInput = z.object({
  sessionId: idSchema("session"),
  after: z.number().int().nonnegative().default(0),
});

export const ListDecisionsInput = z.object({
  repoSlug: RepoSlug,
  status: DecisionStatus.optional(),
});

export const CreateDecisionInput = z.object({
  repoSlug: RepoSlug,
  title: text(120),
  statement: text(2_000),
  rationale: z.string().trim().max(4_000).default(""),
  /** Tie the decision to paths. Leave empty for a general rule, which is the normal case. */
  globs: z.array(text(200)).default([]),
});

export const EditDecisionInput = z.object({
  decisionId: idSchema("decision"),
  title: text(120),
  statement: text(2_000),
  rationale: z.string().trim().max(4_000),
});

export const RevertDecisionInput = z.object({
  decisionId: idSchema("decision"),
  /** The `reshaped` event to undo. */
  eventId: idSchema("decisionEvent"),
});

export const SetMemberRoleInput = z.object({ userId: idSchema("user"), role: UserRole });

/** The workspace snapshot is set by preparing the workspace, never by hand. */
export const UpdateSettingsInput = OrganisationSettings.omit({ workspace: true }).partial();

export const GitCredentialInput = z.object({
  /** The remote git is about to talk to, as git reports it to a credential helper. */
  remote: z.url({ protocol: /^https$/ }),
});

export type ListChangesInput = z.input<typeof ListChangesInput>;
export type OpenThreadInput = z.input<typeof OpenThreadInput>;
export type DismissThreadInput = z.input<typeof DismissThreadInput>;
export type CreateRepositoryInput = z.input<typeof CreateRepositoryInput>;
export type StartSessionInput = z.input<typeof StartSessionInput>;
export type CreateDecisionInput = z.input<typeof CreateDecisionInput>;
export type EditDecisionInput = z.input<typeof EditDecisionInput>;
export type UpdateSettingsInput = z.input<typeof UpdateSettingsInput>;
