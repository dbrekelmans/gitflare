import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { accountQueries } from "@/data/account.queries";
import { formatUsd } from "@/lib/format";

export const Route = createFileRoute("/settings/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(accountQueries.members()),
      context.queryClient.ensureQueryData(accountQueries.budget()),
    ]);
  },
  component: Settings,
});

function Settings() {
  const { data: members } = useSuspenseQuery(accountQueries.members());
  const { data: budget } = useSuspenseQuery(accountQueries.budget());
  return (
    <>
      <PageHead
        title="Settings"
        lede="Who can do what in this deployment, and what its agents have cost this month."
      />
      <SectionHead title="Members" aside="who may log in is decided by your Access policy" />
      {members.map((member) => (
        <Row key={member.id} label={member.name} annotation={member.role}>
          {member.email}
        </Row>
      ))}
      <SectionHead
        title="Spend"
        className="mt-s11"
        aside={`${formatUsd(budget.summary.spentMicroUsd)} of ${formatUsd(budget.summary.budgetMicroUsd)}`}
      />
      {budget.topChanges.map(({ change, costMicroUsd }) => (
        <Row
          key={change.id}
          label={`#${change.number}`}
          annotation={<Evidence size="sm">{formatUsd(costMicroUsd)} estimated</Evidence>}
        >
          {change.title}
        </Row>
      ))}
      <Unbuilt task="web-sessions" />
    </>
  );
}
