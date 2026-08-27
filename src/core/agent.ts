import { errorInfo, isAbortError, jsonError, KernelError } from "./errors.js";
import { isJsonValue } from "./schema.js";
import { AgentKernel } from "./kernel.js";
import type {
  AgentEvent,
  AgentLimits,
  AgentRunRequest,
  AgentRunResult,
  AssistantMessage,
  JsonValue,
  ModelAttachment,
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelUsage,
  ToolCall,
  ToolCallDelta,
  ToolExecutionResult,
  ToolError,
  ToolMessage,
} from "./types.js";

export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  maxMessages: Number.POSITIVE_INFINITY,
  maxMessageChars: Number.POSITIVE_INFINITY,
  maxRequestChars: Number.POSITIVE_INFINITY,
  maxToolOutputChars: Number.POSITIVE_INFINITY,
  maxToolCallsPerTurn: Number.POSITIVE_INFINITY,
});

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function runId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return clone(messages).map(freeze);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

function addUsage(current: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  const result: ModelUsage = {};
  if (current.inputTokens !== undefined || next.inputTokens !== undefined) result.inputTokens = (current.inputTokens ?? 0) + (next.inputTokens ?? 0);
  if (current.outputTokens !== undefined || next.outputTokens !== undefined) result.outputTokens = (current.outputTokens ?? 0) + (next.outputTokens ?? 0);
  if (current.totalTokens !== undefined || next.totalTokens !== undefined) result.totalTokens = (current.totalTokens ?? 0) + (next.totalTokens ?? 0);
  return result;
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value);
}

function errorResult(code: string, message: string): Extract<ToolExecutionResult, { readonly ok: false }> {
  const error: ToolError = { code, message };
  return { ok: false, error };
}

function assertToolCall(call: ToolCall): void {
  const candidate: unknown = call;
  if (typeof candidate !== "object" || candidate === null) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    !isJsonValue(record.arguments)
  ) {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
  }
}

function assertToolCallDelta(delta: ToolCallDelta): void {
  const candidate: unknown = delta;
  if (typeof candidate !== "object" || candidate === null) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
  const record = candidate as Record<string, unknown>;
  if (!Number.isInteger(record.index) || Number(record.index) < 0) {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call index.");
  }
  for (const key of ["id", "name", "arguments"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
    }
  }
}

interface StreamedToolCallDraft {
  id: string;
  name: string;
  arguments: string;
}

function completeStreamedToolCalls(drafts: ReadonlyMap<number, StreamedToolCallDraft>): ToolCall[] {
  return [...drafts.entries()].sort(([left], [right]) => left - right).map(([index, draft]) => {
    const name = draft.name.trim();
    if (!name) throw new KernelError("INVALID_MODEL_OUTPUT", `Tool call ${index + 1} did not include a name.`);
    let argumentsValue: unknown = {};
    if (draft.arguments.trim().length > 0) {
      try {
        argumentsValue = JSON.parse(draft.arguments) as unknown;
      } catch {
        throw new KernelError("INVALID_MODEL_OUTPUT", `Tool call ${name} returned malformed arguments.`);
      }
    }
    if (!isJsonValue(argumentsValue)) throw new KernelError("INVALID_MODEL_OUTPUT", `Tool call ${name} returned non-JSON arguments.`);
    return { id: draft.id || `call-${index + 1}`, name, arguments: argumentsValue };
  });
}

function assertAssistant(message: AssistantMessage): void {
  const candidate: unknown = message;
  if (typeof candidate !== "object" || candidate === null) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  const record = candidate as Record<string, unknown>;
  if (record.role !== "assistant" || typeof record.content !== "string") {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  }
  if (record.reasoning !== undefined && typeof record.reasoning !== "string") {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned invalid reasoning text.");
  }
  if (record.toolCalls !== undefined) {
    if (!Array.isArray(record.toolCalls)) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned invalid tool calls.");
    for (const call of record.toolCalls) assertToolCall(call as ToolCall);
  }
}

function assertMessages(messages: readonly ModelMessage[], limits: AgentLimits, validateContents = true): void {
  if (!Array.isArray(messages) || messages.length > limits.maxMessages) {
    throw new KernelError("MESSAGE_LIMIT_EXCEEDED", `A run may contain at most ${limits.maxMessages} messages.`);
  }
  if (Number.isFinite(limits.maxRequestChars)) {
    const serialized = JSON.stringify(messages) ?? "";
    if (serialized.length > limits.maxRequestChars) {
      throw new KernelError("REQUEST_LIMIT_EXCEEDED", `The model request exceeds the ${limits.maxRequestChars}-character limit.`);
    }
  }
  if (!validateContents) return;
  for (const message of messages) {
    if (!isJsonValue(message) || typeof message !== "object" || Array.isArray(message)) {
      throw new KernelError("INVALID_MESSAGES", "Model messages must be JSON objects.");
    }
    const record = message as Record<string, unknown>;
    if (!['system', 'user', 'assistant', 'tool'].includes(String(record.role))) throw new KernelError("INVALID_MESSAGES", "Model messages have an invalid role.");
    if (typeof record.content !== "string") throw new KernelError("INVALID_MESSAGES", "Every model message needs string content.");
    if (record.role === "user" && record.attachmentIds !== undefined) {
      if (!Array.isArray(record.attachmentIds) || record.attachmentIds.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new KernelError("INVALID_MESSAGES", "User attachment IDs must be non-empty strings.");
      }
    }
    if (record.content.length > limits.maxMessageChars) {
      throw new KernelError("MESSAGE_LIMIT_EXCEEDED", `A model message may contain at most ${limits.maxMessageChars} characters.`);
    }
    if (record.role === "assistant" && record.reasoning !== undefined && typeof record.reasoning !== "string") {
      throw new KernelError("INVALID_MESSAGES", "Assistant reasoning must be a string.");
    }
    if (record.role === "assistant" && typeof record.reasoning === "string" && record.reasoning.length > limits.maxMessageChars) {
      throw new KernelError("MESSAGE_LIMIT_EXCEEDED", `Assistant reasoning may contain at most ${limits.maxMessageChars} characters.`);
    }
    if (record.role === "assistant" && record.toolCalls !== undefined) {
      if (!Array.isArray(record.toolCalls)) throw new KernelError("INVALID_MESSAGES", "Assistant tool calls must be an array.");
      for (const call of record.toolCalls) assertToolCall(call as ToolCall);
    }
  }
}

function assertAttachments(attachments: readonly ModelAttachment[] | undefined, messages: readonly ModelMessage[]): void {
  const byId = new Map<string, ModelAttachment>();
  for (const attachment of attachments ?? []) {
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      typeof attachment.id !== "string" ||
      attachment.id.length === 0 ||
      typeof attachment.name !== "string" ||
      attachment.name.length === 0 ||
      typeof attachment.mediaType !== "string" ||
      !attachment.mediaType.startsWith("image/") ||
      !(attachment.data instanceof Uint8Array) ||
      attachment.data.byteLength === 0
    ) {
      throw new KernelError("INVALID_ATTACHMENTS", "Model attachments must contain non-empty image bytes.");
    }
    if (byId.has(attachment.id)) throw new KernelError("INVALID_ATTACHMENTS", `Duplicate model attachment ID “${attachment.id}”.`);
    byId.set(attachment.id, attachment);
  }
  for (const message of messages) {
    if (message.role !== "user" || message.attachmentIds === undefined) continue;
    for (const id of message.attachmentIds) {
      if (!byId.has(id)) throw new KernelError("INVALID_ATTACHMENTS", `User message references missing attachment “${id}”.`);
    }
  }
}

function assertUsage(usage: ModelUsage): void {
  const candidate: unknown = usage;
  if (typeof candidate !== "object" || candidate === null) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
  const record = candidate as Record<string, unknown>;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
    }
  }
}

function validateLimits(input: AgentLimits): void {
  for (const [name, value] of Object.entries(input) as Array<[keyof AgentLimits, number]>) {
    if (value === Number.POSITIVE_INFINITY) continue;
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer or Infinity.`);
  }
}

async function executeWithTimeout(
  kernel: AgentKernel,
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
): Promise<ToolExecutionResult> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  const execution = kernel.executeTool(call.name, call.arguments, controller.signal).catch((error) => {
    const info = errorInfo(error, "TOOL_ERROR");
    return { ok: false, error: info } as ToolExecutionResult;
  });
  const abort = new Promise<never>((_, reject) => {
    onParentAbort = () => {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });
  const timeout = timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY
    ? undefined
    : new Promise<ToolExecutionResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new KernelError("TOOL_TIMEOUT", "Tool execution timed out."));
          resolve(errorResult("TOOL_TIMEOUT", `Tool execution exceeded ${timeoutMs} ms.`));
        }, timeoutMs);
      });

  try {
    const races: Array<Promise<ToolExecutionResult>> = [execution, abort as Promise<ToolExecutionResult>];
    if (timeout !== undefined) races.push(timeout);
    return await Promise.race(races);
  } finally {
    parentSignal.removeEventListener("abort", relayAbort);
    if (onParentAbort !== undefined) parentSignal.removeEventListener("abort", onParentAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class Agent {
  private model: ModelAdapter;
  private readonly kernel: AgentKernel;

  constructor(model: ModelAdapter, kernel: AgentKernel) {
    this.model = model;
    this.kernel = kernel;
  }

  setModel(model: ModelAdapter): void {
    this.model = model;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const id = runId();
    const signal = request.signal ?? NEVER_ABORTED_SIGNAL;
    const maxTurns = request.maxTurns;
    const modelTimeoutMs = request.modelTimeoutMs;
    const toolTimeoutMs = request.toolTimeoutMs;
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...(request.limits ?? {}) };
    if (maxTurns !== undefined && maxTurns !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error("maxTurns must be a positive integer or Infinity.");
    if (modelTimeoutMs !== undefined && modelTimeoutMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs < 1)) throw new Error("modelTimeoutMs must be positive or Infinity.");
    if (toolTimeoutMs !== undefined && toolTimeoutMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs < 1)) throw new Error("toolTimeoutMs must be positive or Infinity.");
    validateLimits(limits);

    const messages: ModelMessage[] = [];
    let turns = 0;
    let usage: ModelUsage | undefined;
    this.emit(request.onEvent, { type: "run-started", runId: id });

    const finish = (result: Omit<AgentRunResult, "runId" | "messages" | "turns" | "usage">): AgentRunResult => {
      const complete: AgentRunResult = {
        runId: id,
        status: result.status,
        messages: Object.freeze([...messages]),
        turns,
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(usage === undefined ? {} : { usage }),
      };
      this.emit(request.onEvent, { type: "run-finished", result: complete });
      return complete;
    };

    const fail = (error: ToolError): AgentRunResult => {
      this.emit(request.onEvent, { type: "run-error", error });
      return finish({ status: "failed", error });
    };

    try {
      assertMessages(request.messages, limits);
      assertAttachments(request.attachments, request.messages);
      messages.push(...cloneMessages(request.messages));
    } catch (error) {
      return fail(errorInfo(error, "INVALID_MESSAGES"));
    }

    while (true) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
      }
      try {
        assertMessages(messages, limits, false);
      } catch (error) {
        return fail(errorInfo(error, "MESSAGE_LIMIT_EXCEEDED"));
      }

      turns += 1;
      this.emit(request.onEvent, { type: "model-started", turn: turns });
      let completed: AssistantMessage | undefined;
      let streamedText = "";
      let streamedReasoning = "";
      const streamedCalls: ToolCall[] = [];
      const streamedCallDeltas = new Map<number, StreamedToolCallDraft>();
      let sawCompleted = false;

      const descriptors = this.kernel.descriptors();
      const modelController = new AbortController();
      const relayModelAbort = () => modelController.abort(signal.reason);
      signal.addEventListener("abort", relayModelAbort, { once: true });
      let modelTimer: ReturnType<typeof setTimeout> | undefined;
      let onModelParentAbort: (() => void) | undefined;
      let iterator: AsyncIterator<ModelEvent> | undefined;
      let timedOut = false;
      try {
        const consume = (async () => {
          const iterable = this.model.stream({
            messages: Object.freeze([...messages]),
            ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
            tools: descriptors,
            signal: modelController.signal,
          });
          const currentIterator = iterable[Symbol.asyncIterator]();
          iterator = currentIterator;
          try {
            while (true) {
              const next = await currentIterator.next();
              if (next.done) break;
              throwIfAborted(signal);
              throwIfAborted(modelController.signal);
              const event = next.value;
              if (typeof event !== "object" || event === null || typeof event.type !== "string") {
                throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid event.");
              }
              switch (event.type) {
                case "text-delta":
                  if (typeof event.delta !== "string") throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid text delta.");
                  streamedText += event.delta;
                  if (streamedText.length > limits.maxMessageChars) throw new KernelError("MODEL_OUTPUT_TOO_LARGE", "Model output is too large.");
                  this.emit(request.onEvent, event);
                  break;
                case "reasoning-delta":
                  if (typeof event.delta !== "string") throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid reasoning delta.");
                  streamedReasoning += event.delta;
                  if (streamedReasoning.length > limits.maxMessageChars) throw new KernelError("MODEL_OUTPUT_TOO_LARGE", "Model reasoning is too large.");
                  this.emit(request.onEvent, event);
                  break;
                case "tool-call-delta": {
                  assertToolCallDelta(event.delta);
                  const previous = streamedCallDeltas.get(event.delta.index) ?? { id: `call-${event.delta.index + 1}`, name: "", arguments: "" };
                  streamedCallDeltas.set(event.delta.index, {
                    id: event.delta.id ?? previous.id,
                    name: `${previous.name}${event.delta.name ?? ""}`,
                    arguments: `${previous.arguments}${event.delta.arguments ?? ""}`,
                  });
                  this.emit(request.onEvent, event);
                  break;
                }
                case "tool-call":
                  assertToolCall(event.call);
                  streamedCalls.push(event.call);
                  this.emit(request.onEvent, {
                    type: "tool-call-delta",
                    delta: { index: streamedCalls.length - 1, id: event.call.id, name: event.call.name, arguments: JSON.stringify(event.call.arguments) },
                  });
                  break;
                case "usage":
                  assertUsage(event.usage);
                  usage = addUsage(usage, event.usage);
                  break;
                case "completed":
                  assertAssistant(event.message);
                  completed = event.message;
                  sawCompleted = true;
                  if (event.usage !== undefined) {
                    assertUsage(event.usage);
                    usage = addUsage(usage, event.usage);
                  }
                  break;
                default:
                  throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an unknown event.");
              }
            }
          } finally {
            if (currentIterator.return !== undefined) await currentIterator.return();
          }
        })();
        const abort = new Promise<never>((_, reject) => {
          onModelParentAbort = () => {
            const error = new Error("Operation cancelled.");
            error.name = "AbortError";
            reject(error);
          };
          signal.addEventListener("abort", onModelParentAbort, { once: true });
        });
        const timeout = modelTimeoutMs === undefined || modelTimeoutMs === Number.POSITIVE_INFINITY
          ? undefined
          : new Promise<never>((_, reject) => {
              modelTimer = setTimeout(() => {
                timedOut = true;
                modelController.abort(new KernelError("MODEL_TIMEOUT", "Model request timed out."));
                void iterator?.return?.();
                reject(new KernelError("MODEL_TIMEOUT", `Model request exceeded ${modelTimeoutMs} ms.`));
              }, modelTimeoutMs);
            });
        const races: Array<Promise<unknown>> = [consume, abort];
        if (timeout !== undefined) races.push(timeout);
        await Promise.race(races);
      } catch (error) {
        if (timedOut) return fail(errorInfo(error, "MODEL_TIMEOUT"));
        if (signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
        if (isAbortError(error)) return fail(errorInfo(error, "MODEL_ERROR"));
        return fail(errorInfo(error, "MODEL_ERROR"));
      } finally {
        signal.removeEventListener("abort", relayModelAbort);
        if (onModelParentAbort !== undefined) signal.removeEventListener("abort", onModelParentAbort);
        if (modelTimer !== undefined) clearTimeout(modelTimer);
        if (timedOut) modelController.abort(new KernelError("MODEL_TIMEOUT", "Model request timed out."));
      }

      if (!sawCompleted) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned no completed response." });
      const calls = completed?.toolCalls === undefined || (completed.toolCalls.length === 0 && (streamedCalls.length > 0 || streamedCallDeltas.size > 0))
        ? streamedCalls.length > 0 ? streamedCalls : completeStreamedToolCalls(streamedCallDeltas)
        : [...completed.toolCalls];
      if (calls.length > limits.maxToolCallsPerTurn) {
        return fail({ code: "TOOL_CALL_LIMIT_EXCEEDED", message: `A model turn may contain at most ${limits.maxToolCallsPerTurn} tool calls.` });
      }
      const callIds = new Set<string>();
      for (const call of calls) {
        if (callIds.has(call.id)) return fail({ code: "INVALID_MODEL_OUTPUT", message: "Model returned duplicate tool call IDs." });
        callIds.add(call.id);
      }
      const baseAssistant: AssistantMessage = completed ?? { role: "assistant", content: streamedText };
      const content = baseAssistant.content.length === 0 && streamedText.length > 0 ? streamedText : baseAssistant.content;
      const reasoning = baseAssistant.reasoning === undefined && streamedReasoning.length > 0 ? streamedReasoning : baseAssistant.reasoning;
      const assistantBase: AssistantMessage = reasoning === undefined ? { ...baseAssistant, content } : { ...baseAssistant, content, reasoning };
      const assistant: AssistantMessage = calls.length === 0
        ? assistantBase
        : { ...assistantBase, toolCalls: calls };
      assertAssistant(assistant);
      if (assistant.content.trim().length === 0 && calls.length === 0) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned an empty response." });
      if (assistant.content.length > limits.maxMessageChars) return fail({ code: "MODEL_OUTPUT_TOO_LARGE", message: "Model output is too large." });
      const immutableAssistant = freeze(clone(assistant));
      messages.push(immutableAssistant);
      this.emit(request.onEvent, { type: "assistant-message", message: immutableAssistant });

      if (calls.length === 0) return finish({ status: "completed", response: immutableAssistant });
      if (maxTurns !== undefined && turns >= maxTurns) return finish({ status: "max-turns", response: immutableAssistant });

      let executed: readonly { readonly call: ToolCall; readonly result: ToolExecutionResult }[];
      try {
        executed = await Promise.all(calls.map(async (call) => {
          throwIfAborted(signal);
          this.emit(request.onEvent, { type: "tool-started", call });
          let result: ToolExecutionResult;
          try {
            result = await executeWithTimeout(this.kernel, call, signal, toolTimeoutMs);
          } catch (error) {
            if (isAbortError(error) || signal.aborted) throw error;
            result = errorResult("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.");
          }
          this.emit(request.onEvent, { type: "tool-finished", call, result });
          return { call, result };
        }));
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
        return fail(errorInfo(error, "TOOL_ERROR"));
      }

      for (const { call, result } of executed) {
        try {
          const toolMessage: ToolMessage = result.ok
            ? { role: "tool", callId: call.id, name: call.name, content: jsonString(result.value) }
            : { role: "tool", callId: call.id, name: call.name, content: jsonString({ error: jsonError(result.error) }), isError: true };
          messages.push(Object.freeze(toolMessage));
          assertMessages(messages, limits, false);
          if (!result.ok && result.error.code === "TOOL_TIMEOUT") return fail(result.error);
        } catch (error) {
          if (isAbortError(error) || signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
          if (error instanceof KernelError && ["MESSAGE_LIMIT_EXCEEDED", "REQUEST_LIMIT_EXCEEDED"].includes(error.code)) return fail(errorInfo(error, error.code));
          return fail(errorInfo(error, "TOOL_ERROR"));
        }
      }
    }
  }

  private emit(onEvent: AgentRunRequest["onEvent"], event: AgentEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // Observer failures must not interrupt an agent run.
    }
  }
}
