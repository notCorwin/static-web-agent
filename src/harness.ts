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

export class Harness {
  private model: ModelAdapter | undefined;
  private readonly pageRuntime: PageRuntime;
  private readonly listeners = new Set<HarnessListener>();
  private readonly activeRuns = new Set<AbortController>();
  private disposed = false;

  private constructor(options: HarnessOptions) {
    if (options.model !== undefined) {
      assertModel(options.model);
      this.model = options.model;
    }
    this.pageRuntime = options.pageRuntime ?? new BrowserPageRuntime();
  }

  private ensureActive(): void {
    if (this.disposed) throw new HarnessError("HARNESS_DISPOSED", "The Harness has been disposed.");
  }

  private changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
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
    const relayAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    if (request.signal?.aborted) relayAbort();
    this.activeRuns.add(controller);
    try {
      return await new Agent(model, this.pageRuntime).run({ ...request, signal: controller.signal });
    } finally {
      request.signal?.removeEventListener("abort", relayAbort);
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
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
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
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    return new Harness(options);
  }
}

export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  return Harness.create(options);
}
