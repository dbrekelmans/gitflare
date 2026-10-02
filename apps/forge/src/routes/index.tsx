import { Row } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { changeQueries } from "@/data/changes.queries";

const changes = changeQueries.list({ scope: "all" });

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(changes),
  component: Inbox,
});

function Inbox() {
  const { data } = useSuspenseQuery(changes);
  return (
    <>
      <PageHead
        title="Inbox"
        lede="Changes that are waiting for you, then everything else in flight."
      />
      {data.map((item) => (
        <Row
          key={item.change.id}
          label={
            <RouteLink to="/changes/$changeId" params={{ changeId: item.change.id }}>
              {item.change.title}
            </RouteLink>
          }
          annotation={
            <Evidence size="sm" kind="note">
              {item.repository.slug} #{item.change.number} · {item.sectionsApproved}/
              {item.sectionsTotal} sections · {item.openComments} open
            </Evidence>
          }
        >
          <span className="flex items-center gap-s4">
            {item.author.name}
            {item.needsYou && <StatusPill tone="flare">needs you</StatusPill>}
            {!item.needsYou && <StatusPill tone="neutral">{item.change.status}</StatusPill>}
          </span>
        </Row>
      ))}
      <Unbuilt task="web-inbox-repos" />
    </>
  );
}
