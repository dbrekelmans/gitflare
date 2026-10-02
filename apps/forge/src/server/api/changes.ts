import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Changes: the list, the change page's read model, section approval, re-running a stage, merging and closing.
 * Build task: `pipeline`.
 */
export function changesApi(_services: Services): ForgeApi["changes"] {
  return stubSlice("changes");
}
