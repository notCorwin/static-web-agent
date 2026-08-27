import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore, createHarness } from "../dist/index.js";

// THE public contract of the harness: one function, four concepts
// (model adapter, tool, optional permission gate, run loop).

function fakeContainer() {
  const children = [];
  return {
    children,
    ownerDocument: {
      createElement() {
        return { dataset: {}, textContent: "", removed: false, remove() { this.removed = true; } };
      },
    },
    append(slot) { children.push(slot); },
  };
}

test("the minimal contract: a run loop over a plain model and plain tools", async () => {
  let requestedTools;
  const model = {
    id: "contract-model",
    async *stream({ messages, tools }) {
      requestedTools = tools.map((tool) => tool.name);
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "completed", message: { role: "assistant", content: "echo completed" } };
        return;
      }
      yield {
        type: "completed",
        message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "demo.echo", arguments: { value: "hello" } }] },
      };
    },
  };
  const echoTool = {
    name: "demo.echo",
    description: "Return the supplied value.",
    inputSchema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    execute: (input) => input,
  };

  const agent = await createHarness({
    defaultPlugins: false,
    stateStore: new MemoryStateStore(),
    model,
    tools: [echoTool],
  });
  assert.equal(agent.snapshot().selectedModelId, "contract-model");

  const events = [];
  const result = await agent.run({
    messages: [{ role: "user", content: "run the demo" }],
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.response?.content, "echo completed");
  assert.deepEqual(requestedTools, ["demo.echo"]);
  assert.ok(events.includes("tool-started"));
  assert.ok(events.includes("run-finished"));

  // Cancellation stays part of the base contract.
  const controller = new AbortController();
  controller.abort();
  const cancelled = await agent.run({ messages: [], signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");

  await agent.dispose();
  assert.equal(agent.snapshot().status, "disposed");
});

test("the plugin surface remains available for third-party contributions", async () => {
  const agent = await createHarness({
    defaultPlugins: false,
    stateStore: new MemoryStateStore(),
    plugins: [
      {
        manifest: { apiVersion: "1", id: "processor-plugin", name: "Processor", version: "1.0.0", permissions: [] },
        setup(context) {
          context.registerProcessor({ id: "upper", description: "Uppercase strings.", process: (value) => typeof value === "string" ? value.toUpperCase() : value });
          context.registerUi({ id: "slot", mount: (container) => { container.textContent = "mounted"; } });
        },
      },
    ],
  });
  assert.deepEqual(agent.snapshot().manifests.map((manifest) => manifest.id), ["processor-plugin"]);

  // Advanced surfaces live behind `kernel`, off the default facade.
  assert.equal(await agent.kernel.process("hello"), "HELLO");
  const container = fakeContainer();
  const unmount = agent.kernel.mountUi(container);
  assert.equal(container.children[0].textContent, "mounted");
  unmount();

  await agent.dispose();
});
