import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Sessions: starting one forks the repository; a cloud session also has a hosted agent to prompt.
 * Build task: `artifacts`. The cloud operations (`prompt`, `events`, `stop`) pass
 * straight through to the `cloudSessions` port, which `cloud-sessions` implements.
 */
export function sessionsApi(_services: Services): ForgeApi["sessions"] {
  return stubSlice("sessions");
}
