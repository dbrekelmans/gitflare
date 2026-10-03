import type { DecisionEvent, DecisionEventKind, DecisionId, DecisionOrigin } from "@gitflare/core";
import type { UserRef } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button, buttonVariants } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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

/** Whether the event reworded the statement specifically, the part of the wording shown struck through. */
function statementChanged(event: DecisionEvent): boolean {
  return event.wording !== null && event.wording.before.statement !== event.wording.after.statement;
}

/** Whether the event changed any part of the wording: title, statement or rationale. */
function wordingChanged(event: DecisionEvent): boolean {
  if (event.wording === null) return false;
  const { before, after } = event.wording;
  return (
    before.title !== after.title ||
    before.statement !== after.statement ||
    before.rationale !== after.rationale
  );
}

function historyLabel(event: DecisionEvent): string {
  if (event.kind === "reshaped" && !statementChanged(event)) return "Edited";
  return eventLabel[event.kind];
}

function attribution(user: UserRef | null, userId: string | null): string | null {
  if (user) return user.name;
  if (userId) return userId;
  return null;
}

/** One part of a wording diff: struck-through old text (when there was any) and the new text. */
function WordingDiff({ before, after }: { before: string; after: string }) {
  if (before === after) return null;
  return (
    <>
      {before !== "" && (
        <Text size="body-s" tone="muted" className="line-through">
          {before}
        </Text>
      )}
      <Text size="body-s">{after}</Text>
    </>
  );
}

function BackLink({ repoSlug }: { repoSlug: string }) {
  return (
    <Link
      to="/repos/$repoSlug/decisions"
      params={{ repoSlug }}
      className={buttonVariants({ variant: "link", className: "mb-s6" })}
    >
      Back to decisions
    </Link>
  );
}

export function DecisionPage({ decisionId }: { decisionId: DecisionId }) {
  const { data } = useSuspenseQuery(decisionQueries.detail(decisionId));
  const [editing, setEditing] = useState(false);
  const revive = useReviveDecision();
  const revert = useRevertDecision();
  const { decision, repository, events } = data;

  if (editing) {
    return (
      <>
        <BackLink repoSlug={repository.slug} />
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
      <BackLink repoSlug={repository.slug} />
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
                {changed && event.wording && (
                  <>
                    <WordingDiff
                      before={event.wording.before.title}
                      after={event.wording.after.title}
                    />
                    <WordingDiff
                      before={event.wording.before.statement}
                      after={event.wording.after.statement}
                    />
                    <WordingDiff
                      before={event.wording.before.rationale}
                      after={event.wording.after.rationale}
                    />
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
                        by {attribution(event.user, event.userId)}
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
                {(event.kind === "reshaped" || event.kind === "reverted") && changed && (
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
