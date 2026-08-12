import test from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  CapabilityManager,
  CHAT_LIMITS,
  CONNECTION_SETTINGS_KEY,
  DEFAULT_THINKING_LEVEL,
  MemoryStateStore,
  AiSdkAdapter,
  PluginManager,
  PrefixedStateStore,
  ResilientStateStore,
  ToolRegistry,
  createBrowserStateStore,
  createRemoteModelPlugin,
  loadConnectionSettings,
  normalizeMessages,
  saveConnectionSettings,
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

function sseResponse(chunks, status = 200) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
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
  allowed.register("secret-method", { provide: () => ({ read: () => 42 }) });
  await allowed.request("example", [{ name: "secret-method", reason: "test" }]);
  const cached = await allowed.get("example", "secret-method");
  allowed.revoke("example", ["secret-method"]);
  assert.throws(() => cached.read(), (error) => error.code === "CAPABILITY_DENIED");
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

test("tool registry does not impose an output-size ceiling", async () => {
  const tools = new ToolRegistry(new CapabilityManager());
  tools.register({
    name: "test.large",
    description: "Return a large value.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ text: "too large" }),
  });
  const result = await tools.execute("test.large", {});
  assert.deepEqual(result, { ok: true, value: { text: "too large" } });
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

test("agent forwards streaming tool-call deltas and reconstructs their arguments", async () => {
  const tools = new ToolRegistry(new CapabilityManager());
  tools.register({
    name: "test.echo",
    description: "Echo a value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: (input) => input,
  });
  const model = scriptedAdapter([
    [
      { type: "tool-call-delta", delta: { index: 0, id: "stream-call", name: "test.", arguments: '{"value":"' } },
      { type: "tool-call-delta", delta: { index: 0, name: "echo", arguments: "ok\"}" } },
      { type: "completed", message: { role: "assistant", content: "" } },
    ],
    [{ type: "completed", message: { role: "assistant", content: "done" } }],
  ]);
  const events = [];
  const result = await new Agent(model, tools).run({ messages: [{ role: "user", content: "echo" }], onEvent: (event) => events.push(event) });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.messages.find((message) => message.role === "assistant" && message.toolCalls !== undefined)?.toolCalls, [{ id: "stream-call", name: "test.echo", arguments: { value: "ok" } }]);
  assert.equal(events.filter((event) => event.type === "tool-call-delta").length, 2);
  assert.equal(events.find((event) => event.type === "tool-started")?.call.name, "test.echo");
});

test("agent forwards and preserves streaming reasoning text", async () => {
  const model = scriptedAdapter([[
    { type: "reasoning-delta", delta: "first" },
    { type: "reasoning-delta", delta: " second" },
    { type: "text-delta", delta: "answer" },
    { type: "completed", message: { role: "assistant", content: "answer" } },
  ]]);
  const events = [];
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({
    messages: [{ role: "user", content: "think" }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.response.reasoning, "first second");
  assert.deepEqual(events.filter((event) => event.type === "reasoning-delta").map((event) => event.delta), ["first", " second"]);
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

test("agent has no default turn or per-turn tool-call ceiling", async () => {
  const tools = new ToolRegistry(new CapabilityManager());
  tools.register({
    name: "test.step",
    description: "Advance the scripted run.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ ok: true }),
  });
  let turns = 0;
  const model = {
    id: "unbounded",
    async *stream() {
      turns += 1;
      if (turns === 1) {
        yield {
          type: "completed",
          message: {
            role: "assistant",
            content: "",
            toolCalls: Array.from({ length: 17 }, (_, index) => ({ id: `first-${index}`, name: "test.step", arguments: {} })),
          },
        };
      } else if (turns < 40) {
        yield { type: "completed", message: { role: "assistant", content: "", toolCalls: [{ id: `step-${turns}`, name: "test.step", arguments: {} }] } };
      } else {
        yield { type: "completed", message: { role: "assistant", content: "done" } };
      }
    },
  };
  const result = await new Agent(model, tools).run({ messages: [{ role: "user", content: "continue" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 40);
  assert.equal(result.response.content, "done");
});

test("agent accepts large messages by default", async () => {
  const model = { id: "large-message", async *stream() { yield { type: "completed", message: { role: "assistant", content: "ok" } }; } };
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({
    messages: [{ role: "user", content: "x".repeat(120_000) }],
  });
  assert.equal(result.status, "completed");
});

test("agent cancellation returns a cancellable result", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = scriptedAdapter([[{ type: "completed", message: { role: "assistant", content: "never" } }]]);
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({ messages: [], signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "ABORTED");
});

test("agent rejects an empty model stream", async () => {
  const model = { id: "empty", async *stream() {} };
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({ messages: [] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "EMPTY_MODEL_RESPONSE");
});

test("agent reports model timeouts and aborts the adapter signal", async () => {
  let aborted = false;
  const model = {
    id: "hanging",
    async *stream({ signal }) {
      await new Promise((resolve) => signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }, { once: true }));
    },
  };
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({ messages: [], modelTimeoutMs: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_TIMEOUT");
  assert.equal(aborted, true);
});

test("tool timeout ends the run instead of starting another model turn", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  let aborted = false;
  tools.register({
    name: "test.slow",
    description: "A slow tool.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async (_input, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ done: true });
    }, { once: true })),
  });
  let turns = 0;
  const model = {
    id: "tool-timeout",
    async *stream() {
      turns += 1;
      yield { type: "completed", message: { role: "assistant", content: "", toolCalls: [{ id: "slow", name: "test.slow", arguments: {} }] } };
    },
  };
  const result = await new Agent(model, tools).run({ messages: [{ role: "user", content: "run" }], toolTimeoutMs: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "TOOL_TIMEOUT");
  assert.equal(turns, 1);
  assert.equal(aborted, true);
});

test("agent still accepts explicit caller limits", async () => {
  const model = { id: "limit", async *stream() { yield { type: "completed", message: { role: "assistant", content: "ok" } }; } };
  const result = await new Agent(model, new ToolRegistry(new CapabilityManager())).run({
    messages: [{ role: "user", content: "too long" }],
    limits: { maxMessageChars: 2 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MESSAGE_LIMIT_EXCEEDED");
});

test("plugin lifecycle is scoped and unregisters all contribution types", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  const plugins = new PluginManager(tools, capabilities);
  let teardown = false;
  let lateRegister;
  const handle = await plugins.install({
    manifest: { apiVersion: "1", id: "test-plugin", name: "Test", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerTool({
        name: "test.owned",
        description: "Owned by the test plugin.",
        inputSchema: { type: "object", additionalProperties: false },
        execute: () => ({ done: true }),
      });
      context.registerModelAdapter({ id: "test.model", async *stream() { yield { type: "completed", message: { role: "assistant", content: "model" } }; } });
      context.registerProcessor({ id: "test.upper", description: "Uppercase values.", process: (value) => typeof value === "string" ? value.toUpperCase() : value });
      context.registerUi({ id: "test.ui", mount: () => undefined });
      lateRegister = () => context.registerTool({
        name: "test.late",
        description: "Must not register after uninstall.",
        inputSchema: { type: "object", additionalProperties: false },
        execute: () => null,
      });
    },
    teardown() {
      teardown = true;
    },
  });
  assert.equal(tools.descriptors().length, 1);
  assert.equal(plugins.modelAdapter("test.model").id, "test.model");
  assert.equal(plugins.processors().length, 1);
  assert.equal(plugins.uiContributions().length, 1);
  assert.equal(await plugins.process("hello"), "HELLO");
  assert.equal(plugins.isInstalled("test-plugin"), true);
  await handle.uninstall();
  await handle.uninstall();
  assert.equal(teardown, true);
  assert.equal(plugins.isInstalled("test-plugin"), false);
  assert.equal(tools.descriptors().length, 0);
  assert.equal(plugins.modelAdapter("test.model"), undefined);
  assert.equal(plugins.processors().length, 0);
  assert.equal(plugins.uiContributions().length, 0);
  assert.throws(() => lateRegister(), (error) => error.code === "PLUGIN_INACTIVE");
});

test("a model adapter plugin is registered, selected, and removed through the registry", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  capabilities.register("network", { provide: () => ({ fetch: async () => sseResponse([
    { choices: [{ delta: { content: "remote" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]) }) });
  const tools = new ToolRegistry(capabilities);
  const plugins = new PluginManager(tools, capabilities);
  const handle = await plugins.install(createRemoteModelPlugin({ endpoint: "https://example.test/chat", model: "demo" }));
  const adapter = plugins.modelAdapter("remote-model");
  assert.ok(adapter);
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) events.push(event);
  assert.equal(events.at(-1).message.content, "remote");
  await handle.uninstall();
  assert.equal(plugins.modelAdapter("remote-model"), undefined);
});

test("a plugin can provide a capability before requesting its grant", async () => {
  const capabilities = new CapabilityManager({ decide: () => true });
  const tools = new ToolRegistry(capabilities);
  const plugins = new PluginManager(tools, capabilities);
  const handle = await plugins.install({
    manifest: { apiVersion: "1", id: "provider-plugin", name: "Provider", version: "1", permissions: [{ name: "provided", reason: "test" }] },
    setup(context) {
      context.registerCapability({ name: "provided", provider: { provide: () => ({ value: 7 }) } });
      context.registerTool({
        name: "provided.value",
        description: "Read the provided capability.",
        inputSchema: { type: "object", additionalProperties: false },
        requiredCapabilities: ["provided"],
        execute: async (_input, toolContext) => ({ value: (await toolContext.getCapability("provided")).value }),
      });
    },
  });
  assert.deepEqual(await tools.execute("provided.value", {}), { ok: true, value: { value: 7 } });
  await handle.uninstall();
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
  await state.apply([
    { type: "set", key: "a", value: 1 },
    { type: "set", key: "b", value: 2 },
    { type: "remove", key: "a" },
  ]);
  assert.deepEqual(await state.keys(), ["b"]);
});

test("browser state falls back to memory when IndexedDB opening fails", async () => {
  const failingIndexedDb = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
  const store = createBrowserStateStore({ indexedDB: failingIndexedDb });
  assert.equal(store.kind, "indexeddb");
  await store.set("draft", { text: "kept" });
  assert.equal(store.kind, "memory");
  assert.deepEqual(await store.get("draft"), { text: "kept" });
  assert.ok(store instanceof ResilientStateStore);
});

test("connection settings persist as a browser-local state record", async () => {
  const state = new MemoryStateStore();
  const settings = { endpoint: "https://example.test/v1/chat/completions", model: "demo", apiKey: "secret", thinkingLevel: "high" };
  await saveConnectionSettings(state, settings);
  assert.deepEqual(await loadConnectionSettings(state), settings);
  assert.deepEqual(await state.get(CONNECTION_SETTINGS_KEY), settings);

  await state.set(CONNECTION_SETTINGS_KEY, { endpoint: settings.endpoint, model: settings.model, apiKey: 42 });
  assert.equal(await loadConnectionSettings(state), undefined);

  await state.set(CONNECTION_SETTINGS_KEY, { endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey });
  assert.equal((await loadConnectionSettings(state)).thinkingLevel, DEFAULT_THINKING_LEVEL);
});

test("in-memory chat normalization preserves unbounded message history", () => {
  const messages = Array.from({ length: 220 }, (_, index) => ({ role: "user", content: `message-${index}` }));
  const normalized = normalizeMessages(messages);
  assert.equal(normalized.length, 220);
  assert.equal(normalized[0].content, "message-0");
  assert.equal(normalized.at(-1).content, "message-219");
  assert.equal(CHAT_LIMITS.maxMessages, Infinity);
  assert.equal(CHAT_LIMITS.maxMessageChars, Infinity);
  assert.doesNotThrow(() => normalizeMessages([{ role: "user", content: "x".repeat(100_001) }]));
});

test("AI SDK adapter normalizes a streaming provider response", async () => {
  let requestBody;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    apiKey: "secret",
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return sseResponse([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
      ]);
    },
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) events.push(event);
  assert.equal(events.at(-1).type, "completed");
  assert.equal(events.at(-1).message.content, "hello");
  assert.deepEqual(events.at(-1).usage, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  assert.equal(events.at(-1).usage.totalTokens, 3);
  assert.equal(requestBody.model, "demo");
  assert.equal(requestBody.messages[0].role, "user");
  assert.equal(requestBody.stream, true);
});

test("AI SDK adapter streams reasoning and forwards the selected thinking level", async () => {
  let requestBody;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    reasoning: "high",
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return sseResponse([
        { choices: [{ delta: { reasoning_content: "first step" } }] },
        { choices: [{ delta: { reasoning_content: "; second step" } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "think" }], tools: [], signal: noSignal() })) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "reasoning-delta").map((event) => event.delta), ["first step", "; second step"]);
  assert.equal(events.at(-1).message.reasoning, "first step; second step");
  assert.equal(events.at(-1).message.content, "answer");
  assert.equal(requestBody.reasoning_effort, "high");
});

test("AI SDK adapter resolves versioned API bases to chat completions", async () => {
  let requestUrl;
  const adapter = new AiSdkAdapter({
    endpoint: "https://openrouter.ai/api/v1",
    model: "demo",
    fetcher: async (input) => {
      requestUrl = String(input);
      return sseResponse([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) {}
  assert.equal(requestUrl, "https://openrouter.ai/api/v1/chat/completions");
});

test("AI SDK adapter preserves arbitrary full endpoint paths", async () => {
  let requestUrl;
  const adapter = new AiSdkAdapter({
    endpoint: "https://proxy.example.test/llm/stream",
    model: "demo",
    fetcher: async (input) => {
      requestUrl = String(input);
      return sseResponse([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) {}
  assert.equal(requestUrl, "https://proxy.example.test/llm/stream");
});

test("AI SDK adapter normalizes provider tool names in both directions", async () => {
  const tool = {
    name: "runtime.javascript",
    description: "Run JavaScript.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    requiredCapabilities: [],
  };
  const requestBodies = [];
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    fetcher: async (_input, init) => {
      requestBodies.push(JSON.parse(init.body));
      return requestBodies.length === 1
        ? sseResponse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "runtime_javascript", arguments: '{"code":"' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'return 1"}' } } ] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        : sseResponse([
            { choices: [{ delta: { content: "done" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]);
    },
  });
  const firstEvents = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "run it" }], tools: [tool], signal: noSignal() })) firstEvents.push(event);
  const firstMessage = firstEvents.at(-1).message;
  assert.equal(firstMessage.toolCalls[0].name, "runtime.javascript");

  const secondEvents = [];
  for await (const event of adapter.stream({
    messages: [
      { role: "user", content: "run it" },
      firstMessage,
      { role: "tool", callId: "call-1", name: "runtime.javascript", content: '{"value":1}' },
    ],
    tools: [tool],
    signal: noSignal(),
  })) secondEvents.push(event);
  assert.equal(secondEvents.at(-1).message.content, "done");
  assert.equal(requestBodies[0].tools[0].function.name, "runtime_javascript");
  assert.equal(requestBodies[1].messages[1].tool_calls[0].function.name, "runtime_javascript");
  assert.equal(requestBodies[1].messages[2].tool_call_id, "call-1");
  assert.equal(requestBodies[1].messages[2].content, '{"value":1}');
});

test("AI SDK adapter maps provider HTTP errors to kernel errors", async () => {
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    fetcher: async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    async () => { for await (const _event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) {} },
    (error) => error.code === "MODEL_PROVIDER_ERROR" && error.message.includes("quota exceeded"),
  );
});

test("AI SDK adapter sends large requests without an application ceiling", async () => {
  let fetched = false;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    fetcher: async () => {
      fetched = true;
      return sseResponse([
        { choices: [{ delta: { content: "accepted" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "x".repeat(600_000) }], tools: [], signal: noSignal() })) events.push(event);
  assert.equal(fetched, true);
  assert.equal(events.at(-1).message.content, "accepted");
});

test("AI SDK adapter rejects empty model responses", async () => {
  const empty = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    fetcher: async () => sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
  });
  await assert.rejects(
    async () => { for await (const _event of empty.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) {} },
    (error) => error.code === "MODEL_EMPTY_RESPONSE",
  );
});

test("AI SDK adapter preserves streaming text and tool input deltas", async () => {
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    fetcher: async () => sseResponse([
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "runtime_javascript", arguments: '{"code":"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "return 42\"}" } } ] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "run" }], tools: [{ name: "runtime.javascript", description: "run", inputSchema: { type: "object" }, requiredCapabilities: [] }], signal: noSignal() })) events.push(event);
  assert.equal(events.filter((event) => event.type === "text-delta").length, 1);
  assert.equal(events.filter((event) => event.type === "tool-call-delta").length, 3);
  assert.equal(events.at(-1).type, "completed");
  assert.equal(events.at(-1).message.content, "hello");
  assert.deepEqual(events.at(-1).message.toolCalls, [{ id: "call-1", name: "runtime.javascript", arguments: { code: "return 42" } }]);
});
