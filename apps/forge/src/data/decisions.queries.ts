import type { DecisionId, DecisionStatus } from "@gitflare/core";
import { queryOptions } from "@tanstack/react-query";
import {
  createDecision,
  editDecision,
  getDecision,
  listDecisions,
  revertDecision,
  reviveDecision,
} from "./decisions.functions";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";

export const decisionQueries = {
  list: (repoSlug: string, status?: DecisionStatus) =>
    queryOptions({
      queryKey: keys.decisions.list(repoSlug, status),
      queryFn: () => listDecisions({ data: { repoSlug, status } }),
    }),
  detail: (decisionId: DecisionId) =>
    queryOptions({
      queryKey: keys.decisions.detail(decisionId),
      queryFn: () => getDecision({ data: { decisionId } }),
    }),
};

const decisionsChanged = () => [keys.decisions.all, keys.repositories.all];

export const useCreateDecision = () => useApiMutation(createDecision, decisionsChanged);
export const useEditDecision = () => useApiMutation(editDecision, decisionsChanged);
export const useRevertDecision = () => useApiMutation(revertDecision, decisionsChanged);
export const useReviveDecision = () => useApiMutation(reviveDecision, decisionsChanged);
