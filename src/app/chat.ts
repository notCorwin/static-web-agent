import type { JsonObject, ModelMessage } from "../core/types.js";

/** Compatibility export: all application chat ceilings are unbounded by default. */
export const CHAT_LIMITS = Object.freeze({
  maxMessages: Number.POSITIVE_INFINITY,
  maxMessageChars: Number.POSITIVE_INFINITY,
  maxConversationChars: Number.POSITIVE_INFINITY,
});

export interface ChatState {
  messages: ModelMessage[];
}

export function createChatState(): ChatState {
  return { messages: [] };
}

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
