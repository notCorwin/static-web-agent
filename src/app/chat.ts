import type { JsonObject, JsonValue, ModelAttachment, ModelMessage } from "../core/types.js";

export const CONVERSATION_KEY = "app:conversation";

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

const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

function isMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.content !== "string") return false;
  switch (value.role) {
    case "system":
      return true;
    case "user":
      return value.attachmentIds === undefined || isStringArray(value.attachmentIds);
    case "assistant":
      return (value.reasoning === undefined || typeof value.reasoning === "string")
        && (value.toolCalls === undefined
          || (Array.isArray(value.toolCalls)
            && value.toolCalls.every((call) => isRecord(call) && typeof call.id === "string" && typeof call.name === "string")));
    case "tool":
      return typeof value.callId === "string"
        && typeof value.name === "string"
        && (value.isError === undefined || typeof value.isError === "boolean");
    default:
      return false;
  }
}

// ponytail: attachments stored as base64 (+33% size) to keep StateStore JSON-only; move to a raw IDB object store when transcripts exceed ~50MB.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeTranscript(messages: readonly ModelMessage[], attachments: readonly ModelAttachment[]): JsonValue | undefined {
  const validMessages = messages.filter(isMessage);
  if (validMessages.length === 0) return undefined;
  return {
    messages: validMessages.map((message) => ({ ...message })) as JsonValue[],
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      dataBase64: bytesToBase64(attachment.data),
    })) as unknown as JsonValue[],
  };
}

export interface TranscriptRecord {
  readonly messages: ModelMessage[];
  readonly attachments: ModelAttachment[];
}

/** Lenient per-item validation: corrupt entries are dropped so one bad record cannot brick restore. */
export function decodeTranscript(value: unknown): TranscriptRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) return undefined;
  const messages = value.messages.filter(isMessage);
  const attachments: ModelAttachment[] = [];
  if (Array.isArray(value.attachments)) {
    for (const entry of value.attachments) {
      if (!isRecord(entry)
        || typeof entry.id !== "string"
        || typeof entry.name !== "string"
        || typeof entry.mediaType !== "string"
        || typeof entry.dataBase64 !== "string") continue;
      try {
        attachments.push({ id: entry.id, name: entry.name, mediaType: entry.mediaType, data: base64ToBytes(entry.dataBase64) });
      } catch {
        // Undecodable attachment data: skip it rather than failing the whole transcript.
      }
    }
  }
  if (messages.length === 0 && attachments.length === 0) return undefined;
  return { messages, attachments };
}
