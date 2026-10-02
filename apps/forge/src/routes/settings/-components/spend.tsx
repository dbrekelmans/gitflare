import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteLink } from "@/components/shell/link";
import { accountQueries } from "@/data/account.queries";
import { formatUsd } from "@/lib/format";

/** The deployment's whole AI budget for the month, and what drove it. */
export function Spend() {
  const { data } = useSuspenseQuery(accountQueries.budget());
  const { summary, perChangeBudgetMicroUsd, byAgent, topChanges } = data;
  return (
    <>
      <Row label="This month" annotation={`of ${formatUsd(summary.budgetMicroUsd)}`}>
        {formatUsd(summary.spentMicroUsd)} spent · {formatUsd(perChangeBudgetMicroUsd)} cap per
        change
      </Row>
      {byAgent.length > 0 && (
        <>
          <SectionHead title="By agent" level={3} className="mt-s7" />
          {byAgent.map(({ agent, costMicroUsd }) => (
            <Row
              key={agent}
              label={agent}
              annotation={<Evidence>{formatUsd(costMicroUsd)}</Evidence>}
            />
          ))}
        </>
      )}
      {topChanges.length > 0 && (
        <>
          <SectionHead title="Costliest changes" level={3} className="mt-s7" />
          {topChanges.map(({ change, costMicroUsd }) => (
            <Row
              key={change.id}
              label={
                <RouteLink to="/changes/$changeId" params={{ changeId: change.id }}>
                  #{change.number} {change.title}
                </RouteLink>
              }
              annotation={<Evidence>{formatUsd(costMicroUsd)}</Evidence>}
            />
          ))}
        </>
      )}
    </>
  );
}
