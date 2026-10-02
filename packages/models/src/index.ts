// @gitflare/models — the one typed way gitflare calls a model. The gateway
// adapter turns a `GenerateRequest` into an Anthropic Messages body for
// `env.AI.run` and back; fallback, recording and budgets are wrappers around
// the port, written here so they are tested without a gateway. Facts and
// signatures: spec/research/ai-identity.md. Build task: `models`.

export {
  type AiBindingLike,
  attributionMetadata,
  type BilledCall,
  BilledModelError,
  catalogPrices,
  createGatewayModels,
  type GatewayLog,
  type GatewayModelsOptions,
  type ModelPrice,
} from "./gateway";
export {
  composeModels,
  cosineSimilarity,
  withAccounting,
  withChangeBudget,
  withFallback,
} from "./wrappers";
