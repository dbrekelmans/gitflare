import type { DecisionId } from "@gitflare/core";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHead } from "@/components/shell/page";
import { decisionQueries, useRevertDecision, useReviveDecision } from "@/data/decisions.queries";
import { formatTime } from "@/lib/format";
import { EditDecisionForm } from "./decision-form";

const eventLabel: Record<string, string> = {
  created: "Recorded",
  followed: "Followed",
  cited: "Cited in a review",
  confirmed: "Confirmed",
  contradiction_accepted: "Went against this, and it stood",
  reshaped: "Reworded",
  reverted: "Reverted",
  revived: "Revived",
};

export function DecisionPage({ decisionId }: { decisionId: DecisionId }) {
  const { data } = useSuspenseQuery(decisionQueries.detail(decisionId));
  const [editing, setEditing] = useState(false);
  const revive = useReviveDecision();
  const revert = useRevertDecision();
  const { decision, events } = data;

  if (editing) {
    return (
      <>
        <PageHead title="Edit decision" />
        <EditDecisionForm
          decisionId={decision.id}
          wording={{
            title: decision.title,
            statement: decision.statement,
            rationale: decision.rationale,
          }}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title={decision.title}
        lede={decision.statement}
        aside={
          <div className="flex flex-col items-end gap-s4">
            <div className="flex items-center gap-s4">
              <StatusPill tone={decision.status === "active" ? "success" : "neutral"}>
                {decision.status}
              </StatusPill>
              <Evidence size="sm" kind="note">
                strength {decision.strength.toFixed(2)}
              </Evidence>
            </div>
            <div className="flex items-center gap-s4">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {decision.status === "dormant" && (
                <Button
                  type="button"
                  variant="flare"
                  size="sm"
                  disabled={revive.isPending}
                  onClick={() => revive.mutate({ decisionId: decision.id })}
                >
                  {revive.isPending ? "Reviving…" : "Revive"}
                </Button>
              )}
            </div>
          </div>
        }
      />
      {decision.rationale !== "" && (
        <Text size="body-s" tone="muted">
          {decision.rationale}
        </Text>
      )}
      <SectionHead title="History" aside="newest first" />
      <ul aria-label="Decision history" className="flex flex-col">
        {events.map((event) => (
          <li key={event.id}>
            <Row
              label={eventLabel[event.kind] ?? event.kind}
              annotation={
                <Evidence size="sm" kind="note">
                  {event.strengthBefore.toFixed(2)} → {event.strengthAfter.toFixed(2)} ·{" "}
                  {formatTime(event.createdAt)}
                </Evidence>
              }
            >
              {event.statementAfter != null ? (
                <>
                  <Text size="body-s" tone="muted" className="line-through">
                    {event.statementBefore}
                  </Text>
                  <Text size="body-s">{event.statementAfter}</Text>
                </>
              ) : (
                event.note != null && (
                  <Text size="body-s" tone="muted">
                    {event.note}
                  </Text>
                )
              )}
              {event.kind === "reshaped" && (
                <Button
                  type="button"
                  variant="link"
                  className="mt-s2"
                  disabled={revert.isPending}
                  onClick={() => revert.mutate({ decisionId: decision.id, eventId: event.id })}
                >
                  {revert.isPending ? "Reverting…" : "Revert to the earlier wording"}
                </Button>
              )}
            </Row>
          </li>
        ))}
      </ul>
      {(revive.error ?? revert.error) && (
        <Text size="detail" className="text-danger" role="alert">
          {(revive.error ?? revert.error)?.message}
        </Text>
      )}
    </>
  );
}
