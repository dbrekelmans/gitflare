import type { ChangeId } from "@gitflare/core";
import type { ThreadView } from "@gitflare/core/api";
import { queryOptions } from "@tanstack/react-query";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";
import {
  dismissThread,
  listThreads,
  openThread,
  postMessage,
  reclassifyThread,
  reopenThread,
  resolveThread,
} from "./threads.functions";

export const threadQueries = {
  /** Every thread of a change with its messages. One query; components select the threads they show. */
  list: (changeId: ChangeId) =>
    queryOptions({
      queryKey: keys.changes.threads(changeId),
      queryFn: () => listThreads({ data: { changeId } }),
    }),
};

// A thread's status feeds merge readiness, so settling one refreshes the whole change.
const threadChanged = (_input: unknown, view: ThreadView) => [
  keys.changes.one(view.thread.changeId),
  keys.decisions.all,
];

export const useOpenThread = () => useApiMutation(openThread, threadChanged);
export const usePostMessage = () =>
  useApiMutation(postMessage, (_input, view) => [keys.changes.threads(view.thread.changeId)]);
export const useResolveThread = () => useApiMutation(resolveThread, threadChanged);
export const useDismissThread = () => useApiMutation(dismissThread, threadChanged);
export const useReclassifyThread = () => useApiMutation(reclassifyThread, threadChanged);
export const useReopenThread = () => useApiMutation(reopenThread, threadChanged);
