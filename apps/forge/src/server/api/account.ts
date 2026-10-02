import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Who is signed in, the members of the deployment, its settings and its AI budget.
 * Build task: `identity`.
 */
export function accountApi(_services: Services): ForgeApi["account"] {
  return stubSlice("account");
}
