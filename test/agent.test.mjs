import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageRuntime, HarnessError, createHarness } from "../dist/index.js";

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

test("a Harness without a model fails explicitly and disposal is final", async () => {
  const harness = await createHarness();
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "MODEL_NOT_CONNECTED");
  await harness.dispose();
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof HarnessError && error.code === "HARNESS_DISPOSED");
});
