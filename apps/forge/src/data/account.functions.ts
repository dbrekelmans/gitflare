import { SetMemberRoleInput, UpdateSettingsInput } from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const getMe = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().account.me(context));

export const listMembers = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().account.listMembers(context));

export const setMemberRole = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SetMemberRoleInput)
  .handler(({ context, data }) => forgeApi().account.setMemberRole(context, data));

export const getSettings = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().account.getSettings(context));

export const updateSettings = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(UpdateSettingsInput)
  .handler(({ context, data }) => forgeApi().account.updateSettings(context, data));

export const prepareWorkspace = createServerFn({ method: "POST" })
  .middleware([authed])
  .handler(({ context }) => forgeApi().account.prepareWorkspace(context));

export const getBudget = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().account.budget(context));
