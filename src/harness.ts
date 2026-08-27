import { Agent } from "./core/agent.js";
import { AgentKernel } from "./core/kernel.js";
import { KernelError } from "./core/errors.js";
import { BrowserPageRuntime } from "./core/page-runtime.js";
import { BrowserWorkerRuntime } from "./core/runtime.js";
import { createBrowserStateStore, PrefixedStateStore } from "./core/state.js";
import { createBrowserApiPlugin } from "./plugins/browser-api.js";
import { createJavaScriptRuntimePlugin } from "./plugins/javascript-runtime.js";
import { createStoragePlugin } from "./plugins/storage.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  JavaScriptRuntime,
  JsonValue,
  ModelAdapter,
  PageRuntime,
  PermissionPolicy,
  Plugin,
  PluginManifest,
  StateStore,
  ToolDefinition,
  ToolDescriptor,
} from "./core/types.js";

export type BrowserFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The minimal public contract: a model adapter, tools, an optional permission
 * gate, and the run loop. Advanced embedding (processor pipelines, extension
 * UI mounting, direct capability wiring) goes through `Harness#kernel`.
 */
export interface HarnessOptions {
  /** Host-owned models. Registered under the "host" owner and never policy-gated. */
  readonly model?: ModelAdapter | readonly ModelAdapter[];
  /** Host-owned tools. Their declared capabilities are granted to the host automatically. */
  readonly tools?: readonly ToolDefinition[];
  readonly plugins?: readonly Plugin[];
  readonly defaultPlugins?: boolean;
  readonly initialModelId?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly stateStore?: StateStore;
  readonly fetcher?: BrowserFetcher;
  readonly workerRuntime?: JavaScriptRuntime;
  readonly pageRuntime?: PageRuntime;
}

export type HarnessStatus = "active" | "disposed";

export interface HarnessModelDescriptor {
  readonly id: string;
  readonly supportsVision?: boolean;
}

export interface HarnessSnapshot {
  readonly status: HarnessStatus;
  readonly selectedModelId?: string | undefined;
  readonly manifests: readonly PluginManifest[];
  readonly models: readonly HarnessModelDescriptor[];
  readonly tools: readonly ToolDescriptor[];
}

export type HarnessListener = (snapshot: HarnessSnapshot) => void;

export interface HarnessPluginHandle {
  readonly manifest: PluginManifest;
  readonly uninstall: () => Promise<void>;
}

const HOST_PLUGIN_ID = "host";

interface ActiveRun {
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

function abortError(): Error {
  const error = new Error("Harness was disposed.");
  error.name = "AbortError";
  return error;
}

function browserFetcher(): BrowserFetcher | undefined {
  if (typeof globalThis.fetch !== "function") return undefined;
  return globalThis.fetch.bind(globalThis) as BrowserFetcher;
}

function unavailableFetcher(): BrowserFetcher {
  return async () => {
    throw new KernelError("NETWORK_UNAVAILABLE", "This browser context does not provide fetch; inject a fetcher when creating the harness.");
  };
}

export class Harness {
  /**
   * The underlying registry. Escaped on purpose for advanced hosts that need
   * processor pipelines or extension UI slots; casual embedders can ignore it.
   */
  readonly kernel: AgentKernel;

  private readonly handles = new Map<string, HarnessPluginHandle>();
  private readonly listeners = new Set<HarnessListener>();
  private readonly activeRuns = new Set<ActiveRun>();
  private readonly cleanup: (() => void)[] = [];
  private readonly modelCleanups: (() => void)[] = [];
  private selectedModelId: string | undefined;
  private disposed = false;

  private constructor(kernel: AgentKernel) {
    this.kernel = kernel;
    kernel.subscribe(() => this.changed());
  }

  private static construct(options: HarnessOptions): Harness {
    const kernel = new AgentKernel(options.permissionPolicy);
    const harness = new Harness(kernel);
    const stateStore = options.stateStore ?? createBrowserStateStore();
    const runtime = options.workerRuntime ?? new BrowserWorkerRuntime();
    const pageRuntime = options.pageRuntime ?? new BrowserPageRuntime();
    const fetcher = options.fetcher ?? browserFetcher() ?? unavailableFetcher();

    harness.cleanup.push(kernel.provide("runtime", { provide: () => runtime }));
    harness.cleanup.push(kernel.provide("page", { provide: () => pageRuntime }));
    harness.cleanup.push(kernel.provide("storage", {
      provide: ({ pluginId }) => {
        const scoped = new PrefixedStateStore(stateStore, `plugin:${pluginId}`);
        return {
          get: (key: string) => scoped.get(key),
          set: (key: string, value: JsonValue) => scoped.set(key, value),
          remove: (key: string) => scoped.remove(key),
          keys: () => scoped.keys(),
        };
      },
    }));
    harness.cleanup.push(kernel.provide("network", { provide: (): NetworkCapability => ({ fetch: fetcher }) }));

    // ponytail: host tools/models bypass permission prompting entirely — first-party code;
    // move them behind plugins with manifests if third parties ever ship them.
    for (const tool of options.tools ?? []) {
      harness.kernel.register(tool, HOST_PLUGIN_ID);
      for (const capability of tool.requiredCapabilities ?? []) harness.kernel.grant(HOST_PLUGIN_ID, capability);
    }
    for (const adapter of options.model === undefined ? [] : Array.isArray(options.model) ? [...options.model] : [options.model]) {
      harness.modelCleanups.push(harness.kernel.addModel(adapter));
    }
    return harness;
  }

  private ensureActive(): void {
    if (this.disposed) throw new KernelError("HARNESS_DISPOSED", "The Harness has been disposed.");
  }

  private changed(): void {
    if (this.selectedModelId !== undefined && this.kernel.modelAdapter(this.selectedModelId) === undefined) {
      this.selectedModelId = undefined;
    }
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not break lifecycle operations.
      }
    }
  }

  async install(plugin: Plugin, signal?: AbortSignal): Promise<HarnessPluginHandle> {
    this.ensureActive();
    const handle = await this.kernel.install(plugin, signal);
    const wrapped: HarnessPluginHandle = {
      manifest: handle.manifest,
      uninstall: async () => {
        await this.uninstall(handle.manifest.id);
      },
    };
    this.handles.set(handle.manifest.id, wrapped);
    return wrapped;
  }

  async uninstall(pluginId: string): Promise<boolean> {
    this.ensureActive();
    try {
      return await this.kernel.uninstall(pluginId);
    } finally {
      if (!this.kernel.isInstalled(pluginId)) this.handles.delete(pluginId);
    }
  }

  selectModel(id: string): void {
    this.ensureActive();
    if (this.kernel.modelAdapter(id) === undefined) {
      throw new KernelError("MODEL_NOT_FOUND", `Model adapter “${id}” is not registered.`);
    }
    if (this.selectedModelId === id) return;
    this.selectedModelId = id;
    this.changed();
  }

  clearModel(): void {
    this.ensureActive();
    if (this.selectedModelId === undefined) return;
    this.selectedModelId = undefined;
    this.changed();
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.ensureActive();
    if (this.selectedModelId === undefined) {
      throw new KernelError("MODEL_NOT_SELECTED", "Select a model adapter before starting a run.");
    }
    const model = this.kernel.modelAdapter(this.selectedModelId);
    if (model === undefined) {
      this.selectedModelId = undefined;
      throw new KernelError("MODEL_NOT_FOUND", "The selected model adapter is no longer registered.");
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    if (request.signal?.aborted) relayAbort();
    const active: ActiveRun = { controller, cleanup: () => request.signal?.removeEventListener("abort", relayAbort) };
    this.activeRuns.add(active);

    try {
      return await new Agent(model, this.kernel).run({ ...request, signal: controller.signal });
    } finally {
      active.cleanup();
      this.activeRuns.delete(active);
    }
  }

  snapshot(): HarnessSnapshot {
    const models = this.kernel.modelAdapters().map((adapter): HarnessModelDescriptor => ({
      id: adapter.id,
      ...(adapter.supportsVision === undefined ? {} : { supportsVision: adapter.supportsVision }),
    }));
    return Object.freeze({
      status: this.disposed ? "disposed" : "active",
      ...(this.selectedModelId === undefined ? {} : { selectedModelId: this.selectedModelId }),
      manifests: Object.freeze([...this.kernel.manifests()].sort((left, right) => left.id.localeCompare(right.id))),
      models: Object.freeze(models),
      tools: Object.freeze(this.kernel.descriptors()),
    });
  }

  subscribe(listener: HarnessListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // A subscriber cannot prevent later subscriptions or lifecycle changes.
    }
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.activeRuns) active.controller.abort(abortError());
    for (const handle of [...this.handles.values()].reverse()) {
      try {
        await this.kernel.uninstall(handle.manifest.id);
      } catch {
        // One broken teardown must not prevent the remaining plugins from closing.
      }
    }
    this.handles.clear();
    for (const unregister of this.modelCleanups.reverse()) {
      try { unregister(); } catch { /* Best-effort host model cleanup. */ }
    }
    this.modelCleanups.length = 0;
    for (const cleanup of this.cleanup.reverse()) {
      try { cleanup(); } catch { /* Capability cleanup is best effort. */ }
    }
    this.cleanup.length = 0;
    this.changed();
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    const harness = Harness.construct(options);
    try {
      if (options.defaultPlugins !== false) {
        await harness.install(createJavaScriptRuntimePlugin());
        await harness.install(createStoragePlugin());
        await harness.install(createBrowserApiPlugin());
      }
      for (const plugin of options.plugins ?? []) await harness.install(plugin);
      if (options.initialModelId !== undefined) harness.selectModel(options.initialModelId);
      else {
        const only = singleModelId(harness);
        if (only !== undefined) harness.selectModel(only);
      }
      return harness;
    } catch (error) {
      await harness.dispose();
      throw error;
    }
  }
}

export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  return Harness.create(options);
}

function singleModelId(harness: Harness): string | undefined {
  const models = harness.kernel.modelAdapters();
  return models.length === 1 ? models[0]?.id : undefined;
}
