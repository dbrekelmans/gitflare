import { can } from "@gitflare/core";
import { Row } from "@gitflare/ui/components/row";
import { StatusBadge } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { accountQueries, usePrepareWorkspace } from "@/data/account.queries";

/** What every sandbox boots from: CI runs and hosted sessions alike. */
export function Workspace() {
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const prepare = usePrepareWorkspace();
  const mayManage = can(me.user, { type: "settings.manage" });

  // Preparing takes minutes and reports nothing back: once triggered, poll
  // the settings until a snapshot appears, then stop.
  const [waiting, setWaiting] = useState(false);
  const { data: settings } = useSuspenseQuery({
    ...accountQueries.settings(),
    refetchInterval: (query) => (waiting && !query.state.data?.workspace.snapshot ? 3000 : false),
  });
  const { workspace } = settings;
  useEffect(() => {
    if (workspace.snapshot) setWaiting(false);
  }, [workspace.snapshot]);

  const preparing = prepare.isPending || waiting;

  return (
    <Row
      label="Workspace"
      annotation={
        <StatusBadge tone={workspace.snapshot ? "success" : "warning"}>
          {preparing ? "preparing" : workspace.snapshot ? "prepared" : "not prepared"}
        </StatusBadge>
      }
    >
      <Text tone="muted" size="body-s">
        {preparing
          ? "Preparing a fresh snapshot. This takes minutes; the page updates on its own."
          : workspace.snapshot
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
            disabled={preparing}
            onClick={() => {
              setWaiting(true);
              prepare.mutate(undefined);
            }}
          >
            {preparing ? "Preparing…" : workspace.snapshot ? "Prepare again" : "Prepare workspace"}
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
