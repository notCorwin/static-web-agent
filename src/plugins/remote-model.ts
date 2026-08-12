import { AiSdkAdapter, type BrowserFetcher } from "../adapters/ai-sdk.js";
import type { ModelAdapter, Plugin, ReasoningLevel } from "../core/types.js";

export interface RemoteModelPluginOptions {
  readonly id?: string;
  readonly adapterId?: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly reasoning?: ReasoningLevel;
}

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

export function createRemoteModelPlugin(options: RemoteModelPluginOptions): Plugin {
  const pluginId = options.id ?? "remote-model";
  const adapterId = options.adapterId ?? pluginId;
  return {
    manifest: {
      apiVersion: "1",
      id: pluginId,
      name: "Remote model",
      version: "1.0.0",
      description: "An OpenAI-compatible model selected for the current tab.",
      permissions: [{ name: "network", reason: "Send conversation messages to the configured model endpoint." }],
    },
    async setup(context) {
      const adapter: ModelAdapter = new AiSdkAdapter({
        id: adapterId,
        endpoint: options.endpoint,
        model: options.model,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        fetcher: async (input, init) => (await context.capabilities.get<NetworkCapability>("network")).fetch(input, init),
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      });
      context.registerModelAdapter(adapter);
    },
  };
}
