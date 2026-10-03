import { Row } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { buttonVariants } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { sessionQueries } from "@/data/sessions.queries";
import { sessionStatusLabel } from "./-components/status";

export const Route = createFileRoute("/sessions/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionQueries.mine()),
  component: Sessions,
});

function Sessions() {
  const { data } = useSuspenseQuery(sessionQueries.mine());
  return (
    <>
      <PageHead
        title="Sessions"
        lede="Your work in progress. A session is a fork, the commits pushed to it and how they were made, wherever it runs."
        aside={
          <Link to="/sessions/new" className={buttonVariants({ variant: "flare" })}>
            Start a session
          </Link>
        }
      />
      {data.length === 0 && (
        <Row label="No sessions yet">Start one to fork a repository and get to work.</Row>
      )}
      {data.map((view) => (
        <Row
          key={view.session.id}
          label={
            <RouteLink to="/sessions/$sessionId" params={{ sessionId: view.session.id }}>
              {view.session.title}
            </RouteLink>
          }
          annotation={
            <Evidence size="sm" kind="note">
              {view.session.kind} · {sessionStatusLabel(view)}
            </Evidence>
          }
        >
          {view.repository.slug}
        </Row>
      ))}
    </>
  );
}
