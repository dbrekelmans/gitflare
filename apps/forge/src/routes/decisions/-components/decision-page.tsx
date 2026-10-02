import type { DecisionEvent, DecisionEventKind, DecisionId, DecisionOrigin } from "@gitflare/core";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { decisionQueries, useRevertDecision, useReviveDecision } from "@/data/decisions.queries";
import { formatTime } from "@/lib/format";
import { EditDecisionForm } from "./decision-form";

const eventLabel: Record<DecisionEventKind, string> = {
  created: "Recorded",
  followed: "Followed",
  cited: "Cited in a review",
  confirmed: "Confirmed",
  contradiction_accepted: "Went against this, and it stood",
  reshaped: "Reworded",
  reverted: "Reverted",
  revived: "Revived",
};

const originCopy: Record<DecisionOrigin, string> = {
  dismissed_finding: "Recorded from a dismissed review comment.",
  review_reply: "Learned from a reply in review.",
  chat: "Learned from a conversation about a change.",
  change: "Recorded when a change merged.",
  manual: "Added by hand, not derived from a review.",
};

/** A `reshaped` event records every edit, even one that left the statement untouched. */
function wordingChanged(event: DecisionEvent): boolean {
  return event.statementAfter != null && event.statementBefore !== event.statementAfter;
}

function historyLabel(event: DecisionEvent): string {
  if (event.kind === "reshaped" && !wordingChanged(event)) return "Edited";
  return eventLabel[event.kind];
}

function BackLink() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="link"
      className="mb-s6 px-0"
      onClick={() => router.history.back()}
    >
      Back to decisions
    </Button>
  );
}

export function DecisionPage({ decisionId }: { decisionId: DecisionId }) {
  const { data } = useSuspenseQuery(decisionQueries.detail(decisionId));
  const [editing, setEditing] = useState(false);
  const revive = useReviveDecision();
  const revert = useRevertDecision();
  const { decision, events } = data;

  if (editing) {
    return (
      <>
        <BackLink />
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
      <BackLink />
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
      <SectionHead title="Where it came from" />
      <section aria-label="Where it came from">
        <Text size="body-s" tone="muted">
          {originCopy[decision.origin]}
        </Text>
        {(decision.originChangeId || decision.originThreadId) && (
          <div className="mt-s2 flex flex-col gap-s1">
            {decision.originChangeId && (
              <RouteLink
                to="/changes/$changeId"
                params={{ changeId: decision.originChangeId }}
                standalone
              >
                The change it came from
              </RouteLink>
            )}
            {decision.originThreadId && (
              <Evidence size="sm" kind="note">
                thread {decision.originThreadId}
              </Evidence>
            )}
          </div>
        )}
      </section>
      <SectionHead title="History" aside="newest first" />
      <ul aria-label="Decision history" className="flex flex-col">
        {events.map((event) => {
          const changed = wordingChanged(event);
          const reverting = revert.isPending && revert.variables?.eventId === event.id;
          return (
            <li key={event.id}>
              <Row
                label={historyLabel(event)}
                annotation={
                  <Evidence size="sm" kind="note">
                    {event.strengthBefore.toFixed(2)} → {event.strengthAfter.toFixed(2)} ·{" "}
                    {formatTime(event.createdAt)}
                  </Evidence>
                }
              >
                {changed && (
                  <>
                    <Text size="body-s" tone="muted" className="line-through">
                      {event.statementBefore}
                    </Text>
                    <Text size="body-s">{event.statementAfter}</Text>
                  </>
                )}
                {event.note != null && (
                  <Text size="body-s" tone="muted" className={changed ? "mt-s2" : undefined}>
                    {event.note}
                  </Text>
                )}
                {(event.userId || event.changeId || event.threadId) && (
                  <div className="mt-s2 flex flex-wrap items-center gap-s4">
                    {event.userId && (
                      <Evidence size="sm" kind="note">
                        by {event.userId}
                      </Evidence>
                    )}
                    {event.changeId && (
                      <RouteLink
                        to="/changes/$changeId"
                        params={{ changeId: event.changeId }}
                        standalone
                      >
                        the change
                      </RouteLink>
                    )}
                    {event.threadId && (
                      <Evidence size="sm" kind="note">
                        thread {event.threadId}
                      </Evidence>
                    )}
                  </div>
                )}
                {event.kind === "reshaped" && changed && (
                  <Button
                    type="button"
                    variant="link"
                    className="mt-s2 px-0"
                    disabled={revert.isPending}
                    onClick={() => revert.mutate({ decisionId: decision.id, eventId: event.id })}
                  >
                    {reverting ? "Reverting…" : "Revert to the earlier wording"}
                  </Button>
                )}
              </Row>
            </li>
          );
        })}
      </ul>
      {(revive.error ?? revert.error) && (
        <Text size="detail" className="text-danger" role="alert">
          {(revive.error ?? revert.error)?.message}
        </Text>
      )}
    </>
  );
}
