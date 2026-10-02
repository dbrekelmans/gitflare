import type {
  Change,
  ChangeCommit,
  ChangeCost,
  Intent,
  Revision,
  StageRun,
} from "../domain/change";
import type { CiRun, CiStep } from "../domain/ci";
import type { CloudSessionStatus } from "../domain/cloud-session";
import type { Decision, DecisionEvent } from "../domain/decision";
import type { BudgetSummary, Organisation, User } from "../domain/organisation";
import type { GitCommit, Repository, Session, TrustTier } from "../domain/repository";
import type { Approval, FileDiff, Section } from "../domain/section";
import type { Thread, ThreadMessage } from "../domain/thread";
import type { ChangeId, MicroUsd, SectionId, Timestamp } from "../ids";
import type { SectionApprovalState } from "../machines/approval";
import type { MergeReadiness } from "../machines/merge-readiness";

// What the API returns: domain records composed for a screen. Plain JSON only,
// because these cross the server-function boundary.

export type UserRef = Pick<User, "id" | "name" | "email">;
export type RepositoryRef = Pick<Repository, "id" | "slug">;

export interface MeView {
  user: User;
  organisation: Pick<Organisation, "id" | "name" | "slug">;
  budget: BudgetSummary;
}

export interface RepositoryView {
  repository: Repository;
  openChanges: number;
  activeDecisions: number;
}

export interface RepositoryDetail extends RepositoryView {
  /** What to `git clone`. Read access comes from the credential helper. */
  remote: string;
  /** The sibling repo holding checkpoints and decision files. */
  contextRemote: string;
  recentCommits: GitCommit[];
}

export interface ChangeSummary {
  change: Change;
  repository: RepositoryRef;
  author: UserRef;
  /** The newest attempt of each stage for the head revision. */
  stages: StageRun[];
  sectionsTotal: number;
  sectionsApproved: number;
  openComments: number;
  /** True when the change is ready and the caller still has a section to approve. */
  needsYou: boolean;
}

export interface SectionView {
  section: Section;
  approvalState: SectionApprovalState;
  /** Every approval ever given, current or withdrawn, newest first. */
  approvals: (Approval & { user: UserRef })[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  openComments: number;
}

export interface ChangeDetail {
  change: Change;
  repository: RepositoryRef;
  author: UserRef;
  session: Session;
  trustTier: TrustTier;
  revisions: Revision[];
  commits: ChangeCommit[];
  /** The newest attempt of each stage for the head revision. */
  stages: StageRun[];
  /** The current intent; null until the intent stage first succeeds. */
  intent: Intent | null;
  sections: SectionView[];
  readiness: MergeReadiness;
  cost: ChangeCost;
  /** The last event applied to this view. The live connection resumes after it. */
  lastEventSeq: number;
}

export interface SectionDiff {
  changeId: ChangeId;
  sectionId: SectionId;
  files: FileDiff[];
}

export interface ThreadView {
  thread: Thread;
  /** Oldest first. `user` is set for a person's message. */
  messages: (ThreadMessage & { user: UserRef | null })[];
}

export interface CiView {
  /** Null when the CI stage was skipped or has not started. */
  run: CiRun | null;
  steps: CiStep[];
}

export interface CiLog {
  text: string;
  /** False when only the stored tail was available. */
  complete: boolean;
}

export interface DecisionDetail {
  decision: Decision;
  /** Newest first. */
  events: DecisionEvent[];
}

export interface SessionView {
  session: Session;
  repository: RepositoryRef;
  /** The change the session's pushes opened, once there is one. */
  change: Pick<Change, "id" | "number" | "title" | "status"> | null;
  /** Where the session pushes: the fork's git remote. */
  pushRemote: string;
  /** Null for a local session. */
  cloud: CloudSessionStatus | null;
}

export interface BudgetView {
  summary: BudgetSummary;
  perChangeBudgetMicroUsd: MicroUsd;
  byAgent: { agent: string; costMicroUsd: MicroUsd }[];
  /** The costliest changes this month, costliest first. */
  topChanges: { change: Pick<Change, "id" | "number" | "title">; costMicroUsd: MicroUsd }[];
}

/** What a git credential helper hands back to git. */
export interface GitCredential {
  username: string;
  password: string;
  expiresAt: Timestamp;
}
