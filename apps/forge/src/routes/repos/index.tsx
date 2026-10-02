import { Row } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { repositoryQueries } from "@/data/repositories.queries";

export const Route = createFileRoute("/repos/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(repositoryQueries.list()),
  component: Repositories,
});

function Repositories() {
  const { data } = useSuspenseQuery(repositoryQueries.list());
  return (
    <>
      <PageHead
        title="Repositories"
        lede="Each one has a main repository only gitflare writes to, and a context repository beside it."
        aside={
          <Button variant="outline" render={<Link to="/repos/new" />}>
            New repository
          </Button>
        }
      />
      {data.map(({ repository, openChanges, activeDecisions }) => (
        <Row
          key={repository.id}
          label={
            <RouteLink to="/repos/$repoSlug" params={{ repoSlug: repository.slug }}>
              {repository.slug}
            </RouteLink>
          }
          annotation={
            <Evidence size="sm" kind="note">
              {openChanges} open · {activeDecisions} decisions
            </Evidence>
          }
        >
          {repository.description}
        </Row>
      ))}
      <Unbuilt task="web-inbox-repos" />
    </>
  );
}
