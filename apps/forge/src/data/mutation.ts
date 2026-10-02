import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

/**
 * The one way a component changes something: a mutation over a server
 * function that, once it succeeds, invalidates the queries it made stale.
 * The mutation stays pending until those have refetched, so a button can
 * stay disabled until the screen is true again.
 *
 * Every mutation hook in `src/data/*.queries.ts` is built with this. Do not
 * call a server function from an event handler directly.
 */
export function useApiMutation<Input, Output>(
  serverFn: (options: { data: Input }) => Promise<Output>,
  invalidates: (input: Input, output: Output) => QueryKey[],
) {
  const queryClient = useQueryClient();
  const call = useServerFn(serverFn);
  return useMutation({
    mutationFn: (input: Input) => call({ data: input }),
    onSuccess: (output, input) =>
      Promise.all(
        invalidates(input, output).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
  });
}
