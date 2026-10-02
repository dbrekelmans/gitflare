import { createFileRoute } from "@tanstack/react-router";
import { changeQueries } from "@/data/changes.queries";
import { InboxPage } from "./-inbox/inbox-page";

const changes = changeQueries.list({ scope: "all" });

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(changes),
  component: InboxPage,
});
