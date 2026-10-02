import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";
import { stubSlice } from "./stub";

/**
 * Review comments and chats on a change, and settling them.
 * Build task: `review`.
 */
export function threadsApi(_services: Services): ForgeApi["threads"] {
  return stubSlice("threads");
}
