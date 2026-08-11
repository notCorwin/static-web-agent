import test from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  CapabilityManager,
  MemoryStateStore,
  OpenAICompatibleAdapter,
  PluginManager,
  PrefixedStateStore,
  ToolRegistry,
  validate,
} from "../dist/index.js";

const noSignal = () => new AbortController().signal;

function scriptedAdapter(turns) {
  let index = 0;
  return {
    id: "scripted",
    async *stream(request) {
      const events = turns[Math.min(index++, turns.length - 1)] ?? [];
      for (const event of events) {
        if (request.signal.aborted) {
          const error = new Error("Operation cancelled.");
          error.name = "AbortError";
          throw error;
        }
        yield event;
      }
    },
  };
}

test("JSON schema validation rejects malformed and extra tool input", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string", minLength: 2 } },
    required: ["query"],
    additionalProperties: false,
  };
  assert.equal(validate(schema, { query: "ok" }).valid, true);
  assert.equal(validate(schema, { query: "" }).valid, false);
  assert.equal(validate(schema, { query: "ok", extra: true }).valid, false);
  assert.equal(validate(schema, undefined).valid, false);
});

test("capabilities require an explicit provider and permission grant", async () => {
  const denied = new CapabilityManager({ decide: () => false });
  denied.register("secret", { provide: () => ({ value: 42 }) });
  await assert.rejects(
    denied.request("example", [{ name: "secret", reason: "test" }]),
    (error) => error.code === "CAPABILITY_DENIED",
  );
  await assert.rejects(denied.get("example", "secret"), (error) => error.code === "CAPABILITY_DENIED");

  const allowed = new CapabilityManager({ decide: () => true });
  allowed.register("secret", { provide: () => ({ value: 42 }) });
  await allowed.request("example", [{ name: "secret", reason: "test" }]);
  const scope = allowed.scope("example", ["secret"]);
  assert.deepEqual(await scope.get("secret"), { value: 42 });
  await assert.rejects(scope.get("other"), (error) => error.code === "CAPABILITY_DENIED");
});

test("tool registry validates arguments, enforces permission, and returns structured errors", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  capabilities.register("clock", { provide: () => ({ now: 7 }) });
  const registry = new ToolRegistry(capabilities);
  const unregister = registry.register({
    name: "test.clock",
    description: "Return a test clock.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredCapabilities: ["clock"],
    execute: async (_, context) => ({ value: (await context.getCapability("clock")).now }),
  }, "test-plugin");

  const denied = await registry.execute("test.clock", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "CAPABILITY_DENIED");

  await capabilities.request("test-plugin", [{ name: "clock", reason: "test" }]);
  const result = await registry.execute("test.clock", {});
  assert.deepEqual(result, { ok: true, value: { value: 7 } });
  const invalid = await registry.execute("test.clock", { extra: 1 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_TOOL_INPUT");

  unregister();
  assert.equal(registry.get("test.clock"), undefined);
});

test("agent loops through multiple tool calls and normalizes tool errors", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  tools.register({
    name: "test.add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"],
      additionalProperties: false,
    },
    execute: (input) => ({ total: input.left + input.right }),
  }, "core");
  const model = scriptedAdapter([
    [{
      type: "completed",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "test.add", arguments: { left: 2, right: 3 } },
          { id: "missing", name: "test.missing", arguments: {} },
        ],
      },
    }],
    [{ type: "text-delta", delta: "The sum is five." }, { type: "completed", message: { role: "assistant", content: "The sum is five." } }],
  ]);
  const events = [];
  const result = await new Agent(model, tools).run({
    messages: [{ role: "user", content: "Calculate." }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 2);
  assert.equal(result.response.content, "The sum is five.");
  assert.equal(result.messages.filter((message) => message.role === "tool").length, 2);
  assert.equal(events.filter((event) => event.type === "tool-started").length, 2);
  assert.ok(result.messages.some((message) => message.role === "tool" && message.isError === true));
});

test("agent termination is deterministic at max turns", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  tools.register({
    name: "test.loop",
    description: "Keep looping.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ ok: true }),
  });
  const model = scriptedAdapter([[{ type: "completed", message: { role: "assistant", content: "loop", toolCalls: [{ id: "x", name: "test.loop", arguments: {} }] } }]]);
  const result = await new Agent(model, tools).run({ messages: [{ role: "user", content: "loop" }], maxTurns: 2 });
  assert.equal(result.status, "max-turns");
  assert.equal(result.turns, 2);
});

test("agent cancellation returns a cancellable result", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = scriptedAdapter([[{ type: "completed", message: { role: "assistant", content: "never" } }]]);
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({ messages: [], signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "ABORTED");
});

test("agent reports model timeouts", async () => {
  const model = {
    id: "hanging",
    async *stream() {
      await new Promise(() => {});
    },
  };
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({ messages: [], modelTimeoutMs: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_TIMEOUT");
});

test("plugin lifecycle is scoped and unregisters its contributions", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  const plugins = new PluginManager(tools, capabilities);
  let teardown = false;
  const handle = await plugins.install({
    manifest: { apiVersion: "1", id: "test-plugin", name: "Test", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerTool({
        name: "test.owned",
        description: "Owned by the test plugin.",
        inputSchema: { type: "object", additionalProperties: false },
        execute: () => ({ done: true }),
      });
    },
    teardown() {
      teardown = true;
    },
  });
  assert.equal(tools.descriptors().length, 1);
  assert.equal(plugins.isInstalled("test-plugin"), true);
  await handle.uninstall();
  await handle.uninstall();
  assert.equal(teardown, true);
  assert.equal(plugins.isInstalled("test-plugin"), false);
  assert.equal(tools.descriptors().length, 0);
});

test("state store persists cloned values and isolates prefixes", async () => {
  const state = new MemoryStateStore();
  const scoped = new PrefixedStateStore(state, "plugin-a");
  const value = { nested: { count: 1 } };
  await scoped.set("item", value);
  value.nested.count = 9;
  const loaded = await scoped.get("item");
  assert.deepEqual(loaded, { nested: { count: 1 } });
  assert.deepEqual(await scoped.keys(), ["item"]);
  assert.deepEqual(await state.keys(), ["plugin-a:item"]);
  await scoped.clear();
  assert.deepEqual(await state.keys(), []);
});

test("OpenAI-compatible adapter normalizes a provider response", async () => {
  let requestBody;
  const adapter = new OpenAICompatibleAdapter({
    endpoint: "https://example.test/chat",
    model: "demo",
    apiKey: "secret",
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }], usage: { total_tokens: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) events.push(event);
  assert.equal(events.at(-1).type, "completed");
  assert.equal(events.at(-1).message.content, "hello");
  assert.equal(events.at(-1).usage.totalTokens, 3);
  assert.equal(requestBody.model, "demo");
  assert.equal(requestBody.messages[0].role, "user");
});
