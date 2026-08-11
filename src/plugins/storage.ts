import type { JsonObject, Plugin, StorageCapability, ToolDefinition } from "../core/types.js";

const tool: ToolDefinition = {
  name: "storage.local",
  description: "Read, write, remove, or list values in the plugin's isolated local state namespace.",
  inputSchema: {
    type: "object",
    anyOf: [
      { type: "object", properties: { action: { const: "get" }, key: { type: "string", minLength: 1 } }, required: ["action", "key"], additionalProperties: false },
      { type: "object", properties: { action: { const: "set" }, key: { type: "string", minLength: 1 }, value: {} }, required: ["action", "key", "value"], additionalProperties: false },
      { type: "object", properties: { action: { const: "remove" }, key: { type: "string", minLength: 1 } }, required: ["action", "key"], additionalProperties: false },
      { type: "object", properties: { action: { const: "list" } }, required: ["action"], additionalProperties: false },
    ],
  },
  execute: async (input, context) => {
    const object = input as JsonObject;
    const storage = await context.getCapability<StorageCapability>("storage");
    const action = object.action as string;
    const key = object.key as string | undefined;
    switch (action) {
      case "get": {
        const value = await storage.get(key as string);
        return { value: value ?? null };
      }
      case "set":
        await storage.set(key as string, object.value ?? null);
        return { saved: true };
      case "remove":
        await storage.remove(key as string);
        return { removed: true };
      case "list":
        return { keys: [...await storage.keys()] };
      default:
        throw new Error(`Unknown storage action “${action}”.`);
    }
  },
};

export function createStoragePlugin(): Plugin {
  return {
    manifest: {
      apiVersion: "1",
      id: "local-storage",
      name: "Local storage",
      version: "1.0.0",
      description: "An opt-in, namespaced tool for local browser state.",
      permissions: [{ name: "storage", reason: "Read and write values in this plugin's local namespace." }],
    },
    setup(context) {
      context.registerTool(tool);
    },
  };
}