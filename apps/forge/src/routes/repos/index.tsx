import { createFileRoute } from "@tanstack/react-router";
import { repositoryQueries } from "@/data/repositories.queries";
import { RepositoryList } from "./-components/repository-list";

export const Route = createFileRoute("/repos/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(repositoryQueries.list()),
  component: RepositoryList,
});
