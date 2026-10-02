import {
  PromptSessionInput,
  SessionEventsInput,
  SessionRef,
  StartSessionInput,
} from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const startSession = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(StartSessionInput)
  .handler(({ context, data }) => forgeApi().sessions.start(context, data));

export const getSession = createServerFn()
  .middleware([authed])
  .validator(SessionRef)
  .handler(({ context, data }) => forgeApi().sessions.get(context, data));

export const listMySessions = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().sessions.listMine(context));

export const promptSession = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PromptSessionInput)
  .handler(({ context, data }) => forgeApi().sessions.prompt(context, data));

export const getSessionEvents = createServerFn()
  .middleware([authed])
  .validator(SessionEventsInput)
  .handler(({ context, data }) => forgeApi().sessions.events(context, data));

export const stopSession = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SessionRef)
  .handler(({ context, data }) => forgeApi().sessions.stop(context, data));

export const abandonSession = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SessionRef)
  .handler(({ context, data }) => forgeApi().sessions.abandon(context, data));
