import { Agent, PAGE_TOOL_DESCRIPTOR } from "./core/agent.js";
import { HarnessError } from "./core/errors.js";
import { BrowserPageRuntime } from "./core/page-runtime.js";
import type { AgentRunRequest, AgentRunResult, ModelAdapter, PageRuntime, ToolDescriptor } from "./core/types.js";

export interface HarnessOptions {
  /** The one model used by this Harness. It may be attached later by a host. */
  readonly model?: ModelAdapter;
  /** Hosts may provide a different current-page executor; the default uses this page. */
  readonly pageRuntime?: PageRuntime;
}

export type HarnessStatus = "active" | "disposed";

export interface HarnessSnapshot {
  readonly status: HarnessStatus;
  readonly modelId?: string;
  readonly tools: readonly ToolDescriptor[];
}

export type HarnessListener = (snapshot: HarnessSnapshot) => void;

function assertModel(model: ModelAdapter): void {
  if (typeof model !== "object" || model === null || typeof model.id !== "string" || model.id.trim().length === 0 || typeof model.stream !== "function") {
    throw new HarnessError("INVALID_MODEL_ADAPTER", "A model adapter needs an ID and stream function.");
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  try {
    return signal?.reason;
  } catch {
    return undefined;
  }
}

function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (signal === undefined) return;
  try {
    signal.removeEventListener("abort", listener);
  } catch {
    // Cleanup cannot change the operation result.
  }
}

export class Harness {
  private model: ModelAdapter | undefined;
  private readonly pageRuntime: PageRuntime;
  private readonly listeners = new Set<HarnessListener>();
  private readonly activeRuns = new Set<AbortController>();
  private disposed = false;

  private constructor(options: HarnessOptions) {
    const model = Object.hasOwn(options, "model") ? options.model : undefined;
    if (model !== undefined) {
      assertModel(model);
      this.model = model;
    }
    this.pageRuntime = (Object.hasOwn(options, "pageRuntime") ? options.pageRuntime : undefined) ?? new BrowserPageRuntime();
  }

  private ensureActive(): void {
    if (this.disposed) throw new HarnessError("HARNESS_DISPOSED", "The Harness has been disposed.");
  }

  private changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        const observed = listener(snapshot) as unknown;
        if (observed !== undefined) void Promise.resolve(observed).catch(() => undefined);
      } catch {
        // A view observer cannot change runtime lifecycle.
      }
    }
  }

  setModel(model: ModelAdapter): void {
    this.ensureActive();
    assertModel(model);
    for (const controller of this.activeRuns) controller.abort(new HarnessError("MODEL_REPLACED", "The model connection was replaced."));
    this.model = model;
    this.changed();
  }

  clearModel(): void {
    this.ensureActive();
    for (const controller of this.activeRuns) controller.abort(new HarnessError("MODEL_CLEARED", "The model connection was cleared."));
    this.model = undefined;
    this.changed();
  }

  get modelId(): string | undefined {
    return this.model?.id;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.ensureActive();
    const model = this.model;
    if (model === undefined) throw new HarnessError("MODEL_NOT_CONNECTED", "Connect a model adapter before starting a run.");

    const controller = new AbortController();
    const requestSignal = Object.hasOwn(request, "signal") ? request.signal : undefined;
    const relayAbort = () => controller.abort(abortReason(requestSignal));
    requestSignal?.addEventListener("abort", relayAbort, { once: true });
    if (requestSignal?.aborted) relayAbort();
    this.activeRuns.add(controller);
    try {
      const forwardedRequest = {
        ...(Object.hasOwn(request, "messages") ? { messages: request.messages } : {}),
        ...(Object.hasOwn(request, "maxTurns") ? { maxTurns: request.maxTurns } : {}),
        ...(Object.hasOwn(request, "modelTimeoutMs") ? { modelTimeoutMs: request.modelTimeoutMs } : {}),
        ...(Object.hasOwn(request, "toolTimeoutMs") ? { toolTimeoutMs: request.toolTimeoutMs } : {}),
        ...(Object.hasOwn(request, "onEvent") ? { onEvent: request.onEvent } : {}),
        signal: controller.signal,
      };
      return await new Agent(model, this.pageRuntime).run(forwardedRequest as AgentRunRequest);
    } finally {
      removeAbortListener(requestSignal, relayAbort);
      this.activeRuns.delete(controller);
    }
  }

  snapshot(): HarnessSnapshot {
    return Object.freeze({
      status: this.disposed ? "disposed" : "active",
      ...(this.model === undefined ? {} : { modelId: this.model.id }),
      tools: Object.freeze([PAGE_TOOL_DESCRIPTOR]),
    });
  }

  subscribe(listener: HarnessListener): () => void {
    if (!this.disposed) this.listeners.add(listener);
    try {
      const observed = listener(this.snapshot()) as unknown;
      if (observed !== undefined) void Promise.resolve(observed).catch(() => undefined);
    } catch {
      // Initial observer errors are isolated just like later observer errors.
    }
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeRuns) controller.abort(new HarnessError("HARNESS_DISPOSED", "The Harness has been disposed."));
    this.activeRuns.clear();
    this.model = undefined;
    this.changed();
    this.listeners.clear();
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    return new Harness(options);
  }
}

export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  return Harness.create(options);
}
