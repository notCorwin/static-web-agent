import type { JsonObject, StateStore } from "../core/types.js";

export const CONNECTION_SETTINGS_KEY = "app:connection-settings";

export interface ConnectionSettings extends JsonObject {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectionSettings(value: unknown): value is ConnectionSettings {
  return isRecord(value)
    && typeof value.endpoint === "string"
    && typeof value.model === "string"
    && typeof value.apiKey === "string";
}

export async function loadConnectionSettings(store: StateStore): Promise<ConnectionSettings | undefined> {
  const value = await store.get(CONNECTION_SETTINGS_KEY);
  return isConnectionSettings(value) ? value : undefined;
}

export async function saveConnectionSettings(store: StateStore, settings: ConnectionSettings): Promise<void> {
  await store.set(CONNECTION_SETTINGS_KEY, {
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey: settings.apiKey,
  });
}
