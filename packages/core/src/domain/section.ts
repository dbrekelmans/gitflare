import { z } from "zod";
import type { ApprovalId, ChangeId, RevisionId, SectionId, Timestamp, UserId } from "../ids";

export const FileStatus = z.enum(["added", "modified", "deleted", "renamed"]);
export type FileStatus = z.infer<typeof FileStatus>;

export interface DiffLine {
  kind: "context" | "add" | "delete";
  text: string;
  /** Line number on the base side; null for an added line. */
  oldLine: number | null;
  /** Line number on the head side; null for a deleted line. */
  newLine: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** `hunkHash(path, lines)`: stable when the hunk only moved. */
  hash: string;
}

export interface FileDiff {
  path: string;
  /** Set when `status` is `renamed`. */
  oldPath: string | null;
  status: FileStatus;
  /** Binary and oversized files carry no hunks; the diff says so instead. */
  binary: boolean;
  insertions: number;
  deletions: number;
  hunks: Hunk[];
}

/** What a section shows first decides the reading order. */
export const SectionKind = z.enum(["behaviour", "supporting", "tests", "mechanical"]);
export type SectionKind = z.infer<typeof SectionKind>;

/** The part of the diff a section presents: whole files, or named hunks of one. */
export interface SectionFile {
  path: string;
  /** `Hunk.hash` values; empty means every hunk of the file. */
  hunkHashes: string[];
}

/**
 * A section is a presentation of part of one change so it can be read and
 * approved in a followable order. It is not buildable or mergeable on its own.
 * Sections stay stable across pushes: a new commit is folded into the existing
 * ones, and `contentHash` moves only when the section's own diff moved.
 */
export interface Section {
  id: SectionId;
  changeId: ChangeId;
  position: number;
  title: string;
  kind: SectionKind;
  /** What changed and why, written for a reader who has not opened the diff. */
  explanation: string;
  files: SectionFile[];
  /** `sectionContentHash` of the diff at `updatedRevisionId`. Approvals are tied to it. */
  contentHash: string;
  createdRevisionId: RevisionId;
  updatedRevisionId: RevisionId;
}

/** The size of the part of the diff a section presents. */
export interface SectionStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export const ApprovalWithdrawalReason = z.enum(["content_changed", "section_removed", "revoked"]);
export type ApprovalWithdrawalReason = z.infer<typeof ApprovalWithdrawalReason>;

/** One person's approval of one section as it stood at `contentHash`. Never deleted. */
export interface Approval {
  id: ApprovalId;
  changeId: ChangeId;
  sectionId: SectionId;
  userId: UserId;
  /** True when the approver is the change's author. Allowed, and always shown as such. */
  selfApproval: boolean;
  contentHash: string;
  createdAt: Timestamp;
  withdrawnAt: Timestamp | null;
  withdrawnReason: ApprovalWithdrawalReason | null;
}
