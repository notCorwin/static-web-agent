import { LocalModelAdapter } from "../adapters/local-model.js";
import type { Plugin } from "../core/types.js";

export function createLocalModelPlugin(): Plugin {
  return {
    manifest: {
      apiVersion: "1",
      id: "local-model",
      name: "Offline assistant",
      version: "1.0.0",
      description: "A bounded local assistant for help, time, tools, and arithmetic commands.",
      permissions: [],
    },
    setup(context) {
      context.registerModelAdapter(new LocalModelAdapter());
    },
  };
}
