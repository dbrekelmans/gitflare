import { defaultOrganisationSettings, type ModelAttribution } from "@gitflare/core";
import { type GenerateRequest, ModelError, type ModelStreamEvent } from "@gitflare/core/ports";
import { changeCost, schema, toModelCall } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { FakeModelGateway, ManualClock, SequentialIds } from "@gitflare/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGatewayModels } from "./gateway";
import { StubAi } from "./stub-ai";
import {
  composeModels,
  cosineSimilarity,
  withAccounting,
  withChangeBudget,
  withFallback,
} from "./wrappers";

const primary = "anthropic/claude-sonnet-5";
const fallback = "anthropic/claude-haiku-4.5";

const attribution: ModelAttribution = {
  agent: "review",
  userId: "usr_1",
  repositoryId: "rep_1",
  changeId: "chg_1",
};

function request(overrides: Partial<GenerateRequest<undefined>> = {}): GenerateRequest<undefined> {
  return {
    model: primary,
    messages: [{ role: "user", content: "Review this change, please." }],
    maxOutputTokens: 500,
    attribution,
    ...overrides,
  };
}

function setup() {
  const db = createTestDb();
  const clock = new ManualClock();
  const ids = new SequentialIds();
  const inner = new FakeModelGateway();
  const recorded = async () => (await db.select().from(schema.modelCalls)).map(toModelCall);
  return { db, clock, ids, inner, deps: { db, clock, ids }, recorded };
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ModelError)) throw new Error(`expected a ModelError, got ${error}`);
  return error.code;
}

async function collect<T>(events: AsyncIterable<ModelStreamEvent<T>>) {
  const all: ModelStreamEvent<T>[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("withFallback", () => {
  it.each(["budget_exceeded", "rate_limited", "unavailable"] as const)(
    "answers from the next model on %s",
    async (code) => {
      const { inner } = setup();
      inner.fail(primary, code).reply("review", { text: "From the fallback." });

      const result = await withFallback(inner, [fallback]).generate(request());

      expect(result.model).toBe(fallback);
      expect(result.text).toBe("From the fallback.");
      expect(inner.calls.map((call) => call.model)).toEqual([primary, fallback]);
    },
  );

  it.each(["no_credits", "invalid_output"] as const)("never falls back on %s", async (code) => {
    const { inner } = setup();
    inner.fail(primary, code).reply("review", { text: "From the fallback." });
    const models = withFallback(inner, [fallback]);

    expect(await codeOf(models.generate(request()))).toBe(code);
    expect(await codeOf(collect(models.stream(request())))).toBe(code);
    expect(inner.calls.map((call) => call.model)).toEqual([primary, primary]);
  });

  it("stops at no_credits part-way down the list", async () => {
    const { inner } = setup();
    inner.fail(primary, "budget_exceeded").fail(fallback, "no_credits");

    const models = withFallback(inner, [fallback, "anthropic/claude-opus-5.5"]);

    expect(await codeOf(models.generate(request()))).toBe("no_credits");
    expect(inner.calls.map((call) => call.model)).toEqual([primary, fallback]);
  });

  it("fails with the requested model's error when no model answers", async () => {
    const { inner } = setup();
    inner.fail(primary, "budget_exceeded").fail(fallback, "unavailable");

    // The requested model is not tried twice for being in the list as well.
    const models = withFallback(inner, [primary, fallback]);

    expect(await codeOf(models.generate(request()))).toBe("budget_exceeded");
    expect(inner.calls.map((call) => call.model)).toEqual([primary, fallback]);
  });

  it("does not call a fallback when the requested model answers", async () => {
    const { inner } = setup();
    inner.reply("review", { text: "From the first." });

    const result = await withFallback(inner, [fallback]).generate(request());

    expect(result.model).toBe(primary);
    expect(inner.calls).toHaveLength(1);
  });

  it("falls back for a stream that has produced nothing", async () => {
    const { inner } = setup();
    inner.fail(primary, "budget_exceeded").reply("review", { text: "Streamed reply." });

    const events = await collect(withFallback(inner, [fallback]).stream(request()));

    expect(events.at(-1)).toMatchObject({ type: "done", result: { model: fallback } });
    expect(events.filter((event) => event.type === "text")).toHaveLength(2);
  });

  it("does not fall back once a stream has produced text", async () => {
    const { inner } = setup();
    const broken = {
      ...inner,
      generate: inner.generate.bind(inner),
      embed: inner.embed.bind(inner),
      async *stream(streamed: GenerateRequest<unknown>) {
        inner.calls.push(streamed);
        yield { type: "text" as const, text: "Half a " };
        throw new ModelError("unavailable", "connection lost");
      },
    };

    const events: unknown[] = [];
    const reading = (async () => {
      for await (const event of withFallback(broken as never, [fallback]).stream(request())) {
        events.push(event);
      }
    })();

    expect(await codeOf(reading)).toBe("unavailable");
    expect(events).toEqual([{ type: "text", text: "Half a " }]);
    expect(inner.calls.map((call) => call.model)).toEqual([primary]);
  });

  it("leaves embeddings on the model asked for", async () => {
    const { inner } = setup();

    const result = await withFallback(inner, [fallback]).embed({
      model: "@cf/baai/bge-m3",
      texts: ["a decision"],
      attribution,
    });

    expect(result.model).toBe("@cf/baai/bge-m3");
    expect(inner.embedCalls).toHaveLength(1);
  });
});

describe("withAccounting", () => {
  it("records a call with its attribution, usage and cost", async () => {
    const { inner, deps, clock, recorded } = setup();
    inner.reply("review", { text: "Looks fine." });

    const result = await withAccounting(inner, deps).generate(request());

    expect(await recorded()).toEqual([
      {
        id: "mdl_000001",
        attribution,
        model: primary,
        requestedModel: primary,
        gatewayLogId: result.gatewayLogId,
        usage: result.usage,
        costMicroUsd: result.costMicroUsd,
        createdAt: clock.now(),
      },
    ]);
    expect(result.costMicroUsd).toBeGreaterThan(0);
  });

  it("records a stream once, when it is done", async () => {
    const { inner, deps, recorded } = setup();
    inner.reply("thread", { text: "A streamed reply." });
    const stream = withAccounting(inner, deps).stream(
      request({ attribution: { agent: "thread", changeId: "chg_1" } }),
    );

    const events = [];
    for await (const event of stream) {
      if (event.type === "text") expect(await recorded()).toEqual([]);
      events.push(event);
    }

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(await recorded()).toMatchObject([
      {
        attribution: { agent: "thread", changeId: "chg_1" },
        costMicroUsd: done?.type === "done" ? done.result.costMicroUsd : -1,
      },
    ]);
  });

  it("records an embedding call by its cost", async () => {
    const { inner, deps, recorded } = setup();

    const result = await withAccounting(inner, deps).embed({
      model: "@cf/baai/bge-m3",
      texts: ["use hairlines, not boxes"],
      attribution: { agent: "decisions", repositoryId: "rep_1" },
    });

    expect(await recorded()).toMatchObject([
      {
        attribution: { agent: "decisions", repositoryId: "rep_1" },
        model: "@cf/baai/bge-m3",
        requestedModel: "@cf/baai/bge-m3",
        costMicroUsd: result.costMicroUsd,
      },
    ]);
  });

  it("records nothing for a call no model answered", async () => {
    const { inner, deps, recorded } = setup();
    inner.fail(primary, "no_credits");
    const models = withAccounting(inner, deps);

    expect(await codeOf(models.generate(request()))).toBe("no_credits");
    expect(await codeOf(collect(models.stream(request())))).toBe("no_credits");
    expect(await recorded()).toEqual([]);
  });

  it("records a reply that did not validate, because it was paid for", async () => {
    const { deps, recorded } = setup();
    const ai = new StubAi();
    const usage = { input_tokens: 40, output_tokens: 8 };
    ai.message("Not JSON at all.", { logId: "log_1", usage });
    ai.sse(
      [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":40}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Nor this."}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n\n',
      ],
      "log_2",
    );
    ai.logs.set("log_1", { cost: 0.00016 }).set("log_2", { cost: 0.00016 });
    const models = withAccounting(createGatewayModels(ai, { gatewayId: "gitflare" }), deps);
    const structured = {
      ...request(),
      output: { name: "verdict", schema: z.object({ ok: z.boolean() }) },
    };

    expect(await codeOf(models.generate(structured))).toBe("invalid_output");
    expect(await codeOf(collect(models.stream(structured)))).toBe("invalid_output");

    expect(await recorded()).toMatchObject([
      { gatewayLogId: "log_1", costMicroUsd: 160, usage: { inputTokens: 40, outputTokens: 8 } },
      { gatewayLogId: "log_2", costMicroUsd: 160, usage: { inputTokens: 40, outputTokens: 8 } },
    ]);
    expect((await changeCost(deps.db, "chg_1")).totalMicroUsd).toBe(320);
  });
});

describe("withChangeBudget", () => {
  /** Spends on `chg_1` through the accounting wrapper and returns what it came to. */
  async function spend(context: ReturnType<typeof setup>) {
    context.inner.reply("review", { text: "A first review, which costs something." });
    await withAccounting(context.inner, context.deps).generate(request());
    return (await changeCost(context.db, "chg_1")).totalMicroUsd;
  }

  it("refuses a change that has reached its budget before the gateway is called", async () => {
    const context = setup();
    const spent = await spend(context);
    const { inner, deps } = context;
    const before = inner.calls.length;
    const models = withChangeBudget(inner, deps, { perChangeBudgetMicroUsd: spent });

    expect(await codeOf(models.generate(request()))).toBe("budget_exceeded");
    expect(await codeOf(collect(models.stream(request())))).toBe("budget_exceeded");
    expect(
      await codeOf(models.embed({ model: "@cf/baai/bge-m3", texts: ["a"], attribution })),
    ).toBe("budget_exceeded");
    expect(inner.calls).toHaveLength(before);
    expect(inner.embedCalls).toEqual([]);
  });

  it("lets a change under its budget through", async () => {
    const context = setup();
    const spent = await spend(context);
    context.inner.reply("review", { text: "A second review." });
    const models = withChangeBudget(context.inner, context.deps, {
      perChangeBudgetMicroUsd: spent + 1,
    });

    expect((await models.generate(request())).text).toBe("A second review.");
  });

  it("counts each change on its own, and leaves calls for no change alone", async () => {
    const context = setup();
    const spent = await spend(context);
    const { inner, deps } = context;
    inner.reply("review", { text: "Another change." }).reply("decisions", { text: "No change." });
    const models = withChangeBudget(inner, deps, { perChangeBudgetMicroUsd: spent });

    const other = await models.generate(
      request({ attribution: { agent: "review", changeId: "chg_2" } }),
    );
    const none = await models.generate(request({ attribution: { agent: "decisions" } }));

    expect([other.text, none.text]).toEqual(["Another change.", "No change."]);
  });
});

describe("composeModels", () => {
  const settings = {
    ...defaultOrganisationSettings,
    models: { ...defaultOrganisationSettings.models, fallbacks: [fallback] },
  };

  it("records a fallback as the model asked for and the model that answered", async () => {
    const { inner, deps, recorded } = setup();
    inner.fail(primary, "budget_exceeded").reply("review", { text: "From the fallback." });

    const result = await composeModels(inner, deps, settings).generate(request());

    expect(result.model).toBe(fallback);
    expect(await recorded()).toMatchObject([
      { requestedModel: primary, model: fallback, costMicroUsd: result.costMicroUsd, attribution },
    ]);
  });

  it("records nothing and tries no fallback on no_credits", async () => {
    const { inner, deps, recorded } = setup();
    inner.fail(primary, "no_credits");

    expect(await codeOf(composeModels(inner, deps, settings).generate(request()))).toBe(
      "no_credits",
    );
    expect(inner.calls.map((call) => call.model)).toEqual([primary]);
    expect(await recorded()).toEqual([]);
  });

  it("stops a change at its budget: the call that crosses it is the last", async () => {
    const { inner, deps, recorded } = setup();
    inner.respond(() => ({ text: "A review of some length, so that it costs something." }));
    const models = composeModels(inner, deps, { ...settings, perChangeBudgetMicroUsd: 1 });

    await models.generate(request());

    // Over budget is refused outright: no model is asked, the fallback included.
    expect(await codeOf(models.generate(request()))).toBe("budget_exceeded");
    expect(inner.calls.map((call) => call.model)).toEqual([primary]);
    expect(await recorded()).toHaveLength(1);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for the same direction, 0 for a right angle, -1 for the opposite", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 5])).toBe(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("is 0 when a vector has no length", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("refuses vectors of different lengths", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(RangeError);
  });
});
