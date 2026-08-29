import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  streamText,
  type JSONSchema7,
  type ModelMessage as AiModelMessage,
  type ToolSet,
} from "ai";
import { isAbortError, ModelAdapterError } from "../core/errors.js";
import { isJsonValue } from "../core/schema.js";
import type {
  AssistantMessage,
  JsonSchema,
  JsonValue,
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ToolCall,
  ToolCallDelta,
  ToolDescriptor,
} from "../core/types.js";

export type BrowserFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AiSdkAdapterOptions {
  readonly id?: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetcher: BrowserFetcher;
  readonly headers?: Readonly<Record<string, string>>;
}

/** AI SDK adds a User-Agent header that Safari rejects in browser fetches. */
function safariSafeFetcher(fetcher: BrowserFetcher): BrowserFetcher {
  return (input, init) => {
    if (init?.headers === undefined) return fetcher(input, init);
    const headers = new Headers(init.headers);
    headers.delete("user-agent");
    return fetcher(input, { ...init, headers });
  };
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

interface ToolCallDraft {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly index: number;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface ResolvedEndpoint {
  readonly baseURL: string;
  readonly directURL?: string;
  readonly search?: string;
}

function resolveEndpoint(endpoint: string): ResolvedEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("A valid model endpoint is required.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Model endpoint must use http:// or https://.");

  const originalPath = url.pathname.replace(/\/+$/, "");
  if (originalPath === "/chat/completions" || url.pathname.endsWith("/chat/completions/")) {
    const directURL = new URL(endpoint);
    directURL.hash = "";
    return { baseURL: url.origin, directURL: directURL.toString() };
  }
  const search = url.search || undefined;
  let path = originalPath;
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);
  if (path === "") path = "/v1";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  const baseURL = url.toString().replace(/\/$/, "");
  const isKnownBase = originalPath === "" || originalPath === "/" || originalPath.endsWith("/v1") || originalPath.endsWith("/chat/completions");
  if (isKnownBase) return { baseURL, ...(search === undefined ? {} : { search }) };
  const directURL = new URL(endpoint);
  directURL.hash = "";
  return { baseURL, directURL: directURL.toString() };
}

function providerToolNames(tools: readonly ToolDescriptor[]): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const [index, tool] of tools.entries()) {
    if (names.has(tool.name)) throw new ModelAdapterError("Model tools must have unique names.", undefined, "MODEL_PROTOCOL_ERROR");
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_") || `tool_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    names.set(tool.name, candidate);
  }
  return names;
}

function localToolName(providerName: string, names: ReadonlyMap<string, string>): string {
  for (const [localName, mappedName] of names) if (mappedName === providerName) return localName;
  let unknownName = providerName;
  while (names.has(unknownName)) unknownName = `unknown_${unknownName}`;
  return unknownName;
}

function schema(value: JsonSchema): ReturnType<typeof jsonSchema> {
  return jsonSchema(value as unknown as JSONSchema7);
}

function aiTools(descriptors: readonly ToolDescriptor[], names: ReadonlyMap<string, string>): ToolSet {
  const tools: ToolSet = Object.create(null) as ToolSet;
  for (const descriptor of descriptors) {
    const name = names.get(descriptor.name) ?? descriptor.name;
    tools[name] = {
      description: descriptor.description,
      inputSchema: schema(descriptor.inputSchema),
      // The Agent owns execution; an output schema lets AI SDK describe calls without running them.
      outputSchema: schema({ type: "object", additionalProperties: true }),
    };
  }
  return tools;
}

function parseJsonValue(text: string): JsonValue | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function toolResultOutput(message: Extract<ModelMessage, { readonly role: "tool" }>) {
  const parsed = parseJsonValue(message.content);
  if (message.isError === true) return parsed === undefined ? { type: "error-text" as const, value: message.content } : { type: "error-json" as const, value: parsed };
  return parsed === undefined ? { type: "text" as const, value: message.content } : { type: "json" as const, value: parsed };
}

function toAiMessage(message: ModelMessage, names: ReadonlyMap<string, string>): AiModelMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      if (message.toolCalls === undefined || message.toolCalls.length === 0) return { role: "assistant", content: message.content };
      const content: Array<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: JsonValue }
      > = [];
      if (message.content.length > 0) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) content.push({ type: "tool-call", toolCallId: call.id, toolName: names.get(call.name) ?? call.name, input: call.arguments });
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.callId,
          toolName: names.get(message.name) ?? message.name,
          output: toolResultOutput(message),
        }],
      };
  }
}

function usage(value: unknown): ModelUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const [normalized, field] of [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["totalTokens", "totalTokens"]] as const) {
    const candidate = record[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) throw new ModelAdapterError("Model returned invalid usage data.", undefined, "MODEL_PROTOCOL_ERROR");
    result[normalized] = candidate;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function detailsForError(value: unknown): JsonValue | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const details: Record<string, JsonValue> = {};
  const status = record.statusCode ?? record.status;
  if (typeof status === "number" && Number.isFinite(status)) details.status = status;
  if (typeof record.responseBody === "string") details.body = record.responseBody;
  if (typeof record.url === "string") details.url = record.url;
  return Object.keys(details).length === 0 ? undefined : details;
}

function modelError(value: unknown, fallbackCode = "MODEL_PROVIDER_ERROR"): ModelAdapterError {
  if (value instanceof ModelAdapterError) return value;
  const record = asRecord(value);
  const message = value instanceof Error ? value.message : asString(record?.message) ?? "The model provider returned an error.";
  return new ModelAdapterError(message || "The model provider returned an error.", detailsForError(value), fallbackCode);
}

function toolCallFromPart(part: { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }, names: ReadonlyMap<string, string>, index: number): ToolCallDraft {
  if (typeof part.toolCallId !== "string" || part.toolCallId.length === 0 || typeof part.toolName !== "string" || part.toolName.length === 0) throw new ModelAdapterError("Model returned an invalid tool call.", undefined, "MODEL_PROTOCOL_ERROR");
  if (!isJsonValue(part.input)) throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
  return { id: part.toolCallId, name: localToolName(part.toolName, names), input: part.input, index };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  let reason: unknown;
  try {
    reason = signal.reason;
  } catch {
  }
  let isError = false;
  try {
    isError = reason instanceof Error;
  } catch {
  }
  if (isError) throw reason as Error;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

export class AiSdkAdapter implements ModelAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(options: AiSdkAdapterOptions) {
    this.id = options.id ?? "ai-sdk";
    this.model = options.model.trim();
    if (!this.model) throw new Error("A model name is required.");
    if (typeof options.fetcher !== "function") throw new Error("A model fetcher is required.");
    const resolvedEndpoint = resolveEndpoint(options.endpoint);
    const endpointFetcher: BrowserFetcher = resolvedEndpoint.directURL === undefined
      ? resolvedEndpoint.search === undefined
        ? options.fetcher
        : (input, init) => {
            const url = new URL(String(input));
            url.search = resolvedEndpoint.search!;
            return options.fetcher(url, init);
          }
      : (_input, init) => options.fetcher(resolvedEndpoint.directURL!, init);
    this.provider = createOpenAICompatible({
      name: this.id,
      baseURL: resolvedEndpoint.baseURL,
      ...(options.apiKey === undefined || options.apiKey.length === 0 ? {} : { apiKey: options.apiKey }),
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
      includeUsage: true,
      fetch: safariSafeFetcher(endpointFetcher),
    });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    throwIfAborted(request.signal);
    const names = providerToolNames(request.tools);
    const prompt = request.messages.length === 0
      ? { prompt: "" as const }
      : { messages: request.messages.map((message) => toAiMessage(message, names)) };
    const result = streamText({
      model: this.provider(this.model),
      ...prompt,
      ...(request.tools.length === 0 ? {} : { tools: aiTools(request.tools, names) }),
      maxRetries: 0,
      abortSignal: request.signal,
      onError: () => {
        // The full stream below carries the provider error with its details.
      },
    });

    const content: string[] = [];
    let finalUsage: ModelUsage | undefined;
    let sawFinish = false;
    const calls = new Map<string, ToolCallDraft>();
    const indexes = new Map<string, number>();
    let nextIndex = 0;

    try {
      for await (const part of result.fullStream) {
        throwIfAborted(request.signal);
        switch (part.type) {
          case "text-delta":
            if (part.text.length > 0) {
              content.push(part.text);
              yield { type: "text-delta", delta: part.text };
            }
            break;
          case "tool-input-start": {
            const index = indexes.get(part.id) ?? nextIndex++;
            indexes.set(part.id, index);
            yield { type: "tool-call-delta", delta: { index, id: part.id, name: part.toolName } };
            break;
          }
          case "tool-input-delta": {
            if (part.delta.length === 0) break;
            const index = indexes.get(part.id) ?? nextIndex++;
            indexes.set(part.id, index);
            yield { type: "tool-call-delta", delta: { index, arguments: part.delta } satisfies ToolCallDelta };
            break;
          }
          case "tool-call": {
            const index = indexes.get(part.toolCallId) ?? nextIndex++;
            indexes.set(part.toolCallId, index);
            const call = toolCallFromPart(part, names, index);
            calls.set(part.toolCallId, call);
            break;
          }
          case "finish-step":
            finalUsage = usage(part.usage) ?? finalUsage;
            break;
          case "finish":
            finalUsage = usage(part.totalUsage) ?? finalUsage;
            sawFinish = true;
            break;
          case "error":
            throw modelError(part.error);
          default:
            break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || request.signal.aborted) throw error;
      throw modelError(error);
    }

    if (!sawFinish) throw new ModelAdapterError("Model stream ended before completion.", undefined, "MODEL_SSE_INCOMPLETE");
    const normalizedCalls: ToolCall[] = [...calls.values()]
      .sort((left, right) => left.index - right.index)
      .map(({ id, name, input }) => ({ id, name, arguments: input }));
    const contentText = content.join("");
    if (contentText.trim().length === 0 && normalizedCalls.length === 0) throw new ModelAdapterError("Model returned an empty response.", undefined, "MODEL_EMPTY_RESPONSE");
    const message: AssistantMessage = normalizedCalls.length === 0
      ? { role: "assistant", content: contentText }
      : { role: "assistant", content: contentText, toolCalls: normalizedCalls };
    yield { type: "completed", message, ...(finalUsage === undefined ? {} : { usage: finalUsage }) };
  }
}
