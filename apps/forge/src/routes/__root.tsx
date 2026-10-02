import { Heading, Text } from "@gitflare/ui/components/typography";
import { TooltipProvider } from "@gitflare/ui/components/ui/tooltip";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { accountQueries } from "@/data/account.queries";
import appCss from "@/styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "gitflare" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(accountQueries.me()),
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  return (
    <Document>
      <TooltipProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </TooltipProvider>
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div className="max-w-claim">
      <Heading level={1} size="display-s">
        Nothing here
      </Heading>
      <Text size="body-l" tone="muted" className="mt-s5">
        That page does not exist, or it is not yours to see.
      </Text>
    </div>
  );
}
