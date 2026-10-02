import type { PipelineParams } from "@gitflare/core";
import type { ChangeLive, PipelineRunner, ThreadHost } from "@gitflare/core/ports";

// The ports that are backed by this Worker's own Durable Objects and
// Workflows. They run the same way locally and deployed, so there is one
// implementation and no fake behind them in `pnpm dev`.

export function createChangeLive(env: Env): ChangeLive {
  return {
    publish: (event) => env.CHANGE_ROOM.getByName(event.changeId).publish(event),
    signal: (changeId, signal) => env.CHANGE_ROOM.getByName(changeId).signal(changeId, signal),
  };
}

export function createPipelineRunner(env: Env): PipelineRunner {
  const start = async (params: PipelineParams) => {
    await env.CHANGE_PIPELINE.create({ params });
  };
  return {
    handlePush: (push) => start({ kind: "push", push }),
    rerunStage: (changeId, stage) => start({ kind: "rerun", changeId, stage }),
  };
}

export function createThreadHost(env: Env): ThreadHost {
  return {
    post: (threadId, message) => env.THREAD_ROOM.getByName(threadId).post(threadId, message),
  };
}
