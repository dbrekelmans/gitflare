import { queryOptions } from "@tanstack/react-query";
import { keys } from "./keys";
import { useApiMutation } from "./mutation";
import { createRepository, getRepository, listRepositories } from "./repositories.functions";

export const repositoryQueries = {
  list: () => queryOptions({ queryKey: keys.repositories.list, queryFn: () => listRepositories() }),
  detail: (repoSlug: string) =>
    queryOptions({
      queryKey: keys.repositories.detail(repoSlug),
      queryFn: () => getRepository({ data: { repoSlug } }),
    }),
};

export const useCreateRepository = () =>
  useApiMutation(createRepository, () => [keys.repositories.all]);
