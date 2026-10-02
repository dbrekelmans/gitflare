import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One QueryClient per router, and so per SSR request: a client at module
  // scope would leak one reader's data into another's page.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Query decides whether a preload needs fetching, not the router.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
