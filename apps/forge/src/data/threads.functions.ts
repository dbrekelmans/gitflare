import {
  ChangeRef,
  DismissThreadInput,
  OpenThreadInput,
  PostMessageInput,
  ReclassifyThreadInput,
  ThreadRef,
} from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const listThreads = createServerFn()
  .middleware([authed])
  .validator(ChangeRef)
  .handler(({ context, data }) => forgeApi().threads.list(context, data));

export const openThread = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(OpenThreadInput)
  .handler(({ context, data }) => forgeApi().threads.open(context, data));

export const postMessage = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PostMessageInput)
  .handler(({ context, data }) => forgeApi().threads.post(context, data));

export const resolveThread = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ThreadRef)
  .handler(({ context, data }) => forgeApi().threads.resolve(context, data));

export const dismissThread = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(DismissThreadInput)
  .handler(({ context, data }) => forgeApi().threads.dismiss(context, data));

export const reclassifyThread = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ReclassifyThreadInput)
  .handler(({ context, data }) => forgeApi().threads.reclassify(context, data));

export const reopenThread = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ThreadRef)
  .handler(({ context, data }) => forgeApi().threads.reopen(context, data));
