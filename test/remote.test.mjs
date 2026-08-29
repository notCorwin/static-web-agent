import assert from "node:assert/strict";
import test from "node:test";
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
