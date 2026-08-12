import { errorInfo, isAbortError, jsonError, KernelError } from "./errors.js";
import { isJsonValue } from "./schema.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  AgentEvent,
  AgentLimits,
  AgentRunRequest,
  AgentRunResult,
  AssistantMessage,
  JsonValue,
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

function runId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  if (typeof structuredClone === "function") return structuredClone(messages) as ModelMessage[];
  return JSON.parse(JSON.stringify(messages)) as ModelMessage[];
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

function assertMessages(messages: readonly ModelMessage[], limits: AgentLimits): void {
  if (!Array.isArray(messages) || messages.length > limits.maxMessages) {
    throw new KernelError("MESSAGE_LIMIT_EXCEEDED", `A run may contain at most ${limits.maxMessages} messages.`);
  }
  for (const message of messages) {
    if (!isJsonValue(message) || typeof message !== "object" || Array.isArray(message)) {
      throw new KernelError("INVALID_MESSAGES", "Model messages must be JSON objects.");
    }
    const record = message as Record<string, unknown>;
    if (!['system', 'user', 'assistant', 'tool'].includes(String(record.role))) throw new KernelError("INVALID_MESSAGES", "Model messages have an invalid role.");
    if (typeof record.content !== "string") throw new KernelError("INVALID_MESSAGES", "Every model message needs string content.");
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
  if (Number.isFinite(limits.maxRequestChars)) {
    const serialized = JSON.stringify(messages) ?? "";
    if (serialized.length > limits.maxRequestChars) {
      throw new KernelError("REQUEST_LIMIT_EXCEEDED", `The model request exceeds the ${limits.maxRequestChars}-character limit.`);
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
  registry: ToolRegistry,
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
  const execution = registry.execute(call.name, call.arguments, { signal: controller.signal }).catch((error) => {
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
  private readonly tools: ToolRegistry;

  constructor(model: ModelAdapter, tools: ToolRegistry) {
    this.model = model;
    this.tools = tools;
  }

  setModel(model: ModelAdapter): void {
    this.model = model;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const id = runId();
    const signal = request.signal ?? new AbortController().signal;
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
        messages: cloneMessages(messages),
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
        assertMessages(messages, limits);
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

      const descriptors = this.tools.descriptors();
      const modelController = new AbortController();
      const relayModelAbort = () => modelController.abort(signal.reason);
      signal.addEventListener("abort", relayModelAbort, { once: true });
      let modelTimer: ReturnType<typeof setTimeout> | undefined;
      let onModelParentAbort: (() => void) | undefined;
      let iterator: AsyncIterator<ModelEvent> | undefined;
      let timedOut = false;
      try {
        const consume = (async () => {
          const iterable = this.model.stream({ messages: cloneMessages(messages), tools: descriptors, signal: modelController.signal });
          const currentIterator = iterable[Symbol.asyncIterator]();
          iterator = currentIterator;
          try {
            while (true) {
              const next = await currentIterator.next();
              if (next.done) break;
              throwIfAborted(signal);
              throwIfAborted(modelController.signal);
              this.consumeModelEvent(
                next.value,
                request.onEvent,
                streamedCalls,
                streamedCallDeltas,
                (delta) => {
                  streamedText += delta;
                  if (streamedText.length > limits.maxMessageChars) throw new KernelError("MODEL_OUTPUT_TOO_LARGE", "Model output is too large.");
                },
                (delta) => {
                  streamedReasoning += delta;
                  if (streamedReasoning.length > limits.maxMessageChars) throw new KernelError("MODEL_OUTPUT_TOO_LARGE", "Model reasoning is too large.");
                },
                (message) => {
                  completed = message;
                  sawCompleted = true;
                },
                (nextUsage) => {
                  usage = addUsage(usage, nextUsage);
                },
              );
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
      messages.push(assistant);
      this.emit(request.onEvent, { type: "assistant-message", message: assistant });

      if (calls.length === 0) return finish({ status: "completed", response: assistant });
      if (maxTurns !== undefined && turns >= maxTurns) return finish({ status: "max-turns", response: assistant });

      for (const call of calls) {
        try {
          throwIfAborted(signal);
          this.emit(request.onEvent, { type: "tool-started", call });
          const result = await executeWithTimeout(this.tools, call, signal, toolTimeoutMs);
          this.emit(request.onEvent, { type: "tool-finished", call, result });
          const toolMessage: ToolMessage = result.ok
            ? { role: "tool", callId: call.id, name: call.name, content: jsonString(result.value) }
            : { role: "tool", callId: call.id, name: call.name, content: jsonString({ error: jsonError(result.error) }), isError: true };
          messages.push(toolMessage);
          assertMessages(messages, limits);
          if (!result.ok && result.error.code === "TOOL_TIMEOUT") return fail(result.error);
        } catch (error) {
          if (isAbortError(error) || signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
          if (error instanceof KernelError && ["MESSAGE_LIMIT_EXCEEDED", "REQUEST_LIMIT_EXCEEDED"].includes(error.code)) return fail(errorInfo(error, error.code));
          const result = errorResult("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.");
          this.emit(request.onEvent, { type: "tool-finished", call, result });
          messages.push({ role: "tool", callId: call.id, name: call.name, content: jsonString({ error: jsonError(result.error) }), isError: true });
          try {
            assertMessages(messages, limits);
          } catch (limitError) {
            return fail(errorInfo(limitError, "MESSAGE_LIMIT_EXCEEDED"));
          }
        }
      }
    }
  }

  private consumeModelEvent(
    event: ModelEvent,
    onEvent: AgentRunRequest["onEvent"],
    calls: ToolCall[],
    callDeltas: Map<number, StreamedToolCallDraft>,
    addText: (delta: string) => void,
    addReasoning: (delta: string) => void,
    setCompleted: (message: AssistantMessage) => void,
    addUsageValue: (usage: ModelUsage) => void,
  ): void {
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid event.");
    }
    switch (event.type) {
      case "text-delta":
        if (typeof event.delta !== "string") throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid text delta.");
        addText(event.delta);
        this.emit(onEvent, event);
        break;
      case "reasoning-delta":
        if (typeof event.delta !== "string") throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid reasoning delta.");
        addReasoning(event.delta);
        this.emit(onEvent, event);
        break;
      case "tool-call-delta": {
        assertToolCallDelta(event.delta);
        const previous = callDeltas.get(event.delta.index) ?? { id: `call-${event.delta.index + 1}`, name: "", arguments: "" };
        callDeltas.set(event.delta.index, {
          id: event.delta.id ?? previous.id,
          name: `${previous.name}${event.delta.name ?? ""}`,
          arguments: `${previous.arguments}${event.delta.arguments ?? ""}`,
        });
        this.emit(onEvent, event);
        break;
      }
      case "tool-call":
        assertToolCall(event.call);
        calls.push(event.call);
        this.emit(onEvent, {
          type: "tool-call-delta",
          delta: { index: calls.length - 1, id: event.call.id, name: event.call.name, arguments: JSON.stringify(event.call.arguments) },
        });
        break;
      case "usage":
        assertUsage(event.usage);
        addUsageValue(event.usage);
        break;
      case "completed":
        assertAssistant(event.message);
        setCompleted(event.message);
        if (event.usage !== undefined) {
          assertUsage(event.usage);
          addUsageValue(event.usage);
        }
        break;
      default:
        throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an unknown event.");
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
