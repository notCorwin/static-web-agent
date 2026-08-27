import test from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  AgentKernel,
  MemoryStateStore,
  PrefixedStateStore,
  ResilientStateStore,
  createBrowserStateStore,
  validate,
} from "../dist/index.js";
import { AiSdkAdapter, createRemoteModelPlugin } from "../dist/remote.js";
import { createAttachmentIntake } from "../dist/app/attachments.js";
import {
  CONNECTION_SETTINGS_KEY,
  DEFAULT_THINKING_LEVEL,
  createPendingAttachment,
  loadConnectionSettings,
  normalizeMessages,
  processAttachmentFiles,
  saveConnectionSettings,
} from "../dist/app-entry.js";

const noSignal = () => new AbortController().signal;

function attachmentIntake(overrides = {}) {
  return createAttachmentIntake({
    documentToMarkdown: async () => undefined,
    async *streamPdfContentPages() {},
    recognizeImages: async (inputs) => inputs.map(() => ""),
    ...overrides,
  });
}

async function processAttachments(files, supportsVision, signal, engines = {}, onProgress) {
  const intake = attachmentIntake(engines);
  try {
    return await intake.process(files, {
      supportsVision,
      signal,
      ...(onProgress === undefined ? {} : { onProgress }),
    });
  } finally {
    await intake.dispose();
  }
}

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

function manifest(id, permissions = []) {
  return { apiVersion: "1", id, name: id, version: "1.0.0", permissions };
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
  assert.deepEqual(validate({ type: "array", items: { type: "object", properties: { count: { type: "integer" } } } }, [{ count: "no" }]).issues, [
    { path: "$[0].count", message: "Expected integer.", keyword: "type" },
  ]);
  assert.equal(validate({}, { nested: [Number.NaN] }).issues[0]?.keyword, "json");
});

test("capabilities require an explicit provider and a granted permission", async () => {
  const denied = new AgentKernel({ decide: () => false });
  denied.provide("secret", { provide: () => ({ value: 42 }) });
  await assert.rejects(
    denied.install({ manifest: manifest("denied-plugin", [{ name: "secret", reason: "test" }]), setup() {} }),
    (error) => error.code === "CAPABILITY_DENIED",
  );

  // ponytail: capability values are plain objects; revocation is enforced at
  // access time through the scope, not by proxying cached references.
  const allowed = new AgentKernel();
  allowed.provide("secret", { provide: () => ({ value: 42 }) });
  let scope;
  let undeclaredGet;
  await allowed.install({
    manifest: manifest("allowed-plugin", [{ name: "secret", reason: "test" }]),
    setup(context) {
      scope = context.capabilities;
      undeclaredGet = () => scope.get("undeclared");
    },
  });
  assert.deepEqual(await scope.get("secret"), { value: 42 });
  assert.equal(scope.has("secret"), true);
  await assert.rejects(undeclaredGet(), (error) => error.code === "CAPABILITY_DENIED");

  // Uninstalling revokes the grant: later scope reads are denied.
  for (const handle of allowed.manifests()) await allowed.uninstall(handle.id);
  assert.equal(scope.has("secret"), false);
  await assert.rejects(scope.get("secret"), (error) => error.code === "CAPABILITY_DENIED");
});

test("tool execution validates arguments, enforces permission, and returns structured errors", async () => {
  const kernel = new AgentKernel();
  kernel.provide("clock", { provide: () => ({ now: 7 }) });
  const unregister = kernel.register({
    name: "test.clock",
    description: "Return a test clock.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredCapabilities: ["clock"],
    execute: async (_, context) => ({ value: (await context.getCapability("clock")).now }),
  }, "test-plugin");

  const denied = await kernel.executeTool("test.clock", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "CAPABILITY_DENIED");

  kernel.grant("test-plugin", "clock");
  const result = await kernel.executeTool("test.clock", {});
  assert.deepEqual(result, { ok: true, value: { value: 7 } });
  const invalid = await kernel.executeTool("test.clock", { extra: 1 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_TOOL_INPUT");

  unregister();
  assert.equal(kernel.hasTool("test.clock"), false);
});

test("the kernel does not impose an output-size ceiling on tools", async () => {
  const kernel = new AgentKernel();
  kernel.register({
    name: "test.large",
    description: "Return a large value.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ text: "too large" }),
  });
  const result = await kernel.executeTool("test.large", {});
  assert.deepEqual(result, { ok: true, value: { text: "too large" } });
});

test("tool outputs must be JSON with or without an output schema", async () => {
  const kernel = new AgentKernel();
  for (const name of ["untyped", "typed"]) {
    kernel.register({
      name,
      description: "Return invalid JSON.",
      inputSchema: { type: "null" },
      ...(name === "typed" ? { outputSchema: { type: "number" } } : {}),
      execute: () => Number.NaN,
    });
    const result = await kernel.executeTool(name, null);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TOOL_OUTPUT");
  }
});

test("tool descriptors are immutable and cached until registration changes", () => {
  const kernel = new AgentKernel();
  const unregister = kernel.register({ name: "test.cached", description: "Cached.", inputSchema: { type: "object" }, execute: () => null });
  const cached = kernel.descriptors();
  assert.equal(kernel.descriptors(), cached);
  assert.equal(Object.isFrozen(cached), true);
  assert.equal(Object.isFrozen(cached[0].inputSchema), true);
  unregister();
  assert.notEqual(kernel.descriptors(), cached);
  assert.deepEqual(kernel.descriptors(), []);
});

test("agent loops through multiple tool calls and normalizes tool errors", async () => {
  const kernel = new AgentKernel();
  kernel.register({
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
  const result = await new Agent(model, kernel).run({
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

test("agent executes same-turn tools concurrently and preserves result order", async () => {
  const kernel = new AgentKernel();
  let started = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  for (const name of ["barrier.a", "barrier.b"]) {
    kernel.register({
      name,
      description: "Wait for both tools.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: async () => {
        started += 1;
        if (started === 2) release();
        await barrier;
        return name;
      },
    });
  }
  const model = scriptedAdapter([
    [{ type: "completed", message: { role: "assistant", content: "", toolCalls: [
      { id: "a", name: "barrier.a", arguments: {} },
      { id: "b", name: "barrier.b", arguments: {} },
    ] } }],
    [{ type: "completed", message: { role: "assistant", content: "done" } }],
  ]);
  const result = await new Agent(model, kernel).run({ messages: [], toolTimeoutMs: 50 });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.messages.filter((message) => message.role === "tool").map((message) => message.name), ["barrier.a", "barrier.b"]);
});

test("agent forwards attachment bytes only through the model request side channel", async () => {
  let received;
  const model = {
    id: "attachment-model",
    async *stream(request) {
      received = request;
      yield { type: "completed", message: { role: "assistant", content: "seen" } };
    },
  };
  const attachment = { id: "image-1", name: "scan.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) };
  const result = await new Agent(model, new AgentKernel()).run({
    messages: [{ role: "user", content: "read this", attachmentIds: [attachment.id] }],
    attachments: [attachment],
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(received.attachments, [attachment]);
  assert.deepEqual(received.messages[0].attachmentIds, [attachment.id]);
});

test("agent exposes immutable message history to model adapters", async () => {
  const model = {
    id: "immutable-history",
    async *stream({ messages }) {
      assert.equal(Object.isFrozen(messages), true);
      assert.equal(Object.isFrozen(messages[0]), true);
      assert.equal(Object.isFrozen(messages[0].toolCalls[0].arguments.nested), true);
      assert.throws(() => { messages[0].toolCalls[0].arguments.nested.value = 2; }, TypeError);
      yield { type: "completed", message: { role: "assistant", content: "unchanged" } };
    },
  };
  const result = await new Agent(model, new AgentKernel()).run({
    messages: [{ role: "assistant", content: "", toolCalls: [{ id: "call", name: "test", arguments: { nested: { value: 1 } } }] }],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.messages[0].toolCalls[0].arguments.nested.value, 1);
  assert.equal(Object.isFrozen(result.messages), true);
});

test("agent forwards streaming tool-call deltas and reconstructs their arguments", async () => {
  const kernel = new AgentKernel();
  kernel.register({
    name: "test.echo",
    description: "Echo a value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: (input) => input,
  });
  const model = scriptedAdapter([
    [
      { type: "tool-call-delta", delta: { index: 0, id: "stream-call", name: "test.", arguments: '{"value":"' } },
      { type: "tool-call-delta", delta: { index: 0, name: "echo", arguments: 'ok"}' } },
      { type: "completed", message: { role: "assistant", content: "" } },
    ],
    [{ type: "completed", message: { role: "assistant", content: "done" } }],
  ]);
  const events = [];
  const result = await new Agent(model, kernel).run({ messages: [{ role: "user", content: "echo" }], onEvent: (event) => events.push(event) });
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
  const result = await new Agent(model, new AgentKernel()).run({
    messages: [{ role: "user", content: "think" }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.response.reasoning, "first second");
  assert.deepEqual(events.filter((event) => event.type === "reasoning-delta").map((event) => event.delta), ["first", " second"]);
});

test("agent termination is deterministic at max turns", async () => {
  const kernel = new AgentKernel();
  kernel.register({
    name: "test.loop",
    description: "Keep looping.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ ok: true }),
  });
  const model = scriptedAdapter([[{ type: "completed", message: { role: "assistant", content: "loop", toolCalls: [{ id: "x", name: "test.loop", arguments: {} }] } }]]);
  const result = await new Agent(model, kernel).run({ messages: [{ role: "user", content: "loop" }], maxTurns: 2 });
  assert.equal(result.status, "max-turns");
  assert.equal(result.turns, 2);
});

test("agent has no default turn or per-turn tool-call ceiling", async () => {
  const kernel = new AgentKernel();
  kernel.register({
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
  const result = await new Agent(model, kernel).run({ messages: [{ role: "user", content: "continue" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 40);
  assert.equal(result.response.content, "done");
});

test("agent accepts large messages by default", async () => {
  const model = { id: "large-message", async *stream() { yield { type: "completed", message: { role: "assistant", content: "ok" } }; } };
  const result = await new Agent(model, new AgentKernel()).run({
    messages: [{ role: "user", content: "x".repeat(120_000) }],
  });
  assert.equal(result.status, "completed");
});

test("agent cancellation returns a cancellable result", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = scriptedAdapter([[{ type: "completed", message: { role: "assistant", content: "never" } }]]);
  const result = await new Agent(model, new AgentKernel()).run({ messages: [], signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "ABORTED");
});

test("agent rejects an empty model stream", async () => {
  const model = { id: "empty", async *stream() {} };
  const result = await new Agent(model, new AgentKernel()).run({ messages: [] });
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
  const result = await new Agent(model, new AgentKernel()).run({ messages: [], modelTimeoutMs: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_TIMEOUT");
  assert.equal(aborted, true);
});

test("tool timeout ends the run instead of starting another model turn", async () => {
  const kernel = new AgentKernel();
  let aborted = false;
  kernel.register({
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
  const result = await new Agent(model, kernel).run({ messages: [{ role: "user", content: "run" }], toolTimeoutMs: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "TOOL_TIMEOUT");
  assert.equal(turns, 1);
  assert.equal(aborted, true);
});

test("agent still accepts explicit caller limits", async () => {
  const model = { id: "limit", async *stream() { yield { type: "completed", message: { role: "assistant", content: "ok" } }; } };
  const result = await new Agent(model, new AgentKernel()).run({
    messages: [{ role: "user", content: "too long" }],
    limits: { maxMessageChars: 2 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MESSAGE_LIMIT_EXCEEDED");
});

test("agent enforces message limits after tool results", async () => {
  const kernel = new AgentKernel();
  kernel.register({
    name: "test.noop",
    description: "Return nothing.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => null,
  });
  const model = scriptedAdapter([[
    { type: "completed", message: { role: "assistant", content: "", toolCalls: [{ id: "noop", name: "test.noop", arguments: {} }] } },
  ]]);
  const result = await new Agent(model, kernel).run({
    messages: [{ role: "user", content: "run" }],
    limits: { maxMessages: 2 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MESSAGE_LIMIT_EXCEEDED");
});

test("plugin lifecycle is scoped and unregisters all contribution types", async () => {
  const kernel = new AgentKernel();
  let teardown = false;
  let lateRegister;
  const handle = await kernel.install({
    manifest: manifest("test-plugin"),
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
  assert.equal(kernel.descriptors().length, 1);
  assert.equal(kernel.modelAdapter("test.model").id, "test.model");
  assert.equal(kernel.processors().length, 1);
  assert.equal(kernel.uiContributions().length, 1);
  assert.equal(await kernel.process("hello"), "HELLO");
  assert.equal(kernel.isInstalled("test-plugin"), true);
  await handle.uninstall();
  await handle.uninstall();
  assert.equal(teardown, true);
  assert.equal(kernel.isInstalled("test-plugin"), false);
  assert.equal(kernel.descriptors().length, 0);
  assert.equal(kernel.modelAdapter("test.model"), undefined);
  assert.equal(kernel.processors().length, 0);
  assert.equal(kernel.uiContributions().length, 0);
  assert.throws(() => lateRegister(), (error) => error.code === "PLUGIN_INACTIVE");
});

test("a plugin cannot register a tool with an undeclared capability", async () => {
  const kernel = new AgentKernel();
  await assert.rejects(
    kernel.install({
      manifest: manifest("sneaky-plugin"),
      setup(context) {
        context.registerTool({
          name: "sneaky.tool",
          description: "Uses a capability it never declared.",
          inputSchema: { type: "object", additionalProperties: false },
          requiredCapabilities: ["network"],
          execute: () => null,
        });
      },
    }),
    (error) => error.code === "PLUGIN_PERMISSION_MISSING",
  );
  assert.equal(kernel.hasTool("sneaky.tool"), false);
});

test("a remote model plugin is registered and removed through the registry", async () => {
  const kernel = new AgentKernel();
  kernel.provide("network", { provide: () => ({ fetch: async () => sseResponse([
    { choices: [{ delta: { content: "remote" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]) }) });
  const handle = await kernel.install(createRemoteModelPlugin({ endpoint: "https://example.test/chat", model: "demo" }));
  const adapter = kernel.modelAdapter("remote-model");
  assert.ok(adapter);
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: "user", content: "hi" }], tools: [], signal: noSignal() })) events.push(event);
  assert.equal(events.at(-1).message.content, "remote");
  await handle.uninstall();
  assert.equal(kernel.modelAdapter("remote-model"), undefined);
});

test("a plugin can provide a capability before requesting its grant", async () => {
  const kernel = new AgentKernel();
  const handle = await kernel.install({
    manifest: manifest("provider-plugin", [{ name: "provided", reason: "test" }]),
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
  assert.deepEqual(await kernel.executeTool("provided.value", {}), { ok: true, value: { value: 7 } });
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

test("memory state batches remain atomic when cloning fails", async () => {
  const state = new MemoryStateStore();
  await state.set("kept", 1);
  const uncloneable = new Proxy({ value: 2 }, {});
  await assert.rejects(state.apply([
    { type: "set", key: "added", value: 2 },
    { type: "set", key: "broken", value: uncloneable },
  ]));
  assert.deepEqual(await state.keys(), ["kept"]);
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
  const settings = { endpoint: "https://example.test/v1/chat/completions", model: "demo", apiKey: "secret", thinkingLevel: "high", supportsVision: true };
  await saveConnectionSettings(state, settings);
  assert.deepEqual(await loadConnectionSettings(state), settings);
  assert.deepEqual(await state.get(CONNECTION_SETTINGS_KEY), settings);

  await state.set(CONNECTION_SETTINGS_KEY, { endpoint: settings.endpoint, model: settings.model, apiKey: 42 });
  assert.equal(await loadConnectionSettings(state), undefined);

  await state.set(CONNECTION_SETTINGS_KEY, { endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey });
  assert.equal((await loadConnectionSettings(state)).thinkingLevel, DEFAULT_THINKING_LEVEL);
  assert.equal((await loadConnectionSettings(state)).supportsVision, false);
});

test("attachment processing sends images as direct model attachments when vision is enabled", async () => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "scan.png", { type: "image/png" });
  const pending = createPendingAttachment(file);
  const result = await processAttachmentFiles([pending], { supportsVision: true, signal: noSignal() });
  assert.deepEqual(result.attachmentIds, [pending.id]);
  assert.equal(result.attachments[0].mediaType, "image/png");
  assert.deepEqual([...result.attachments[0].data], [137, 80, 78, 71]);
  assert.equal(result.usedVision, true);
  assert.match(result.content, /scan\.png/);
});

test("attachment processing routes non-vision images through local OCR", async () => {
  const file = new File([new Uint8Array([1, 2])], "scan.png", { type: "image/png" });
  const pending = createPendingAttachment(file);
  const result = await processAttachments([pending], false, noSignal(), {
    recognizeImages: async () => ["OCR line 1\nOCR line 2"],
  });
  assert.deepEqual(result.attachmentIds, []);
  assert.equal(result.attachments.length, 0);
  assert.match(result.content, /OCR line 1/);
  assert.equal(result.usedVision, false);
});

test("image extensions recover an empty or generic MIME type", async () => {
  const emptyType = createPendingAttachment(new File([new Uint8Array([1])], "scan.png"));
  const genericType = createPendingAttachment(new File([new Uint8Array([1])], "scan.jpg", { type: "application/octet-stream" }));
  assert.equal(emptyType.mediaType, "image/png");
  assert.equal(genericType.mediaType, "image/jpeg");
  const result = await processAttachments([emptyType], false, noSignal(), { recognizeImages: async () => ["recognized"] });
  assert.match(result.content, /recognized/);
});

test("text attachments decode UTF-8 and UTF-16 BOMs without AnyDoc", async () => {
  const utf8 = createPendingAttachment(new File([new Uint8Array([0xef, 0xbb, 0xbf, 0x55, 0x54, 0x46, 0x38])], "utf8.txt"));
  const utf16le = createPendingAttachment(new File([new Uint8Array([0xff, 0xfe, 0x55, 0x00, 0x54, 0x00, 0x46, 0x00])], "utf16le.txt"));
  const utf16be = createPendingAttachment(new File([new Uint8Array([0xfe, 0xff, 0x00, 0x55, 0x00, 0x54, 0x00, 0x46])], "utf16be.txt"));
  let anydocCalls = 0;
  const result = await processAttachments([utf8, utf16le, utf16be], false, noSignal(), {
    documentToMarkdown: async () => {
      anydocCalls += 1;
      return "unexpected";
    },
  });
  assert.equal(anydocCalls, 0);
  assert.equal((result.content.match(/UTF/g) ?? []).length, 3);
  const whitespace = createPendingAttachment(new File([new TextEncoder().encode(" \n")], "empty.txt", { type: "text/plain" }));
  await assert.rejects(processAttachments([whitespace], false, noSignal()), (error) => error.code === "ATTACHMENT_PARSE_FAILED");
  const invalid = createPendingAttachment(new File([new Uint8Array([0xff])], "invalid.txt", { type: "text/plain" }));
  await assert.rejects(processAttachments([invalid], false, noSignal()), (error) => error.code === "ATTACHMENT_PARSE_FAILED");
});

test("attachment OCR failure is surfaced once without an automatic retry", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([1, 2])], "scan.png", { type: "image/png" }));
  let calls = 0;
  await assert.rejects(
    processAttachments([pending], false, noSignal(), {
      recognizeImages: async () => {
        calls += 1;
        throw new Error("OCR unavailable");
      },
    }),
    /OCR unavailable/,
  );
  assert.equal(calls, 1);
});

test("attachment processing batches local OCR inputs while preserving order", async () => {
  const first = createPendingAttachment(new File([new Uint8Array([1])], "first.png", { type: "image/png" }));
  const second = createPendingAttachment(new File([new Uint8Array([2])], "second.png", { type: "image/png" }));
  let batchCalls = 0;
  const result = await processAttachments([first, second], false, noSignal(), {
    recognizeImages: async (inputs) => {
      batchCalls += 1;
      assert.deepEqual(inputs.map((input) => input.data[0]), [1, 2]);
      return ["first text", "second text"];
    },
  });
  assert.equal(batchCalls, 1);
  assert.match(result.content, /first\.png/);
  assert.ok(result.content.indexOf("first text") < result.content.indexOf("second text"));
});

test("attachment processing stops before parsing when cancelled", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([1, 2])], "notes.txt", { type: "text/plain" }));
  const controller = new AbortController();
  controller.abort();
  let parsed = false;
  await assert.rejects(
    processAttachments([pending], false, controller.signal, {
      documentToMarkdown: async () => {
        parsed = true;
        return "never";
      },
    }),
    (error) => error.code === "ATTACHMENT_CANCELLED",
  );
  assert.equal(parsed, false);
});

test("unsupported attachments produce an explicit processing error", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([1])], "archive.zip", { type: "application/zip" }));
  await assert.rejects(
    processAttachments([pending], false, noSignal(), { documentToMarkdown: async () => undefined }),
    (error) => error.code === "ATTACHMENT_UNSUPPORTED",
  );
});

test("attachment intake owns engine disposal and rejects work after shutdown", async () => {
  let disposals = 0;
  const intake = attachmentIntake({ dispose: () => { disposals += 1; } });
  const pending = createPendingAttachment(new File([new Uint8Array([1])], "scan.png", { type: "image/png" }));
  await intake.process([pending], { supportsVision: true, signal: noSignal() });
  await intake.dispose();
  await intake.dispose();
  assert.equal(disposals, 1);
  await assert.rejects(
    intake.process([pending], { supportsVision: true, signal: noSignal() }),
    (error) => error.code === "ATTACHMENT_CANCELLED",
  );
});

test("scanned PDF pages preserve order in vision and OCR routes", async () => {
  const file = new File([new Uint8Array([37, 80, 68, 70])], "scan.pdf", { type: "application/pdf" });
  const pending = createPendingAttachment(file);
  const pages = [
    { name: "scan.pdf · page 1", mediaType: "image/png", data: new Uint8Array([1]) },
    { name: "scan.pdf · page 2", mediaType: "image/png", data: new Uint8Array([2]) },
  ];
  const visual = await processAttachments([pending], true, noSignal(), {
    streamPdfContentPages: async function* () {
      for (const [index, image] of pages.entries()) yield { kind: "image", pageNumber: index + 1, image };
    },
  });
  assert.deepEqual(visual.attachmentIds, [`${pending.id}-page-1`, `${pending.id}-page-2`]);
  assert.deepEqual(visual.attachments.map((item) => item.name), pages.map((page) => page.name));

  const ocrPages = [];
  const text = await processAttachments([pending], false, noSignal(), {
    streamPdfContentPages: async function* () {
      for (const [index, image] of pages.entries()) yield { kind: "image", pageNumber: index + 1, image };
    },
    recognizeImages: async (inputs) => {
      ocrPages.push(...inputs.map((input) => input.data[0]));
      return inputs.map((input) => `page ${input.data[0]}`);
    },
  });
  assert.deepEqual(ocrPages, [1, 2]);
  assert.match(text.content, /scan\.pdf · page 1/);
  assert.match(text.content, /scan\.pdf · page 2/);
});

test("streamed PDF pages are OCRed in bounded batches without retaining the full document", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([37, 80, 68, 70])], "long-scan.pdf", { type: "application/pdf" }));
  const batchSizes = [];
  let renderedPages = 0;
  const result = await processAttachments([pending], false, noSignal(), {
    streamPdfContentPages: async function* () {
      for (let page = 1; page <= 5; page += 1) {
        renderedPages += 1;
        yield { kind: "image", pageNumber: page, image: { name: `long-scan.pdf · page ${page}`, mediaType: "image/png", data: new Uint8Array([page]) } };
      }
    },
    recognizeImages: async (inputs) => {
      batchSizes.push(inputs.length);
      return inputs.map((input) => `OCR page ${input.data[0]}`);
    },
  });
  assert.equal(renderedPages, 5);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.match(result.content, /long-scan\.pdf · page 1/);
  assert.match(result.content, /OCR page 5/);
});

test("mixed PDF pages preserve order and process only image pages", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([37, 80, 68, 70])], "mixed.pdf", { type: "application/pdf" }));
  const pages = [
    { kind: "text", pageNumber: 1, text: "first page text" },
    { kind: "image", pageNumber: 2, image: { name: "mixed.pdf · page 2", mediaType: "image/png", data: new Uint8Array([2]) } },
    { kind: "text", pageNumber: 3, text: "last page text" },
  ];
  let ocrCalls = 0;
  const visual = await processAttachments([pending], true, noSignal(), {
    streamPdfContentPages: async function* () { yield* pages; },
  });
  assert.deepEqual(visual.attachmentIds, [`${pending.id}-page-2`]);
  assert.ok(visual.content.indexOf("first page text") < visual.content.indexOf("page 2"));
  assert.ok(visual.content.indexOf("page 2") < visual.content.indexOf("last page text"));

  const text = await processAttachments([pending], false, noSignal(), {
    streamPdfContentPages: async function* () { yield* pages; },
    recognizeImages: async (inputs) => {
      ocrCalls += 1;
      assert.deepEqual(inputs.map((input) => input.data[0]), [2]);
      return ["scanned page text"];
    },
  });
  assert.equal(ocrCalls, 1);
  assert.ok(text.content.indexOf("first page text") < text.content.indexOf("scanned page text"));
  assert.ok(text.content.indexOf("scanned page text") < text.content.indexOf("last page text"));
});

test("text-only PDFs do not render or OCR pages", async () => {
  const pending = createPendingAttachment(new File([new Uint8Array([37, 80, 68, 70])], "text.pdf", { type: "application/pdf" }));
  let ocr = false;
  const result = await processAttachments([pending], false, noSignal(), {
    streamPdfContentPages: async function* () {
      yield { kind: "text", pageNumber: 1, text: "PDF text" };
    },
    recognizeImages: async () => { ocr = true; return []; },
  });
  assert.match(result.content, /PDF text/);
  assert.equal(ocr, false);
});

test("a PDF with no OCR text fails, while blank pages beside text remain usable", async () => {
  const emptyPending = createPendingAttachment(new File([new Uint8Array([37, 80, 68, 70])], "empty.pdf", { type: "application/pdf" }));
  const emptyPages = [{ kind: "image", pageNumber: 1, image: { name: "empty.pdf · page 1", mediaType: "image/png", data: new Uint8Array([1]) } }];
  await assert.rejects(
    processAttachments([emptyPending], false, noSignal(), {
      streamPdfContentPages: async function* () { yield* emptyPages; },
      recognizeImages: async () => [""],
    }),
    (error) => error.code === "ATTACHMENT_PARSE_FAILED",
  );

  const usablePending = createPendingAttachment(new File([new Uint8Array([37, 80, 68, 70])], "usable.pdf", { type: "application/pdf" }));
  const usable = await processAttachments([usablePending], false, noSignal(), {
    streamPdfContentPages: async function* () {
      yield { kind: "image", pageNumber: 1, image: { name: "usable.pdf · page 1", mediaType: "image/png", data: new Uint8Array([1]) } };
      yield { kind: "image", pageNumber: 2, image: { name: "usable.pdf · page 2", mediaType: "image/png", data: new Uint8Array([2]) } };
    },
    recognizeImages: async () => ["", "page two"],
  });
  assert.match(usable.content, /page two/);
});

test("ordinary documents use anydoc output without OCR or page rendering", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const pending = createPendingAttachment(file);
  let rendered = false;
  let ocr = false;
  const result = await processAttachments([pending], false, noSignal(), {
    documentToMarkdown: async () => "# Extracted notes",
    streamPdfContentPages: async function* () { rendered = true; },
    recognizeImages: async () => { ocr = true; return []; },
  });
  assert.match(result.content, /Extracted notes/);
  assert.equal(rendered, false);
  assert.equal(ocr, false);
});

test("in-memory chat normalization preserves unbounded message history", () => {
  const messages = Array.from({ length: 220 }, (_, index) => ({ role: "user", content: `message-${index}` }));
  const normalized = normalizeMessages(messages);
  assert.equal(normalized.length, 220);
  assert.equal(normalized[0].content, "message-0");
  assert.equal(normalized.at(-1).content, "message-219");
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

test("AI SDK adapter converts vision attachments to OpenAI-compatible file parts", async () => {
  let requestBody;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "vision-demo",
    supportsVision: true,
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return sseResponse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  for await (const _event of adapter.stream({
    messages: [{ role: "user", content: "describe", attachmentIds: ["image-1"] }],
    attachments: [{ id: "image-1", name: "scan.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    tools: [],
    signal: noSignal(),
  })) {}
  const content = requestBody.messages[0].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
});

test("AI SDK adapter preserves every visual attachment in order", async () => {
  let requestBody;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "vision-demo",
    supportsVision: true,
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return sseResponse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  const attachments = [
    { id: "page-1", name: "scan · page 1.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
    { id: "page-2", name: "scan · page 2.png", mediaType: "image/png", data: new Uint8Array([4, 5, 6]) },
  ];
  for await (const _event of adapter.stream({
    messages: [{ role: "user", content: "describe both pages", attachmentIds: attachments.map((attachment) => attachment.id) }],
    attachments,
    tools: [],
    signal: noSignal(),
  })) {}
  const imageParts = requestBody.messages[0].content.filter((part) => part.type === "image_url");
  assert.equal(imageParts.length, 2);
  assert.ok(imageParts.every((part) => /^data:image\/png;base64,/.test(part.image_url.url)));
});

test("AI SDK adapter refuses image attachments unless vision is explicitly enabled", async () => {
  const adapter = new AiSdkAdapter({ endpoint: "https://example.test/v1", model: "text-only", fetcher: async () => sseResponse([]) });
  await assert.rejects(
    async () => { for await (const _event of adapter.stream({
      messages: [{ role: "user", content: "read", attachmentIds: ["image-1"] }],
      attachments: [{ id: "image-1", name: "scan.png", mediaType: "image/png", data: new Uint8Array([1]) }],
      tools: [],
      signal: noSignal(),
    })) {} },
    (error) => error.code === "MODEL_VISION_DISABLED",
  );
});

test("AI SDK adapter streams reasoning and forwards the selected thinking level", async () => {
  let requestBody;
  let requestHeaders;
  const adapter = new AiSdkAdapter({
    endpoint: "https://example.test/v1",
    model: "demo",
    reasoning: "high",
    fetcher: async (_input, init) => {
      requestHeaders = Object.fromEntries(new Headers(init.headers).entries());
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
  assert.equal(requestHeaders["user-agent"], undefined, "the browser adapter must not send User-Agent in CORS requests");
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
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'return 42"}' } } ] } }] },
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
