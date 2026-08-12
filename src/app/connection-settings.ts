import type { JsonObject, ReasoningLevel, StateStore } from "../core/types.js";

export const CONNECTION_SETTINGS_KEY = "app:connection-settings";
export const DEFAULT_THINKING_LEVEL: ReasoningLevel = "provider-default";
export const THINKING_LEVELS: readonly ReasoningLevel[] = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"];

export interface ConnectionSettings extends JsonObject {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel: ReasoningLevel;
  readonly supportsVision: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ReasoningLevel);
}

export function isConnectionSettings(value: unknown): value is ConnectionSettings {
  return isRecord(value)
    && typeof value.endpoint === "string"
    && typeof value.model === "string"
    && typeof value.apiKey === "string"
    && (value.supportsVision === undefined || typeof value.supportsVision === "boolean")
    && (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel));
}

export async function loadConnectionSettings(store: StateStore): Promise<ConnectionSettings | undefined> {
  const value = await store.get(CONNECTION_SETTINGS_KEY);
  if (!isConnectionSettings(value)) return undefined;
  return { ...value, thinkingLevel: value.thinkingLevel ?? DEFAULT_THINKING_LEVEL, supportsVision: value.supportsVision ?? false };
}

export async function saveConnectionSettings(store: StateStore, settings: ConnectionSettings): Promise<void> {
  await store.set(CONNECTION_SETTINGS_KEY, {
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey: settings.apiKey,
    supportsVision: settings.supportsVision,
    ...(isThinkingLevel(settings.thinkingLevel) ? { thinkingLevel: settings.thinkingLevel } : {}),
  });
}
