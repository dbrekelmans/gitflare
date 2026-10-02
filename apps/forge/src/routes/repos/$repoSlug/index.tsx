import { createFileRoute } from "@tanstack/react-router";
import { repositoryQueries } from "@/data/repositories.queries";
import { RepositoryPage } from "../-components/repository-detail";

export const Route = createFileRoute("/repos/$repoSlug/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(repositoryQueries.detail(params.repoSlug)),
  component: () => <RepositoryPage repoSlug={Route.useParams().repoSlug} />,
});
