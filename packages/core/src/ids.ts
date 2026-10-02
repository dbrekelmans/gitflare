/**
 * Every record id is `<prefix>_<ULID>`. The prefix makes an id self-describing
 * in logs and URLs; the ULID makes ids sort by creation time.
 */
export const idPrefixes = {
  organisation: "org",
  user: "usr",
  repository: "rep",
  session: "ses",
  change: "chg",
  revision: "rev",
  stageRun: "stg",
  intent: "int",
  section: "sec",
  approval: "apr",
  thread: "thr",
  message: "msg",
  ciRun: "cir",
  ciStep: "cis",
  decision: "dec",
  decisionEvent: "dev",
  modelCall: "mdl",
  sandbox: "sbx",
} as const;

export type IdKind = keyof typeof idPrefixes;
export type Id<K extends IdKind> = `${(typeof idPrefixes)[K]}_${string}`;

export type OrganisationId = Id<"organisation">;
export type UserId = Id<"user">;
export type RepositoryId = Id<"repository">;
export type SessionId = Id<"session">;
export type ChangeId = Id<"change">;
export type RevisionId = Id<"revision">;
export type StageRunId = Id<"stageRun">;
export type IntentId = Id<"intent">;
export type SectionId = Id<"section">;
export type ApprovalId = Id<"approval">;
export type ThreadId = Id<"thread">;
export type MessageId = Id<"message">;
export type CiRunId = Id<"ciRun">;
export type CiStepId = Id<"ciStep">;
export type DecisionId = Id<"decision">;
export type DecisionEventId = Id<"decisionEvent">;
export type ModelCallId = Id<"modelCall">;
export type SandboxId = Id<"sandbox">;

/** A full git object id: 40 lowercase hex characters. */
export type Sha = string;

/** Milliseconds since the Unix epoch. Used everywhere: domain, database and API. */
export type Timestamp = number;

/** US dollars × 1,000,000, so cost arithmetic stays in integers. */
export type MicroUsd = number;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A lowercase ULID: 10 characters of time, 16 of randomness. */
export function ulid(now: Timestamp, random: (length: number) => Uint8Array): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const byte of random(16)) {
    rand += CROCKFORD.charAt(byte % 32);
  }
  return time + rand;
}

export function makeId<K extends IdKind>(kind: K, suffix: string): Id<K> {
  return `${idPrefixes[kind]}_${suffix}`;
}

export function isId<K extends IdKind>(kind: K, value: string): value is Id<K> {
  return value.startsWith(`${idPrefixes[kind]}_`) && value.length > idPrefixes[kind].length + 1;
}
