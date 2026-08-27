import type { JsonObject, ModelMessage } from "../core/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  let normalized = [...messages];
  while (normalized.length > 0 && normalized[0]?.role === "tool") normalized = normalized.slice(1);
  return normalized;
}

export function isMessageEnvelope(value: unknown): value is JsonObject {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
}
