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
  ToolExecutionResult,
  ToolError,
  ToolMessage,
} from "./types.js";

export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  maxMessages: 200,
  maxMessageChars: 32_000,
  maxRequestChars: 500_000,
  maxToolOutputChars: 64_000,
  maxToolCallsPerTurn: 16,
});

const MAX_TURNS = 32;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;

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
    record.id.length > 256 ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    record.name.length > 128 ||
    !isJsonValue(record.arguments)
  ) {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
  }
}

function assertAssistant(message: AssistantMessage): void {
  const candidate: unknown = message;
  if (typeof candidate !== "object" || candidate === null) throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  const record = candidate as Record<string, unknown>;
  if (record.role !== "assistant" || typeof record.content !== "string") {
    throw new KernelError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
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
    if (record.role === "assistant" && record.toolCalls !== undefined) {
      if (!Array.isArray(record.toolCalls)) throw new KernelError("INVALID_MESSAGES", "Assistant tool calls must be an array.");
      for (const call of record.toolCalls) assertToolCall(call as ToolCall);
    }
  }
  const serialized = JSON.stringify(messages) ?? "";
  if (serialized.length > limits.maxRequestChars) {
    throw new KernelError("REQUEST_LIMIT_EXCEEDED", `The model request exceeds the ${limits.maxRequestChars}-character limit.`);
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
  const ceilings: AgentLimits = {
    maxMessages: 2_000,
    maxMessageChars: 100_000,
    maxRequestChars: 1_000_000,
    maxToolOutputChars: 100_000,
    maxToolCallsPerTurn: 64,
  };
  for (const [name, value] of Object.entries(input) as Array<[keyof AgentLimits, number]>) {
    if (!Number.isInteger(value) || value < 1 || value > ceilings[name]) throw new Error(`${name} must be an integer between 1 and ${ceilings[name]}.`);
  }
}

async function executeWithTimeout(
  registry: ToolRegistry,
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<ToolExecutionResult> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  let timedOut = false;
  const execution = registry.execute(call.name, call.arguments, { signal: controller.signal }).catch((error) => {
    const info = errorInfo(error, "TOOL_ERROR");
    return { ok: false, error: info } as ToolExecutionResult;
  });
  const timeout = new Promise<ToolExecutionResult>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new KernelError("TOOL_TIMEOUT", "Tool execution timed out."));
      resolve(errorResult("TOOL_TIMEOUT", `Tool execution exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    onParentAbort = () => {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });

  try {
    const result = await Promise.race([execution, timeout]);
    if (timedOut) return errorResult("TOOL_TIMEOUT", `Tool execution exceeded ${timeoutMs} ms.`);
    return result;
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
    const maxTurns = request.maxTurns ?? 8;
    const modelTimeoutMs = request.modelTimeoutMs ?? 120_000;
    const toolTimeoutMs = request.toolTimeoutMs ?? 15_000;
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...(request.limits ?? {}) };
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS) throw new Error(`maxTurns must be an integer between 1 and ${MAX_TURNS}.`);
    if (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > MAX_TIMEOUT_MS) throw new Error(`modelTimeoutMs must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
    if (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > MAX_TIMEOUT_MS) throw new Error(`toolTimeoutMs must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
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
      const streamedCalls: ToolCall[] = [];
      let sawCompleted = false;

      const descriptors = this.tools.descriptors();
      if ((JSON.stringify({ messages, tools: descriptors }) ?? "").length > limits.maxRequestChars) {
        return fail({ code: "REQUEST_LIMIT_EXCEEDED", message: `The model request exceeds the ${limits.maxRequestChars}-character limit.` });
      }
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
                (delta) => {
                  streamedText += delta;
                  if (streamedText.length > limits.maxMessageChars) throw new KernelError("MODEL_OUTPUT_TOO_LARGE", "Model output is too large.");
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
        const timeout = new Promise<never>((_, reject) => {
          modelTimer = setTimeout(() => {
            timedOut = true;
            modelController.abort(new KernelError("MODEL_TIMEOUT", "Model request timed out."));
            void iterator?.return?.();
            reject(new KernelError("MODEL_TIMEOUT", `Model request exceeded ${modelTimeoutMs} ms.`));
          }, modelTimeoutMs);
          onModelParentAbort = () => {
            const error = new Error("Operation cancelled.");
            error.name = "AbortError";
            reject(error);
          };
          signal.addEventListener("abort", onModelParentAbort, { once: true });
        });
        await Promise.race([consume, timeout]);
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
      const calls = completed?.toolCalls === undefined || (completed.toolCalls.length === 0 && streamedCalls.length > 0) ? streamedCalls : [...completed.toolCalls];
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
      const assistant: AssistantMessage = calls.length === 0
        ? { role: "assistant", content }
        : { ...baseAssistant, content, toolCalls: calls };
      assertAssistant(assistant);
      if (assistant.content.trim().length === 0 && calls.length === 0) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned an empty response." });
      if (assistant.content.length > limits.maxMessageChars) return fail({ code: "MODEL_OUTPUT_TOO_LARGE", message: "Model output is too large." });
      messages.push(assistant);
      this.emit(request.onEvent, { type: "assistant-message", message: assistant });

      if (calls.length === 0) return finish({ status: "completed", response: assistant });
      if (turns >= maxTurns) return finish({ status: "max-turns", response: assistant });

      for (const call of calls) {
        try {
          throwIfAborted(signal);
          this.emit(request.onEvent, { type: "tool-started", call });
          let result = await executeWithTimeout(this.tools, call, signal, toolTimeoutMs);
          if (result.ok && (JSON.stringify(result.value) ?? "").length > limits.maxToolOutputChars) {
            result = errorResult("TOOL_OUTPUT_TOO_LARGE", `Tool output exceeds the ${limits.maxToolOutputChars}-character limit.`);
          }
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
    addText: (delta: string) => void,
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
      case "tool-call":
        assertToolCall(event.call);
        calls.push(event.call);
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
