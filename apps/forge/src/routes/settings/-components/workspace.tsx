import { can } from "@gitflare/core";
import { Row } from "@gitflare/ui/components/row";
import { StatusBadge } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { accountQueries, usePrepareWorkspace } from "@/data/account.queries";

/**
 * Nothing in the backend writes `preparation: { state: "running" }` yet —
 * `prepareWorkspace` and the provisioning Workflow only ever clear it or
 * write `failed` (see the task comment on GF-49). Until that lands, this is
 * the only signal this page gets that preparing is under way: a fixed
 * window from the moment the request went out, generous enough to cover a
 * real preparation (image pull, setup script, snapshot).
 */
const FALLBACK_POLL_MS = 10 * 60 * 1000;

/** What every sandbox boots from: CI runs and hosted sessions alike. */
export function Workspace() {
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const prepare = usePrepareWorkspace();
  const mayManage = can(me.user, { type: "settings.manage" });
  const [pollUntil, setPollUntil] = useState<number | null>(null);

  // Clears itself once the fallback window elapses, so polling actually
  // stops rather than running until the next unrelated re-render.
  useEffect(() => {
    if (pollUntil === null) return;
    const remaining = pollUntil - Date.now();
    if (remaining <= 0) {
      setPollUntil(null);
      return;
    }
    const timer = setTimeout(() => setPollUntil(null), remaining);
    return () => clearTimeout(timer);
  }, [pollUntil]);

  // Preparing takes minutes and reports nothing back on this request: poll
  // while `preparation` says one is actually running, whoever triggered it,
  // or — until the backend writes that — for a fallback window from the
  // moment this caller asked for one. That also covers re-preparing an
  // already-prepared workspace, where the mutation itself resolves long
  // before preparation finishes.
  const { data: settings } = useSuspenseQuery({
    ...accountQueries.settings(),
    refetchInterval: (query) => {
      if (query.state.data?.workspace.preparation?.state === "running") return 3000;
      if (pollUntil !== null && Date.now() < pollUntil) return 3000;
      return false;
    },
  });
  const { workspace } = settings;
  // The fallback window only keeps polling alive; it does not by itself
  // mean preparing is still running; a mutation the fixture (or a fast
  // backend) settles immediately must not show "Preparing…" for the rest
  // of that window.
  const running = prepare.isPending || workspace.preparation?.state === "running";
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
            disabled={running}
            onClick={() => {
              setPollUntil(Date.now() + FALLBACK_POLL_MS);
              prepare.mutate(undefined);
            }}
          >
            {running ? "Preparing…" : workspace.snapshot ? "Prepare again" : "Prepare workspace"}
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
