// The entry the Workers Vitest plugin loads instead of `src/server.ts`. It
// cannot load the real one: TanStack Start's handler needs its own Vite
// plugin. Durable Objects and Workflows do not, so `*.worker.test.ts` files
// exercise them through this entry with real local D1, storage and alarms.

export { ChangeRoom } from "./durable/change-room";
export { SandboxRoom } from "./durable/sandbox-room";
export { ThreadRoom } from "./durable/thread-room";
export { SandboxEgress } from "./egress";
export { ChangePipelineWorkflow } from "./workflows/change-pipeline";
export { CiWorkflow } from "./workflows/ci";
export { ProvisionWorkflow } from "./workflows/provision";

export default {
  fetch: () => new Response("test entry"),
} satisfies ExportedHandler<Env>;
