import type { JsonObject, PageRuntime, Plugin, ToolDefinition } from "../core/types.js";

const resultSchema = {
  type: "object" as const,
  properties: {
    value: {},
    logs: { type: "array" as const, items: { type: "string" as const } },
    durationMs: { type: "number" as const, minimum: 0 },
  },
  required: ["value", "logs", "durationMs"],
  additionalProperties: false,
};

const evaluateTool: ToolDefinition = {
  name: "browser.evaluate",
  description: "Execute async JavaScript in the current page's main browser realm. Use actual Web APIs such as window, document, navigator, location, fetch, localStorage, indexedDB, crypto, WebSocket, timers, and DOM events. Return a JSON-serializable value; use input for structured data and signal for cooperative cancellation. This does not provide host shell, arbitrary filesystem, or other-tab access.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: 100_000 },
      input: {},
    },
    required: ["code"],
    additionalProperties: false,
  },
  outputSchema: resultSchema,
  requiredCapabilities: ["page"],
  execute: async (input, context) => {
    const object = input as JsonObject;
    const page = await context.getCapability<PageRuntime>("page");
    const result = await page.execute(object.code as string, object.input ?? null, { signal: context.signal });
    return { value: result.value, logs: [...result.logs], durationMs: result.durationMs };
  },
};

const inspectTool: ToolDefinition = {
  name: "browser.inspect",
  description: "Inspect the current page runtime and discover its location, document state, viewport, and common Web API availability before using browser.evaluate.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  requiredCapabilities: ["page"],
  execute: async (_, context) => {
    const page = await context.getCapability<PageRuntime>("page");
    const result = await page.execute(`return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight },
      apis: {
        document: typeof document !== "undefined",
        fetch: typeof fetch === "function",
        localStorage: typeof localStorage !== "undefined",
        indexedDB: typeof indexedDB !== "undefined",
        crypto: typeof crypto !== "undefined",
        webSocket: typeof WebSocket === "function",
        broadcastChannel: typeof BroadcastChannel === "function",
        notifications: typeof Notification === "function",
        clipboard: typeof navigator?.clipboard !== "undefined",
        workers: typeof Worker === "function",
      },
    };`, null, { signal: context.signal });
    return result.value;
  },
};

export function createBrowserApiPlugin(): Plugin {
  return {
    manifest: {
      apiVersion: "1",
      id: "browser-api",
      name: "Browser API",
      version: "1.0.0",
      description: "A general page-realm interface for the Web APIs available to this tab.",
      permissions: [{ name: "page", reason: "Execute agent-requested JavaScript with the current page's Web APIs." }],
    },
    setup(context) {
      context.registerTool(inspectTool);
      context.registerTool(evaluateTool);
    },
  };
}
