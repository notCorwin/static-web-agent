import assert from "node:assert/strict";
import test from "node:test";
import { createHarness } from "../dist/index.js";
import { AiSdkAdapter } from "../dist/remote.js";

function response() {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function requestFor(endpoint) {
  let request;
  const adapter = new AiSdkAdapter({
    endpoint,
    model: "demo",
    fetcher: async (input, init) => {
      request = { url: String(input), init };
      return response();
    },
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools: [], signal: new AbortController().signal })) events.push(event);
  return { request, events };
}

test("the OpenAI-compatible adapter preserves exact completion endpoints", async () => {
  for (const [endpoint, expected] of [
    ["http://example.test/v1", "http://example.test/v1/chat/completions"],
    ["http://example.test/v1?tenant=one", "http://example.test/v1/chat/completions?tenant=one"],
    ["http://example.test/v1?tenant=one&tenant=two&flag", "http://example.test/v1/chat/completions?tenant=one&tenant=two&flag"],
    ["http://example.test/v1/chat/completions", "http://example.test/v1/chat/completions"],
    ["http://example.test/v1/chat/completions/", "http://example.test/v1/chat/completions/"],
    ["http://example.test/v1/chat/completions/#ignored", "http://example.test/v1/chat/completions/"],
    ["http://example.test/chat/completions", "http://example.test/chat/completions"],
    ["http://example.test/chat/completions?tenant=one", "http://example.test/chat/completions?tenant=one"],
    ["http://example.test/custom/gateway", "http://example.test/custom/gateway"],
    ["http://example.test/custom/gateway?tenant=one#ignored", "http://example.test/custom/gateway?tenant=one"],
  ]) {
    const { request, events } = await requestFor(endpoint);
    assert.equal(request.url, expected);
    assert.deepEqual(events.map((event) => event.type), ["text-delta", "completed"]);
    assert.equal(events.at(-1).message.content, "ok");
  }
});

test("the OpenAI-compatible adapter rejects invalid IDs", () => {
  for (const id of [123, "  "]) {
    assert.throws(
      () => new AiSdkAdapter({ id, endpoint: "http://example.test/v1", model: "demo", fetcher: async () => response() }),
      /adapter ID is required/,
    );
  }
});

test("the OpenAI-compatible adapter rejects non-string API keys", () => {
  assert.throws(
    () => new AiSdkAdapter({ endpoint: "http://example.test/v1", model: "demo", apiKey: 123, fetcher: async () => response() }),
    /API key must be a string/,
  );
});

test("an omitted API key cannot be inherited from the prototype chain", async () => {
  const key = "apiKey";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, { configurable: true, value: "polluted-key" });
  let headers;
  try {
    const adapter = new AiSdkAdapter({
      endpoint: "http://example.test/v1",
      model: "demo",
      fetcher: async (_input, init) => {
        headers = Object.fromEntries(new Headers(init?.headers).entries());
        return response();
      },
    });
    for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools: [], signal: new AbortController().signal })) {}
    assert.equal(headers.authorization, undefined);
  } finally {
    if (previous === undefined) delete Object.prototype[key];
    else Object.defineProperty(Object.prototype, key, previous);
  }
});

test("unknown provider tool names are not silently aliased", async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "page", arguments: JSON.stringify({ code: "return 1" }) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ];
  const body = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools: [{ name: "page.run", description: "page", inputSchema: { type: "object" } }], signal: new AbortController().signal })) events.push(event);
  assert.equal(events.at(-1).message.toolCalls[0].name, "page");
});

test("mapped provider tool names stay local in streamed deltas", async () => {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "page_run", arguments: JSON.stringify({ code: "return 1" }) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools: [{ name: "page.run", description: "page", inputSchema: { type: "object" } }], signal: new AbortController().signal })) events.push(event);
  assert.equal(events.find((event) => event.type === "tool-call-delta")?.delta.name, "page.run");
});

test("an unmapped provider name cannot execute a same-named local tool", async () => {
  const toolResponse = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "page.run", arguments: JSON.stringify({ code: "return 1" }) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  let requests = 0;
  let executed = 0;
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async () => {
      requests += 1;
      return requests === 1
        ? new Response(toolResponse, { headers: { "content-type": "text/event-stream" } })
        : response();
    },
  });
  const harness = await createHarness({
    model: adapter,
    pageRuntime: { async execute() { executed += 1; return { value: 1, logs: [], durationMs: 0 }; } },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "completed");
    assert.equal(executed, 0);
    assert.equal(JSON.parse(result.messages[2].content).code, "TOOL_NOT_FOUND");
  } finally {
    await harness.dispose();
  }
});

test("tool names that overlap object properties stay in the provider request", async () => {
  let request;
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async (_input, init) => {
      request = JSON.parse(String(init.body));
      return response();
    },
  });
  const tools = [{ name: "__proto__", description: "proto", inputSchema: { type: "object" } }];
  for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools, signal: new AbortController().signal })) {}
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["__proto__"]);
});

test("duplicate local tool names fail before the provider request", async () => {
  let called = false;
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async () => {
      called = true;
      return response();
    },
  });
  const tools = [
    { name: "same", description: "one", inputSchema: { type: "object" } },
    { name: "same", description: "two", inputSchema: { type: "object" } },
  ];
  await assert.rejects(
    (async () => {
      for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools, signal: new AbortController().signal })) {}
    })(),
    (error) => error?.code === "MODEL_PROTOCOL_ERROR",
  );
  assert.equal(called, false);
});

test("the adapter contains hostile cancellation reasons", async () => {
  const source = new Error("cancel");
  const reason = new Proxy(source, { getPrototypeOf() { throw new Error("blocked prototype"); } });
  const controller = new AbortController();
  controller.abort(reason);
  let called = false;
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async () => {
      called = true;
      return response();
    },
  });
  await assert.rejects(
    (async () => {
      for await (const _event of adapter.stream({ messages: [], tools: [], signal: controller.signal })) {}
    })(),
    (error) => error instanceof Error && error.name === "AbortError" && error.message === "Operation cancelled.",
  );
  assert.equal(called, false);
});

test("the adapter aborts an in-flight provider request through a request-scoped signal", async () => {
  let providerSignal;
  const adapter = new AiSdkAdapter({
    endpoint: "http://example.test/v1",
    model: "demo",
    fetcher: async (_input, init) => {
      providerSignal = init.signal;
      return await new Promise((_, reject) => {
        providerSignal.addEventListener("abort", () => reject(providerSignal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const running = (async () => {
    for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hello" }], tools: [], signal: controller.signal })) {}
  })();
  for (let attempt = 0; providerSignal === undefined && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(providerSignal instanceof AbortSignal);
  assert.notEqual(providerSignal, controller.signal);
  controller.abort();
  await assert.rejects(running);
  assert.equal(providerSignal.aborted, true);
});
