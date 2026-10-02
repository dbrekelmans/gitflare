import { createFileRoute } from "@tanstack/react-router";
import { decisionQueries } from "@/data/decisions.queries";
import { Decisions } from "@/routes/decisions/-components/decisions-list";

export const Route = createFileRoute("/repos/$repoSlug/decisions")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(decisionQueries.list(params.repoSlug)),
  component: () => <Decisions repoSlug={Route.useParams().repoSlug} />,
});
