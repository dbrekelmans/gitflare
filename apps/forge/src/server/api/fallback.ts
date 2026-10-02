import { type ApiSlice, apiOperations, type ForgeApi } from "@gitflare/core/api";

type Operation = (...args: unknown[]) => Promise<unknown>;

/**
 * Local development only. Wraps the API so that an operation whose slice has
 * not built it yet (it throws `NotImplementedError`) is answered by the
 * fixture API instead. This is what lets a screen be built before its
 * backend: the page works on fixture data today and on the real operation the
 * day that lands, with no change to the screen.
 *
 * The fallback is per operation, and what a fixture operation writes lives
 * only in this isolate's memory. Any other error is the real operation's and
 * is not hidden.
 */
export function withFixtureFallback(live: ForgeApi, fixture: ForgeApi): ForgeApi {
  const wrapped: Record<string, Record<string, Operation>> = {};
  for (const slice of Object.keys(apiOperations) as ApiSlice[]) {
    const liveSlice = live[slice] as unknown as Record<string, Operation>;
    const fixtureSlice = fixture[slice] as unknown as Record<string, Operation>;
    wrapped[slice] = {};
    for (const operation of apiOperations[slice]) {
      (wrapped[slice] as Record<string, Operation>)[operation] = async (...args) => {
        try {
          return await (liveSlice[operation] as Operation)(...args);
        } catch (error) {
          if (error instanceof Error && error.name === "NotImplementedError") {
            return (fixtureSlice[operation] as Operation)(...args);
          }
          throw error;
        }
      };
    }
  }
  return wrapped as unknown as ForgeApi;
}
