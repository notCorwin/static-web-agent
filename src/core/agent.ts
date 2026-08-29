import { errorInfo, isAbortError, jsonError, HarnessError } from "./errors.js";
import { formatIssues, isJsonValue, validate } from "./schema.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AssistantMessage,
  JsonObject,
  JsonValue,
  ModelAdapter,
  ModelEvent,
  ModelMessage,
  ModelUsage,
  PageRuntime,
  PageExecutionResult,
  ToolCall,
  ToolCallDelta,
  ToolError,
  ToolExecutionResult,
  ToolMessage,
  ToolDescriptor,
} from "./types.js";

export const PAGE_TOOL_NAME = "page.run";

export const PAGE_TOOL_DESCRIPTOR: ToolDescriptor = freeze({
  name: PAGE_TOOL_NAME,
  description: "Run JavaScript in the current Harness page. Use the real Web APIs available to this page and return a JSON-serializable value. The page is trusted, not sandboxed; no shell, native process, host filesystem, or other-tab access is provided.",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: { type: "string" as const, minLength: 1 },
      input: {},
    },
    required: ["code"],
    additionalProperties: false,
  },
});

const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const STREAM_EVENT_YIELD_BATCH = 32;

function runId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return clone(messages).map((message) => freeze(message));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

function yieldToHost(signal: AbortSignal): Promise<void> {
  // ponytail: one task yield per burst keeps streaming responsive without a render scheduler in the core.
  const task = typeof MessageChannel === "function"
    ? new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(0);
      })
    : new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  return task.then(() => throwIfAborted(signal));
}

function addUsage(current: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return {
    ...(current.inputTokens !== undefined || next.inputTokens !== undefined ? { inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0) } : {}),
    ...(current.outputTokens !== undefined || next.outputTokens !== undefined ? { outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0) } : {}),
    ...(current.totalTokens !== undefined || next.totalTokens !== undefined ? { totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0) } : {}),
  };
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value);
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function errorResult(code: string, message: string, durationMs = 0): Extract<ToolExecutionResult, { readonly ok: false }> {
  return { ok: false, error: { code, message }, durationMs };
}

function abortedToolResult(error: unknown): Extract<ToolExecutionResult, { readonly ok: false }> {
  return { ok: false, error: errorInfo(error, "ABORTED"), durationMs: 0 };
}

function assertToolCall(call: ToolCall): void {
  const candidate: unknown = call;
  if (typeof candidate !== "object" || candidate === null) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id.length === 0 ||
    typeof record.name !== "string" || record.name.length === 0 ||
    !isJsonValue(record.arguments)
  ) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
}

function assertToolCalls(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    assertToolCall(call);
    if (ids.has(call.id)) throw new HarnessError("INVALID_MODEL_OUTPUT", `Model returned duplicate tool call ID “${call.id}”.`);
    ids.add(call.id);
  }
}

function assertToolCallDelta(delta: ToolCallDelta): void {
  const candidate: unknown = delta;
  if (typeof candidate !== "object" || candidate === null) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
  const record = candidate as Record<string, unknown>;
  if (!Number.isInteger(record.index) || Number(record.index) < 0) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call index.");
  if (
    (record.id !== undefined && typeof record.id !== "string") ||
    (record.name !== undefined && typeof record.name !== "string") ||
    (record.arguments !== undefined && typeof record.arguments !== "string")
  ) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
}

interface StreamedToolCallDraft {
  id: string;
  readonly name: string[];
  readonly arguments: string[];
}

function completeStreamedToolCalls(drafts: ReadonlyMap<number, StreamedToolCallDraft>): ToolCall[] {
  return [...drafts.entries()].sort(([left], [right]) => left - right).map(([index, draft]) => {
    const name = draft.name.join("").trim();
    if (!name) throw new HarnessError("INVALID_MODEL_OUTPUT", `Tool call ${index + 1} did not include a name.`);
    const argumentsText = draft.arguments.join("");
    let argumentsValue: unknown = {};
    if (argumentsText.trim().length > 0) {
      try {
        argumentsValue = JSON.parse(argumentsText) as unknown;
      } catch {
        throw new HarnessError("INVALID_MODEL_OUTPUT", `Tool call ${name} returned malformed arguments.`);
      }
    }
    if (!isJsonValue(argumentsValue)) throw new HarnessError("INVALID_MODEL_OUTPUT", `Tool call ${name} returned non-JSON arguments.`);
    return { id: draft.id || `call-${index + 1}`, name, arguments: argumentsValue };
  });
}

function assertAssistant(message: AssistantMessage): void {
  const candidate: unknown = message;
  if (typeof candidate !== "object" || candidate === null) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  const record = candidate as Record<string, unknown>;
  if (record.role !== "assistant" || typeof record.content !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  if (record.toolCalls !== undefined) {
    if (!Array.isArray(record.toolCalls)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid tool calls.");
    assertToolCalls(record.toolCalls as ToolCall[]);
  }
}

function assertMessages(messages: readonly ModelMessage[]): void {
  if (!Array.isArray(messages)) throw new HarnessError("INVALID_MESSAGES", "Model messages must be an array.");
  const pendingToolCalls = new Map<string, string>();
  for (const message of messages) {
    if (!isJsonValue(message) || typeof message !== "object" || Array.isArray(message)) throw new HarnessError("INVALID_MESSAGES", "Model messages must be JSON objects.");
    const record = message as Record<string, unknown>;
    if (record.role !== "system" && record.role !== "user" && record.role !== "assistant" && record.role !== "tool") throw new HarnessError("INVALID_MESSAGES", "Model messages have an invalid role.");
    if (typeof record.content !== "string") throw new HarnessError("INVALID_MESSAGES", "Every model message needs string content.");
    if (record.role === "assistant") {
      assertAssistant(message as unknown as AssistantMessage);
      if (pendingToolCalls.size > 0) throw new HarnessError("INVALID_MESSAGES", `Tool call “${pendingToolCalls.keys().next().value}” has no result before the next assistant message.`);
      for (const call of (message as unknown as AssistantMessage).toolCalls ?? []) pendingToolCalls.set(call.id, call.name);
    } else if (record.role === "tool") {
      if (typeof record.callId !== "string" || record.callId.length === 0 || typeof record.name !== "string" || record.name.length === 0) {
        throw new HarnessError("INVALID_MESSAGES", "Tool messages need a call ID and name.");
      }
      if (record.isError !== undefined && typeof record.isError !== "boolean") {
        throw new HarnessError("INVALID_MESSAGES", "Tool message error status must be boolean.");
      }
      if (record.durationMs !== undefined && (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0)) {
        throw new HarnessError("INVALID_MESSAGES", "Tool message timing must be a non-negative number.");
      }
      const expectedName = pendingToolCalls.get(record.callId);
      if (expectedName === undefined) throw new HarnessError("INVALID_MESSAGES", `Tool result “${record.callId}” has no preceding assistant call.`);
      if (expectedName !== record.name) throw new HarnessError("INVALID_MESSAGES", `Tool result “${record.callId}” names “${record.name}”, expected “${expectedName}”.`);
      pendingToolCalls.delete(record.callId);
    } else if (pendingToolCalls.size > 0) {
      throw new HarnessError("INVALID_MESSAGES", `Tool call “${pendingToolCalls.keys().next().value}” has no result before the next message.`);
    }
  }
  if (pendingToolCalls.size > 0) throw new HarnessError("INVALID_MESSAGES", `Tool call “${pendingToolCalls.keys().next().value}” has no result.`);
}

function assertUsage(usage: ModelUsage): void {
  const candidate: unknown = usage;
  if (typeof candidate !== "object" || candidate === null) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
  const record = candidate as Record<string, unknown>;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
  }
}

function validatePositive(value: number | undefined, name: string): void {
  if (value !== undefined && value !== Number.POSITIVE_INFINITY && (!Number.isFinite(value) || value < 1)) throw new Error(`${name} must be positive or Infinity.`);
}

function partialMessage(text: string, calls: readonly ToolCall[]): AssistantMessage | undefined {
  if (text.length === 0 && calls.length === 0) return undefined;
  return {
    role: "assistant",
    content: text,
    ...(calls.length === 0 ? {} : { toolCalls: calls.map((call) => clone(call)) }),
  };
}

function isPageExecutionResult(value: unknown): value is PageExecutionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isJsonValue(record.value)
    && Array.isArray(record.logs)
    && Array.from(record.logs).every((line) => typeof line === "string")
    && typeof record.durationMs === "number"
    && Number.isFinite(record.durationMs)
    && record.durationMs >= 0;
}

async function executePageTool(runtime: PageRuntime, call: ToolCall, signal: AbortSignal): Promise<ToolExecutionResult> {
  const started = now();
  const duration = (): number => Math.max(0, Math.round(now() - started));
  if (call.name !== PAGE_TOOL_NAME) return errorResult("TOOL_NOT_FOUND", `Tool “${call.name}” is not available.`, duration());
  const validation = validate(PAGE_TOOL_DESCRIPTOR.inputSchema, call.arguments);
  if (!validation.valid) return errorResult("INVALID_TOOL_INPUT", formatIssues(validation.issues), duration());
  const input = call.arguments as JsonObject;
  try {
    throwIfAborted(signal);
    const result = await runtime.execute(input.code as string, input.input ?? null, { signal });
    throwIfAborted(signal);
    if (!isPageExecutionResult(result)) return errorResult("INVALID_PAGE_RUNTIME_RESULT", "Page runtime returned an invalid result.", duration());
    return { ok: true, value: { value: result.value, logs: [...result.logs], durationMs: result.durationMs }, durationMs: duration() };
  } catch (error) {
    if (signal.aborted) throw error;
    const toolError = isAbortError(error)
      ? { code: "PAGE_TOOL_ERROR", message: error instanceof Error ? error.message || "Page tool execution failed." : "Page tool execution failed." }
      : errorInfo(error, "PAGE_TOOL_ERROR");
    return { ok: false, error: toolError, durationMs: duration() };
  }
}

async function executeWithTimeout(runtime: PageRuntime, call: ToolCall, parentSignal: AbortSignal, timeoutMs: number | undefined): Promise<ToolExecutionResult> {
  throwIfAborted(parentSignal);
  const started = now();
  const duration = (): number => Math.max(0, Math.round(now() - started));
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", relayAbort, { once: true });
  if (parentSignal.aborted) relayAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = executePageTool(runtime, call, controller.signal);
  try {
    if (timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY) return await execution;
    const timeout = new Promise<ToolExecutionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new HarnessError("TOOL_TIMEOUT", "Page tool execution timed out."));
        resolve(errorResult("TOOL_TIMEOUT", `Page tool execution exceeded ${timeoutMs} ms.`, duration()));
      }, timeoutMs);
    });
    return await Promise.race([execution, timeout]);
  } finally {
    parentSignal.removeEventListener("abort", relayAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class Agent {
  constructor(private readonly model: ModelAdapter, private readonly pageRuntime: PageRuntime) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const id = runId();
    const signal = request.signal ?? NEVER_ABORTED_SIGNAL;
    validatePositive(request.modelTimeoutMs, "modelTimeoutMs");
    validatePositive(request.toolTimeoutMs, "toolTimeoutMs");
    if (request.maxTurns !== undefined && request.maxTurns !== Number.POSITIVE_INFINITY && (!Number.isInteger(request.maxTurns) || request.maxTurns < 1)) throw new Error("maxTurns must be a positive integer or Infinity.");

    const messages: ModelMessage[] = [];
    let turns = 0;
    let usage: ModelUsage | undefined;
    this.emit(request.onEvent, { type: "run-started", runId: id });

    const finish = (result: Omit<AgentRunResult, "runId" | "messages" | "turns" | "usage">): AgentRunResult => {
      const complete: AgentRunResult = freeze({
        runId: id,
        status: result.status,
        messages: Object.freeze([...messages]),
        turns,
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.partial === undefined ? {} : { partial: result.partial }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(usage === undefined ? {} : { usage }),
      });
      this.emit(request.onEvent, { type: "run-finished", result: complete });
      return complete;
    };

    const fail = (error: ToolError, partial?: AssistantMessage): AgentRunResult => {
      const immutableError = freeze(error);
      this.emit(request.onEvent, { type: "run-error", error: immutableError });
      return finish({ status: "failed", error: immutableError, ...(partial === undefined ? {} : { partial }) });
    };

    try {
      assertMessages(request.messages);
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

      turns += 1;
      this.emit(request.onEvent, { type: "model-started", turn: turns });
      let completed: AssistantMessage | undefined;
      const streamedText: string[] = [];
      const streamedCalls: ToolCall[] = [];
      const streamedCallDeltas = new Map<number, StreamedToolCallDraft>();
      let sawCompleted = false;
      let iterator: AsyncIterator<ModelEvent> | undefined;
      let timedOut = false;
      let abortListener: (() => void) | undefined;
      const modelController = new AbortController();
      const relayModelAbort = () => modelController.abort(signal.reason);
      signal.addEventListener("abort", relayModelAbort, { once: true });
      if (signal.aborted) relayModelAbort();
      let modelTimer: ReturnType<typeof setTimeout> | undefined;

      const consume = (async () => {
        throwIfAborted(modelController.signal);
        const iterable = this.model.stream({ messages: Object.freeze([...messages]), tools: [PAGE_TOOL_DESCRIPTOR], signal: modelController.signal });
        const currentIterator = iterable[Symbol.asyncIterator]();
        iterator = currentIterator;
        let eventsSinceYield = 0;
        try {
          while (true) {
            const next = await currentIterator.next();
            if (next.done) break;
            throwIfAborted(modelController.signal);
            const event: unknown = next.value;
            if (typeof event !== "object" || event === null || typeof (event as { readonly type?: unknown }).type !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid event.");
            switch ((event as { readonly type: string }).type) {
              case "text-delta": {
                const delta = (event as Extract<ModelEvent, { readonly type: "text-delta" }>).delta;
                if (typeof delta !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid text delta.");
                if (delta.length > 0) {
                  streamedText.push(delta);
                  this.emit(request.onEvent, { type: "text-delta", delta });
                }
                break;
              }
              case "tool-call-delta": {
                const delta = (event as Extract<ModelEvent, { readonly type: "tool-call-delta" }>).delta;
                assertToolCallDelta(delta);
                if (delta.id === undefined && (delta.name === undefined || delta.name.length === 0) && (delta.arguments === undefined || delta.arguments.length === 0)) break;
                let draft = streamedCallDeltas.get(delta.index);
                if (draft === undefined) {
                  draft = { id: `call-${delta.index + 1}`, name: [], arguments: [] };
                  streamedCallDeltas.set(delta.index, draft);
                }
                if (delta.id !== undefined) draft.id = delta.id;
                if (delta.name !== undefined) draft.name.push(delta.name);
                if (delta.arguments !== undefined) draft.arguments.push(delta.arguments);
                this.emit(request.onEvent, { type: "tool-call-delta", delta });
                break;
              }
              case "tool-call": {
                const call = (event as Extract<ModelEvent, { readonly type: "tool-call" }>).call;
                assertToolCall(call);
                streamedCalls.push(call);
                this.emit(request.onEvent, { type: "tool-call-delta", delta: { index: streamedCalls.length - 1, id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) } });
                break;
              }
              case "usage": {
                const current = (event as Extract<ModelEvent, { readonly type: "usage" }>).usage;
                assertUsage(current);
                usage = addUsage(usage, current);
                break;
              }
              case "completed": {
                const message = (event as Extract<ModelEvent, { readonly type: "completed" }>).message;
                assertAssistant(message);
                completed = message;
                sawCompleted = true;
                const currentUsage = (event as Extract<ModelEvent, { readonly type: "completed" }>).usage;
                if (currentUsage !== undefined) {
                  assertUsage(currentUsage);
                  usage = addUsage(usage, currentUsage);
                }
                break;
              }
              default:
                throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an unknown event.");
            }
            if (sawCompleted) break;
            if (request.onEvent !== undefined && ++eventsSinceYield >= STREAM_EVENT_YIELD_BATCH) {
              eventsSinceYield = 0;
              await yieldToHost(modelController.signal);
            }
          }
        } finally {
          if (currentIterator.return !== undefined) await currentIterator.return();
        }
      })();
      void consume.catch(() => undefined);

      try {
        const abort = new Promise<never>((_, reject) => {
          const onAbort = () => {
            try {
              throwIfAborted(signal);
            } catch (error) {
              reject(error);
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          abortListener = onAbort;
        });
        const timeout = request.modelTimeoutMs === undefined || request.modelTimeoutMs === Number.POSITIVE_INFINITY
          ? undefined
          : new Promise<never>((_, reject) => {
              modelTimer = setTimeout(() => {
                timedOut = true;
                modelController.abort(new HarnessError("MODEL_TIMEOUT", "Model request timed out."));
                void iterator?.return?.();
                reject(new HarnessError("MODEL_TIMEOUT", `Model request exceeded ${request.modelTimeoutMs} ms.`));
              }, request.modelTimeoutMs);
            });
        const races: Array<Promise<unknown>> = [consume, abort];
        if (timeout !== undefined) races.push(timeout);
        await Promise.race(races);
      } catch (error) {
        const partial = partialMessage(streamedText.join(""), streamedCalls);
        if (timedOut) return fail(errorInfo(error, "MODEL_TIMEOUT"), partial);
        if (signal.aborted) return finish({ status: "cancelled", error: errorInfo(signal.reason ?? error, "ABORTED"), ...(partial === undefined ? {} : { partial }) });
        return fail(errorInfo(error, "MODEL_ERROR"), partial);
      } finally {
        signal.removeEventListener("abort", relayModelAbort);
        if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
        if (modelTimer !== undefined) clearTimeout(modelTimer);
        if (timedOut) modelController.abort(new HarnessError("MODEL_TIMEOUT", "Model request timed out."));
      }

      if (!sawCompleted || completed === undefined) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned no completed response." }, partialMessage(streamedText.join(""), streamedCalls));
      let calls: ToolCall[];
      try {
        calls = completed.toolCalls !== undefined && completed.toolCalls.length > 0
          ? [...completed.toolCalls]
          : streamedCalls.length > 0
            ? streamedCalls
            : completeStreamedToolCalls(streamedCallDeltas);
        assertToolCalls(calls);
        calls = calls.map((call) => freeze({ id: call.id, name: call.name, arguments: clone(call.arguments) }));
      } catch (error) {
        return fail(errorInfo(error, "MODEL_ERROR"), partialMessage(streamedText.join(""), streamedCalls));
      }
      const content = completed.content.length > 0 ? completed.content : streamedText.join("");
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        ...(calls.length === 0 ? {} : { toolCalls: calls }),
      };
      if (assistant.content.trim().length === 0 && calls.length === 0) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned an empty response." });
      const immutableAssistant = freeze(assistant);
      messages.push(immutableAssistant);
      this.emit(request.onEvent, { type: "assistant-message", message: immutableAssistant });

      const appendToolResult = (call: ToolCall, result: ToolExecutionResult): void => {
        const toolMessage: ToolMessage = result.ok
          ? { role: "tool", callId: call.id, name: call.name, content: jsonString(result.value as JsonObject), durationMs: result.durationMs }
          : { role: "tool", callId: call.id, name: call.name, content: jsonString(jsonError(result.error)), isError: true, durationMs: result.durationMs };
        this.emit(request.onEvent, { type: "tool-finished", call, result: freeze(result) });
        messages.push(Object.freeze(toolMessage));
      };
      if (calls.length === 0) return finish({ status: "completed", response: immutableAssistant });
      if (request.maxTurns !== undefined && turns >= request.maxTurns) {
        for (const call of calls) {
          this.emit(request.onEvent, { type: "tool-started", call });
          appendToolResult(call, errorResult("MAX_TURNS", "Host turn limit reached before this tool call could run."));
        }
        return finish({ status: "max-turns", response: immutableAssistant });
      }
      const cancelTools = (startIndex: number, error: unknown, firstStarted = false): AgentRunResult => {
        for (let index = startIndex; index < calls.length; index += 1) {
          const call = calls[index];
          if (call === undefined) break;
          if (!(firstStarted && index === startIndex)) this.emit(request.onEvent, { type: "tool-started", call });
          appendToolResult(call, abortedToolResult(error));
        }
        return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
      };
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        if (call === undefined) break;
        try {
          throwIfAborted(signal);
        } catch (error) {
          return cancelTools(index, error);
        }
        this.emit(request.onEvent, { type: "tool-started", call });
        let result: ToolExecutionResult;
        try {
          result = await executeWithTimeout(this.pageRuntime, call, signal, request.toolTimeoutMs);
        } catch (error) {
          if (signal.aborted) return cancelTools(index, signal.reason ?? error, true);
          result = errorResult("PAGE_TOOL_ERROR", error instanceof Error ? error.message : "Page tool execution failed.");
        }
        appendToolResult(call, result);
      }
    }
  }

  private emit(onEvent: AgentRunRequest["onEvent"], event: AgentEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // Observers are outside the runtime contract and cannot break a run.
    }
  }
}
