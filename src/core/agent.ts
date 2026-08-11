import { errorInfo, isAbortError, jsonError, KernelError } from "./errors.js";
import { isJsonValue } from "./schema.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  AgentEvent,
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
  if (typeof record.id !== "string" || record.id.length === 0 || typeof record.name !== "string" || record.name.length === 0 || !isJsonValue(record.arguments)) {
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
  const execution = registry.execute(call.name, call.arguments, { signal: controller.signal }).catch((error) => {
    const info = errorInfo(error, "TOOL_ERROR");
    return { ok: false, error: info } as ToolExecutionResult;
  });
  const timeout = new Promise<ToolExecutionResult>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Tool execution timed out."));
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
    return await Promise.race([execution, timeout]);
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
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer.");
    if (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs < 1) throw new Error("modelTimeoutMs must be positive.");
    if (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs < 1) throw new Error("toolTimeoutMs must be positive.");

    const messages: ModelMessage[] = cloneMessages(request.messages);
    let turns = 0;
    let usage: ModelUsage | undefined;
    this.emit(request.onEvent, { type: "run-started", runId: id });

    const finish = (result: Omit<AgentRunResult, "runId" | "messages" | "turns" | "usage">): AgentRunResult => {
      const complete: AgentRunResult = {
        runId: id,
        status: result.status,
        messages: [...messages],
        turns,
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(usage === undefined ? {} : { usage }),
      };
      this.emit(request.onEvent, { type: "run-finished", result: complete });
      return complete;
    };

    while (true) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
      }

      turns += 1;
      this.emit(request.onEvent, { type: "model-started", turn: turns });
      let completed: AssistantMessage | undefined;
      let streamedText = "";
      const streamedCalls: ToolCall[] = [];

      const modelController = new AbortController();
      const relayModelAbort = () => modelController.abort(signal.reason);
      signal.addEventListener("abort", relayModelAbort, { once: true });
      let modelTimer: ReturnType<typeof setTimeout> | undefined;
      let onModelParentAbort: (() => void) | undefined;
      try {
        const consume = (async () => {
          const events = this.model.stream({ messages: cloneMessages(messages), tools: this.tools.descriptors(), signal: modelController.signal });
          for await (const event of events) {
            throwIfAborted(signal);
            throwIfAborted(modelController.signal);
            this.consumeModelEvent(event, request.onEvent, streamedCalls, (delta) => {
              streamedText += delta;
            }, (message) => {
              completed = message;
            }, (nextUsage) => {
              usage = addUsage(usage, nextUsage);
            });
          }
        })();
        const timeout = new Promise<never>((_, reject) => {
          modelTimer = setTimeout(() => {
            modelController.abort(new Error("Model request timed out."));
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
        if (isAbortError(error) || signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
        const info = errorInfo(error, "MODEL_ERROR");
        this.emit(request.onEvent, { type: "run-error", error: info });
        return finish({ status: "failed", error: info });
      } finally {
        signal.removeEventListener("abort", relayModelAbort);
        if (onModelParentAbort !== undefined) signal.removeEventListener("abort", onModelParentAbort);
        if (modelTimer !== undefined) clearTimeout(modelTimer);
      }

      const calls = completed?.toolCalls === undefined ? streamedCalls : [...completed.toolCalls];
      const assistant: AssistantMessage = completed === undefined
        ? calls.length === 0
          ? { role: "assistant", content: streamedText }
          : { role: "assistant", content: streamedText, toolCalls: calls }
        : calls.length === 0 || completed.toolCalls !== undefined
          ? completed
          : { ...completed, toolCalls: calls };
      messages.push(assistant);
      this.emit(request.onEvent, { type: "assistant-message", message: assistant });

      if (calls.length === 0) return finish({ status: "completed", response: assistant });
      if (turns >= maxTurns) return finish({ status: "max-turns", response: assistant });

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
        } catch (error) {
          if (isAbortError(error) || signal.aborted) return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
          const result = errorResult("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.");
          this.emit(request.onEvent, { type: "tool-finished", call, result });
          messages.push({ role: "tool", callId: call.id, name: call.name, content: jsonString({ error: jsonError(result.error) }), isError: true });
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