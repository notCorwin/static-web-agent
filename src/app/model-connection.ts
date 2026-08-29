import type { Harness } from "../harness.js";
import { AiSdkAdapter, type BrowserFetcher } from "../adapters/ai-sdk.js";
import { loadConnectionSettings, saveConnectionSettings, type ConnectionSettings } from "./connection-settings.js";

export interface RestoredConnection {
  readonly settings?: ConnectionSettings;
  readonly source: "local" | "none";
}

export interface ModelConnectionResult {
  readonly saved: boolean;
}

export interface ModelConnection {
  readonly restore: () => RestoredConnection;
  readonly connect: (settings: ConnectionSettings) => Promise<ModelConnectionResult>;
}

export interface ModelConnectionOptions {
  readonly harness: Harness;
  readonly fetcher?: BrowserFetcher;
}

export function createModelConnection(options: ModelConnectionOptions): ModelConnection {
  return {
    restore: () => {
      const settings = loadConnectionSettings();
      return settings === undefined ? { source: "none" } : { settings, source: "local" };
    },
    connect: async (settings) => {
      const fetcher = options.fetcher ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) as BrowserFetcher : undefined);
      if (fetcher === undefined) throw new Error("This browser does not provide fetch.");
      const model = new AiSdkAdapter({
        id: "openai-compatible",
        endpoint: settings.endpoint,
        model: settings.model,
        ...(settings.apiKey.length === 0 ? {} : { apiKey: settings.apiKey }),
        fetcher,
      });
      options.harness.setModel(model);
      saveConnectionSettings(settings);
      return { saved: true };
    },
  };
}
