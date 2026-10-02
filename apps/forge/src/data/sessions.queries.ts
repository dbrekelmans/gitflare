import type { SessionId } from "@gitflare/core";
import { queryOptions } from "@tanstack/react-query";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";
import {
  abandonSession,
  getSession,
  getSessionEvents,
  listMySessions,
  promptSession,
  startSession,
  stopSession,
} from "./sessions.functions";

export const sessionQueries = {
  mine: () => queryOptions({ queryKey: keys.sessions.mine, queryFn: () => listMySessions() }),
  detail: (sessionId: SessionId) =>
    queryOptions({
      queryKey: keys.sessions.detail(sessionId),
      queryFn: () => getSession({ data: { sessionId } }),
    }),
  /**
   * A hosted session's whole event log. The agent's events have no push
   * channel in the MVP: pass `refetchInterval` at the call site while the
   * session is working.
   */
  events: (sessionId: SessionId) =>
    queryOptions({
      queryKey: keys.sessions.events(sessionId),
      queryFn: () => getSessionEvents({ data: { sessionId, after: 0 } }),
    }),
};

export const useStartSession = () =>
  useApiMutation(startSession, () => [keys.sessions.all, keys.repositories.all]);

export const usePromptSession = () =>
  useApiMutation(promptSession, (input) => [keys.sessions.one(input.sessionId)]);

export const useStopSession = () =>
  useApiMutation(stopSession, (input) => [keys.sessions.one(input.sessionId), keys.sessions.mine]);

export const useAbandonSession = () =>
  useApiMutation(abandonSession, () => [keys.sessions.all, keys.changes.all]);
