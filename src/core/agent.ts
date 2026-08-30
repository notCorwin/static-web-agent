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

function copyArrayByIndex<T>(items: readonly T[]): T[] {
  return Array.from({ length: items.length }, (_, index) => items[index] as T);
}

function abortReason(signal: AbortSignal): unknown {
  try {
    return signal.reason;
  } catch {
    return undefined;
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    signal.removeEventListener("abort", listener);
  } catch {
    // Cleanup cannot change the operation result.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = abortReason(signal);
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
  if (current === undefined) return next === undefined ? undefined : { ...next };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEnumerableOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.getOwnPropertyDescriptor(record, key)?.enumerable === true;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const deadline = now() + delayMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function errorResult(code: string, message: string, durationMs = 0): Extract<ToolExecutionResult, { readonly ok: false }> {
  return { ok: false, error: { code, message }, durationMs };
}

function safeErrorMessage(value: unknown, fallback: string): string {
  try {
    const message = value instanceof Error ? value.message : undefined;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

function abortedToolResult(error: unknown, durationMs = 0): Extract<ToolExecutionResult, { readonly ok: false }> {
  return { ok: false, error: errorInfo(error, "ABORTED"), durationMs };
}

function assertToolCall(call: ToolCall): void {
  const candidate: unknown = call;
  if (!isRecord(candidate) || !isJsonValue(candidate)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
  const record = candidate;
  if (
    !hasEnumerableOwn(record, "id") || typeof record.id !== "string" || record.id.length === 0 ||
    !hasEnumerableOwn(record, "name") || typeof record.name !== "string" || record.name.length === 0 ||
    !hasEnumerableOwn(record, "arguments") || !isJsonValue(record.arguments)
  ) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
}

function snapshotToolCall(call: ToolCall): ToolCall {
  return { id: call.id, name: call.name, arguments: clone(call.arguments) };
}

function snapshotAssistant(message: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls === undefined ? {} : { toolCalls: copyArrayByIndex(message.toolCalls).map(snapshotToolCall) }),
  };
}

function assertToolCalls(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index] as ToolCall;
    assertToolCall(call);
    if (ids.has(call.id)) throw new HarnessError("INVALID_MODEL_OUTPUT", `Model returned duplicate tool call ID “${call.id}”.`);
    ids.add(call.id);
  }
}

function assertToolCallDelta(delta: ToolCallDelta): void {
  const candidate: unknown = delta;
  if (!isRecord(candidate) || !isJsonValue(candidate)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
  const record = candidate;
  if (!hasEnumerableOwn(record, "index") || !Number.isSafeInteger(record.index) || Number(record.index) < 0) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call index.");
  if (
    (("id" in record) && !hasEnumerableOwn(record, "id")) ||
    (record.id !== undefined && (typeof record.id !== "string" || record.id.length === 0)) ||
    (("name" in record) && !hasEnumerableOwn(record, "name")) ||
    (record.name !== undefined && typeof record.name !== "string") ||
    (("arguments" in record) && !hasEnumerableOwn(record, "arguments")) ||
    (record.arguments !== undefined && typeof record.arguments !== "string")
  ) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
}

interface StreamedToolCallDraft {
  id?: string;
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
    return { id: draft.id ?? `call-${index + 1}`, name, arguments: argumentsValue };
  });
}

function assertAssistant(message: AssistantMessage): void {
  const candidate: unknown = message;
  if (!isRecord(candidate) || !isJsonValue(candidate)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  const record = candidate as Record<string, unknown>;
  if (!hasEnumerableOwn(record, "role") || record.role !== "assistant" || !hasEnumerableOwn(record, "content") || typeof record.content !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
  if (record.toolCalls !== undefined) {
    if (!hasEnumerableOwn(record, "toolCalls") || !Array.isArray(record.toolCalls)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid tool calls.");
    assertToolCalls(record.toolCalls as ToolCall[]);
  }
}

function assertMessages(messages: readonly ModelMessage[]): void {
  if (!Array.isArray(messages)) throw new HarnessError("INVALID_MESSAGES", "Model messages must be an array.");
  const pendingToolCalls = new Map<string, string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isJsonValue(message) || typeof message !== "object" || Array.isArray(message)) throw new HarnessError("INVALID_MESSAGES", "Model messages must be JSON objects.");
    const record = message as Record<string, unknown>;
    if (!hasEnumerableOwn(record, "role") || (record.role !== "system" && record.role !== "user" && record.role !== "assistant" && record.role !== "tool")) throw new HarnessError("INVALID_MESSAGES", "Model messages have an invalid role.");
    if (!hasEnumerableOwn(record, "content") || typeof record.content !== "string") throw new HarnessError("INVALID_MESSAGES", "Every model message needs string content.");
    if (record.role === "assistant") {
      assertAssistant(message as unknown as AssistantMessage);
      if (pendingToolCalls.size > 0) throw new HarnessError("INVALID_MESSAGES", `Tool call “${pendingToolCalls.keys().next().value}” has no result before the next assistant message.`);
      const toolCalls = (message as unknown as AssistantMessage).toolCalls ?? [];
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = toolCalls[callIndex] as ToolCall;
        pendingToolCalls.set(call.id, call.name);
      }
    } else if (record.role === "tool") {
      if (!hasEnumerableOwn(record, "callId") || typeof record.callId !== "string" || record.callId.length === 0 || !hasEnumerableOwn(record, "name") || typeof record.name !== "string" || record.name.length === 0) {
        throw new HarnessError("INVALID_MESSAGES", "Tool messages need a call ID and name.");
      }
      if (record.isError !== undefined && (!hasEnumerableOwn(record, "isError") || typeof record.isError !== "boolean")) {
        throw new HarnessError("INVALID_MESSAGES", "Tool message error status must be boolean.");
      }
      if (record.durationMs !== undefined && (!hasEnumerableOwn(record, "durationMs") || typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0)) {
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
  if (!isRecord(candidate) || !isJsonValue(candidate)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
  const record = candidate;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (key in record && !hasEnumerableOwn(record, key)) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
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
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isJsonValue(value)) return false;
  const record = value as Record<string, unknown>;
  return hasEnumerableOwn(record, "value")
    && isJsonValue(record.value)
    && hasEnumerableOwn(record, "logs")
    && Array.isArray(record.logs)
    && Array.prototype.every.call(record.logs, (line: unknown) => typeof line === "string")
    && hasEnumerableOwn(record, "durationMs")
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
    const pageInput = hasEnumerableOwn(input, "input") ? input.input : undefined;
    const result = await runtime.execute(input.code as string, pageInput === undefined ? null : clone(pageInput), { signal });
    throwIfAborted(signal);
    if (!isPageExecutionResult(result)) return errorResult("INVALID_PAGE_RUNTIME_RESULT", "Page runtime returned an invalid result.", duration());
    return { ok: true, value: { value: clone(result.value), logs: copyArrayByIndex(result.logs), durationMs: result.durationMs }, durationMs: duration() };
  } catch (error) {
    if (signal.aborted) throw error;
    const toolError = isAbortError(error)
      ? { code: "PAGE_TOOL_ERROR", message: safeErrorMessage(error, "Page tool execution failed.") }
      : errorInfo(error, "PAGE_TOOL_ERROR");
    return { ok: false, error: toolError, durationMs: duration() };
  }
}

async function executeWithTimeout(runtime: PageRuntime, call: ToolCall, parentSignal: AbortSignal, timeoutMs: number | undefined): Promise<ToolExecutionResult> {
  throwIfAborted(parentSignal);
  const started = now();
  const duration = (): number => Math.max(0, Math.round(now() - started));
  const controller = new AbortController();
  const relayAbort = () => controller.abort(abortReason(parentSignal));
  parentSignal.addEventListener("abort", relayAbort, { once: true });
  if (parentSignal.aborted) relayAbort();
  let cancelTimer: (() => void) | undefined;
  const execution = executePageTool(runtime, call, controller.signal);
  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      try {
        throwIfAborted(parentSignal);
      } catch (error) {
        reject(error);
      }
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
    if (parentSignal.aborted) onAbort();
    abortListener = onAbort;
  });
  try {
    const races: Array<Promise<ToolExecutionResult>> = [execution, abort];
    if (timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY) return await Promise.race(races);
    const timeout = new Promise<ToolExecutionResult>((resolve) => {
      cancelTimer = scheduleTimeout(() => {
        controller.abort(new HarnessError("TOOL_TIMEOUT", "Page tool execution timed out."));
        resolve(errorResult("TOOL_TIMEOUT", `Page tool execution exceeded ${timeoutMs} ms.`, duration()));
      }, timeoutMs);
    });
    races.push(timeout);
    return await Promise.race(races);
  } finally {
    removeAbortListener(parentSignal, relayAbort);
    if (abortListener !== undefined) removeAbortListener(parentSignal, abortListener);
    cancelTimer?.();
  }
}

export class Agent {
  constructor(private readonly model: ModelAdapter, private readonly pageRuntime: PageRuntime) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const id = runId();
    const signal = (Object.hasOwn(request, "signal") ? request.signal : undefined) ?? NEVER_ABORTED_SIGNAL;
    const modelTimeoutMs = Object.hasOwn(request, "modelTimeoutMs") ? request.modelTimeoutMs : undefined;
    const toolTimeoutMs = Object.hasOwn(request, "toolTimeoutMs") ? request.toolTimeoutMs : undefined;
    const maxTurns = Object.hasOwn(request, "maxTurns") ? request.maxTurns : undefined;
    const onEvent = Object.hasOwn(request, "onEvent") ? request.onEvent : undefined;
    const inputMessages = Object.hasOwn(request, "messages") ? request.messages : undefined;
    validatePositive(modelTimeoutMs, "modelTimeoutMs");
    validatePositive(toolTimeoutMs, "toolTimeoutMs");
    if (maxTurns !== undefined && maxTurns !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error("maxTurns must be a positive integer or Infinity.");

    const messages: ModelMessage[] = [];
    let turns = 0;
    let usage: ModelUsage | undefined;
    this.emit(onEvent, { type: "run-started", runId: id });

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
      this.emit(onEvent, { type: "run-finished", result: complete });
      return complete;
    };

    const fail = (error: ToolError, partial?: AssistantMessage): AgentRunResult => {
      const immutableError = freeze(error);
      this.emit(onEvent, { type: "run-error", error: immutableError });
      return finish({ status: "failed", error: immutableError, ...(partial === undefined ? {} : { partial }) });
    };

    try {
      if (inputMessages === undefined) throw new HarnessError("INVALID_MESSAGES", "Model messages must be an array.");
      assertMessages(inputMessages);
      messages.push(...cloneMessages(inputMessages));
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
      this.emit(onEvent, { type: "model-started", turn: turns });
      let completed: AssistantMessage | undefined;
      const streamedText: string[] = [];
      const streamedCalls: ToolCall[] = [];
      const streamedCallDeltas = new Map<number, StreamedToolCallDraft>();
      let sawCompleted = false;
      let iterator: AsyncIterator<ModelEvent> | undefined;
      let timedOut = false;
      let abortListener: (() => void) | undefined;
      const modelController = new AbortController();
      const relayModelAbort = () => modelController.abort(abortReason(signal));
      signal.addEventListener("abort", relayModelAbort, { once: true });
      if (signal.aborted) relayModelAbort();
      let cancelModelTimer: (() => void) | undefined;

      const consume = (async () => {
        throwIfAborted(modelController.signal);
        const iterable = this.model.stream({ messages: Object.freeze([...messages]), tools: Object.freeze([PAGE_TOOL_DESCRIPTOR]), signal: modelController.signal });
        const currentIterator = iterable[Symbol.asyncIterator]();
        iterator = currentIterator;
        let eventsSinceYield = 0;
        try {
          while (true) {
            const next = await currentIterator.next();
            if (next.done) break;
            throwIfAborted(modelController.signal);
            const event: unknown = next.value;
            if (!isRecord(event) || !isJsonValue(event) || !hasEnumerableOwn(event, "type") || typeof event.type !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid event.");
            switch (event.type) {
              case "text-delta": {
                if (!hasEnumerableOwn(event, "delta") || typeof event.delta !== "string") throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid text delta.");
                const delta = event.delta;
                if (delta.length > 0) {
                  streamedText.push(delta);
                  this.emit(onEvent, { type: "text-delta", delta });
                }
                break;
              }
              case "tool-call-delta": {
                if (!hasEnumerableOwn(event, "delta")) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool-call delta.");
                const delta = event.delta as unknown as ToolCallDelta;
                assertToolCallDelta(delta);
                if (delta.id === undefined && (delta.name === undefined || delta.name.length === 0) && (delta.arguments === undefined || delta.arguments.length === 0)) break;
                let draft = streamedCallDeltas.get(delta.index);
                if (draft === undefined) {
                  draft = { name: [], arguments: [] };
                  streamedCallDeltas.set(delta.index, draft);
                }
                if (delta.id !== undefined) {
                  if (draft.id !== undefined && draft.id !== delta.id) throw new HarnessError("INVALID_MODEL_OUTPUT", `Tool call ${delta.index + 1} changed its ID while streaming.`);
                  draft.id = delta.id;
                }
                if (delta.name !== undefined) draft.name.push(delta.name);
                if (delta.arguments !== undefined) draft.arguments.push(delta.arguments);
                this.emit(onEvent, { type: "tool-call-delta", delta });
                break;
              }
              case "tool-call": {
                if (!hasEnumerableOwn(event, "call")) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid tool call.");
                const call = event.call as unknown as ToolCall;
                assertToolCall(call);
                streamedCalls.push(snapshotToolCall(call));
                this.emit(onEvent, { type: "tool-call-delta", delta: { index: streamedCalls.length - 1, id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) } });
                break;
              }
              case "usage": {
                if (!hasEnumerableOwn(event, "usage")) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
                const current = event.usage as ModelUsage;
                assertUsage(current);
                usage = addUsage(usage, current);
                break;
              }
              case "completed": {
                if (!hasEnumerableOwn(event, "message")) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned an invalid assistant message.");
                if ("usage" in event && !hasEnumerableOwn(event, "usage")) throw new HarnessError("INVALID_MODEL_OUTPUT", "Model returned invalid usage data.");
                const message = event.message as unknown as AssistantMessage;
                assertAssistant(message);
                completed = snapshotAssistant(message);
                if (streamedText.length === 0 && message.content.length > 0) {
                  streamedText.push(message.content);
                  this.emit(onEvent, { type: "text-delta", delta: message.content });
                }
                sawCompleted = true;
                const currentUsage = event.usage as ModelUsage | undefined;
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
            if (++eventsSinceYield >= STREAM_EVENT_YIELD_BATCH) {
              eventsSinceYield = 0;
              await yieldToHost(modelController.signal);
            }
          }
        } finally {
          try {
            void Promise.resolve(currentIterator.return?.()).catch(() => undefined);
          } catch {
            // Iterator cleanup cannot change the model result.
          }
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
        const timeout = modelTimeoutMs === undefined || modelTimeoutMs === Number.POSITIVE_INFINITY
          ? undefined
          : new Promise<never>((_, reject) => {
              cancelModelTimer = scheduleTimeout(() => {
                timedOut = true;
                modelController.abort(new HarnessError("MODEL_TIMEOUT", "Model request timed out."));
                void Promise.resolve().then(() => iterator?.return?.()).catch(() => undefined);
                reject(new HarnessError("MODEL_TIMEOUT", `Model request exceeded ${modelTimeoutMs} ms.`));
              }, modelTimeoutMs);
            });
        const races: Array<Promise<unknown>> = [consume, abort];
        if (timeout !== undefined) races.push(timeout);
        await Promise.race(races);
      } catch (error) {
        const partial = partialMessage(streamedText.join(""), streamedCalls);
        if (timedOut) return fail(errorInfo(error, "MODEL_TIMEOUT"), partial);
        if (signal.aborted) return finish({ status: "cancelled", error: errorInfo(abortReason(signal) ?? error, "ABORTED"), ...(partial === undefined ? {} : { partial }) });
        return fail(errorInfo(error, "MODEL_ERROR"), partial);
      } finally {
        removeAbortListener(signal, relayModelAbort);
        if (abortListener !== undefined) removeAbortListener(signal, abortListener);
        cancelModelTimer?.();
        if (timedOut) modelController.abort(new HarnessError("MODEL_TIMEOUT", "Model request timed out."));
      }

      try {
        throwIfAborted(signal);
      } catch (error) {
        const partial = partialMessage(streamedText.join(""), streamedCalls);
        return finish({ status: "cancelled", error: errorInfo(error, "ABORTED"), ...(partial === undefined ? {} : { partial }) });
      }

      if (!sawCompleted || completed === undefined) return fail({ code: "EMPTY_MODEL_RESPONSE", message: "Model returned no completed response." }, partialMessage(streamedText.join(""), streamedCalls));
      let calls: ToolCall[];
      try {
        calls = completed.toolCalls !== undefined && completed.toolCalls.length > 0
          ? copyArrayByIndex(completed.toolCalls)
          : streamedCalls.length > 0
            ? streamedCalls
            : completeStreamedToolCalls(streamedCallDeltas);
        assertToolCalls(calls);
        calls = calls.map((call) => freeze(snapshotToolCall(call)));
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
      this.emit(onEvent, { type: "assistant-message", message: immutableAssistant });

      const appendToolResult = (call: ToolCall, result: ToolExecutionResult): void => {
        const toolMessage: ToolMessage = result.ok
          ? { role: "tool", callId: call.id, name: call.name, content: jsonString(result.value as JsonObject), durationMs: result.durationMs }
          : { role: "tool", callId: call.id, name: call.name, content: jsonString(jsonError(result.error)), isError: true, durationMs: result.durationMs };
        this.emit(onEvent, { type: "tool-finished", call, result: freeze(result) });
        messages.push(Object.freeze(toolMessage));
      };
      const cancelTools = (startIndex: number, error: unknown, firstStarted = false, firstDurationMs = 0): AgentRunResult => {
        for (let index = startIndex; index < calls.length; index += 1) {
          const call = calls[index];
          if (call === undefined) break;
          if (!(firstStarted && index === startIndex)) this.emit(onEvent, { type: "tool-started", call });
          appendToolResult(call, abortedToolResult(error, firstStarted && index === startIndex ? firstDurationMs : 0));
        }
        return finish({ status: "cancelled", error: errorInfo(error, "ABORTED") });
      };
      try {
        throwIfAborted(signal);
      } catch (error) {
        return cancelTools(0, error);
      }
      if (calls.length === 0) return finish({ status: "completed", response: immutableAssistant });
      if (maxTurns !== undefined && turns >= maxTurns) {
        for (const call of calls) {
          this.emit(onEvent, { type: "tool-started", call });
          appendToolResult(call, errorResult("MAX_TURNS", "Host turn limit reached before this tool call could run."));
        }
        return finish({ status: "max-turns", response: immutableAssistant });
      }
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        if (call === undefined) break;
        try {
          throwIfAborted(signal);
        } catch (error) {
          return cancelTools(index, error);
        }
        this.emit(onEvent, { type: "tool-started", call });
        const toolStarted = now();
        let result: ToolExecutionResult;
        try {
          result = await executeWithTimeout(this.pageRuntime, call, signal, toolTimeoutMs);
        } catch (error) {
          if (signal.aborted) return cancelTools(index, abortReason(signal) ?? error, true, Math.max(0, Math.round(now() - toolStarted)));
          result = errorResult("PAGE_TOOL_ERROR", safeErrorMessage(error, "Page tool execution failed."));
        }
        appendToolResult(call, result);
      }
    }
  }

  private emit(onEvent: AgentRunRequest["onEvent"], event: AgentEvent): void {
    try {
      const observed = onEvent?.(event) as unknown;
      if (observed !== undefined) void Promise.resolve(observed).catch(() => undefined);
    } catch {
      // Observers are outside the runtime contract and cannot break a run.
    }
  }
}
