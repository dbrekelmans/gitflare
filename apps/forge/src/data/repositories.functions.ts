import { CreateRepositoryInput, RepoRef } from "@gitflare/core/api";
import { createServerFn } from "@tanstack/react-start";
import { forgeApi } from "@/server/api";
import { authed } from "./fn";

export const listRepositories = createServerFn()
  .middleware([authed])
  .handler(({ context }) => forgeApi().repositories.list(context));

export const getRepository = createServerFn()
  .middleware([authed])
  .validator(RepoRef)
  .handler(({ context, data }) => forgeApi().repositories.get(context, data));

export const createRepository = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CreateRepositoryInput)
  .handler(({ context, data }) => forgeApi().repositories.create(context, data));
