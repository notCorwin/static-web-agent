import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore, createBrowserAgentHarness } from "../dist/index.js";

test("the README light-entry consumer example completes a tool loop", async () => {
  const demo = {
    manifest: {
      apiVersion: "1",
      id: "demo-plugin",
      name: "Demo",
      version: "1.0.0",
      permissions: [],
    },
    setup(context) {
      context.registerTool({
        name: "demo.echo",
        description: "Return the supplied value.",
        inputSchema: {
          type: "object",
          properties: { value: {} },
          required: ["value"],
          additionalProperties: false,
        },
        execute: (input) => input,
      });
      context.registerModelAdapter({
        id: "demo-model",
        async *stream({ messages }) {
          if (messages.some((message) => message.role === "tool")) {
            yield { type: "completed", message: { role: "assistant", content: "tool completed" } };
            return;
          }
          yield {
            type: "completed",
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "demo.echo", arguments: { value: "hello" } }],
            },
          };
        },
      });
    },
  };

  const harness = await createBrowserAgentHarness({
    defaultPlugins: false,
    plugins: [demo],
    stateStore: new MemoryStateStore(),
    initialModelId: "demo-model",
  });
  const result = await harness.run({ messages: [{ role: "user", content: "run the demo" }] });
  assert.equal(result.response?.content, "tool completed");
  await harness.dispose();
});
