import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Repositories, and the git credentials the forge issues for them.
 * Build task: `artifacts`.
 */
export function repositoriesApi(_services: Services): ForgeApi["repositories"] {
  return stubSlice("repositories");
}
