import { CapabilityManager } from "./capabilities.js";
import { PluginError } from "./errors.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  CapabilityContribution,
  DataProcessor,
  Logger,
  ModelAdapter,
  Plugin,
  PluginContext,
  PluginHandle,
  PluginManifest,
  UiContribution,
} from "./types.js";

const API_VERSION = "1" as const;

type InstalledPlugin = {
  readonly plugin: Plugin;
  readonly context: PluginContext;
  readonly cleanup: (() => void)[];
  removed: boolean;
};

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
  if (manifest.apiVersion !== API_VERSION) throw new PluginError("PLUGIN_API_MISMATCH", `Plugin “${manifest.id}” requires an unsupported API version.`);
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(manifest.id)) throw new PluginError("INVALID_PLUGIN_ID", "Plugin IDs must be lowercase and URL-safe.");
  if (!manifest.name.trim() || !manifest.version.trim()) throw new PluginError("INVALID_PLUGIN_MANIFEST", "Plugin name and version are required.");
  const names = new Set<string>();
  for (const permission of manifest.permissions) {
    if (!permission.name.trim() || names.has(permission.name)) {
      throw new PluginError("INVALID_PLUGIN_MANIFEST", `Plugin “${manifest.id}” contains a duplicate or empty permission.`);
    }
    names.add(permission.name);
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly models = new Map<string, ModelAdapter>();
  private readonly processorMap = new Map<string, DataProcessor>();
  private readonly ui = new Map<string, UiContribution>();
  private readonly tools: ToolRegistry;
  private readonly capabilities: CapabilityManager;

  constructor(tools: ToolRegistry, capabilities: CapabilityManager) {
    this.tools = tools;
    this.capabilities = capabilities;
  }

  async install(plugin: Plugin, signal = new AbortController().signal): Promise<PluginHandle> {
    validateManifest(plugin.manifest);
    const manifest = plugin.manifest;
    if (this.plugins.has(manifest.id)) throw new PluginError("DUPLICATE_PLUGIN", `Plugin “${manifest.id}” is already installed.`);

    await this.capabilities.request(manifest.id, manifest.permissions, signal);
    const cleanup: (() => void)[] = [];
    const context: PluginContext = {
      manifest,
      signal,
      logger: loggerFor(manifest.id),
      capabilities: this.capabilities.scope(manifest.id, manifest.permissions.map((permission) => permission.name), signal),
      registerTool: (tool) => {
        const required = new Set((tool.requiredCapabilities ?? []).map((capability) => capability.trim()));
        const declared = new Set(manifest.permissions.map((permission) => permission.name));
        for (const capability of required) {
          if (!declared.has(capability)) {
            throw new PluginError(
              "PLUGIN_PERMISSION_MISSING",
              `Tool “${tool.name}” requires “${capability}”, but plugin “${manifest.id}” did not request it.`,
            );
          }
        }
        const unregister = this.tools.register({ ...tool, pluginId: manifest.id }, manifest.id);
        cleanup.push(unregister);
        return unregister;
      },
      registerCapability: (contribution: CapabilityContribution) => {
        const unregister = this.capabilities.register(contribution.name, contribution.provider);
        cleanup.push(unregister);
        return unregister;
      },
      registerModelAdapter: (adapter: ModelAdapter) => {
        if (this.models.has(adapter.id)) throw new PluginError("DUPLICATE_MODEL_ADAPTER", `Model adapter “${adapter.id}” is already registered.`);
        this.models.set(adapter.id, adapter);
        const unregister = () => {
          if (this.models.get(adapter.id) === adapter) this.models.delete(adapter.id);
        };
        cleanup.push(unregister);
        return unregister;
      },
      registerProcessor: (processor: DataProcessor) => {
        if (this.processorMap.has(processor.id)) throw new PluginError("DUPLICATE_PROCESSOR", `Processor “${processor.id}” is already registered.`);
        this.processorMap.set(processor.id, processor);
        const unregister = () => {
          if (this.processorMap.get(processor.id) === processor) this.processorMap.delete(processor.id);
        };
        cleanup.push(unregister);
        return unregister;
      },
      registerUi: (contribution: UiContribution) => {
        if (this.ui.has(contribution.id)) throw new PluginError("DUPLICATE_UI_CONTRIBUTION", `UI contribution “${contribution.id}” is already registered.`);
        this.ui.set(contribution.id, contribution);
        const unregister = () => {
          if (this.ui.get(contribution.id) === contribution) this.ui.delete(contribution.id);
        };
        cleanup.push(unregister);
        return unregister;
      },
    };

    try {
      await plugin.setup(context);
    } catch (error) {
      for (const undo of cleanup.reverse()) undo();
      this.capabilities.revoke(manifest.id);
      throw error;
    }

    const installed: InstalledPlugin = { plugin, context, cleanup, removed: false };
    this.plugins.set(manifest.id, installed);
    const uninstall = async (): Promise<void> => {
      if (installed.removed) return;
      installed.removed = true;
      try {
        if (plugin.teardown !== undefined) await plugin.teardown(context);
      } finally {
        for (const undo of cleanup.reverse()) undo();
        this.tools.unregisterByPlugin(manifest.id);
        this.capabilities.revoke(manifest.id);
        if (this.plugins.get(manifest.id) === installed) this.plugins.delete(manifest.id);
      }
    };
    return { manifest, uninstall };
  }

  async uninstall(pluginId: string): Promise<boolean> {
    const installed = this.plugins.get(pluginId);
    if (installed === undefined || installed.removed) return false;
    installed.removed = true;
    try {
      if (installed.plugin.teardown !== undefined) await installed.plugin.teardown(installed.context);
    } finally {
      for (const undo of installed.cleanup.reverse()) undo();
      this.tools.unregisterByPlugin(pluginId);
      this.capabilities.revoke(pluginId);
      if (this.plugins.get(pluginId) === installed) this.plugins.delete(pluginId);
    }
    return true;
  }

  isInstalled(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  manifests(): readonly PluginManifest[] {
    return [...this.plugins.values()].map(({ plugin }) => plugin.manifest);
  }

  modelAdapter(id: string): ModelAdapter | undefined {
    return this.models.get(id);
  }

  processors(): readonly DataProcessor[] {
    return [...this.processorMap.values()];
  }

  uiContributions(): readonly UiContribution[] {
    return [...this.ui.values()];
  }
}