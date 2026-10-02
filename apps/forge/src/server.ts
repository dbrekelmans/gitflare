import handler from "@tanstack/react-start/server-entry";

// The Worker's entry. TanStack Start handles every request; the classes below
// are exported here because this is the only module the runtime looks in for
// Durable Objects, Workflows and entrypoints. Each is declared in both
// Wrangler configs. A build task fills in its class; this file does not change.

export { ChangeRoom } from "./server/durable/change-room";
export { SandboxRoom } from "./server/durable/sandbox-room";
export { ThreadRoom } from "./server/durable/thread-room";
export { SandboxEgress } from "./server/egress";
export { ChangePipelineWorkflow } from "./server/workflows/change-pipeline";
export { CiWorkflow } from "./server/workflows/ci";
export { ProvisionWorkflow } from "./server/workflows/provision";

export default {
  fetch: handler.fetch,
};
