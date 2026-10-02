import { can } from "@gitflare/core";
import { Row } from "@gitflare/ui/components/row";
import { StatusBadge } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { accountQueries, usePrepareWorkspace } from "@/data/account.queries";

/** What every sandbox boots from: CI runs and hosted sessions alike. */
export function Workspace() {
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const prepare = usePrepareWorkspace();
  const mayManage = can(me.user, { type: "settings.manage" });

  // Preparing takes minutes and reports nothing back on this request: poll
  // while `preparation` says one is actually running, whoever triggered it.
  // That also covers re-preparing an already-prepared workspace, where the
  // mutation itself resolves long before preparation finishes.
  const { data: settings } = useSuspenseQuery({
    ...accountQueries.settings(),
    refetchInterval: (query) =>
      query.state.data?.workspace.preparation?.state === "running" ? 3000 : false,
  });
  const { workspace } = settings;
  const running = workspace.preparation?.state === "running";
  const failed = workspace.preparation?.state === "failed" ? workspace.preparation : null;

  return (
    <Row
      label="Workspace"
      annotation={
        <StatusBadge tone={workspace.snapshot ? "success" : failed ? "danger" : "warning"}>
          {running ? "preparing" : workspace.snapshot ? "prepared" : "not prepared"}
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
      {failed && (
        <Text size="detail" className="mt-s2 text-danger" role="alert">
          {failed.error}
        </Text>
      )}
      {mayManage && (
        <div className="mt-s5 flex items-center gap-s5">
          <Button
            variant="outline"
            disabled={prepare.isPending || running}
            onClick={() => prepare.mutate(undefined)}
          >
            {prepare.isPending || running
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
