import type { JsonObject, ModelMessage } from "../core/types.js";

export const CHAT_LIMITS = Object.freeze({
  maxMessages: 200,
  maxMessageChars: 20_000,
  maxConversationChars: 250_000,
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

function jsonSize(value: unknown): number {
  return (JSON.stringify(value) ?? "").length;
}

export function normalizeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  let normalized = [...messages].slice(-CHAT_LIMITS.maxMessages);
  while (normalized.length > 1 && jsonSize(normalized) > CHAT_LIMITS.maxConversationChars) normalized = normalized.slice(1);
  while (normalized.length > 0 && normalized[0]?.role === "tool") normalized = normalized.slice(1);
  for (const message of normalized) {
    if (message.content.length > CHAT_LIMITS.maxMessageChars) throw new Error("A chat message is too large.");
  }
  return normalized;
}

export function isMessageEnvelope(value: unknown): value is JsonObject {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
}
