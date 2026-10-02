import { createFileRoute } from "@tanstack/react-router";
import { accountQueries } from "@/data/account.queries";
import { SettingsPage } from "./-components/settings-page";

export const Route = createFileRoute("/settings/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(accountQueries.me()),
      context.queryClient.ensureQueryData(accountQueries.members()),
      context.queryClient.ensureQueryData(accountQueries.settings()),
      context.queryClient.ensureQueryData(accountQueries.budget()),
    ]);
  },
  component: SettingsPage,
});
