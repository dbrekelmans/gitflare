import type { Repository } from "@gitflare/core";

/** Still importing, and not yet known to have failed: worth polling for. */
export function stillImporting(
  repository: Pick<Repository, "readyAt" | "importFailedAt">,
): boolean {
  return repository.readyAt === null && repository.importFailedAt === null;
}
