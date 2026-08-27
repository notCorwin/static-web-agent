import type { HarnessPluginHandle } from "../harness.js";
import type { Plugin, StateStore } from "../core/types.js";
import { DEFAULT_THINKING_LEVEL, isConnectionSettings, saveConnectionSettings, THINKING_LEVELS, type ConnectionSettings } from "./connection-settings.js";

export interface ConnectionDraft {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel: string;
  readonly supportsVision: boolean;
}

export interface ConnectionFieldErrors {
  readonly endpoint?: string;
  readonly model?: string;
}

export interface ConnectionValidation {
  readonly settings?: ConnectionSettings;
  readonly errors: ConnectionFieldErrors;
}

export interface StoredConnectionCredential {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface CredentialAdapter {
  readonly read?: () => Promise<StoredConnectionCredential | undefined>;
  readonly save?: (settings: ConnectionSettings) => Promise<void>;
}

export interface RestoredConnection {
  readonly settings?: ConnectionSettings;
  readonly source: "credential" | "local" | "none";
}

export interface ModelConnectionResult {
  readonly credentialSaved: boolean;
}

export interface ModelConnection {
  readonly restore: (savedSettings?: ConnectionSettings) => Promise<RestoredConnection>;
  readonly connect: (settings: ConnectionSettings) => Promise<ModelConnectionResult>;
}

function isThinkingLevel(value: string): value is ConnectionSettings["thinkingLevel"] {
  return THINKING_LEVELS.includes(value as ConnectionSettings["thinkingLevel"]);
}

export function validateConnectionDraft(draft: ConnectionDraft): ConnectionValidation {
  const endpoint = draft.endpoint.trim();
  const model = draft.model.trim();
  const errors: { endpoint?: string; model?: string } = {};
  if (!endpoint) errors.endpoint = "Enter the model endpoint.";
  else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      errors.endpoint = "Use an http:// or https:// endpoint.";
    }
  }
  if (!model) errors.model = "Enter a model name.";
  if (errors.endpoint !== undefined || errors.model !== undefined) return { errors };
  return {
    errors: {},
    settings: {
      endpoint,
      model,
      apiKey: draft.apiKey,
      thinkingLevel: isThinkingLevel(draft.thinkingLevel) ? draft.thinkingLevel : DEFAULT_THINKING_LEVEL,
      supportsVision: draft.supportsVision,
    },
  };
}

function browserEndpoint(value: unknown): string {
  if (typeof value !== "string") return "";
  const endpoint = value.trim();
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:" ? endpoint : "";
  } catch {
    return "";
  }
}

interface BrowserPasswordCredentialData {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly password?: unknown;
}

interface BrowserCredentialManager {
  readonly get?: (options: { readonly password: true; readonly mediation: "silent" }) => Promise<unknown>;
  readonly store?: (credential: unknown) => Promise<unknown>;
}

function browserCredentialManager(): BrowserCredentialManager | undefined {
  const credentials = (navigator as Navigator & { readonly credentials?: unknown }).credentials;
  if (typeof credentials !== "object" || credentials === null) return undefined;
  const manager = credentials as BrowserCredentialManager;
  if (typeof manager.get !== "function" && typeof manager.store !== "function") return undefined;
  return manager;
}

export function createBrowserCredentialAdapter(): CredentialAdapter {
  return {
    read: async () => {
      const credentials = browserCredentialManager();
      const get = credentials?.get;
      if (credentials === undefined || get === undefined) return undefined;
      const value = await get.call(credentials, { password: true, mediation: "silent" });
      if (typeof value !== "object" || value === null) return undefined;
      const data = value as BrowserPasswordCredentialData;
      const id = typeof data.id === "string" ? data.id.trim() : "";
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const apiKey = typeof data.password === "string" ? data.password : "";
      const endpoint = browserEndpoint(name);
      if (id) {
        try {
          const parsed: unknown = JSON.parse(id);
          if (isConnectionSettings(parsed) && parsed.endpoint && parsed.model && parsed.apiKey) {
            return { endpoint: parsed.endpoint, model: parsed.model, apiKey: parsed.apiKey };
          }
        } catch {
          // The browser credential is not using the legacy serialized shape.
        }
      }
      if (id && apiKey && !browserEndpoint(id)) return { endpoint, model: id, apiKey };
      const legacyEndpoint = browserEndpoint(id);
      if (legacyEndpoint && name && apiKey) return { endpoint: legacyEndpoint, model: name, apiKey };
      return undefined;
    },
    save: async (settings) => {
      if (!settings.apiKey) return;
      const credentials = browserCredentialManager();
      const store = credentials?.store;
      const PasswordCredential = (globalThis as typeof globalThis & {
        readonly PasswordCredential?: new (data: { readonly id: string; readonly name: string; readonly password: string }) => unknown;
      }).PasswordCredential;
      if (credentials === undefined || store === undefined || PasswordCredential === undefined) return;
      const credential = new PasswordCredential({ id: settings.model, name: settings.endpoint, password: settings.apiKey });
      await store.call(credentials, credential);
    },
  };
}

interface ModelConnectionHarness {
  readonly install: (plugin: Plugin) => Promise<HarnessPluginHandle>;
  readonly selectModel: (id: string) => void;
  readonly clearModel: () => void;
}

export interface ModelConnectionOptions {
  readonly harness: ModelConnectionHarness;
  readonly store: StateStore;
  readonly credentials?: CredentialAdapter;
}

export function createModelConnection(options: ModelConnectionOptions): ModelConnection {
  const credentials = options.credentials ?? createBrowserCredentialAdapter();
  let remoteHandle: HarnessPluginHandle | undefined;

  const restore = async (savedSettings?: ConnectionSettings): Promise<RestoredConnection> => {
    let credential: StoredConnectionCredential | undefined;
    try {
      credential = await credentials.read?.();
    } catch {
      credential = undefined;
    }
    if (credential === undefined) return savedSettings === undefined
      ? { source: "none" }
      : { settings: savedSettings, source: "local" };
    const settings: ConnectionSettings = {
      endpoint: savedSettings?.endpoint || credential.endpoint,
      model: credential.model || savedSettings?.model || "",
      apiKey: credential.apiKey || savedSettings?.apiKey || "",
      thinkingLevel: savedSettings?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      supportsVision: savedSettings?.supportsVision ?? false,
    };
    return { settings, source: "credential" };
  };

  const uninstallCurrent = async (): Promise<void> => {
    const current = remoteHandle;
    remoteHandle = undefined;
    if (current !== undefined) await current.uninstall();
  };

  const rollback = async (handle: HarnessPluginHandle | undefined): Promise<void> => {
    if (handle !== undefined) {
      try { await handle.uninstall(); } catch { /* Rollback continues through a broken plugin teardown. */ }
    }
    try { options.harness.clearModel(); } catch { /* The harness may already be disposed. */ }
    if (remoteHandle === handle) remoteHandle = undefined;
  };

  return {
    restore,
    connect: async (settings) => {
      await uninstallCurrent();
      // The AI SDK (~600KB bundled) is not needed until a remote model connects.
      const { createRemoteModelPlugin } = await import("../plugins/remote-model.js");
      let handle: HarnessPluginHandle | undefined;
      try {
        handle = await options.harness.install(createRemoteModelPlugin({
          endpoint: settings.endpoint,
          model: settings.model,
          apiKey: settings.apiKey,
          supportsVision: settings.supportsVision,
          reasoning: settings.thinkingLevel,
        }));
        remoteHandle = handle;
        options.harness.selectModel("remote-model");
        await saveConnectionSettings(options.store, settings);
        let credentialSaved = true;
        if (settings.apiKey && credentials.save !== undefined) {
          try {
            await credentials.save(settings);
          } catch {
            credentialSaved = false;
          }
        }
        return { credentialSaved };
      } catch (error) {
        await rollback(handle);
        throw error;
      }
    },
  };
}
