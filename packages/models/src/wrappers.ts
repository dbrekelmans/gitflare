import type { ModelAttribution, OrganisationSettings } from "@gitflare/core";
import {
  type Clock,
  type IdGenerator,
  ModelError,
  type ModelErrorCode,
  type ModelGateway,
} from "@gitflare/core/ports";
import { changeCost, type Db, fromModelCall, schema } from "@gitflare/db";
import { type BilledCall, BilledModelError, reportBilled, withBillingSink } from "./gateway";

const fallbackCodes: ReadonlySet<ModelErrorCode> = new Set([
  "budget_exceeded",
  "rate_limited",
  "unavailable",
]);

function canFallBack(error: unknown): boolean {
  return error instanceof ModelError && fallbackCodes.has(error.code);
}

/** A failure that is answered by the next model would take its bill with it: report that first. */
async function passOver(request: object, error: unknown): Promise<void> {
  if (error instanceof BilledModelError) await reportBilled(request, error.call);
}

/**
 * Tries each fallback model in turn when a call fails with `budget_exceeded`,
 * `rate_limited` or `unavailable`. Never on `no_credits`: no other model of
 * the provider would be served either. The result's `model` says which answered.
 *
 * When no model answers, the error is the requested model's. A stream falls
 * back only while it has produced nothing. Embeddings never fall back: another
 * model's vectors cannot be compared with the ones already stored. A failure
 * that was paid for and is then answered by a fallback is reported to the
 * request's billing sink, so it is still recorded.
 */
export function withFallback(gateway: ModelGateway, fallbacks: string[]): ModelGateway {
  const candidates = (model: string) => [
    model,
    ...fallbacks.filter((fallback) => fallback !== model),
  ];
  return {
    async generate(request) {
      let first: unknown;
      for (const model of candidates(request.model)) {
        try {
          return await gateway.generate({ ...request, model });
        } catch (error) {
          if (!canFallBack(error)) throw error;
          first ??= error;
          await passOver(request, error);
        }
      }
      throw first;
    },

    async *stream(request) {
      let first: unknown;
      for (const model of candidates(request.model)) {
        let started = false;
        try {
          for await (const event of gateway.stream({ ...request, model })) {
            started = true;
            yield event;
          }
          return;
        } catch (error) {
          if (started || !canFallBack(error)) throw error;
          first ??= error;
          await passOver(request, error);
        }
      }
      throw first;
    },

    embed: (request) => gateway.embed(request),
  };
}

/**
 * Records every call in `model_calls`, with its attribution, usage and
 * estimated cost. A call that failed before a model answered cost nothing and
 * is not recorded. Every call a model answered is: one whose reply did not
 * validate, a stream cut off or left part-way, and a failure a fallback then
 * answered, which the inner gateway reports to the billing sink this attaches.
 *
 * A row that cannot be written is logged and the caller still gets its reply:
 * it was paid for, and failing the call would only make the caller pay again.
 */
export function withAccounting(
  gateway: ModelGateway,
  deps: { db: Db; clock: Clock; ids: IdGenerator },
): ModelGateway {
  const { db, clock, ids } = deps;
  // A failure reported to the sink can still be thrown afterwards, when no
  // fallback answered either: it is recorded once.
  const recorded = new WeakSet<BilledCall>();

  const record = async (
    attribution: ModelAttribution,
    requestedModel: string,
    call: BilledCall,
  ) => {
    if (recorded.has(call)) return;
    recorded.add(call);
    const { model, usage, costMicroUsd, gatewayLogId } = call;
    try {
      await db.insert(schema.modelCalls).values(
        fromModelCall({
          id: ids.next("modelCall"),
          attribution,
          model,
          requestedModel,
          gatewayLogId,
          usage,
          costMicroUsd,
          createdAt: clock.now(),
        }),
      );
    } catch (error) {
      console.error(
        `@gitflare/models: could not record a ${model} call (gateway log ${gatewayLogId ?? "none"}, ${costMicroUsd} micro-dollars, change ${attribution.changeId ?? "none"})`,
        error,
      );
    }
  };

  const recordFailure = async (
    attribution: ModelAttribution,
    requestedModel: string,
    error: unknown,
  ) => {
    if (error instanceof BilledModelError) await record(attribution, requestedModel, error.call);
  };

  const sinking = <R extends { attribution: ModelAttribution; model: string }>(request: R) =>
    withBillingSink(request, (call) => record(request.attribution, request.model, call));

  return {
    async generate(request) {
      const result = await gateway.generate(sinking(request)).catch(async (error: unknown) => {
        await recordFailure(request.attribution, request.model, error);
        throw error;
      });
      await record(request.attribution, request.model, result);
      return result;
    },

    async *stream(request) {
      try {
        for await (const event of gateway.stream(sinking(request))) {
          if (event.type === "done") {
            await record(request.attribution, request.model, event.result);
          }
          yield event;
        }
      } catch (error) {
        await recordFailure(request.attribution, request.model, error);
        throw error;
      }
    },

    async embed(request) {
      const result = await gateway.embed(request).catch(async (error: unknown) => {
        await recordFailure(request.attribution, request.model, error);
        throw error;
      });
      await record(request.attribution, request.model, result);
      return result;
    },
  };
}

/**
 * Refuses a call attributed to a change whose recorded spend has reached the
 * per-change budget, with `budget_exceeded`. The gateway's own spend limits
 * are windows of time and cannot express a budget per change.
 */
export function withChangeBudget(
  gateway: ModelGateway,
  deps: { db: Db },
  settings: Pick<OrganisationSettings, "perChangeBudgetMicroUsd">,
): ModelGateway {
  const check = async ({ changeId }: ModelAttribution) => {
    if (!changeId) return;
    const { totalMicroUsd } = await changeCost(deps.db, changeId);
    if (totalMicroUsd >= settings.perChangeBudgetMicroUsd) {
      throw new ModelError(
        "budget_exceeded",
        `change ${changeId} has spent its budget: ${totalMicroUsd} of ${settings.perChangeBudgetMicroUsd} micro-dollars`,
      );
    }
  };

  return {
    async generate(request) {
      await check(request.attribution);
      return gateway.generate(request);
    },
    async *stream(request) {
      await check(request.attribution);
      yield* gateway.stream(request);
    },
    async embed(request) {
      await check(request.attribution);
      return gateway.embed(request);
    },
  };
}

/**
 * The gateway as the rest of the forge uses it: budget check, fallback and
 * accounting, in that order. The budget check is outermost, so a change over
 * its budget reaches no model at all; accounting wraps fallback, so one row
 * holds both the model asked for and the one that answered.
 */
export function composeModels(
  gateway: ModelGateway,
  deps: { db: Db; clock: Clock; ids: IdGenerator },
  settings: OrganisationSettings,
): ModelGateway {
  const answering = withFallback(gateway, settings.models.fallbacks);
  return withChangeBudget(withAccounting(answering, deps), deps, settings);
}

/** Cosine similarity of two vectors of the same length. Zero when either has no length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity: ${a.length} dimensions against ${b.length}`);
  }
  let dot = 0;
  let aSquared = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aSquared += x * x;
    bSquared += y * y;
  }
  const length = Math.sqrt(aSquared * bSquared);
  return length === 0 ? 0 : dot / length;
}
