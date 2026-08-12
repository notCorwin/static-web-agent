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
  ReasoningLevel,
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
  /** Portable reasoning/thinking effort passed to AI SDK Core. */
  readonly reasoning?: ReasoningLevel;
  readonly fetcher: BrowserFetcher;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Safari rejects cross-origin fetches that try to set the forbidden
 * User-Agent request header. AI SDK Core adds that header for its provider
 * diagnostics, so remove it at the browser adapter boundary while preserving
 * the provider's authorization and content headers.
 */
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
}

function resolveEndpoint(endpoint: string): ResolvedEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("A valid model endpoint is required.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model endpoint must use http:// or https://.");
  }

  const originalPath = url.pathname.replace(/\/+$/, "");
  let path = originalPath;
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);
  if (path === "") path = "/v1";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  const baseURL = url.toString().replace(/\/$/, "");
  // AI SDK's OpenAI-compatible provider appends /chat/completions to baseURL.
  // Preserve arbitrary legacy endpoints (for example a browser test route or
  // a proxy URL) by routing the SDK request to the exact endpoint instead.
  const isKnownBase = originalPath === "" || originalPath === "/" || originalPath.endsWith("/v1") || originalPath.endsWith("/chat/completions");
  return isKnownBase ? { baseURL } : { baseURL, directURL: new URL(endpoint).toString() };
}

function providerToolNames(tools: readonly ToolDescriptor[]): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const [index, tool] of tools.entries()) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_") || `tool_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    names.set(tool.name, candidate);
  }
  return names;
}

function localToolName(providerName: string, names: ReadonlyMap<string, string>): string {
  for (const [localName, mappedName] of names) if (mappedName === providerName) return localName;
  const partialMatches = [...names.entries()].filter(([, mappedName]) => mappedName.startsWith(providerName));
  if (partialMatches.length === 1) return partialMatches[0]?.[0] ?? providerName;
  return providerName;
}

function schema(value: JsonSchema): ReturnType<typeof jsonSchema> {
  return jsonSchema(value as unknown as JSONSchema7);
}

function aiTools(descriptors: readonly ToolDescriptor[], names: ReadonlyMap<string, string>): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of descriptors) {
    const name = names.get(descriptor.name) ?? descriptor.name;
    tools[name] = {
      description: descriptor.description,
      inputSchema: schema(descriptor.inputSchema),
      // An output schema marks the tool as client-executed without giving the
      // AI SDK permission to execute it. The runtime owns tool execution.
      outputSchema: schema(descriptor.outputSchema ?? { type: "object", additionalProperties: true }),
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
  if (message.isError) {
    return parsed === undefined
      ? { type: "error-text" as const, value: message.content }
      : { type: "error-json" as const, value: parsed };
  }
  return parsed === undefined
    ? { type: "text" as const, value: message.content }
    : { type: "json" as const, value: parsed };
}

function toAiMessage(message: ModelMessage, names: ReadonlyMap<string, string>): AiModelMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      if (message.toolCalls === undefined && message.reasoning === undefined) return { role: "assistant", content: message.content };
      const content: Array<
        | { type: "reasoning"; text: string }
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: JsonValue }
      > = [];
      if (message.reasoning !== undefined && message.reasoning.length > 0) content.push({ type: "reasoning", text: message.reasoning });
      if (message.content.length > 0) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: names.get(call.name) ?? call.name,
          input: call.arguments,
        });
      }
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
  const result: ModelUsage = {};
  const fields: Array<[keyof ModelUsage, string]> = [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["totalTokens", "totalTokens"],
  ];
  for (const [normalized, field] of fields) {
    const candidate = record[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new ModelAdapterError("Model returned invalid usage data.", undefined, "MODEL_PROTOCOL_ERROR");
    }
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
  const message = value instanceof Error
    ? value.message
    : asString(record?.message) ?? "The model provider returned an error.";
  return new ModelAdapterError(message || "The model provider returned an error.", detailsForError(value), fallbackCode);
}

function toolCallFromPart(part: { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }, names: ReadonlyMap<string, string>, index: number): ToolCallDraft {
  if (typeof part.toolCallId !== "string" || part.toolCallId.length === 0 || typeof part.toolName !== "string" || part.toolName.length === 0) {
    throw new ModelAdapterError("Model returned an invalid tool call.", undefined, "MODEL_PROTOCOL_ERROR");
  }
  if (!isJsonValue(part.input)) {
    throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
  }
  return {
    id: part.toolCallId,
    name: localToolName(part.toolName, names),
    input: part.input,
    index,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

export class AiSdkAdapter implements ModelAdapter {
  readonly id: string;
  private readonly model: string;
  private readonly reasoning: ReasoningLevel | undefined;
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(options: AiSdkAdapterOptions) {
    this.id = options.id ?? "ai-sdk";
    this.model = options.model.trim();
    this.reasoning = options.reasoning;
    if (!this.model) throw new Error("A model name is required.");
    if (typeof options.fetcher !== "function") throw new Error("A model fetcher is required.");

    const resolvedEndpoint = resolveEndpoint(options.endpoint);
    const directURL = resolvedEndpoint.directURL;
    const endpointFetcher: BrowserFetcher = directURL === undefined
      ? options.fetcher
      : (_input, init) => options.fetcher(directURL, init);
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
      ...(this.reasoning === undefined || this.reasoning === "provider-default" ? {} : { reasoning: this.reasoning }),
      maxRetries: 0,
      abortSignal: request.signal,
      onError: () => {
        // The adapter surfaces the error as a structured kernel error below.
      },
    });

    let content = "";
    let reasoning = "";
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
            content += part.text;
            yield { type: "text-delta", delta: part.text };
            break;
          case "reasoning-delta":
            reasoning += part.text;
            yield { type: "reasoning-delta", delta: part.text };
            break;
          case "tool-input-start": {
            const index = indexes.get(part.id) ?? nextIndex++;
            indexes.set(part.id, index);
            yield {
              type: "tool-call-delta",
              delta: { index, id: part.id, name: part.toolName },
            } satisfies Extract<ModelEvent, { readonly type: "tool-call-delta" }>;
            break;
          }
          case "tool-input-delta": {
            const index = indexes.get(part.id) ?? nextIndex++;
            indexes.set(part.id, index);
            const delta: ToolCallDelta = { index, arguments: part.delta };
            yield { type: "tool-call-delta", delta };
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
    if (content.trim().length === 0 && normalizedCalls.length === 0) {
      throw new ModelAdapterError("Model returned an empty response.", undefined, "MODEL_EMPTY_RESPONSE");
    }
    const message: AssistantMessage = normalizedCalls.length === 0
      ? { role: "assistant", content, ...(reasoning.length === 0 ? {} : { reasoning }) }
      : { role: "assistant", content, ...(reasoning.length === 0 ? {} : { reasoning }), toolCalls: normalizedCalls };
    yield { type: "completed", message, ...(finalUsage === undefined ? {} : { usage: finalUsage }) };
  }
}
