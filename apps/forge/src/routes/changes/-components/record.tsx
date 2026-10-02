import type { AgentName, MicroUsd } from "@gitflare/core";
import type { ChangeDetail } from "@gitflare/core/api";
import { Row } from "@gitflare/ui/components/row";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { formatTime, formatUsd, shortSha } from "@/lib/format";
import { plural } from "./copy";

/** What the platform's agents spent on this change. The gateway's figures are estimates, and it says so. */
export function CostFact({ cost }: Pick<ChangeDetail, "cost">) {
  const byAgent = (Object.entries(cost.byAgent) as [AgentName, MicroUsd][]).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <Row
      label="Cost"
      annotation={
        <div>
          {byAgent.map(([agent, amount]) => (
            <Evidence key={agent} as="div" size="sm" kind="note">
              {agent} {formatUsd(amount)}
            </Evidence>
          ))}
        </div>
      }
    >
      <Text tone="muted">
        <span className="font-medium text-ink">{formatUsd(cost.totalMicroUsd)} so far.</span> An
        estimate, from what the gateway reports for each model call made for this change.
      </Text>
    </Row>
  );
}

export function CommitsFact({ commits, revisions }: Pick<ChangeDetail, "commits" | "revisions">) {
  return (
    <Row
      label="Commits"
      annotation={
        <Evidence size="sm" kind="note">
          {plural(commits.length, "commit")} in {plural(revisions.length, "push", "pushes")}
        </Evidence>
      }
    >
      <ul className="flex flex-col gap-s3">
        {commits.map((commit) => (
          <li key={commit.sha}>
            <Text tone="muted">{commit.message.split("\n")[0]}</Text>
            <Evidence as="div" size="sm" kind="note">
              {shortSha(commit.sha)} · {commit.authorName} · {formatTime(commit.authoredAt)}
              {commit.checkpointIds.length > 0 ? " · captured" : ""}
            </Evidence>
          </li>
        ))}
      </ul>
    </Row>
  );
}
