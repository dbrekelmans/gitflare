import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Local development helpers. Refuses everything unless the forge runs in dev mode.
 * Build task: `pipeline`.
 */
export function devApi(_services: Services): ForgeApi["dev"] {
  return stubSlice("dev");
}
