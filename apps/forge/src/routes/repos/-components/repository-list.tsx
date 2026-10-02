import type { RepositoryView } from "@gitflare/core/api";
import { Row } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { repositoryQueries } from "@/data/repositories.queries";

function RepositoryRow({ item }: { item: RepositoryView }) {
  const { repository } = item;
  const ready = repository.readyAt !== null;
  return (
    <Row
      label={
        <RouteLink to="/repos/$repoSlug" params={{ repoSlug: repository.slug }}>
          {repository.slug}
        </RouteLink>
      }
      annotation={
        <Evidence size="sm" kind="note">
          {ready ? `${item.openChanges} open · ${item.activeDecisions} decisions` : "importing"}
        </Evidence>
      }
    >
      <span className="flex items-center gap-s4">
        {repository.description}
        {!ready && <StatusPill tone="neutral">importing</StatusPill>}
      </span>
    </Row>
  );
}

export function RepositoryList() {
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
      {data.length === 0 ? (
        <Text tone="muted">No repositories yet.</Text>
      ) : (
        data.map((item) => <RepositoryRow key={item.repository.id} item={item} />)
      )}
    </>
  );
}
