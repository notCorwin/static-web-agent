import { CapabilityManager } from "./capabilities.js";
import { KernelError, PluginError } from "./errors.js";
import { isJsonValue } from "./schema.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  CapabilityContribution,
  DataProcessor,
  JsonValue,
  Logger,
  ModelAdapter,
  Plugin,
  PluginContext,
  PluginHandle,
  PluginManifest,
  UiContribution,
} from "./types.js";

const API_VERSION = "1" as const;

type ChangeListener = () => void;

type MountedUi = {
  readonly contribution: UiContribution;
  readonly slot: HTMLElement;
  readonly cleanup?: () => void;
  removed: boolean;
};

type InstalledPlugin = {
  readonly plugin: Plugin;
  readonly context: PluginContext;
  readonly ownership: (() => void)[];
  readonly lifecycle: AbortController;
  readonly gate: { value: boolean };
  active: boolean;
};

function ownContribution(ownership: (() => void)[], release: () => void): () => void {
  let active = true;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    release();
  };
  ownership.push(cleanup);
  return cleanup;
}

function releaseContributions(ownership: readonly (() => void)[]): void {
  for (const cleanup of [...ownership].reverse()) {
    try { cleanup(); } catch { /* One broken contribution must not leak the others. */ }
  }
}

function loggerFor(pluginId: string): Logger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (...values) => console.debug(prefix, ...values),
    info: (...values) => console.info(prefix, ...values),
    warn: (...values) => console.warn(prefix, ...values),
    error: (...values) => console.error(prefix, ...values),
  };
}

function validateManifest(manifest: PluginManifest): void {
  if (typeof manifest !== "object" || manifest === null) throw new PluginError("INVALID_PLUGIN_MANIFEST", "A plugin manifest is required.");
  if (manifest.apiVersion !== API_VERSION) throw new PluginError("PLUGIN_API_MISMATCH", `Plugin “${String(manifest.id)}” requires an unsupported API version.`);
  if (typeof manifest.id !== "string" || !manifest.id.trim()) throw new PluginError("INVALID_PLUGIN_ID", "Plugin IDs cannot be empty.");
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || !manifest.name.trim() || !manifest.version.trim()) throw new PluginError("INVALID_PLUGIN_MANIFEST", "Plugin name and version are required.");
  if (!Array.isArray(manifest.permissions)) throw new PluginError("INVALID_PLUGIN_MANIFEST", "Plugin permissions must be an array.");
  const names = new Set<string>();
  for (const permission of manifest.permissions) {
    if (typeof permission !== "object" || permission === null || typeof permission.name !== "string" || typeof permission.reason !== "string" || !permission.name.trim() || permission.name !== permission.name.trim() || !permission.reason.trim() || names.has(permission.name)) {
      throw new PluginError("INVALID_PLUGIN_MANIFEST", `Plugin “${manifest.id}” contains an invalid or duplicate permission.`);
    }
    names.add(permission.name);
  }
}

function abortError(): Error {
  const error = new Error("Plugin was uninstalled.");
  error.name = "AbortError";
  return error;
}

export class PluginManager {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly installing = new Set<string>();
  private readonly models = new Map<string, ModelAdapter>();
  private readonly processorMap = new Map<string, DataProcessor>();
  private readonly ui = new Map<string, UiContribution>();
  private readonly uiMounts = new Set<MountedUi[]>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly tools: ToolRegistry;
  private readonly capabilities: CapabilityManager;

  constructor(tools: ToolRegistry, capabilities: CapabilityManager) {
    this.tools = tools;
    this.capabilities = capabilities;
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Registry observers must not break plugin lifecycle operations.
      }
    }
  }

  private assertActive(active: { value: boolean }, pluginId: string): void {
    if (!active.value) throw new PluginError("PLUGIN_INACTIVE", `Plugin “${pluginId}” is no longer active.`);
  }

  async install(plugin: Plugin, signal = new AbortController().signal): Promise<PluginHandle> {
    validateManifest(plugin.manifest);
    const manifest: PluginManifest = Object.freeze({
      ...plugin.manifest,
      permissions: Object.freeze(plugin.manifest.permissions.map((permission) => Object.freeze({ ...permission }))),
    });
    if (this.plugins.has(manifest.id) || this.installing.has(manifest.id)) throw new PluginError("DUPLICATE_PLUGIN", `Plugin “${manifest.id}” is already installed or installing.`);
    if (signal.aborted) throw abortError();
    this.installing.add(manifest.id);

    const ownership: (() => void)[] = [];
    const lifecycle = new AbortController();
    const active = { value: true };
    let published = false;
    const relayAbort = () => lifecycle.abort(signal.reason);
    signal.addEventListener("abort", relayAbort, { once: true });
    const declared = new Set(manifest.permissions.map((permission) => permission.name));

    try {
      const context: PluginContext = {
        manifest,
        signal: lifecycle.signal,
        logger: loggerFor(manifest.id),
        capabilities: this.capabilities.scope(manifest.id, manifest.permissions.map((permission) => permission.name), lifecycle.signal),
        registerTool: (tool) => {
          this.assertActive(active, manifest.id);
          if (typeof tool !== "object" || tool === null || (tool.requiredCapabilities !== undefined && !Array.isArray(tool.requiredCapabilities)) || (tool.requiredCapabilities ?? []).some((capability) => typeof capability !== "string")) throw new PluginError("INVALID_TOOL", "Plugin tools declare invalid capabilities.");
          const required = new Set((tool.requiredCapabilities ?? []).map((capability) => capability.trim()));
          for (const capability of required) {
            if (!declared.has(capability)) {
              throw new PluginError(
                "PLUGIN_PERMISSION_MISSING",
                `Tool “${tool.name}” requires “${capability}”, but plugin “${manifest.id}” did not request it.`,
              );
            }
          }
          const unregisterTool = this.tools.register({ ...tool, pluginId: manifest.id }, manifest.id);
          const unregister = ownContribution(ownership, () => {
            unregisterTool();
            if (published) this.changed();
          });
          if (published) this.changed();
          return unregister;
        },
        registerCapability: (contribution: CapabilityContribution) => {
          this.assertActive(active, manifest.id);
          if (typeof contribution !== "object" || contribution === null || typeof contribution.name !== "string" || typeof contribution.provider?.provide !== "function") throw new PluginError("INVALID_CAPABILITY", "Capability contributions need a name and provide function.");
          const unregisterCapability = this.capabilities.register(contribution.name, contribution.provider);
          const unregister = ownContribution(ownership, () => {
            unregisterCapability();
            if (published) this.changed();
          });
          if (published) this.changed();
          return unregister;
        },
        registerModelAdapter: (adapter: ModelAdapter) => {
          this.assertActive(active, manifest.id);
          if (typeof adapter !== "object" || adapter === null || typeof adapter.id !== "string" || !adapter.id.trim() || typeof adapter.stream !== "function") throw new PluginError("INVALID_MODEL_ADAPTER", "Model adapters need an ID and stream function.");
          if (this.models.has(adapter.id)) throw new PluginError("DUPLICATE_MODEL_ADAPTER", `Model adapter “${adapter.id}” is already registered.`);
          this.models.set(adapter.id, adapter);
          const unregister = ownContribution(ownership, () => {
            if (this.models.get(adapter.id) === adapter) this.models.delete(adapter.id);
            if (published) this.changed();
          });
          if (published) this.changed();
          return unregister;
        },
        registerProcessor: (processor: DataProcessor) => {
          this.assertActive(active, manifest.id);
          if (typeof processor !== "object" || processor === null || typeof processor.id !== "string" || !processor.id.trim() || typeof processor.description !== "string" || !processor.description.trim() || typeof processor.process !== "function") throw new PluginError("INVALID_PROCESSOR", "Processors need an ID, description, and process function.");
          if (this.processorMap.has(processor.id)) throw new PluginError("DUPLICATE_PROCESSOR", `Processor “${processor.id}” is already registered.`);
          this.processorMap.set(processor.id, processor);
          const unregister = ownContribution(ownership, () => {
            if (this.processorMap.get(processor.id) === processor) this.processorMap.delete(processor.id);
            if (published) this.changed();
          });
          if (published) this.changed();
          return unregister;
        },
        registerUi: (contribution: UiContribution) => {
          this.assertActive(active, manifest.id);
          if (typeof contribution !== "object" || contribution === null || typeof contribution.id !== "string" || !contribution.id.trim() || typeof contribution.mount !== "function") throw new PluginError("INVALID_UI_CONTRIBUTION", "UI contributions need an ID and mount function.");
          if (this.ui.has(contribution.id)) throw new PluginError("DUPLICATE_UI_CONTRIBUTION", `UI contribution “${contribution.id}” is already registered.`);
          this.ui.set(contribution.id, contribution);
          const unregister = ownContribution(ownership, () => {
            if (this.ui.get(contribution.id) !== contribution) return;
            this.ui.delete(contribution.id);
            this.removeMountedUi(contribution);
            if (published) this.changed();
          });
          if (published) this.changed();
          return unregister;
        },
      };
      Object.freeze(context);

      await plugin.setup(context);
      await this.capabilities.request(manifest.id, manifest.permissions, signal);
      if (signal.aborted) throw abortError();
      const installed: InstalledPlugin = { plugin, context, ownership, lifecycle, gate: active, active: true };
      this.plugins.set(manifest.id, installed);
      published = true;
      this.changed();
      const uninstall = async (): Promise<void> => {
        await this.remove(installed);
      };
      return { manifest, uninstall };
    } catch (error) {
      active.value = false;
      lifecycle.abort(error);
      releaseContributions(ownership);
      this.capabilities.revoke(manifest.id);
      throw error;
    } finally {
      signal.removeEventListener("abort", relayAbort);
      this.installing.delete(manifest.id);
    }
  }

  private async remove(installed: InstalledPlugin): Promise<boolean> {
    if (!installed.active) return false;
    installed.active = false;
    installed.gate.value = false;
    let teardownFailed = false;
    let teardownError: unknown;
    try {
      if (installed.plugin.teardown !== undefined) await installed.plugin.teardown(installed.context);
    } catch (error) {
      teardownFailed = true;
      teardownError = error;
    } finally {
      installed.lifecycle.abort(abortError());
      releaseContributions(installed.ownership);
      const pluginId = installed.context.manifest.id;
      this.tools.unregisterByPlugin(pluginId);
      this.capabilities.revoke(pluginId);
      if (this.plugins.get(pluginId) === installed) this.plugins.delete(pluginId);
      this.changed();
    }
    if (teardownFailed) throw teardownError;
    return true;
  }

  async uninstall(pluginId: string): Promise<boolean> {
    const installed = this.plugins.get(pluginId);
    return installed === undefined ? false : this.remove(installed);
  }

  isInstalled(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  manifests(): readonly PluginManifest[] {
    return [...this.plugins.values()].map(({ context }) => context.manifest);
  }

  modelAdapter(id: string): ModelAdapter | undefined {
    return this.models.get(id);
  }

  modelAdapters(): readonly ModelAdapter[] {
    return [...this.models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  processors(): readonly DataProcessor[] {
    return [...this.processorMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async process(value: JsonValue, signal = new AbortController().signal): Promise<JsonValue> {
    let result = value;
    for (const processor of this.processors()) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
      result = await processor.process(result, signal);
      if (!isJsonValue(result)) throw new KernelError("INVALID_PROCESSOR_OUTPUT", `Processor “${processor.id}” returned a non-JSON value.`);
    }
    return result;
  }

  uiContributions(): readonly UiContribution[] {
    return [...this.ui.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private removeMountedUi(contribution: UiContribution): void {
    for (const mounted of this.uiMounts) {
      for (const item of mounted.filter((candidate) => candidate.contribution === contribution)) {
        this.releaseMountedUi(item);
      }
    }
  }

  private releaseMountedUi(item: MountedUi): void {
    if (item.removed) return;
    item.removed = true;
    try { item.cleanup?.(); } catch { /* A broken UI cleanup must not block other slots. */ }
    finally { item.slot.remove(); }
  }

  mountUi(container: HTMLElement): () => void {
    const mounted: MountedUi[] = [];
    this.uiMounts.add(mounted);
    for (const contribution of this.uiContributions()) {
      const slot = container.ownerDocument.createElement("div");
      slot.dataset.uiContribution = contribution.id;
      container.append(slot);
      try {
        const cleanup = contribution.mount(slot);
        mounted.push({ contribution, slot, ...(typeof cleanup === "function" ? { cleanup } : {}), removed: false });
      } catch (error) {
        slot.textContent = error instanceof Error ? `Extension failed: ${error.message}` : "Extension failed.";
        mounted.push({ contribution, slot, removed: false });
      }
    }
    return () => {
      for (const item of mounted.reverse()) {
        this.releaseMountedUi(item);
      }
      this.uiMounts.delete(mounted);
    };
  }
}
