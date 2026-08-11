import { isJsonValue } from "../core/schema.js";
import type { JsonObject, JsonValue, ModelMessage, StateChange, StateStore, ToolCall } from "../core/types.js";

export const CONVERSATION_LIMITS = Object.freeze({
  maxSessions: 50,
  maxMessages: 200,
  maxMessageChars: 20_000,
  maxConversationChars: 250_000,
});

export interface Conversation {
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  messages: ModelMessage[];
}

export interface ConversationIndexItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCall(value: unknown): ToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string" || value.name.length === 0 || !isJsonValue(value.arguments)) return undefined;
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function parseMessage(value: unknown): ModelMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.content !== "string" || value.content.length > CONVERSATION_LIMITS.maxMessageChars) return undefined;
  if (value.role === "system" || value.role === "user") return { role: value.role, content: value.content };
  if (value.role === "assistant") {
    if (value.toolCalls === undefined) return { role: "assistant", content: value.content };
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length > 16) return undefined;
    const toolCalls = value.toolCalls.map(parseToolCall);
    return toolCalls.every((call): call is ToolCall => call !== undefined) ? { role: "assistant", content: value.content, toolCalls } : undefined;
  }
  if (value.role === "tool" && typeof value.callId === "string" && value.callId.length > 0 && typeof value.name === "string") {
    return value.isError === true
      ? { role: "tool", callId: value.callId, name: value.name, content: value.content, isError: true }
      : { role: "tool", callId: value.callId, name: value.name, content: value.content };
  }
  return undefined;
}

function parseMessages(value: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value.map(parseMessage);
  return messages.every((message): message is ModelMessage => message !== undefined) ? messages : undefined;
}

function parseConversation(value: unknown): Conversation | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt)
  ) return undefined;
  const messages = parseMessages(value.messages);
  if (messages === undefined) return undefined;
  return normalizeConversation({ id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, messages });
}

function parseIndex(value: unknown): ConversationIndexItem[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, ConversationIndexItem>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 || typeof item.title !== "string" || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) continue;
    unique.set(item.id, { id: item.id, title: item.title, updatedAt: item.updatedAt });
  }
  return [...unique.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function jsonSize(value: unknown): number {
  return (JSON.stringify(value) ?? "").length;
}

export function normalizeConversation(conversation: Conversation): Conversation {
  let messages = conversation.messages.slice(-CONVERSATION_LIMITS.maxMessages);
  while (messages.length > 1 && jsonSize(messages) > CONVERSATION_LIMITS.maxConversationChars) messages = messages.slice(1);
  while (messages.length > 0 && messages[0]?.role === "tool") messages = messages.slice(1);
  for (const message of messages) {
    if (message.content.length > CONVERSATION_LIMITS.maxMessageChars) throw new Error("A conversation message is too large.");
  }
  const title = conversation.title.trim().slice(0, 120) || "New session";
  return { ...conversation, title, messages };
}

function conversationValue(conversation: Conversation): JsonValue {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages as unknown as JsonValue,
  };
}

function indexValue(conversations: Iterable<Conversation>): JsonValue {
  return [...conversations]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CONVERSATION_LIMITS.maxSessions)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) as unknown as JsonValue;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function titleFor(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact || "New session";
}

export class ConversationRepository {
  private readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  create(): Conversation {
    const timestamp = Date.now();
    return { id: newId(), title: "New session", createdAt: timestamp, updatedAt: timestamp, messages: [] };
  }

  async load(): Promise<Map<string, Conversation>> {
    const result = new Map<string, Conversation>();
    const storedIndex = await this.store.get("conversations:index");
    let index = parseIndex(storedIndex);
    const keys = await this.store.keys();
    const rebuiltIndex = index.length === 0 && keys.some((key) => key.startsWith("conversation:"));
    if (rebuiltIndex) {
      index = keys
        .filter((key) => key.startsWith("conversation:"))
        .map((key) => ({ id: key.slice("conversation:".length), title: "New session", updatedAt: 0 }));
    }
    const kept = index.slice(0, CONVERSATION_LIMITS.maxSessions);
    const repaired: Conversation[] = [];
    for (const item of kept) {
      const raw = await this.store.get(`conversation:${item.id}`);
      const conversation = parseConversation(raw);
      if (conversation !== undefined && conversation.id === item.id) {
        result.set(conversation.id, conversation);
        if (JSON.stringify(raw) !== JSON.stringify(conversationValue(conversation))) repaired.push(conversation);
      }
    }
    const retainedIds = new Set(result.keys());
    const staleIds = new Set([
      ...index.map((item) => item.id),
      ...keys.filter((key) => key.startsWith("conversation:")).map((key) => key.slice("conversation:".length)),
    ]);
    for (const id of retainedIds) staleIds.delete(id);
    if (rebuiltIndex || staleIds.size > 0 || repaired.length > 0 || result.size !== index.length) {
      const changes: StateChange[] = repaired.map((conversation) => ({ type: "set", key: `conversation:${conversation.id}`, value: conversationValue(conversation) }));
      changes.push({ type: "set", key: "conversations:index", value: indexValue(result.values()) });
      for (const id of staleIds) changes.push({ type: "remove", key: `conversation:${id}` });
      await this.store.apply(changes);
    }
    return result;
  }

  async save(conversations: Map<string, Conversation>, changed: Conversation, removedIds: readonly string[] = []): Promise<void> {
    if (conversations.size > CONVERSATION_LIMITS.maxSessions) throw new Error(`A workspace may contain at most ${CONVERSATION_LIMITS.maxSessions} sessions.`);
    const normalized = normalizeConversation({ ...changed, updatedAt: Date.now() });
    const next = new Map(conversations);
    next.set(normalized.id, normalized);
    const changes: StateChange[] = [
      { type: "set", key: `conversation:${normalized.id}`, value: conversationValue(normalized) },
      { type: "set", key: "conversations:index", value: indexValue(next.values()) },
    ];
    for (const id of removedIds) changes.push({ type: "remove", key: `conversation:${id}` });
    await this.store.apply(changes);
    conversations.clear();
    for (const [id, conversation] of next) conversations.set(id, conversation);
  }

  async remove(conversations: Map<string, Conversation>, id: string): Promise<void> {
    const next = new Map(conversations);
    next.delete(id);
    await this.store.apply([
      { type: "remove", key: `conversation:${id}` },
      { type: "set", key: "conversations:index", value: indexValue(next.values()) },
    ]);
    conversations.clear();
    for (const [conversationId, conversation] of next) conversations.set(conversationId, conversation);
  }
}

export function isConversationMessage(value: unknown): value is JsonObject {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
}
