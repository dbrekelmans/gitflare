import type { ModelAttribution } from "@gitflare/core";
import { type GenerateRequest, ModelError, type ModelStreamEvent } from "@gitflare/core/ports";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BilledModelError, createGatewayModels } from "./gateway";
import { StubAi } from "./stub-ai";

const attribution: ModelAttribution = {
  agent: "review",
  userId: "usr_1",
  changeId: "chg_1",
};

const Finding = z.object({ title: z.string(), severity: z.enum(["low", "high"]) });

function setup() {
  const ai = new StubAi();
  const models = createGatewayModels(ai, { gatewayId: "gitflare", logRetryDelayMs: 1 });
  return { ai, models };
}

function request<T = undefined>(overrides: Partial<GenerateRequest<T>> = {}): GenerateRequest<T> {
  return {
    model: "anthropic/claude-sonnet-5",
    system: "You review code.",
    messages: [{ role: "user", content: "Review this." }],
    maxOutputTokens: 800,
    attribution,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ModelError)) throw new Error(`expected a ModelError, got ${error}`);
  return error;
}

async function collect<T>(events: AsyncIterable<ModelStreamEvent<T>>) {
  const all: ModelStreamEvent<T>[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("the request", () => {
  it("is the Anthropic body, with the cache skipped and the attribution as metadata", async () => {
    const { ai, models } = setup();
    ai.message("Looks fine.");

    await models.generate(
      request({
        messages: [
          { role: "user", content: "Review this." },
          { role: "assistant", content: "Which part?" },
          { role: "user", content: "All of it." },
        ],
      }),
    );

    expect(ai.calls).toEqual([
      {
        model: "anthropic/claude-sonnet-5",
        inputs: {
          max_tokens: 800,
          system: "You review code.",
          messages: [
            { role: "user", content: "Review this." },
            { role: "assistant", content: "Which part?" },
            { role: "user", content: "All of it." },
          ],
        },
        options: {
          gateway: {
            id: "gitflare",
            skipCache: true,
            metadata: { agent: "review", userId: "usr_1", changeId: "chg_1" },
          },
        },
      },
    ]);
  });

  it("asks for structured output in a string system prompt, never with a tool choice", async () => {
    const { ai, models } = setup();
    ai.message('{"title":"Unbounded retry","severity":"high"}');

    await models.generate(request({ output: { name: "finding", schema: Finding } }));

    const inputs = ai.calls[0]?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(["max_tokens", "messages", "system"]);
    expect(inputs.system).toBeTypeOf("string");
    expect(inputs.system).toMatch(/^You review code\./);
    expect(inputs.system).toContain('"severity"');
    expect(inputs.system).toContain('"enum":["low","high"]');
  });

  it("has no system when there is nothing to say in one", async () => {
    const { ai, models } = setup();
    ai.message("Hello.");

    await models.generate(request({ system: undefined }));

    expect(ai.calls[0]?.inputs).not.toHaveProperty("system");
  });

  it("sends only string metadata, at most the five attribution keys", async () => {
    const { ai, models } = setup();
    ai.message("ok");
    const loose = {
      agent: "thread",
      userId: "usr_1",
      repositoryId: undefined,
      changeId: null,
      sessionId: "ses_1",
      extra: "dropped",
    } as unknown as ModelAttribution;

    await models.generate(request({ attribution: loose }));

    expect(ai.calls[0]?.options).toEqual({
      gateway: {
        id: "gitflare",
        skipCache: true,
        metadata: { agent: "thread", userId: "usr_1", sessionId: "ses_1" },
      },
    });
  });

  it.each([
    ["an object value", { agent: "review", userId: { id: "usr_1" } }],
    ["a number value", { agent: "review", changeId: 12 }],
    ["an empty value", { agent: "review", sessionId: "" }],
    ["an unknown agent", { agent: "someone" }],
    ["no agent", {}],
  ])("refuses %s in the attribution before calling the gateway", async (_name, bad) => {
    const { ai, models } = setup();
    const broken = bad as unknown as ModelAttribution;

    await expect(models.generate(request({ attribution: broken }))).rejects.toThrow(TypeError);
    await expect(collect(models.stream(request({ attribution: broken })))).rejects.toThrow(
      TypeError,
    );
    await expect(
      models.embed({ model: "@cf/baai/bge-m3", texts: ["a"], attribution: broken }),
    ).rejects.toThrow(TypeError);
    expect(ai.calls).toEqual([]);
  });
});

describe("the reply", () => {
  it("is the text, the model asked for, the usage and the log id", async () => {
    const { ai, models } = setup();
    ai.message("Looks fine.", {
      logId: "log_1",
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 50,
      },
    });
    ai.logs.set("log_1", { cost: 0.00054 });

    const result = await models.generate(request());

    expect(result).toEqual({
      output: undefined,
      text: "Looks fine.",
      model: "anthropic/claude-sonnet-5",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50 },
      costMicroUsd: 540,
      gatewayLogId: "log_1",
    });
  });

  it("joins text blocks and ignores the others", async () => {
    const { ai, models } = setup();
    ai.returns({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: "One. " },
        { type: "text", text: "Two." },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    expect((await models.generate(request())).text).toBe("One. Two.");
  });

  it("is unavailable when it is not an Anthropic message", async () => {
    const { ai, models } = setup();
    ai.returns({ response: "something else" });

    expect((await failure(models.generate(request()))).code).toBe("unavailable");
  });

  it.each([
    ["on its own", '{"title":"Unbounded retry","severity":"high"}'],
    ["in a code fence", 'Here it is:\n```json\n{"title":"Unbounded retry","severity":"high"}\n```'],
    ["after a sentence", 'The finding: {"title":"Unbounded retry","severity":"high"}'],
  ])("is validated against the schema when the JSON is %s", async (_name, text) => {
    const { ai, models } = setup();
    ai.message(text);

    const result = await models.generate(request({ output: { name: "finding", schema: Finding } }));

    expect(result.output).toEqual({ title: "Unbounded retry", severity: "high" });
    expect(result.text).toBe(text);
  });

  it.each([
    ["does not match the schema", '{"title":"Unbounded retry","severity":"urgent"}', "end_turn"],
    ["is not JSON", "I could not find anything.", "end_turn"],
    ["was cut off", '{"title":"Unbounded re', "max_tokens"],
  ])("is invalid_output when it %s, and still billed", async (_name, text, stop_reason) => {
    const { ai, models } = setup();
    ai.message(text, { stop_reason, logId: "log_1", usage: { input_tokens: 9, output_tokens: 4 } });
    ai.logs.set("log_1", { cost: 0.000058 });

    const error = await failure(
      models.generate(request({ output: { name: "finding", schema: Finding } })),
    );

    expect(error.code).toBe("invalid_output");
    expect(error).toBeInstanceOf(BilledModelError);
    expect((error as BilledModelError).call).toEqual({
      model: "anthropic/claude-sonnet-5",
      usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicroUsd: 58,
      gatewayLogId: "log_1",
    });
  });
});

describe("errors", () => {
  it.each([
    ["2021: Insufficient AI Gateway credits", "no_credits"],
    [
      "2045: Spend limit exceeded: rule 'monthly' (cost limit 200 per 2592000s, fixed) for anthropic claude-sonnet-5",
      "budget_exceeded",
    ],
    ["2003: Rate limited", "rate_limited"],
    ["7003: User Input Error", "unavailable"],
    ["Network connection lost.", "unavailable"],
    // A code that is not at the start of the message says nothing about the failure.
    ["upstream said: 2045: Spend limit exceeded", "unavailable"],
  ])("%s is %s", async (message, code) => {
    const { ai, models } = setup();
    ai.throws(message).throws(message).throws(message);

    const errors = [
      await failure(models.generate(request())),
      await failure(collect(models.stream(request()))),
      await failure(models.embed({ model: "@cf/baai/bge-m3", texts: ["a decision"], attribution })),
    ];

    expect(errors.map((error) => error.code)).toEqual([code, code, code]);
    expect(errors[0]?.message).toBe(message);
  });
});

describe("cost", () => {
  it("reads the log a second time when the first read has no cost", async () => {
    const { ai, models } = setup();
    ai.message("ok", { logId: "log_late" });
    ai.onLogRead = (logId) => ai.logs.set(logId, { cost: 0.0012 });

    const result = await models.generate(request());

    expect(ai.logReads).toEqual(["log_late", "log_late"]);
    expect(result.costMicroUsd).toBe(1200);
  });

  it("is estimated from the token counts when the log never has one", async () => {
    const { ai, models } = setup();
    ai.message("ok", {
      logId: "log_missing",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 100,
      },
    });

    const result = await models.generate(request());

    // claude-sonnet-5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per million tokens.
    expect(result.costMicroUsd).toBe(1000 * 2 + 200 * 10 + 5000 * 0.2 + 100 * 2.5);
    expect(ai.logReads).toHaveLength(2);
  });

  it("is zero for a model with no known price and no log", async () => {
    const { ai, models } = setup();
    ai.message("ok");

    const result = await models.generate(request({ model: "anthropic/claude-unknown" }));

    expect(result.costMicroUsd).toBe(0);
    expect(result.gatewayLogId).toBeNull();
    expect(ai.logReads).toEqual([]);
  });
});

describe("stream", () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":7}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looks "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fine."}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  it("asks for a stream and yields the text, then the result", async () => {
    const { ai, models } = setup();
    // Chunk boundaries fall anywhere, inside a line included.
    const chunks = events.match(/[\s\S]{1,37}/g) ?? [];
    ai.sse(chunks, "log_s");
    ai.logs.set("log_s", { cost: 0.00017 });

    const all = await collect(models.stream(request()));

    expect(ai.calls[0]?.inputs).toMatchObject({ stream: true, max_tokens: 800 });
    expect(ai.calls[0]?.options).toMatchObject({ gateway: { skipCache: true } });
    expect(all).toEqual([
      { type: "text", text: "Looks " },
      { type: "text", text: "fine." },
      {
        type: "done",
        result: {
          output: undefined,
          text: "Looks fine.",
          model: "anthropic/claude-sonnet-5",
          usage: { inputTokens: 25, outputTokens: 12, cacheReadTokens: 7, cacheWriteTokens: 0 },
          costMicroUsd: 170,
          gatewayLogId: "log_s",
        },
      },
    ]);
  });

  it("validates structured output once the stream has ended", async () => {
    const { ai, models } = setup();
    const delta = (text: string) =>
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`;
    const start = 'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n';
    ai.sse([start, delta('{"title":"Unbounded retry",'), delta('"severity":"high"}')]);
    ai.sse([start, delta('{"title":"Unbounded retry"}')]);
    const structured = request({ output: { name: "finding", schema: Finding } });

    const done = (await collect(models.stream(structured))).at(-1);
    expect(done).toMatchObject({
      type: "done",
      result: { output: { title: "Unbounded retry", severity: "high" } },
    });
    expect((await failure(collect(models.stream(structured)))).code).toBe("invalid_output");
  });

  it("fails with the error an event carries", async () => {
    const { ai, models } = setup();
    const start = 'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n';
    ai.sse([
      start,
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);
    ai.sse([
      start,
      'data: {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}\n\n',
    ]);

    expect((await failure(collect(models.stream(request())))).code).toBe("unavailable");
    expect((await failure(collect(models.stream(request())))).code).toBe("rate_limited");
  });

  it("is unavailable when the stream carries no message", async () => {
    const { ai, models } = setup();
    ai.sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);

    expect((await failure(collect(models.stream(request())))).code).toBe("unavailable");
  });
});

describe("embed", () => {
  it("sends the texts and returns one vector for each", async () => {
    const { ai, models } = setup();
    ai.returns(
      {
        data: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        shape: [2, 2],
        pooling: "cls",
      },
      "log_e",
    );
    ai.logs.set("log_e", { cost: 0.0000042 });

    const result = await models.embed({
      model: "@cf/baai/bge-m3",
      texts: ["use hairlines", "one accent"],
      attribution: { agent: "decisions", repositoryId: "rep_1" },
    });

    expect(ai.calls).toEqual([
      {
        model: "@cf/baai/bge-m3",
        inputs: { text: ["use hairlines", "one accent"] },
        options: {
          gateway: {
            id: "gitflare",
            skipCache: true,
            metadata: { agent: "decisions", repositoryId: "rep_1" },
          },
        },
      },
    ]);
    expect(result).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: "@cf/baai/bge-m3",
      costMicroUsd: 4,
    });
  });

  it("is unavailable when a vector is missing", async () => {
    const { ai, models } = setup();
    ai.returns({ data: [[0.1, 0.2]] }).returns({ request_id: "async" });
    const twoTexts = { model: "@cf/baai/bge-m3", texts: ["a", "b"], attribution };

    expect((await failure(models.embed(twoTexts))).code).toBe("unavailable");
    expect((await failure(models.embed(twoTexts))).code).toBe("unavailable");
  });

  it("does not call the gateway for no texts", async () => {
    const { ai, models } = setup();

    const result = await models.embed({ model: "@cf/baai/bge-m3", texts: [], attribution });

    expect(result.vectors).toEqual([]);
    expect(ai.calls).toEqual([]);
  });
});
