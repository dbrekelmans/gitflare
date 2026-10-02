import { queryOptions } from "@tanstack/react-query";
import {
  getBudget,
  getMe,
  getSettings,
  listMembers,
  prepareWorkspace,
  setMemberRole,
  updateSettings,
} from "./account.functions";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";

export const accountQueries = {
  me: () => queryOptions({ queryKey: keys.account.me, queryFn: () => getMe() }),
  members: () => queryOptions({ queryKey: keys.account.members, queryFn: () => listMembers() }),
  settings: () => queryOptions({ queryKey: keys.account.settings, queryFn: () => getSettings() }),
  budget: () => queryOptions({ queryKey: keys.account.budget, queryFn: () => getBudget() }),
};

export const useSetMemberRole = () => useApiMutation(setMemberRole, () => [keys.account.members]);

export const useUpdateSettings = () =>
  useApiMutation(updateSettings, () => [
    keys.account.settings,
    keys.account.budget,
    keys.account.me,
  ]);

/** Preparing takes minutes and reports nothing back: refetch the settings to see the snapshot appear. */
export const usePrepareWorkspace = () =>
  useApiMutation(
    (_options: { data: undefined }) => prepareWorkspace(),
    () => [keys.account.settings],
  );
