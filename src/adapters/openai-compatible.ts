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

const MAX_MODEL_REQUEST_CHARS = 500_000;
const MAX_MODEL_RESPONSE_CHARS = 1_000_000;
const MAX_SSE_EVENT_CHARS = 100_000;
const MAX_MODEL_OUTPUT_CHARS = 64_000;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function toolSchema(tool: ToolDescriptor): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as JsonValue,
    },
  };
}

function messageBody(message: ModelMessage): JsonObject {
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
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.callId, name: message.name, content: message.content };
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
      throw new ModelAdapterError("Model returned malformed tool arguments.", { arguments: value.slice(0, 2_000) }, "MODEL_PROTOCOL_ERROR");
    }
    if (!isJsonValue(parsed)) throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
    return parsed;
  }
  if (!isJsonValue(value)) throw new ModelAdapterError("Model returned non-JSON tool arguments.", undefined, "MODEL_PROTOCOL_ERROR");
  return value;
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ModelAdapterError("Model returned invalid tool calls.", undefined, "MODEL_PROTOCOL_ERROR");
  return value.map((item, index) => {
    const record = asRecord(item);
    const functionRecord = asRecord(record?.function);
    const name = asString(functionRecord?.name);
    if (name === undefined || name.trim().length === 0) throw new ModelAdapterError("Model returned a tool call without a name.", undefined, "MODEL_PROTOCOL_ERROR");
    return {
      id: asString(record?.id) || `call-${index + 1}`,
      name,
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
    throw new ModelAdapterError("Model returned invalid JSON.", { body: text.slice(0, 2_000) }, "MODEL_PROTOCOL_ERROR");
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

async function readTextLimited(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (response.body === null) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
    const text = await response.text();
    if (text.length > limit) throw new ModelAdapterError("Model response is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.length > limit) throw new ModelAdapterError("Model response is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
      if (chunk.done) return text;
    }
  } finally {
    try { await reader.cancel(); } catch { /* the body may already be closed */ }
    reader.releaseLock();
  }
}

async function* ssePayloads(response: Response, signal: AbortSignal): AsyncIterable<SseEvent> {
  if (response.body === null) {
    const text = await readTextLimited(response, signal, MAX_MODEL_RESPONSE_CHARS);
    for (const block of text.split(/\r?\n\r?\n/)) {
      const event = parseSseBlock(block);
      if (event !== undefined) yield event;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalChars = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.");
      const chunk = await reader.read();
      const decoded = decoder.decode(chunk.value, { stream: !chunk.done });
      totalChars += decoded.length;
      if (totalChars > MAX_MODEL_RESPONSE_CHARS) throw new ModelAdapterError("Model response is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
      buffer += decoded;
      if (buffer.length > MAX_SSE_EVENT_CHARS) throw new ModelAdapterError("Model SSE event is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
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
    totalChars += tail.length;
    if (totalChars > MAX_MODEL_RESPONSE_CHARS) throw new ModelAdapterError("Model response is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
    buffer += tail;
    if (buffer.length > MAX_SSE_EVENT_CHARS) throw new ModelAdapterError("Model SSE event is too large.", undefined, "MODEL_RESPONSE_TOO_LARGE");
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
    this.endpoint = endpoint;
    this.model = options.model.trim();
    if (!this.model) throw new Error("A model name is required.");
    this.apiKey = options.apiKey;
    if (typeof options.fetcher !== "function") throw new Error("A model fetcher is required.");
    this.fetcher = options.fetcher;
    this.headers = options.headers ?? {};
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body: Record<string, JsonValue> = {
      model: this.model,
      messages: request.messages.map(messageBody),
      stream: true,
    };
    if (request.tools.length > 0) body.tools = request.tools.map(toolSchema);

    const headers: Record<string, string> = {
      Accept: "text/event-stream, application/json",
      "Content-Type": "application/json",
      ...this.headers,
    };
    if (this.apiKey !== undefined && this.apiKey.length > 0) headers.Authorization = `Bearer ${this.apiKey}`;

    const serializedBody = JSON.stringify(body);
    if (serializedBody.length > MAX_MODEL_REQUEST_CHARS) throw new ModelAdapterError("Model request is too large.", undefined, "MODEL_REQUEST_TOO_LARGE");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: request.signal,
    });
    if (!response.ok) {
      const text = (await readTextLimited(response, request.signal, MAX_MODEL_RESPONSE_CHARS)).slice(0, 2_000);
      throw new ModelAdapterError(`Model request failed with HTTP ${response.status}.`, { status: response.status, body: text }, "MODEL_HTTP_ERROR");
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const payload = parseJson(await readTextLimited(response, request.signal, MAX_MODEL_RESPONSE_CHARS));
      providerError(payload);
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length === 0) throw new ModelAdapterError("Model response did not contain a choice.", undefined, "MODEL_PROTOCOL_ERROR");
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      if (message === undefined) throw new ModelAdapterError("Model response did not contain a message.", undefined, "MODEL_PROTOCOL_ERROR");
      const content = asString(message.content) ?? "";
      const calls = parseToolCalls(message.tool_calls);
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
      if (event.event === "error") throw new ModelAdapterError(event.data.slice(0, 2_000) || "Model stream returned an error event.", undefined, "MODEL_SSE_ERROR");
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
        if (content.length > MAX_MODEL_OUTPUT_CHARS) throw new ModelAdapterError("Model output is too large.", undefined, "MODEL_OUTPUT_TOO_LARGE");
        yield { type: "text-delta", delta: deltaText };
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = asRecord(rawCall);
          const index = typeof call?.index === "number" && Number.isInteger(call.index) ? call.index : calls.size;
          const functionRecord = asRecord(call?.function);
          const previous = calls.get(index) ?? { id: `call-${index + 1}`, name: "", arguments: "" };
          calls.set(index, {
            id: asString(call?.id) ?? previous.id,
            name: `${previous.name}${asString(functionRecord?.name) ?? ""}`,
            arguments: `${previous.arguments}${asString(functionRecord?.arguments) ?? ""}`,
          });
          if ((calls.get(index)?.arguments.length ?? 0) > MAX_MODEL_OUTPUT_CHARS) throw new ModelAdapterError("Model tool arguments are too large.", undefined, "MODEL_OUTPUT_TOO_LARGE");
        }
      }
    }

    if (!sawPayload && (sawDone || sawFinish)) throw new ModelAdapterError("Model returned an empty response.", undefined, "MODEL_EMPTY_RESPONSE");
    if (!sawPayload || (!sawDone && !sawFinish)) throw new ModelAdapterError("Model SSE stream ended before completion.", undefined, "MODEL_SSE_INCOMPLETE");
    const normalizedCalls: ToolCall[] = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
    yield { type: "completed", message: completedMessage(content, normalizedCalls), ...(finalUsage === undefined ? {} : { usage: finalUsage }) };
  }
}
