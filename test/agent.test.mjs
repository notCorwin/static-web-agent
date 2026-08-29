import assert from "node:assert/strict";
import test from "node:test";
import { Agent, BrowserPageRuntime, HarnessError, createHarness } from "../dist/index.js";

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

test("model timeouts suppress late events from an uncooperative stream", async () => {
  const events = [];
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
          return() { return Promise.resolve({ done: true, value: undefined }); },
        };
      },
    },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "wait" }], modelTimeoutMs: 5, onEvent: (event) => events.push(event.type) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_TIMEOUT");
  assert.equal(events.includes("text-delta"), false);
  assert.deepEqual(events.slice(-2), ["run-error", "run-finished"]);
  await harness.dispose();
});

test("malformed tool history is rejected at the run boundary", async () => {
  const harness = await createHarness({ model: { id: "history-validation", async *stream() { yield completed("unused"); } } });
  const result = await harness.run({ messages: [{ role: "tool", callId: "call-1", name: "page.run", content: "{}", isError: "true" }] });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_MESSAGES");
  await harness.dispose();
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
    pageRuntime: { async execute() { return { value: undefined, logs: [], durationMs: 0 }; } },
  });
  const result = await harness.run({ messages: [{ role: "user", content: "try" }] });
  assert.equal(result.status, "completed");
  assert.equal(result.response.content, "recovered");
  assert.match(result.messages[2].content, /INVALID_PAGE_RUNTIME_RESULT/);
  await harness.dispose();
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
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "MODEL_NOT_CONNECTED");
  await harness.dispose();
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "HARNESS_DISPOSED");
});
