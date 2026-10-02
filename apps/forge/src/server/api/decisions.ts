import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * A repository's decision record: reading it, correcting it, reverting and reviving.
 * Build task: `decisions`.
 */
export function decisionsApi(_services: Services): ForgeApi["decisions"] {
  return stubSlice("decisions");
}
