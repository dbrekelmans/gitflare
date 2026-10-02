import type {
  ChangeId,
  MicroUsd,
  ModelCallId,
  RepositoryId,
  SessionId,
  Timestamp,
  UserId,
} from "../ids";
import type { AgentName } from "./change";

/**
 * Who a model call is for. This is also the gateway metadata vocabulary: the
 * gateway keeps at most five entries per request, so these five keys are all
 * there is. Budgets are partitioned on them.
 */
export interface ModelAttribution {
  agent: AgentName;
  userId?: UserId;
  repositoryId?: RepositoryId;
  changeId?: ChangeId;
  sessionId?: SessionId;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One call through the gateway, as gitflare recorded it. Per-change cost is a sum over these. */
export interface ModelCall {
  id: ModelCallId;
  attribution: ModelAttribution;
  /** The model that answered, which is not the one asked for after a fallback. */
  model: string;
  requestedModel: string;
  /** The gateway's log entry, where its own cost figure lives. */
  gatewayLogId: string | null;
  usage: ModelUsage;
  /** An estimate: the gateway derives it from token counts. */
  costMicroUsd: MicroUsd;
  createdAt: Timestamp;
}
