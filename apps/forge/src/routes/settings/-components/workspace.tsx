import { can } from "@gitflare/core";
import { Row } from "@gitflare/ui/components/row";
import { StatusBadge } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { accountQueries, usePrepareWorkspace } from "@/data/account.queries";

/** What every sandbox boots from: CI runs and hosted sessions alike. */
export function Workspace() {
  const { data: settings } = useSuspenseQuery(accountQueries.settings());
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const prepare = usePrepareWorkspace();
  const mayManage = can(me.user, { type: "settings.manage" });
  const { workspace } = settings;

  return (
    <Row
      label="Workspace"
      annotation={
        <StatusBadge tone={workspace.snapshot ? "success" : "warning"}>
          {workspace.snapshot ? "prepared" : "not prepared"}
        </StatusBadge>
      }
    >
      <Text tone="muted" size="body-s">
        {workspace.snapshot
          ? "Every sandbox — CI and hosted sessions alike — boots from this snapshot."
          : "No sandbox can run until this is prepared."}
      </Text>
      <Evidence size="sm" kind="note" className="mt-s2 block">
        image {workspace.image}
        {workspace.snapshot && ` · snapshot ${workspace.snapshot.id}`}
      </Evidence>
      {mayManage && (
        <div className="mt-s5 flex items-center gap-s5">
          <Button
            variant="outline"
            disabled={prepare.isPending}
            onClick={() => prepare.mutate(undefined)}
          >
            {prepare.isPending
              ? "Preparing…"
              : workspace.snapshot
                ? "Prepare again"
                : "Prepare workspace"}
          </Button>
          {prepare.error && (
            <Text size="detail" className="text-danger" role="alert">
              {prepare.error.message}
            </Text>
          )}
        </div>
      )}
    </Row>
  );
}
