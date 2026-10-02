import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Sessions: starting one forks the repository; a cloud session also has a hosted agent to prompt.
 * Build task: `cloud-sessions`.
 */
export function sessionsApi(_services: Services): ForgeApi["sessions"] {
  return stubSlice("sessions");
}
