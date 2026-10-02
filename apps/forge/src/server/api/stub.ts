import { NotImplementedError } from "@gitflare/core";
import { type ApiSlice, apiOperations, type ForgeApi } from "@gitflare/core/api";

/**
 * A slice whose every operation is unbuilt. A build task starts from this and
 * replaces operations one at a time:
 *
 *   return { ...stubSlice("changes"), list: async (ctx, input) => … };
 *
 * In local development an unbuilt operation is answered from the fixture
 * instead; see `./index.ts`.
 */
export function stubSlice<S extends ApiSlice>(slice: S): ForgeApi[S] {
  const entries = apiOperations[slice].map((operation) => [
    operation,
    async () => {
      throw new NotImplementedError(`ForgeApi ${slice}.${operation}`);
    },
  ]);
  return Object.fromEntries(entries) as ForgeApi[S];
}
