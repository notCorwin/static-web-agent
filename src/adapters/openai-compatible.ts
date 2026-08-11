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

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usage(value: unknown): ModelUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const inputTokens = typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const outputTokens = typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  const totalTokens = typeof record.total_tokens === "number" ? record.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  const result: ModelUsage = {};
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  return result;
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
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonValue(parsed) ? parsed : { invalidArguments: value };
    } catch {
      return { invalidArguments: value };
    }
  }
  return isJsonValue(value) ? value : {};
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    const functionRecord = asRecord(record?.function);
    const name = asString(functionRecord?.name);
    if (name === undefined || name.length === 0) return [];
    const id = asString(record?.id) ?? `call-${index + 1}`;
    return [{ id, name, arguments: parseArguments(functionRecord?.arguments) }];
  });
}

function completedMessage(content: string, calls: readonly ToolCall[]): AssistantMessage {
  return calls.length === 0 ? { role: "assistant", content } : { role: "assistant", content, toolCalls: calls };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelAdapterError("Model returned invalid JSON.", { body: text.slice(0, 2_000) });
  }
}

async function* ssePayloads(response: Response, signal: AbortSignal): AsyncIterable<string> {
  if (response.body === null) {
    const text = await response.text();
    yield* text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      return data ? [data] : [];
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = "";
  try {
    while (true) {
      if (signal.aborted) {
        const error = new Error("Operation cancelled.");
        error.name = "AbortError";
        throw error;
      }
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
        if (line === "" && data.length > 0) {
          yield data.trimEnd();
          data = "";
        }
      }
      if (chunk.done) break;
    }
    if (buffer.startsWith("data:")) data += `${buffer.slice(5).trimStart()}\n`;
    if (data.length > 0) yield data.trimEnd();
  } finally {
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
    if (!endpoint) throw new Error("A model endpoint is required.");
    this.id = options.id ?? "openai-compatible";
    this.endpoint = endpoint;
    this.model = options.model.trim();
    if (!this.model) throw new Error("A model name is required.");
    this.apiKey = options.apiKey;
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

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2_000);
      throw new ModelAdapterError(`Model request failed with HTTP ${response.status}.`, { status: response.status, body: text });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const payload = parseJson(await response.text());
      const choices = asRecord(payload)?.choices;
      const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
      const message = asRecord(choice?.message);
      const content = asString(message?.content) ?? "";
      const calls = parseToolCalls(message?.tool_calls);
      const normalizedUsage = usage(asRecord(payload)?.usage);
      yield { type: "completed", message: completedMessage(content, calls), ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }) };
      return;
    }

    let content = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finalUsage: ModelUsage | undefined;
    for await (const payloadText of ssePayloads(response, request.signal)) {
      if (payloadText === "[DONE]") continue;
      const payload = asRecord(parseJson(payloadText));
      if (payload === undefined) continue;
      const chunkUsage = usage(payload.usage);
      if (chunkUsage !== undefined) finalUsage = chunkUsage;
      const choice = Array.isArray(payload.choices) ? asRecord(payload.choices[0]) : undefined;
      const delta = asRecord(choice?.delta);
      const deltaText = asString(delta?.content);
      if (deltaText !== undefined) {
        content += deltaText;
        yield { type: "text-delta", delta: deltaText };
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = asRecord(rawCall);
          const index = typeof call?.index === "number" ? call.index : calls.size;
          const functionRecord = asRecord(call?.function);
          const previous = calls.get(index) ?? { id: `call-${index + 1}`, name: "", arguments: "" };
          const next = {
            id: asString(call?.id) ?? previous.id,
            name: `${previous.name}${asString(functionRecord?.name) ?? ""}`,
            arguments: `${previous.arguments}${asString(functionRecord?.arguments) ?? ""}`,
          };
          calls.set(index, next);
        }
      }
    }

    const normalizedCalls: ToolCall[] = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
    yield { type: "completed", message: completedMessage(content, normalizedCalls), ...(finalUsage === undefined ? {} : { usage: finalUsage }) };
  }
}