import type { z } from "zod";
import type { CloudSessionEvent } from "../domain/cloud-session";
import type { Decision } from "../domain/decision";
import type { OrganisationSettings, User } from "../domain/organisation";
import type { Push } from "../domain/push";
import type * as inputs from "./inputs";
import type {
  BudgetView,
  ChangeDetail,
  ChangeSummary,
  CiLog,
  CiView,
  DecisionDetail,
  GitCredential,
  MeView,
  RepositoryDetail,
  RepositoryView,
  SectionDiff,
  SessionView,
  ThreadView,
} from "./views";

/** Who is calling. Every operation is authenticated before it runs. */
export interface ApiContext {
  user: User;
}

type In<S extends z.ZodType> = z.output<S>;

/**
 * Every operation the forge offers, grouped by the slice that owns it. This
 * interface is the contract between the screens and the backend:
 *
 * - the web app reaches each operation through one server function and one
 *   query or mutation in `apps/forge/src/data`;
 * - each slice is implemented in `apps/forge/src/server/api/<slice>.ts`;
 * - `@gitflare/testing` implements the whole thing over fixture data, so a
 *   screen can be built before its slice exists.
 *
 * Operations throw `ForgeError` for expected failures. They check permissions
 * themselves, with `can()`: the server function only establishes who is asking.
 */
export interface ForgeApi {
  account: {
    me(ctx: ApiContext): Promise<MeView>;
    listMembers(ctx: ApiContext): Promise<User[]>;
    setMemberRole(ctx: ApiContext, input: In<typeof inputs.SetMemberRoleInput>): Promise<User>;
    getSettings(ctx: ApiContext): Promise<OrganisationSettings>;
    updateSettings(
      ctx: ApiContext,
      input: In<typeof inputs.UpdateSettingsInput>,
    ): Promise<OrganisationSettings>;
    budget(ctx: ApiContext): Promise<BudgetView>;
    /**
     * Starts preparing the workspace every sandbox boots from. Returns at
     * once; the settings show a snapshot once it is done. Administrators only.
     */
    prepareWorkspace(ctx: ApiContext): Promise<void>;
  };

  repositories: {
    list(ctx: ApiContext): Promise<RepositoryView[]>;
    get(ctx: ApiContext, input: In<typeof inputs.RepoRef>): Promise<RepositoryDetail>;
    create(
      ctx: ApiContext,
      input: In<typeof inputs.CreateRepositoryInput>,
    ): Promise<RepositoryView>;
    /** A short-lived token for the remote, scoped to what this caller may do with that repo. */
    gitCredential(
      ctx: ApiContext,
      input: In<typeof inputs.GitCredentialInput>,
    ): Promise<GitCredential>;
  };

  sessions: {
    /**
     * Records a session and starts forking the repository for it. The fork
     * takes seconds to most of a minute: the view comes back with
     * `session.forkReadyAt` null, and callers poll `get` until it is set. A
     * cloud session's workspace boots once the fork is ready.
     */
    start(ctx: ApiContext, input: In<typeof inputs.StartSessionInput>): Promise<SessionView>;
    get(ctx: ApiContext, input: In<typeof inputs.SessionRef>): Promise<SessionView>;
    listMine(ctx: ApiContext): Promise<SessionView[]>;
    prompt(ctx: ApiContext, input: In<typeof inputs.PromptSessionInput>): Promise<void>;
    events(
      ctx: ApiContext,
      input: In<typeof inputs.SessionEventsInput>,
    ): Promise<CloudSessionEvent[]>;
    /** Stops a hosted session's sandbox; the fork stays. */
    stop(ctx: ApiContext, input: In<typeof inputs.SessionRef>): Promise<SessionView>;
    /** Ends the session without merging, closes its change and deletes the fork. */
    abandon(ctx: ApiContext, input: In<typeof inputs.SessionRef>): Promise<SessionView>;
  };

  changes: {
    list(ctx: ApiContext, input: In<typeof inputs.ListChangesInput>): Promise<ChangeSummary[]>;
    get(ctx: ApiContext, input: In<typeof inputs.ChangeRef>): Promise<ChangeDetail>;
    sectionDiff(ctx: ApiContext, input: In<typeof inputs.SectionRef>): Promise<SectionDiff>;
    approveSection(ctx: ApiContext, input: In<typeof inputs.SectionRef>): Promise<ChangeDetail>;
    /** Withdraws the caller's own current approval of the section. */
    revokeApproval(ctx: ApiContext, input: In<typeof inputs.SectionRef>): Promise<ChangeDetail>;
    rerunStage(ctx: ApiContext, input: In<typeof inputs.RerunStageInput>): Promise<ChangeDetail>;
    /** Fails with `not_ready` and the blockers in the message when the change may not merge. */
    merge(ctx: ApiContext, input: In<typeof inputs.ChangeRef>): Promise<ChangeDetail>;
    close(ctx: ApiContext, input: In<typeof inputs.ChangeRef>): Promise<ChangeDetail>;
    ci(ctx: ApiContext, input: In<typeof inputs.ChangeRef>): Promise<CiView>;
    ciLog(ctx: ApiContext, input: In<typeof inputs.CiStepRef>): Promise<CiLog>;
  };

  threads: {
    /** Every thread of the change with its messages, oldest thread first. */
    list(ctx: ApiContext, input: In<typeof inputs.ChangeRef>): Promise<ThreadView[]>;
    open(ctx: ApiContext, input: In<typeof inputs.OpenThreadInput>): Promise<ThreadView>;
    /** Adds the caller's message. The agent's reply, if any, arrives later as an event. */
    post(ctx: ApiContext, input: In<typeof inputs.PostMessageInput>): Promise<ThreadView>;
    resolve(ctx: ApiContext, input: In<typeof inputs.ThreadRef>): Promise<ThreadView>;
    dismiss(ctx: ApiContext, input: In<typeof inputs.DismissThreadInput>): Promise<ThreadView>;
    reclassify(
      ctx: ApiContext,
      input: In<typeof inputs.ReclassifyThreadInput>,
    ): Promise<ThreadView>;
    reopen(ctx: ApiContext, input: In<typeof inputs.ThreadRef>): Promise<ThreadView>;
  };

  decisions: {
    list(ctx: ApiContext, input: In<typeof inputs.ListDecisionsInput>): Promise<Decision[]>;
    get(ctx: ApiContext, input: In<typeof inputs.DecisionRef>): Promise<DecisionDetail>;
    create(ctx: ApiContext, input: In<typeof inputs.CreateDecisionInput>): Promise<DecisionDetail>;
    edit(ctx: ApiContext, input: In<typeof inputs.EditDecisionInput>): Promise<DecisionDetail>;
    /** Puts the wording back to what it was before one reshaping. */
    revert(ctx: ApiContext, input: In<typeof inputs.RevertDecisionInput>): Promise<DecisionDetail>;
    /** Brings a dormant decision back into reviews. */
    revive(ctx: ApiContext, input: In<typeof inputs.DecisionRef>): Promise<DecisionDetail>;
  };

  dev: {
    /** Local development only: raises a push as if Artifacts had sent the event. */
    simulatePush(ctx: ApiContext, input: Push): Promise<void>;
  };
}

export type ApiSlice = keyof ForgeApi;

/**
 * The name of every operation, per slice. Code that has to treat the API
 * generically (the fixture fallback, the stubs) walks this instead of the
 * interface, which does not exist at run time.
 */
export const apiOperations = {
  account: [
    "me",
    "listMembers",
    "setMemberRole",
    "getSettings",
    "updateSettings",
    "budget",
    "prepareWorkspace",
  ],
  repositories: ["list", "get", "create", "gitCredential"],
  sessions: ["start", "get", "listMine", "prompt", "events", "stop", "abandon"],
  changes: [
    "list",
    "get",
    "sectionDiff",
    "approveSection",
    "revokeApproval",
    "rerunStage",
    "merge",
    "close",
    "ci",
    "ciLog",
  ],
  threads: ["list", "open", "post", "resolve", "dismiss", "reclassify", "reopen"],
  decisions: ["list", "get", "create", "edit", "revert", "revive"],
  dev: ["simulatePush"],
} as const satisfies { [S in ApiSlice]: readonly (keyof ForgeApi[S])[] };

// Fails to compile when an operation is added to `ForgeApi` but not listed above.
type Unlisted = {
  [S in ApiSlice]: Exclude<keyof ForgeApi[S], (typeof apiOperations)[S][number]>;
}[ApiSlice];
const _everyOperationIsListed: Unlisted extends never ? true : never = true;
void _everyOperationIsListed;
