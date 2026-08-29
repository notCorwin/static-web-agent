import assert from "node:assert/strict";
import test from "node:test";
import { Agent, BrowserPageRuntime, HarnessError, createHarness, errorInfo, isJsonValue, validate } from "../dist/index.js";

function completed(content, toolCalls) {
  return { type: "completed", message: { role: "assistant", content, ...(toolCalls === undefined ? {} : { toolCalls }) } };
}

test("the Harness exposes one page tool and executes formal calls sequentially", async () => {
  const requests = [];
  let turn = 0;
  const model = {
    id: "scripted",
    async *stream(request) {
      requests.push(request);
      if (turn++ === 0) {
        yield { type: "text-delta", delta: "Working…" };
        yield completed("", [
          { id: "first", name: "page.run", arguments: { code: "console.log('hello'); return input.value + 1", input: { value: 41 } } },
          { id: "second", name: "page.run", arguments: { code: "return 7" } },
        ]);
      } else {
        assert.equal(request.messages.filter((message) => message.role === "tool").length, 2);
        yield completed("finished");
      }
    },
  };
  const events = [];
  const harness = await createHarness({ model, pageRuntime: new BrowserPageRuntime() });
  const result = await harness.run({
    messages: [{ role: "user", content: "do it" }],
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(harness.snapshot().tools.length, 1);
  assert.equal(harness.snapshot().tools[0].name, "page.run");
  assert.equal(Object.isFrozen(harness.snapshot().tools[0].inputSchema.properties), true);
  assert.equal(Object.isFrozen(requests[0].tools), true);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["page.run"]);
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "finished");
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "assistant"]);
  const firstTool = JSON.parse(result.messages[2].content);
  assert.equal(firstTool.value, 42);
  assert.deepEqual(firstTool.logs, ["hello"]);
  assert.ok(events.indexOf("tool-started") < events.indexOf("tool-finished"));
  assert.equal(events.filter((event) => event === "tool-started").length, 2);
  await harness.dispose();
});

test("completed assistant content is emitted before its tools", async () => {
  let turn = 0;
  const events = [];
  const harness = await createHarness({
    model: {
      id: "completed-content",
      async *stream() {
        if (turn++ === 0) {
          yield completed("thinking", [{ id: "call-1", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          yield completed("done");
        }
      },
    },
    pageRuntime: { async execute() { return { value: 1, logs: [], durationMs: 0 }; } },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }], onEvent: (event) => events.push(event) });
    assert.equal(result.status, "completed");
    const textIndex = events.findIndex((event) => event.type === "text-delta" && event.delta === "thinking");
    const toolIndex = events.findIndex((event) => event.type === "tool-started");
    assert.ok(textIndex >= 0 && textIndex < toolIndex);
  } finally {
    await harness.dispose();
  }
});

test("large model and tool timeouts do not overflow host timers", async () => {
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "large-timeout",
      async *stream({ messages }) {
        if (messages.some((message) => message.role === "tool")) {
          yield completed("done");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        turn += 1;
        yield completed("", [{ id: "slow-tool", name: "page.run", arguments: { code: "return 1" } }]);
      },
    },
    pageRuntime: {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { value: 1, logs: [], durationMs: 0 };
      },
    },
  });
  try {
    const result = await harness.run({
      messages: [{ role: "user", content: "go" }],
      modelTimeoutMs: Number.MAX_SAFE_INTEGER,
      toolTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(turn, 1);
    assert.equal(result.status, "completed");
    assert.equal(JSON.parse(result.messages.at(-2).content).value, 1);
  } finally {
    await harness.dispose();
  }
});

test("page tool failures return to the model instead of becoming hidden control flow", async () => {
  let turn = 0;
  const model = {
    id: "error-recovery",
    async *stream({ messages }) {
      if (turn++ === 0) {
        yield completed("", [{ id: "bad", name: "page.run", arguments: { code: "throw new Error('bad page code')" } }]);
        return;
      }
      assert.equal(messages.at(-1).role, "tool");
      assert.equal(messages.at(-1).isError, true);
      yield completed("I saw the page error.");
    },
  };
  const harness = await createHarness({ model });
  const result = await harness.run({ messages: [{ role: "user", content: "try" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "I saw the page error.");
  assert.match(result.messages[2].content, /PAGE_RUNTIME_EXECUTION_ERROR|bad page code/);
  await harness.dispose();
});

test("cyclic error details stay serializable tool results", async () => {
  const details = { reason: "cycle" };
  details.self = details;
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "cyclic-error-details",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "bad", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          assert.equal(JSON.parse(messages.at(-1).content).code, "PAGE_FAILURE");
          yield completed("recovered");
        }
      },
    },
    pageRuntime: { async execute() { throw new HarnessError("PAGE_FAILURE", "bad page", details); } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "recovered");
  assert.equal(JSON.parse(result.messages[2].content).details, undefined);
  await harness.dispose();
});

test("error details are copied before exposure", () => {
  const details = { nested: { reason: "keep mutable" } };
  const result = errorInfo(new HarnessError("PAGE_FAILURE", "bad page", details));
  assert.deepEqual(result.details, details);
  assert.notEqual(result.details, details);
  assert.notEqual(result.details.nested, details.nested);
});

test("page-local AbortErrors stay tool-local", async () => {
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "page-local-abort",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "inner-abort", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          assert.equal(JSON.parse(messages.at(-1).content).code, "PAGE_TOOL_ERROR");
          yield completed("recovered");
        }
      },
    },
    pageRuntime: { async execute() { const error = new Error("inner operation aborted"); error.name = "AbortError"; throw error; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "recovered");
  await harness.dispose();
});

test("hostile page errors still return tool results", async () => {
  const blocked = new Proxy({}, { getPrototypeOf() { throw new Error("blocked prototype"); } });
  const source = new Error("hidden page failure");
  const hostile = new Proxy(source, {
    get(target, key, receiver) {
      if (key === "name") return "AbortError";
      if (key === "message") throw blocked;
      return Reflect.get(target, key, receiver);
    },
  });
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "hostile-page-error",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "bad-page", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          assert.equal(JSON.parse(messages.at(-1).content).code, "PAGE_TOOL_ERROR");
          yield completed("recovered");
        }
      },
    },
    pageRuntime: { execute() { return Promise.reject(hostile); } },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "completed");
  } finally {
    await harness.dispose();
  }
});

test("ordinary model text is never interpreted as a tool call", async () => {
  const harness = await createHarness({
    model: { id: "text-only", async *stream() { yield completed('{"name":"page.run"}'); } },
  });
  const events = [];
  const result = await harness.run({ messages: [{ role: "user", content: "literal" }], onEvent: (event) => events.push(event.type) });
  assert.equal(result.status, "completed");
  assert.equal(events.includes("tool-started"), false);
  await harness.dispose();
});

test("JSON validation rejects cycles without confusing repeated values", () => {
  const shared = { value: 1 };
  const repeated = { left: shared, right: shared };
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isJsonValue(repeated), true);
  assert.equal(isJsonValue(cyclic), false);
});

test("schema validation reports hostile values instead of throwing", () => {
  const value = new Proxy({}, { getPrototypeOf() { throw new Error("prototype probe"); } });
  const result = validate({ type: "object" }, value);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].keyword, "json");
});

test("model usage records cannot be arrays", async () => {
  const harness = await createHarness({
    model: { id: "array-usage", async *stream() { yield { type: "usage", usage: [] }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  await harness.dispose();
});

test("completed model events end an otherwise open stream", async () => {
  let closed = false;
  const harness = await createHarness({
    model: {
      id: "terminal-completed",
      async *stream() {
        try {
          yield completed("done");
          await new Promise(() => {});
        } finally {
          closed = true;
        }
      },
    },
  });
  try {
    const result = await Promise.race([
      harness.run({ messages: [{ role: "user", content: "go" }] }),
      new Promise((resolve) => setTimeout(() => resolve({ status: "probe-timeout" }), 100)),
    ]);
    assert.equal(result.status, "completed");
    assert.equal(result.response.content, "done");
    assert.equal(closed, true);
  } finally {
    await harness.dispose();
  }
});

test("completed model events do not wait for hanging iterator cleanup", async () => {
  const harness = await createHarness({
    model: {
      id: "hanging-cleanup",
      stream() {
        let first = true;
        return {
          async next() {
            if (first) {
              first = false;
              return { done: false, value: completed("done") };
            }
            return new Promise(() => {});
          },
          return() { return new Promise(() => {}); },
          [Symbol.asyncIterator]() { return this; },
        };
      },
    },
  });
  const result = await Promise.race([
    harness.run({ messages: [{ role: "user", content: "go" }] }),
    new Promise((resolve) => setTimeout(() => resolve({ status: "probe-timeout" }), 100)),
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "done");
  await harness.dispose();
});

test("model stream events are snapshotted before iterator cleanup", async () => {
  let turn = 0;
  const firstMessage = { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "page.run", arguments: { code: "return 1" } }] };
  let executedCode;
  const harness = await createHarness({
    model: {
      id: "mutable-stream-event",
      stream() {
        if (turn++ > 0) return (async function* () { yield completed("done"); })();
        return {
          async next() { return { done: false, value: { type: "completed", message: firstMessage } }; },
          return() {
            firstMessage.toolCalls[0].arguments.code = "return 99";
            return Promise.resolve({ done: true, value: undefined });
          },
          [Symbol.asyncIterator]() { return this; },
        };
      },
    },
    pageRuntime: { async execute(code) { executedCode = code; return { value: code, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "completed");
  assert.equal(executedCode, "return 1");
  assert.equal(firstMessage.toolCalls[0].arguments.code, "return 99");
  await harness.dispose();
});

test("page tool input is mutable and isolated from the tool call snapshot", async () => {
  let turn = 0;
  const call = { id: "call-1", name: "page.run", arguments: { code: "input.count += 1; return input", input: { count: 1 } } };
  const harness = await createHarness({
    model: {
      id: "mutable-page-input",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [call]);
        } else {
          assert.deepEqual(JSON.parse(messages.at(-1).content).value, { count: 2 });
          yield completed("done");
        }
      },
    },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "completed");
  assert.equal(call.arguments.input.count, 1);
  await harness.dispose();
});

test("accessor-backed tool arguments are rejected before execution", async () => {
  let executed = 0;
  const argumentsValue = {};
  Object.defineProperty(argumentsValue, "code", { enumerable: true, get: () => "return 1" });
  const harness = await createHarness({
    model: {
      id: "accessor-tool-input",
      async *stream() {
        yield completed("", [{ id: "accessor", name: "page.run", arguments: argumentsValue }]);
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: 1, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  assert.equal(executed, 0);
  await harness.dispose();
});

test("duplicate tool call IDs are rejected before page execution", async () => {
  let executed = 0;
  const harness = await createHarness({
    model: {
      id: "duplicate-tool-id",
      async *stream() {
        yield completed("", [
          { id: "same", name: "page.run", arguments: { code: "return 1" } },
          { id: "same", name: "page.run", arguments: { code: "return 2" } },
        ]);
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: executed, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  assert.equal(executed, 0);
  await harness.dispose();
});

test("streamed tool protocol failures end the run visibly", async () => {
  const events = [];
  const harness = await createHarness({
    model: {
      id: "malformed-streamed-tool",
      async *stream() {
        yield { type: "tool-call-delta", delta: { index: 0, id: "bad", name: "page.run", arguments: "{" } };
        yield completed("done");
      },
    },
    pageRuntime: { async execute() { throw new Error("must not execute"); } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }], onEvent: (event) => events.push(event.type) });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  assert.deepEqual(events.slice(-2), ["run-error", "run-finished"]);
  await harness.dispose();
});

test("streamed tool calls reject empty IDs", async () => {
  const harness = await createHarness({
    model: {
      id: "empty-streamed-tool-id",
      async *stream() {
        yield { type: "tool-call-delta", delta: { index: 0, id: "", name: "page.run", arguments: "{}" } };
      },
    },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  await harness.dispose();
});

test("streamed tool calls reject changing IDs", async () => {
  let executed = 0;
  const harness = await createHarness({
    model: {
      id: "changing-streamed-tool-id",
      async *stream() {
        yield { type: "tool-call-delta", delta: { index: 0, id: "first", name: "page.run", arguments: "{\"code\":\"return 1\"}" } };
        yield { type: "tool-call-delta", delta: { index: 0, id: "second" } };
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: executed, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  assert.equal(executed, 0);
  await harness.dispose();
});

test("streamed tool calls reject unsafe indexes", async () => {
  let executed = 0;
  const harness = await createHarness({
    model: {
      id: "unsafe-streamed-tool-index",
      async *stream() {
        yield { type: "tool-call-delta", delta: { index: Number.MAX_SAFE_INTEGER + 1, name: "page.run", arguments: "{}" } };
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: executed, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  assert.equal(executed, 0);
  await harness.dispose();
});

test("max-turn limits close unexecuted tool calls for continuation", async () => {
  let executed = 0;
  const harness = await createHarness({
    model: {
      id: "max-turn-history",
      async *stream({ messages }) {
        if (messages.at(-1)?.role === "tool") {
          yield completed("continued");
          return;
        }
        yield completed("", [{ id: "limited", name: "page.run", arguments: { code: "return 1" } }]);
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: executed, logs: [], durationMs: 0 }; } },
  });
  const first = await harness.run({ messages: [{ role: "user", content: "go" }], maxTurns: 1 });
  assert.equal(first.status, "max-turns");
  assert.equal(executed, 0);
  assert.deepEqual(first.messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(JSON.parse(first.messages.at(-1).content).code, "MAX_TURNS");
  const second = await harness.run({ messages: first.messages, maxTurns: 1 });
  assert.equal(second.status, "completed");
  assert.equal(second.response.content, "continued");
  await harness.dispose();
});

test("model transport failures end the run with a visible error", async () => {
  const events = [];
  const harness = await createHarness({
    model: {
      id: "transport-error",
      async *stream() { throw new Error("provider unavailable"); },
    },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "hello" }], onEvent: (event) => events.push(event.type) });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_ERROR");
  assert.match(result.error.message, /provider unavailable/);
  assert.deepEqual(events.slice(-2), ["run-error", "run-finished"]);
  await harness.dispose();
});

test("hostile model errors still end the run visibly", async () => {
  const source = new Error("provider failed");
  const error = new Proxy(source, {
    get(target, key, receiver) {
      if (key === "message" || key === "name") throw new Error("blocked error property");
      return Reflect.get(target, key, receiver);
    },
  });
  const harness = await createHarness({ model: { id: "hostile-error", async *stream() { throw error; } } });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "MODEL_ERROR");
    assert.equal(result.error.message, "Operation failed.");
  } finally {
    await harness.dispose();
  }
});

test("hostile cancellation reasons use a safe abort error", async () => {
  const source = new Error("cancel");
  const reason = new Proxy(source, { getPrototypeOf() { throw new Error("blocked prototype"); } });
  const controller = new AbortController();
  controller.abort(reason);
  let streamed = false;
  const harness = await createHarness({ model: { id: "hostile-abort", async *stream() { streamed = true; yield completed("unexpected"); } } });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }], signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.error, { code: "ABORTED", message: "Operation cancelled." });
    assert.equal(streamed, false);
  } finally {
    await harness.dispose();
  }
});

test("the Harness contains unreadable cancellation reason access", async () => {
  const signal = {
    aborted: true,
    get reason() { throw new Error("blocked reason getter"); },
    addEventListener() {},
    removeEventListener() {},
  };
  let streamed = false;
  const harness = await createHarness({ model: { id: "unreadable-harness-abort", async *stream() { streamed = true; yield completed("unexpected"); } } });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }], signal });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.error, { code: "ABORTED", message: "Operation cancelled." });
    assert.equal(streamed, false);
  } finally {
    await harness.dispose();
  }
});

test("unreadable cancellation reasons still return a cancelled run", async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    get reason() { throw new Error("blocked reason getter"); },
    addEventListener(type, listener) { if (type === "abort") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "abort") listeners.delete(listener); },
    trigger() {
      this.aborted = true;
      for (const listener of listeners) listener();
    },
  };
  const agent = new Agent({
    id: "unreadable-abort",
    stream({ signal: modelSignal }) {
      return (async function* () {
        await new Promise((resolve) => modelSignal.addEventListener("abort", resolve, { once: true }));
      })();
    },
  }, new BrowserPageRuntime());
  const running = agent.run({ messages: [{ role: "user", content: "wait" }], signal });
  setTimeout(() => signal.trigger(), 0);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.error, { code: "ABORTED", message: "Operation cancelled." });
});

test("non-string error messages stay out of public run results", async () => {
  const error = new Error("provider failed");
  error.message = { unsafe: true };
  assert.deepEqual(errorInfo(error, "MODEL_ERROR"), { code: "MODEL_ERROR", message: "Operation failed." });
  const harness = await createHarness({ model: { id: "non-string-error", async *stream() { throw error; } } });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, { code: "MODEL_ERROR", message: "Operation failed." });
    assert.doesNotThrow(() => JSON.stringify(result));
  } finally {
    await harness.dispose();
  }
});

test("accessor-backed assistant output is rejected before use", async () => {
  let reads = 0;
  const message = { role: "assistant", get content() { reads += 1; return reads === 1 ? "ok" : { length: 1 }; } };
  const harness = await createHarness({ model: { id: "accessor-assistant", async *stream() { yield { type: "completed", message }; } } });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
  } finally {
    await harness.dispose();
  }
});

test("accessor-backed direct tool calls are rejected before execution", async () => {
  let executed = 0;
  const call = {};
  Object.defineProperties(call, {
    id: { enumerable: true, get: () => "accessor-call" },
    name: { enumerable: true, get: () => "page.run" },
    arguments: { enumerable: true, value: { code: "return 1" } },
  });
  const harness = await createHarness({
    model: {
      id: "accessor-direct-tool-call",
      async *stream() {
        yield { type: "tool-call", call };
        yield completed("unused");
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: 1, logs: [], durationMs: 0 }; } },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
    assert.equal(executed, 0);
  } finally {
    await harness.dispose();
  }
});

test("cancellation during assistant delivery wins over completion", async () => {
  const controller = new AbortController();
  const harness = await createHarness({
    model: { id: "assistant-cancel", async *stream() { yield completed("done"); } },
  });
  const result = await harness.run({
    messages: [{ role: "user", content: "go" }],
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "assistant-message") controller.abort(new Error("observer stopped"));
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "ABORTED");
  assert.equal(result.messages.at(-1).content, "done");
  await harness.dispose();
});

test("model timeouts suppress late events from an uncooperative stream", async () => {
  const events = [];
  let cleanupRejection;
  const onUnhandledRejection = (error) => { cleanupRejection = error; };
  process.on("unhandledRejection", onUnhandledRejection);
  let nextCall = 0;
  const harness = await createHarness({
    model: {
      id: "late-timeout-event",
      stream() {
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            return new Promise((resolve) => setTimeout(() => resolve(nextCall++ === 0
              ? { done: false, value: { type: "text-delta", delta: "late" } }
              : { done: true, value: undefined }), 20));
          },
          return() { return Promise.reject(new Error("iterator cleanup failed")); },
        };
      },
    },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "wait" }], modelTimeoutMs: 5, onEvent: (event) => events.push(event.type) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "MODEL_TIMEOUT");
    assert.equal(events.includes("text-delta"), false);
    assert.deepEqual(events.slice(-2), ["run-error", "run-finished"]);
    assert.equal(cleanupRejection, undefined);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await harness.dispose();
  }
});

test("model cancellation preserves the signal reason", async () => {
  let started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  const harness = await createHarness({
    model: {
      id: "reason-preserving-cancel",
      stream({ signal }) {
        started();
        return (async function* () {
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
        })();
      },
    },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "wait" }], signal: controller.signal });
  await modelStarted;
  controller.abort(new HarnessError("MODEL_REPLACED", "connection changed"));
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "MODEL_REPLACED");
  await harness.dispose();
});

test("non-error cancellation reasons still return a cancelled run", async () => {
  let started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  const harness = await createHarness({
    model: {
      id: "non-error-cancel",
      stream({ signal }) {
        started();
        return (async function* () {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })();
      },
    },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "wait" }], signal: controller.signal });
  await modelStarted;
  controller.abort("stop");
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.error, { code: "ABORTED", message: "Operation cancelled." });
  await harness.dispose();
});

test("page tool cancellation preserves the signal reason", async () => {
  let started;
  const toolStarted = new Promise((resolve) => { started = resolve; });
  const runtime = new BrowserPageRuntime();
  const harness = await createHarness({
    model: {
      id: "page-tool-reason-preserving-cancel",
      async *stream() {
        yield completed("", [{ id: "tool-1", name: "page.run", arguments: { code: "await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return 1" } }]);
      },
    },
    pageRuntime: { execute(code, input, options) { started(); return runtime.execute(code, input, options); } },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "wait" }], signal: controller.signal });
  await toolStarted;
  controller.abort(new HarnessError("MODEL_REPLACED", "connection changed"));
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "MODEL_REPLACED");
  assert.equal(JSON.parse(result.messages.at(-1).content).code, "MODEL_REPLACED");
  await harness.dispose();
});

test("page tool cancellation prefers the parent signal reason", async () => {
  let started;
  const toolStarted = new Promise((resolve) => { started = resolve; });
  const harness = await createHarness({
    model: {
      id: "page-tool-parent-reason",
      async *stream() {
        yield completed("", [{ id: "tool-1", name: "page.run", arguments: { code: "return 1" } }]);
      },
    },
    pageRuntime: {
      execute(_code, _input, { signal }) {
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("different abort failure")), { once: true }));
      },
    },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "wait" }], signal: controller.signal });
  await toolStarted;
  controller.abort(new HarnessError("MODEL_REPLACED", "connection changed"));
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "MODEL_REPLACED");
  assert.equal(JSON.parse(result.messages.at(-1).content).code, "MODEL_REPLACED");
  await harness.dispose();
});

test("tool execution catches an abort between the parent check and relay registration", async () => {
  const reason = new HarnessError("MODEL_CLEARED", "connection cleared");
  let abortListeners = 0;
  let executed = 0;
  const signal = {
    aborted: false,
    reason,
    addEventListener() {
      abortListeners += 1;
      if (abortListeners === 3) this.aborted = true;
    },
    removeEventListener() {},
  };
  const agent = new Agent({
    id: "tool-relay-race",
    async *stream() {
      yield completed("", [{ id: "tool-1", name: "page.run", arguments: { code: "return 1" } }]);
    },
  }, {
    execute() {
      executed += 1;
      return Promise.resolve({ value: 1, logs: [], durationMs: 0 });
    },
  });
  const result = await agent.run({ messages: [{ role: "user", content: "wait" }], signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "MODEL_CLEARED");
  assert.equal(executed, 0);
  assert.equal(JSON.parse(result.messages.at(-1).content).code, "MODEL_CLEARED");
});

test("model streaming does not start after a relay race abort", async () => {
  const reason = new HarnessError("MODEL_REPLACED", "connection changed");
  let streamCalls = 0;
  const signal = {
    aborted: false,
    reason,
    addEventListener() { this.aborted = true; },
    removeEventListener() {},
  };
  const agent = new Agent({
    id: "model-relay-race",
    stream() {
      streamCalls += 1;
      return (async function* () { yield completed("unexpected"); })();
    },
  }, {
    execute() {
      throw new Error("must not execute");
    },
  });
  const result = await agent.run({ messages: [{ role: "user", content: "wait" }], signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.error.code, "MODEL_REPLACED");
  assert.equal(streamCalls, 0);
});

test("event observers cannot mutate calls or final results", async () => {
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "immutable-events",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "tool-1", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          assert.equal(JSON.parse(messages.at(-1).content).value, 1);
          yield completed("done");
        }
      },
    },
  });
  const result = await harness.run({
    messages: [{ role: "user", content: "run" }],
    onEvent: (event) => {
      if (event.type === "tool-started") event.call.arguments.code = "return 99";
      if (event.type === "run-finished") event.result.status = "failed";
    },
  });
  assert.equal(result.status, "completed");
  await harness.dispose();
});

test("async observers cannot create unhandled rejections", async () => {
  const unhandled = [];
  const onUnhandledRejection = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  const harness = await createHarness({
    model: { id: "async-observers", async *stream() { yield completed("done"); } },
  });
  const unsubscribe = harness.subscribe(async () => { throw new Error("listener failed"); });
  try {
    const result = await harness.run({
      messages: [{ role: "user", content: "go" }],
      onEvent: async () => { throw new Error("event failed"); },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(result.status, "completed");
    assert.deepEqual(unhandled, []);
  } finally {
    unsubscribe();
    process.off("unhandledRejection", onUnhandledRejection);
    await harness.dispose();
  }
});

test("immutable event snapshots do not freeze caller-owned values", async () => {
  const value = { answer: 42 };
  const usage = { inputTokens: 1 };
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "snapshot-ownership",
      async *stream() {
        if (turn++ === 0) {
          yield { type: "completed", message: { role: "assistant", content: "", toolCalls: [{ id: "value", name: "page.run", arguments: { code: "return 1" } }] }, usage };
        } else {
          yield { type: "completed", message: { role: "assistant", content: "done" } };
        }
      },
    },
    pageRuntime: { async execute() { return { value, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "run" }] });
  assert.equal(result.status, "completed");
  assert.equal(Object.isFrozen(value), false);
  assert.equal(Object.isFrozen(usage), false);
  await harness.dispose();
});

test("malformed tool history is rejected at the run boundary", async () => {
  const harness = await createHarness({ model: { id: "history-validation", async *stream() { yield completed("unused"); } } });
  const result = await harness.run({ messages: [{ role: "tool", callId: "call-1", name: "page.run", content: "{}", isError: "true" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MESSAGES");
  await harness.dispose();
});

test("message fields must survive the JSON clone boundary", async () => {
  const message = {};
  Object.defineProperty(message, "role", { value: "user" });
  Object.defineProperty(message, "content", { value: "hidden" });
  let modelCalls = 0;
  const harness = await createHarness({ model: { id: "hidden-message", async *stream() { modelCalls += 1; yield completed("unused"); } } });
  const result = await harness.run({ messages: [message] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MESSAGES");
  assert.equal(modelCalls, 0);
  await harness.dispose();
});

test("message fields cannot come from the prototype chain", async () => {
  const keys = ["role", "content"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  for (const key of keys) Object.defineProperty(Object.prototype, key, { configurable: true, value: key === "role" ? "user" : "inherited" });
  const message = {};
  let modelCalls = 0;
  const harness = await createHarness({ model: { id: "inherited-message", async *stream() { modelCalls += 1; yield completed("unused"); } } });
  let running;
  try {
    running = harness.run({ messages: [message] });
  } finally {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
  try {
    const result = await running;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "INVALID_MESSAGES");
    assert.equal(modelCalls, 0);
  } finally {
    await harness.dispose();
  }
});

test("model event fields cannot come from the prototype chain", async () => {
  const keys = ["type", "delta"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  Object.defineProperty(Object.prototype, "type", { configurable: true, value: "text-delta" });
  Object.defineProperty(Object.prototype, "delta", { configurable: true, value: "polluted" });
  try {
    for (const event of [{ type: "text-delta" }, {}]) {
      const harness = await createHarness({ model: { id: "inherited-event", async *stream() { yield event; } } });
      try {
        const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "INVALID_MODEL_OUTPUT");
        assert.equal(result.partial, undefined);
      } finally {
        await harness.dispose();
      }
    }
  } finally {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
});

test("tool history requires matching preceding calls", async () => {
  for (const messages of [
    [{ role: "user", content: "go" }, { role: "tool", callId: "missing", name: "page.run", content: "{}" }],
    [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ id: "unfinished", name: "page.run", arguments: { code: "return 1" } }] }],
    [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ id: "named", name: "page.run", arguments: { code: "return 1" } }] }, { role: "tool", callId: "named", name: "other", content: "{}" }],
  ]) {
    let modelCalls = 0;
    const harness = await createHarness({ model: { id: "history-sequence", async *stream() { modelCalls += 1; yield completed("unused"); } } });
    const result = await harness.run({ messages });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "INVALID_MESSAGES");
    assert.equal(modelCalls, 0);
    await harness.dispose();
  }
});

test("cancellation returns streamed partial output", async () => {
  const harness = await createHarness({
    model: {
      id: "slow",
      stream({ signal }) {
        return (async function* () {
          yield { type: "text-delta", delta: "partial" };
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })();
      },
    },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "stop" }], signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.partial.content, "partial");
  await harness.dispose();
});

test("cancellation can preempt a burst without an event observer", async () => {
  let emitted = 0;
  const harness = await createHarness({
    model: {
      id: "burst-without-observer",
      async *stream() {
        for (; emitted < 100000; emitted += 1) yield { type: "text-delta", delta: "x" };
        yield completed("done");
      },
    },
  });
  const controller = new AbortController();
  const running = harness.run({ messages: [{ role: "user", content: "stop" }], signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stop")), 0);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.ok(emitted < 100000);
  await harness.dispose();
});

test("cancellation closes every pending tool call in the returned history", async () => {
  const controller = new AbortController();
  const harness = await createHarness({
    model: {
      id: "cancel-tools",
      async *stream() {
        yield completed("", [
          { id: "first", name: "page.run", arguments: { code: "return 1" } },
          { id: "second", name: "page.run", arguments: { code: "return 2" } },
        ]);
      },
    },
    pageRuntime: {
      execute(_code, _input, { signal }) {
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  });
  const running = harness.run({ messages: [{ role: "user", content: "stop" }], signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "tool", "tool"]);
  assert.deepEqual(result.messages.slice(-2).map((message) => [message.callId, message.isError, JSON.parse(message.content).code]), [
    ["first", true, "ABORTED"],
    ["second", true, "ABORTED"],
  ]);
  await harness.dispose();
});

test("cancellation closes a tool that resolves after abort", async () => {
  const controller = new AbortController();
  const harness = await createHarness({
    model: {
      id: "late-tool-result",
      async *stream() {
        yield completed("", [{ id: "late", name: "page.run", arguments: { code: "return 1" } }]);
      },
    },
    pageRuntime: {
      execute() {
        return new Promise((resolve) => setTimeout(() => resolve({ value: 1, logs: [], durationMs: 0 }), 20));
      },
    },
  });
  const running = harness.run({ messages: [{ role: "user", content: "stop" }], signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(JSON.parse(result.messages.at(-1).content).code, "ABORTED");
  await harness.dispose();
});

test("cancellation preempts an uncooperative page runtime", async () => {
  const controller = new AbortController();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const harness = await createHarness({
    model: {
      id: "never-ending-tool",
      async *stream() {
        yield completed("", [{ id: "never", name: "page.run", arguments: { code: "return 1" } }]);
      },
    },
    pageRuntime: {
      execute() {
        resolveStarted();
        return new Promise(() => {});
      },
    },
  });
  try {
    const running = harness.run({ messages: [{ role: "user", content: "stop" }], signal: controller.signal });
    await started;
    controller.abort(new Error("stop"));
    const result = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve({ status: "probe-timeout" }), 50)),
    ]);
    assert.equal(result.status, "cancelled");
    assert.equal(JSON.parse(result.messages.at(-1).content).code, "ABORTED");
  } finally {
    await harness.dispose();
  }
});

test("completed model turns remove their cancellation listeners", async () => {
  class TrackingSignal {
    aborted = false;
    reason = undefined;
    listeners = new Set();

    addEventListener(type, listener) {
      if (type === "abort") this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === "abort") this.listeners.delete(listener);
    }
  }

  const signal = new TrackingSignal();
  const agent = new Agent({ id: "listener-probe", async *stream() { yield completed("ok"); } }, new BrowserPageRuntime());
  for (let index = 0; index < 5; index += 1) {
    const result = await agent.run({ messages: [{ role: "user", content: String(index) }], signal });
    assert.equal(result.status, "completed");
  }
  assert.equal(signal.listeners.size, 0);
});

test("abort listener cleanup cannot replace completed runs", async () => {
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener() {},
    removeEventListener() { throw new Error("cleanup blocked"); },
  };
  const agent = new Agent({ id: "cleanup-probe", async *stream() { yield completed("ok"); } }, new BrowserPageRuntime());
  const agentResult = await agent.run({ messages: [{ role: "user", content: "go" }], signal });
  assert.equal(agentResult.status, "completed");

  let toolTurn = 0;
  const toolAgent = new Agent({
    id: "cleanup-tool",
    async *stream() {
      if (toolTurn++ === 0) yield completed("", [{ id: "tool", name: "page.run", arguments: { code: "return 1" } }]);
      else yield completed("ok");
    },
  }, { async execute() { return { value: 1, logs: [], durationMs: 0 }; } });
  const toolResult = await toolAgent.run({ messages: [{ role: "user", content: "go" }], signal });
  assert.equal(toolResult.status, "completed");
  assert.equal(JSON.parse(toolResult.messages[2].content).value, 1);

  const harness = await createHarness({ model: { id: "cleanup-harness", async *stream() { yield completed("ok"); } } });
  try {
    const harnessResult = await harness.run({ messages: [{ role: "user", content: "go" }], signal });
    assert.equal(harnessResult.status, "completed");
    assert.equal(harness.activeRuns.size, 0);
  } finally {
    await harness.dispose();
  }
});

test("invalid page runtime results return an error to the model", async () => {
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "invalid-runtime-result",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "invalid", name: "page.run", arguments: { code: "return 1" } }]);
        } else {
          assert.equal(messages.at(-1).isError, true);
          yield completed("recovered");
        }
      },
    },
    pageRuntime: { async execute() { return Object.create({ value: 1, logs: [], durationMs: 0 }); } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "try" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "recovered");
  assert.match(result.messages[2].content, /INVALID_PAGE_RUNTIME_RESULT/);
  await harness.dispose();
});

test("page tool input cannot come from the prototype chain", async () => {
  const key = "input";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, { configurable: true, value: { polluted: true } });
  let turn = 0;
  let seenInput;
  const harness = await createHarness({
    model: {
      id: "inherited-page-input",
      async *stream() {
        if (turn++ === 0) {
          yield completed("", [{ id: "input", name: "page.run", arguments: { code: "return input" } }]);
        } else {
          yield completed("recovered");
        }
      },
    },
    pageRuntime: {
      async execute(_code, input) {
        seenInput = input;
        return { value: input, logs: [], durationMs: 0 };
      },
    },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "completed");
    assert.equal(seenInput, null);
    assert.deepEqual(JSON.parse(result.messages[2].content).value, null);
  } finally {
    await harness.dispose();
    if (previous === undefined) delete Object.prototype[key];
    else Object.defineProperty(Object.prototype, key, previous);
  }
});

test("optional run limits cannot come from the prototype chain", async () => {
  const key = "maxTurns";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, { configurable: true, value: 1 });
  let turn = 0;
  let executed = 0;
  const harness = await createHarness({
    model: {
      id: "inherited-run-limit",
      async *stream({ messages }) {
        if (turn++ === 0) yield completed("", [{ id: "call", name: "page.run", arguments: { code: "return 1" } }]);
        else {
          assert.equal(messages.at(-1)?.role, "tool");
          yield completed("done");
        }
      },
    },
    pageRuntime: { async execute() { executed += 1; return { value: 1, logs: [], durationMs: 0 }; } },
  });
  try {
    const result = await harness.run({ messages: [{ role: "user", content: "go" }] });
    assert.equal(result.status, "completed");
    assert.equal(executed, 1);
  } finally {
    await harness.dispose();
    if (previous === undefined) delete Object.prototype[key];
    else Object.defineProperty(Object.prototype, key, previous);
  }
});

test("tool timeout reports its elapsed duration", async () => {
  let turn = 0;
  const harness = await createHarness({
    model: {
      id: "tool-timeout",
      async *stream({ messages }) {
        if (turn++ === 0) {
          yield completed("", [{ id: "slow", name: "page.run", arguments: { code: "await new Promise(() => {})" } }]);
        } else {
          const tool = messages.at(-1);
          assert.equal(tool.isError, true);
          assert.equal(JSON.parse(tool.content).code, "TOOL_TIMEOUT");
          assert.ok(tool.durationMs > 0);
          yield completed("recovered");
        }
      },
    },
    pageRuntime: {
      execute(_code, _input, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "wait" }], toolTimeoutMs: 10 });
  assert.equal(result.status, "completed");
  await harness.dispose();
});

test("a Harness without a model fails explicitly and disposal is final", async () => {
  const harness = await createHarness();
  const statuses = [];
  harness.subscribe((snapshot) => statuses.push(snapshot.status));
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "MODEL_NOT_CONNECTED");
  await harness.dispose();
  assert.deepEqual(statuses, ["active", "disposed"]);
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "HARNESS_DISPOSED");
});

test("a disposed Harness does not retain late subscribers", async () => {
  const harness = await createHarness();
  await harness.dispose();
  harness.subscribe(() => {});
  assert.equal(harness.listeners.size, 0);
});
