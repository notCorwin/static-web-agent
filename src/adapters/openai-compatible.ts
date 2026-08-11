import { ModelAdapterError } from "../core/errors.js";
import { isJsonValue } from "../core/schema.js";
import type {
  AssistantMessage,
  JsonObject,
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

export interface OpenAICompatibleAdapterOptions {
  readonly id?: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetcher: BrowserFetcher;
  readonly headers?: Readonly<Record<string, string>>;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return url.toString();
  if (path === "" || path === "/") url.pathname = "/v1/chat/completions";
  else if (path.endsWith("/v1")) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

function usage(value: unknown): ModelUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const fields: Array<[keyof ModelUsage, string]> = [
    ["inputTokens", "prompt_tokens"],
    ["outputTokens", "completion_tokens"],
    ["totalTokens", "total_tokens"],
  ];
  const result: ModelUsage = {};
  for (const [normalized, provider] of fields) {
    const value = record[provider];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ModelAdapterError("Model returned invalid usage data.", undefined, "MODEL_PROTOCOL_ERROR");
    }
    result[normalized] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function providerToolNames(tools: readonly ToolDescriptor[]): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const [index, tool] of tools.entries()) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_") || `tool_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const suffixText = `_${suffix}`;
      candidate = `${base}${suffixText}`;
      suffix += 1;
    }
    used.add(candidate);
    names.set(tool.name, candidate);
  }
  return names;
}

function localToolName(providerName: string, names: ReadonlyMap<string, string>): string {
  for (const [localName, mappedName] of names) if (mappedName === providerName) return localName;
  return providerName;
}

function toolSchema(tool: ToolDescriptor, providerName: string): JsonObject {
  return {
    type: "function",
    function: {
      name: providerName,
      description: tool.description,
      parameters: tool.inputSchema as JsonValue,
    },
  };
}

function messageBody(message: ModelMessage, names: ReadonlyMap<string, string>): JsonObject {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: names.get(call.name) ?? call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.callId, name: names.get(message.name) ?? message.name, content: message.content };
  }
}

function parseArguments(value: unknown): JsonValue {
  if (value === undefined) return {};
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new ModelAdapterError("Model returned malformed tool arguments.", { arguments: value }, "MODEL_PROTOCOL_ERROR");
    }
    if (!isJsonValue(parsed)) throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
    return parsed;
  }
  if (!isJsonValue(value)) throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
  return value;
}

function parseToolCalls(value: unknown, names: ReadonlyMap<string, string>): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ModelAdapterError("Model returned invalid tool calls.", undefined, "MODEL_PROTOCOL_ERROR");
  return value.map((item, index) => {
    const record = asRecord(item);
    const functionRecord = asRecord(record?.function);
    const name = asString(functionRecord?.name);
    if (name === undefined || name.trim().length === 0) throw new ModelAdapterError("Model returned a tool call without a name.", undefined, "MODEL_PROTOCOL_ERROR");
    return {
      id: asString(record?.id) || `call-${index + 1}`,
      name: localToolName(name, names),
      arguments: parseArguments(functionRecord?.arguments),
    };
  });
}

function completedMessage(content: string, calls: readonly ToolCall[]): AssistantMessage {
  if (content.trim().length === 0 && calls.length === 0) throw new ModelAdapterError("Model returned an empty response.", undefined, "MODEL_EMPTY_RESPONSE");
  return calls.length === 0 ? { role: "assistant", content } : { role: "assistant", content, toolCalls: calls };
}

function parseJson(text: string): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ModelAdapterError("Model returned invalid JSON.", { body: text }, "MODEL_PROTOCOL_ERROR");
  }
  const record = asRecord(parsed);
  if (record === undefined) throw new ModelAdapterError("Model returned a non-object JSON response.", undefined, "MODEL_PROTOCOL_ERROR");
  return record;
}

function providerError(payload: UnknownRecord): void {
  const error = asRecord(payload.error);
  if (error === undefined) return;
  const message = asString(error.message) ?? "The model provider returned an error.";
  const details: JsonValue = isJsonValue(error) ? { provider: error } : { provider: { message } };
  throw new ModelAdapterError(message, details, "MODEL_PROVIDER_ERROR");
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
    return response.text();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) return text;
    }
  } finally {
    try { await reader.cancel(); } catch { /* the body may already be closed */ }
    reader.releaseLock();
  }
}

async function* ssePayloads(response: Response, signal: AbortSignal): AsyncIterable<SseEvent> {
  if (response.body === null) {
    const text = await readText(response, signal);
    for (const block of text.split(/\r?\n\r?\n/)) {
      const event = parseSseBlock(block);
      if (event !== undefined) yield event;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      const chunk = await reader.read();
      const decoded = decoder.decode(chunk.value, { stream: !chunk.done });
      buffer += decoded;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          const event = parseSseBlock(buffer);
          if (event !== undefined) yield event;
          buffer = "";
        } else {
          buffer += `${line}\n`;
        }
      }
      if (chunk.done) break;
    }
    const tail = decoder.decode();
    buffer += tail;
    const event = parseSseBlock(buffer);
    if (event !== undefined) yield event;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch may already have cancelled the body.
    }
    reader.releaseLock();
  }
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: BrowserFetcher;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: OpenAICompatibleAdapterOptions) {
    const endpoint = options.endpoint.trim();
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("A valid model endpoint is required.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Model endpoint must use http:// or https://.");
    this.id = options.id ?? "openai-compatible";
    this.endpoint = normalizeEndpoint(endpoint);
    this.model = options.model.trim();
    if (!this.model) throw new Error("A model name is required.");
    this.apiKey = options.apiKey;
    if (typeof options.fetcher !== "function") throw new Error("A model fetcher is required.");
    this.fetcher = options.fetcher;
    this.headers = options.headers ?? {};
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const names = providerToolNames(request.tools);
    const body: Record<string, JsonValue> = {
      model: this.model,
      messages: request.messages.map((message) => messageBody(message, names)),
      stream: true,
    };
    if (request.tools.length > 0) body.tools = request.tools.map((tool) => toolSchema(tool, names.get(tool.name) ?? tool.name));

    const headers: Record<string, string> = {
      Accept: "text/event-stream, application/json",
      "Content-Type": "application/json",
      ...this.headers,
    };
    if (this.apiKey !== undefined && this.apiKey.length > 0) headers.Authorization = `Bearer ${this.apiKey}`;

    const serializedBody = JSON.stringify(body);
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: request.signal,
    });
    if (!response.ok) {
      const text = await readText(response, request.signal);
      throw new ModelAdapterError(`Model request failed with HTTP ${response.status}.`, { status: response.status, body: text }, "MODEL_HTTP_ERROR");
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const payload = parseJson(await readText(response, request.signal));
      providerError(payload);
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length === 0) throw new ModelAdapterError("Model response did not contain a choice.", undefined, "MODEL_PROTOCOL_ERROR");
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      if (message === undefined) throw new ModelAdapterError("Model response did not contain a message.", undefined, "MODEL_PROTOCOL_ERROR");
      const content = asString(message.content) ?? "";
      const calls = parseToolCalls(message.tool_calls, names);
      const normalizedUsage = usage(payload.usage);
      yield { type: "completed", message: completedMessage(content, calls), ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }) };
      return;
    }

    let content = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finalUsage: ModelUsage | undefined;
    let sawPayload = false;
    let sawDone = false;
    let sawFinish = false;
    for await (const event of ssePayloads(response, request.signal)) {
      if (event.event === "error") throw new ModelAdapterError(event.data || "Model stream returned an error event.", undefined, "MODEL_SSE_ERROR");
      if (event.data === "[DONE]") {
        sawDone = true;
        continue;
      }
      sawPayload = true;
      const payload = parseJson(event.data);
      providerError(payload);
      const chunkUsage = usage(payload.usage);
      if (chunkUsage !== undefined) finalUsage = chunkUsage;
      const choice = Array.isArray(payload.choices) ? asRecord(payload.choices[0]) : undefined;
      if (choice === undefined) continue;
      const finishReason = choice.finish_reason;
      if (finishReason !== undefined && finishReason !== null) sawFinish = true;
      const delta = asRecord(choice.delta);
      const deltaText = asString(delta?.content);
      if (deltaText !== undefined) {
        content += deltaText;
        yield { type: "text-delta", delta: deltaText };
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = asRecord(rawCall);
          const index = typeof call?.index === "number" && Number.isInteger(call.index) ? call.index : calls.size;
          const functionRecord = asRecord(call?.function);
          const previous = calls.get(index) ?? { id: `call-${index + 1}`, name: "", arguments: "" };
          const id = asString(call?.id);
          const name = asString(functionRecord?.name);
          const argumentsDelta = asString(functionRecord?.arguments);
          calls.set(index, {
            id: id ?? previous.id,
            name: `${previous.name}${name ?? ""}`,
            arguments: `${previous.arguments}${argumentsDelta ?? ""}`,
          });
          const delta: ToolCallDelta = {
            index,
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
            ...(argumentsDelta === undefined ? {} : { arguments: argumentsDelta }),
          };
          yield { type: "tool-call-delta", delta };
        }
      }
    }

    if (!sawPayload && (sawDone || sawFinish)) throw new ModelAdapterError("Model returned an empty response.", undefined, "MODEL_EMPTY_RESPONSE");
    if (!sawPayload || (!sawDone && !sawFinish)) throw new ModelAdapterError("Model SSE stream ended before completion.", undefined, "MODEL_SSE_INCOMPLETE");
    const normalizedCalls: ToolCall[] = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
      id: call.id,
      name: localToolName(call.name, names),
      arguments: parseArguments(call.arguments),
    }));
    yield { type: "completed", message: completedMessage(content, normalizedCalls), ...(finalUsage === undefined ? {} : { usage: finalUsage }) };
  }
}
