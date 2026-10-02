import { DurableObject } from "cloudflare:workers";
import type {
  ExecOptions,
  ExecResult,
  LogChunk,
  ProcessStatus,
  SandboxSnapshot,
  SandboxStartOptions,
} from "@gitflare/core/ports";
import {
  type EgressProps,
  noContainer,
  resolveEgressTargets,
  SandboxController,
} from "@gitflare/sandbox";
import { getServices } from "../services";

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

/**
 * One per sandbox, named by sandbox id: the Durable Object that owns one
 * container. Each method forwards to `SandboxController` from
 * `@gitflare/sandbox`, constructed with `this.ctx.container`, and `alarm`
 * forwards to its `onAlarm`. Locally there is no container (`ctx.container`
 * is undefined) and the forge uses the fake sandbox host instead of this
 * class. Build task: `sandbox`.
 */
export class SandboxRoom extends DurableObject<Env> {
  private readonly controller: SandboxController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.controller = new SandboxController({
      container: ctx.container ?? noContainer,
      storage: ctx.storage.kv,
      // Every HTTPS request the container makes arrives at `SandboxEgress`,
      // which is given the grants and nothing else: no token is in the props.
      applyEgress: async (grants) => {
        const gateway = { host: GATEWAY_HOST, gatewayId: env.AI_GATEWAY_ID };
        const targets = await resolveEgressTargets(getServices(), grants, gateway);
        const props: EgressProps = { grants, targets };
        await ctx.container?.interceptOutboundHttps("*", ctx.exports.SandboxEgress({ props }));
      },
      scheduleKeepAlive: (delayMs) => ctx.storage.setAlarm(Date.now() + delayMs),
    });
    // A restart drops the container's inactivity timeout; nothing may run before it is back.
    void ctx.blockConcurrencyWhile(() => this.controller.onWake());
  }

  async start(options: SandboxStartOptions): Promise<void> {
    return this.controller.start(options);
  }

  async isRunning(): Promise<boolean> {
    return this.controller.isRunning();
  }

  async exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.controller.exec(command, options);
  }

  async spawn(name: string, command: string[], options?: ExecOptions): Promise<void> {
    return this.controller.spawn(name, command, options);
  }

  async processStatus(name: string): Promise<ProcessStatus | null> {
    return this.controller.processStatus(name);
  }

  async readLog(name: string, stream: "stdout" | "stderr", offset: number): Promise<LogChunk> {
    return this.controller.readLog(name, stream, offset);
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.controller.writeFile(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    return this.controller.readFile(path);
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return this.controller.snapshot();
  }

  async stop(): Promise<void> {
    return this.controller.stop();
  }

  async alarm(): Promise<void> {
    return this.controller.onAlarm();
  }
}
