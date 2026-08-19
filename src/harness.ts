import { Agent } from "./core/agent.js";
import { BrowserPageRuntime } from "./core/page-runtime.js";
import { CapabilityManager } from "./core/capabilities.js";
import { KernelError } from "./core/errors.js";
import { PluginManager } from "./core/plugin-manager.js";
import { BrowserWorkerRuntime } from "./core/runtime.js";
import { createBrowserStateStore, PrefixedStateStore } from "./core/state.js";
import { ToolRegistry } from "./core/tool-registry.js";
import { createBrowserApiPlugin } from "./plugins/browser-api.js";
import { createJavaScriptRuntimePlugin } from "./plugins/javascript-runtime.js";
import { createStoragePlugin } from "./plugins/storage.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  JavaScriptRuntime,
  PageRuntime,
  PermissionPolicy,
  Plugin,
  PluginHandle,
  PluginManifest,
  JsonValue,
  StateStore,
  ToolDescriptor,
} from "./core/types.js";

export type BrowserFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BrowserAgentHarnessOptions {
  readonly plugins?: readonly Plugin[];
  readonly initialModelId?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly stateStore?: StateStore;
  readonly fetcher?: BrowserFetcher;
  readonly workerRuntime?: JavaScriptRuntime;
  readonly pageRuntime?: PageRuntime;
  readonly defaultPlugins?: boolean;
}

export type BrowserAgentHarnessStatus = "active" | "disposed";

export interface BrowserModelDescriptor {
  readonly id: string;
  readonly supportsVision?: boolean;
}

export interface BrowserAgentHarnessSnapshot {
  readonly status: BrowserAgentHarnessStatus;
  readonly selectedModelId?: string;
  readonly manifests: readonly PluginManifest[];
  readonly models: readonly BrowserModelDescriptor[];
  readonly tools: readonly ToolDescriptor[];
}

export type BrowserAgentHarnessListener = (snapshot: BrowserAgentHarnessSnapshot) => void;

export interface BrowserAgentHarnessPluginHandle {
  readonly manifest: PluginManifest;
  readonly uninstall: () => Promise<void>;
}

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

function defaultPermissionPolicy(): PermissionPolicy {
  return { decide: () => true };
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

/**
 * The browser-native composition surface for the Agent kernel.
 *
 * The harness owns plugin lifecycle and run cancellation, while the lower-level
 * registries remain available for applications that need finer control.
 */
export class BrowserAgentHarness {
  private readonly capabilities: CapabilityManager;
  private readonly tools: ToolRegistry;
  private readonly plugins: PluginManager;
  private readonly handles: PluginHandle[] = [];
  private readonly listeners = new Set<BrowserAgentHarnessListener>();
  private readonly activeRuns = new Set<ActiveRun>();
  private readonly capabilityCleanup: (() => void)[] = [];
  private selectedModelId: string | undefined;
  private disposed = false;

  private constructor(
    capabilities: CapabilityManager,
    tools: ToolRegistry,
    plugins: PluginManager,
    capabilityCleanup: readonly (() => void)[],
  ) {
    this.capabilities = capabilities;
    this.tools = tools;
    this.plugins = plugins;
    this.capabilityCleanup.push(...capabilityCleanup);
    this.plugins.subscribe(() => this.changed());
  }

  private static construct(options: BrowserAgentHarnessOptions): BrowserAgentHarness {
    const capabilities = new CapabilityManager(options.permissionPolicy ?? defaultPermissionPolicy());
    const tools = new ToolRegistry(capabilities);
    const plugins = new PluginManager(tools, capabilities);
    const capabilityCleanup: (() => void)[] = [];

    const stateStore = options.stateStore ?? createBrowserStateStore();
    const runtime = options.workerRuntime ?? new BrowserWorkerRuntime();
    const pageRuntime = options.pageRuntime ?? new BrowserPageRuntime();
    const fetcher = options.fetcher ?? browserFetcher() ?? unavailableFetcher();

    capabilityCleanup.push(capabilities.register("runtime", { provide: () => runtime }));
    capabilityCleanup.push(capabilities.register("page", { provide: () => pageRuntime }));
    capabilityCleanup.push(capabilities.register("storage", {
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
    capabilityCleanup.push(capabilities.register("network", { provide: (): NetworkCapability => ({ fetch: fetcher }) }));
    return new BrowserAgentHarness(capabilities, tools, plugins, capabilityCleanup);
  }

  private ensureActive(): void {
    if (this.disposed) throw new KernelError("HARNESS_DISPOSED", "The Browser Agent Harness has been disposed.");
  }

  private changed(): void {
    if (this.selectedModelId !== undefined && this.plugins.modelAdapter(this.selectedModelId) === undefined) {
      this.selectedModelId = undefined;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not break lifecycle operations.
      }
    }
  }

  private remember(handle: PluginHandle): BrowserAgentHarnessPluginHandle {
    this.handles.push(handle);
    return {
      manifest: handle.manifest,
      uninstall: async () => {
        await this.uninstall(handle.manifest.id);
      },
    };
  }

  async install(plugin: Plugin, signal?: AbortSignal): Promise<BrowserAgentHarnessPluginHandle> {
    this.ensureActive();
    const handle = await this.plugins.install(plugin, signal);
    return this.remember(handle);
  }

  async uninstall(pluginId: string): Promise<boolean> {
    this.ensureActive();
    let removed = false;
    try {
      removed = await this.plugins.uninstall(pluginId);
    } finally {
      const index = this.handles.findIndex((handle) => handle.manifest.id === pluginId);
      if (index >= 0 && !this.plugins.isInstalled(pluginId)) this.handles.splice(index, 1);
    }
    return removed;
  }

  selectModel(id: string): void {
    this.ensureActive();
    if (this.plugins.modelAdapter(id) === undefined) {
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
    const model = this.plugins.modelAdapter(this.selectedModelId);
    if (model === undefined) {
      this.selectedModelId = undefined;
      throw new KernelError("MODEL_NOT_FOUND", "The selected model adapter is no longer registered.");
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    if (request.signal?.aborted) relayAbort();
    const active: ActiveRun = {
      controller,
      cleanup: () => request.signal?.removeEventListener("abort", relayAbort),
    };
    this.activeRuns.add(active);

    try {
      return await new Agent(model, this.tools).run({ ...request, signal: controller.signal });
    } finally {
      active.cleanup();
      this.activeRuns.delete(active);
    }
  }

  process(value: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    this.ensureActive();
    return this.plugins.process(value, signal);
  }

  mountUi(container: HTMLElement): () => void {
    this.ensureActive();
    return this.plugins.mountUi(container);
  }

  snapshot(): BrowserAgentHarnessSnapshot {
    const models = this.plugins.modelAdapters().map((adapter): BrowserModelDescriptor => ({
      id: adapter.id,
      ...(adapter.supportsVision === undefined ? {} : { supportsVision: adapter.supportsVision }),
    }));
    return Object.freeze({
      status: this.disposed ? "disposed" : "active",
      ...(this.selectedModelId === undefined ? {} : { selectedModelId: this.selectedModelId }),
      manifests: Object.freeze([...this.plugins.manifests()].sort((left, right) => left.id.localeCompare(right.id))),
      models: Object.freeze(models),
      tools: Object.freeze([...this.tools.descriptors()]),
    });
  }

  subscribe(listener: BrowserAgentHarnessListener): () => void {
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
    for (const handle of [...this.handles].reverse()) {
      try {
        await this.plugins.uninstall(handle.manifest.id);
      } catch {
        // One broken teardown must not prevent the remaining plugins from closing.
      }
    }
    this.handles.length = 0;
    for (const cleanup of this.capabilityCleanup.reverse()) {
      try { cleanup(); } catch { /* Capability cleanup is best effort. */ }
    }
    this.capabilityCleanup.length = 0;
    this.changed();
  }

  static async create(options: BrowserAgentHarnessOptions = {}): Promise<BrowserAgentHarness> {
    const harness = BrowserAgentHarness.construct(options);
    try {
      if (options.defaultPlugins !== false) {
        await harness.install(createJavaScriptRuntimePlugin());
        await harness.install(createStoragePlugin());
        await harness.install(createBrowserApiPlugin());
      }
      for (const plugin of options.plugins ?? []) await harness.install(plugin);
      if (options.initialModelId !== undefined) harness.selectModel(options.initialModelId);
      return harness;
    } catch (error) {
      await harness.dispose();
      throw error;
    }
  }
}

export async function createBrowserAgentHarness(options: BrowserAgentHarnessOptions = {}): Promise<BrowserAgentHarness> {
  return BrowserAgentHarness.create(options);
}
