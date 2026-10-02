import { idSchema } from "@gitflare/core/api";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { changeQueries } from "@/data/changes.queries";
import { threadQueries } from "@/data/threads.queries";
import { ChangePage } from "./-components/change-page";

const changeId = idSchema("change");

export const Route = createFileRoute("/changes/$changeId")({
  params: {
    parse: (params) => {
      const parsed = changeId.safeParse(params.changeId);
      if (!parsed.success) throw notFound();
      return { changeId: parsed.data };
    },
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(changeQueries.detail(params.changeId)),
      context.queryClient.ensureQueryData(threadQueries.list(params.changeId)),
    ]);
  },
  component: () => <ChangePage changeId={Route.useParams().changeId} />,
});
