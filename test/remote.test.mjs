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
    ["http://example.test/chat/completions", "http://example.test/chat/completions"],
    ["http://example.test/chat/completions?tenant=one", "http://example.test/chat/completions?tenant=one"],
    ["http://example.test/custom/gateway", "http://example.test/custom/gateway"],
  ]) {
    const { request, events } = await requestFor(endpoint);
    assert.equal(request.url, expected);
    assert.deepEqual(events.map((event) => event.type), ["text-delta", "completed"]);
    assert.equal(events.at(-1).message.content, "ok");
  }
});
