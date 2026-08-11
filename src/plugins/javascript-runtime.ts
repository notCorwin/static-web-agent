import type { JavaScriptRuntime, JsonObject, Plugin, ToolDefinition } from "../core/types.js";

const tool: ToolDefinition = {
  name: "runtime.javascript",
  description: "Run JavaScript in a time-limited worker without passing it agent capabilities.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: 100_000 },
      input: {},
    },
    required: ["code"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      value: {},
      logs: { type: "array", items: { type: "string" } },
      durationMs: { type: "number", minimum: 0 },
    },
    required: ["value", "logs", "durationMs"],
    additionalProperties: false,
  },
  requiredCapabilities: ["runtime"],
  execute: async (input, context) => {
    const object = input as JsonObject;
    const runtime = await context.getCapability<JavaScriptRuntime>("runtime");
    const result = await runtime.execute(object.code as string, object.input ?? null, { signal: context.signal });
    return { value: result.value, logs: [...result.logs], durationMs: result.durationMs };
  },
};

export function createJavaScriptRuntimePlugin(): Plugin {
  return {
    manifest: {
      apiVersion: "1",
      id: "javascript-runtime",
      name: "JavaScript runtime",
      version: "1.0.0",
      description: "A worker runtime for small JavaScript transformations.",
      permissions: [{ name: "runtime", reason: "Execute code supplied by the agent in a time-limited worker." }],
    },
    setup(context) {
      context.registerTool(tool);
    },
  };
}
