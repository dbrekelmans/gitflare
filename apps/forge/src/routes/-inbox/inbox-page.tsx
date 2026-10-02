import type { ChangeSummary } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { changeQueries } from "@/data/changes.queries";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ChangeRow({ item }: { item: ChangeSummary }) {
  return (
    <Row
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
        {item.needsYou ? (
          <StatusPill tone="flare">needs you</StatusPill>
        ) : (
          <StatusPill tone="neutral">{item.change.status}</StatusPill>
        )}
      </span>
    </Row>
  );
}

/**
 * What waits on the caller first, then everything else still in flight.
 * A change that has merged or closed has nothing left to wait for, so
 * neither section shows it.
 */
export function InboxPage() {
  const { data } = useSuspenseQuery(changeQueries.list({ scope: "all" }));
  const needsYou = data.filter((item) => item.needsYou);
  const inFlight = data.filter(
    (item) => !item.needsYou && item.change.status !== "merged" && item.change.status !== "closed",
  );

  return (
    <>
      <PageHead
        title="Inbox"
        lede="Changes that are waiting for you, then everything else in flight."
      />
      <section aria-label="Needs you">
        <SectionHead
          title="Needs you"
          aside={needsYou.length > 0 ? plural(needsYou.length, "change") : undefined}
        />
        {needsYou.length === 0 ? (
          <Text tone="muted">Nothing is waiting on you.</Text>
        ) : (
          needsYou.map((item) => <ChangeRow key={item.change.id} item={item} />)
        )}
      </section>
      <section aria-label="In flight">
        <SectionHead
          title="In flight"
          className="mt-s11"
          aside={inFlight.length > 0 ? plural(inFlight.length, "change") : undefined}
        />
        {inFlight.length === 0 ? (
          <Text tone="muted">Nothing else in flight.</Text>
        ) : (
          inFlight.map((item) => <ChangeRow key={item.change.id} item={item} />)
        )}
      </section>
    </>
  );
}
