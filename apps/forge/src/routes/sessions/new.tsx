import { createFileRoute } from "@tanstack/react-router";
import { PageHead } from "@/components/shell/page";
import { repositoryQueries } from "@/data/repositories.queries";
import { NewSessionForm } from "./-components/new-session-form";

export const Route = createFileRoute("/sessions/new")({
  loader: ({ context }) => context.queryClient.ensureQueryData(repositoryQueries.list()),
  component: NewSession,
});

function NewSession() {
  return (
    <>
      <PageHead
        title="Start a session"
        lede="Forks the repository so you, or a hosted agent, can push to it alone. The fork takes a moment to prepare."
      />
      <NewSessionForm />
    </>
  );
}
