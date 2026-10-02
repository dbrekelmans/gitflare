import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { decisionQueries } from "@/data/decisions.queries";
import { AddDecisionForm } from "./decision-form";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The repository's decision record: what is still retrieved, and what has gone dormant. */
export function Decisions({ repoSlug }: { repoSlug: string }) {
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(decisionQueries.list(repoSlug));
  const [adding, setAdding] = useState(false);
  const active = data.filter((decision) => decision.status === "active");
  const dormant = data.filter((decision) => decision.status === "dormant");

  return (
    <>
      <PageHead
        title="Decisions"
        lede={`What ${repoSlug} has decided about how it is built, recorded from its reviews. Reviews are given the ones that apply.`}
        aside={
          !adding && (
            <Button type="button" variant="flare" onClick={() => setAdding(true)}>
              Add decision
            </Button>
          )
        }
      />
      {adding && (
        <>
          <SectionHead title="Add a decision" />
          <AddDecisionForm
            repoSlug={repoSlug}
            onAdded={(decisionId) =>
              navigate({ to: "/decisions/$decisionId", params: { decisionId } })
            }
            onCancel={() => setAdding(false)}
          />
        </>
      )}
      <section aria-label="Active">
        <SectionHead title="Active" aside={plural(active.length, "decision")} />
        {active.length === 0 ? (
          <Text size="body-s" tone="muted">
            No active decisions yet.
          </Text>
        ) : (
          active.map((decision) => (
            <Row
              key={decision.id}
              label={
                <RouteLink to="/decisions/$decisionId" params={{ decisionId: decision.id }}>
                  {decision.title}
                </RouteLink>
              }
              annotation={
                <Evidence size="sm" kind="note">
                  strength {decision.strength.toFixed(2)}
                </Evidence>
              }
            >
              {decision.statement}
            </Row>
          ))
        )}
      </section>
      <section aria-label="Dormant">
        <SectionHead title="Dormant" aside={plural(dormant.length, "decision")} />
        {dormant.length === 0 ? (
          <Text size="body-s" tone="muted">
            No dormant decisions.
          </Text>
        ) : (
          dormant.map((decision) => (
            <Row
              key={decision.id}
              label={
                <RouteLink to="/decisions/$decisionId" params={{ decisionId: decision.id }}>
                  {decision.title}
                </RouteLink>
              }
              annotation={
                <Evidence size="sm" kind="note">
                  strength {decision.strength.toFixed(2)}
                </Evidence>
              }
            >
              {decision.statement}
            </Row>
          ))
        )}
      </section>
    </>
  );
}
