import type { ChangeId, CiStepId, SectionId } from "@gitflare/core";
import type { ListChangesInput } from "@gitflare/core/api";
import { queryOptions } from "@tanstack/react-query";
import {
  approveSection,
  closeChange,
  getChange,
  getChangeCi,
  getCiLog,
  getSectionDiff,
  listChanges,
  mergeChange,
  rerunStage,
  revokeApproval,
} from "./changes.functions";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";

export const changeQueries = {
  list: (input: ListChangesInput = {}) =>
    queryOptions({
      queryKey: keys.changes.list(input),
      queryFn: () => listChanges({ data: input }),
    }),
  detail: (changeId: ChangeId) =>
    queryOptions({
      queryKey: keys.changes.detail(changeId),
      queryFn: () => getChange({ data: { changeId } }),
    }),
  /** A section's diff is fetched when the reader opens it, not with the page. */
  sectionDiff: (changeId: ChangeId, sectionId: SectionId) =>
    queryOptions({
      queryKey: keys.changes.sectionDiff(changeId, sectionId),
      queryFn: () => getSectionDiff({ data: { changeId, sectionId } }),
    }),
  ci: (changeId: ChangeId) =>
    queryOptions({
      queryKey: keys.changes.ci(changeId),
      queryFn: () => getChangeCi({ data: { changeId } }),
    }),
  ciLog: (changeId: ChangeId, stepId: CiStepId) =>
    queryOptions({
      queryKey: keys.changes.ciLog(changeId, stepId),
      queryFn: () => getCiLog({ data: { stepId } }),
    }),
};

// Everything that changes a change invalidates the change and the lists it appears in.
const changed = (input: { changeId: ChangeId }) => [
  keys.changes.one(input.changeId),
  keys.changes.all,
];

export const useApproveSection = () => useApiMutation(approveSection, changed);
export const useRevokeApproval = () => useApiMutation(revokeApproval, changed);
export const useRerunStage = () => useApiMutation(rerunStage, changed);
export const useCloseChange = () => useApiMutation(closeChange, changed);
export const useMergeChange = () =>
  useApiMutation(mergeChange, (input) => [
    ...changed(input),
    keys.repositories.all,
    keys.decisions.all,
  ]);
