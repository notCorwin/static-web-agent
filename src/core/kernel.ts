import { CapabilityUnavailableError, errorInfo, KernelError, PermissionDeniedError, PluginError } from "./errors.js";
import { formatIssues, isJsonValue, validate } from "./schema.js";
import type {
  CapabilityProvider,
  CapabilityScope,
  DataProcessor,
  JsonValue,
  Logger,
  ModelAdapter,
  PermissionPolicy,
  Plugin,
  PluginContext,
  PluginHandle,
  PluginManifest,
  ToolDefinition,
  ToolDescriptor,
  ToolError,
  ToolExecutionResult,
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

interface RegisteredTool extends ToolDefinition {
  readonly pluginId: string;
  readonly requiredCapabilities: readonly string[];
}

interface Installed {
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
  readonly context: PluginContext;
  readonly ownership: (() => void)[];
  readonly lifecycle: AbortController;
  readonly gate: { value: boolean };
  active: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

function abortedError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function issuesAsJson(issues: readonly { readonly path: string; readonly message: string }[]): JsonValue {
  return issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function failure(code: string, message: string, details?: JsonValue): ToolExecutionResult {
  const error: ToolError = details === undefined ? { code, message } : { code, message, details };
  return { ok: false, error };
}

function cloneSchema<T extends ToolDefinition["inputSchema"] | NonNullable<ToolDefinition["outputSchema"]>>(schema: T): T {
  const cloned = typeof structuredClone === "function" ? structuredClone(schema) : JSON.parse(JSON.stringify(schema)) as T;
  return freeze(cloned);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

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

function releaseOwned(ownership: readonly (() => void)[]): void {
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

/**
 * The single agent-runtime registry. Tools, model adapters, capability grants,
 * data processors, and plugin lifecycle live here instead of across three modules.
 *
 * ponytail: capability values are returned raw (no revocation proxies) because plugins are
 * trusted same-realm modules; add proxy guarding if untrusted plugin code becomes a requirement.
 */
export class AgentKernel {
  private readonly policy: PermissionPolicy;
  private readonly tools = new Map<string, RegisteredTool>();
  private toolDescriptors: readonly ToolDescriptor[] | undefined;
  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly grants = new Map<string, Set<string>>();
  private readonly models = new Map<string, ModelAdapter>();
  private readonly processorMap = new Map<string, DataProcessor>();
  private readonly uiMap = new Map<string, UiContribution>();
  private readonly installed = new Map<string, Installed>();
  private readonly installing = new Set<string>();
  private readonly uiMounts = new Set<MountedUi[]>();
  private readonly listeners = new Set<ChangeListener>();

  // ponytail: allow-by-default policy keeps zero-config embeds working; plugins are trusted
  // code. Hosts opt into consent prompting by passing a stricter policy.
  constructor(policy?: PermissionPolicy) {
    this.policy = policy ?? { decide: () => true };
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
        // Registry observers must not break lifecycle operations.
      }
    }
  }

  private assertActive(gate: { value: boolean }, pluginId: string): void {
    if (!gate.value) throw new PluginError("PLUGIN_INACTIVE", `Plugin “${pluginId}” is no longer active.`);
  }

  // ----------------------------------------------------------------- models

  addModel(adapter: ModelAdapter): () => void {
    if (typeof adapter !== "object" || adapter === null || typeof adapter.id !== "string" || !adapter.id.trim() || typeof adapter.stream !== "function") {
      throw new PluginError("INVALID_MODEL_ADAPTER", "Model adapters need an ID and stream function.");
    }
    if (this.models.has(adapter.id)) throw new PluginError("DUPLICATE_MODEL_ADAPTER", `Model adapter “${adapter.id}” is already registered.`);
    this.models.set(adapter.id, adapter);
    return () => {
      if (this.models.get(adapter.id) === adapter) {
        this.models.delete(adapter.id);
        this.changed();
      }
    };
  }

  modelAdapter(id: string): ModelAdapter | undefined {
    return this.models.get(id);
  }

  modelAdapters(): readonly ModelAdapter[] {
    return [...this.models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  // ------------------------------------------------------------------ tools

  register(tool: ToolDefinition, owner = "core"): () => void {
    if (typeof tool !== "object" || tool === null || typeof tool.name !== "string" || typeof tool.description !== "string" || typeof tool.execute !== "function") {
      throw new Error("Tools need a name, description, and execute function.");
    }
    const name = tool.name.trim();
    if (!name) throw new Error("Tool names cannot be empty.");
    if (!tool.description.trim()) throw new Error(`Tool “${name}” must have a description.`);
    if (this.tools.has(name)) throw new Error(`Tool “${name}” is already registered.`);
    if (tool.requiredCapabilities !== undefined && !Array.isArray(tool.requiredCapabilities)) throw new Error(`Tool “${name}” declares invalid capabilities.`);
    if ((tool.requiredCapabilities ?? []).some((capability) => typeof capability !== "string")) throw new Error(`Tool “${name}” declares invalid capabilities.`);
    const requiredCapabilities = Object.freeze([...new Set((tool.requiredCapabilities ?? []).map((capability) => capability.trim()))]);
    if (requiredCapabilities.some((capability) => capability.length === 0)) throw new Error(`Tool “${name}” declares an empty capability name.`);
    const registered: RegisteredTool = {
      ...tool,
      name,
      inputSchema: cloneSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneSchema(tool.outputSchema) }),
      pluginId: owner ?? tool.pluginId ?? "core",
      requiredCapabilities,
    };
    this.tools.set(name, registered);
    this.toolDescriptors = undefined;
    return () => {
      if (this.tools.get(name) === registered) {
        this.tools.delete(name);
        this.toolDescriptors = undefined;
      }
    };
  }

  descriptors(): readonly ToolDescriptor[] {
    return this.toolDescriptors ??= Object.freeze([...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name)).map((tool): ToolDescriptor => Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiredCapabilities: tool.requiredCapabilities,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    })));
  }

  get descriptorCount(): number {
    return this.tools.size;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async executeTool(name: string, input: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) return failure("TOOL_NOT_FOUND", `Tool “${name}” is not registered.`);
    const validation = validate(tool.inputSchema, input);
    if (!validation.valid) {
      return failure("INVALID_TOOL_INPUT", formatIssues(validation.issues), issuesAsJson(validation.issues));
    }
    const resolved = signal ?? new AbortController().signal;
    try {
      if (resolved.aborted) return failure("ABORTED", "Tool execution was cancelled.");
      const result = await tool.execute(input as JsonValue, {
        signal: resolved,
        pluginId: tool.pluginId,
        getCapability: async <T>(capability: string) => {
          if (!tool.requiredCapabilities.includes(capability)) throw new Error(`Tool “${name}” did not declare the “${capability}” capability.`);
          return this.capability<T>(tool.pluginId, capability, resolved);
        },
      });
      if (!isJsonValue(result)) return failure("INVALID_TOOL_OUTPUT", "Tool output must be valid JSON.");
      if (tool.outputSchema !== undefined) {
        const outputValidation = validate(tool.outputSchema, result);
        if (!outputValidation.valid) {
          return failure("INVALID_TOOL_OUTPUT", formatIssues(outputValidation.issues), issuesAsJson(outputValidation.issues));
        }
      }
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, error: errorInfo(error, "TOOL_ERROR") };
    }
  }

  // ------------------------------------------------------------ capabilities

  provide(name: string, provider: CapabilityProvider): () => void {
    const normalized = name.trim();
    if (!normalized) throw new KernelError("INVALID_CAPABILITY", "Capability names cannot be empty.");
    if (this.providers.has(normalized)) throw new KernelError("DUPLICATE_CAPABILITY", `Capability “${normalized}” is already registered.`);
    this.providers.set(normalized, provider);
    return () => {
      if (this.providers.get(normalized) === provider) this.providers.delete(normalized);
    };
  }

  /** Pre-grants a capability without consulting the policy; used for host-owned registrations. */
  grant(pluginId: string, name: string): void {
    const normalized = name.trim();
    if (!normalized) throw new KernelError("INVALID_CAPABILITY", "Capability names must be non-empty.");
    const grant = this.grants.get(pluginId) ?? new Set<string>();
    grant.add(normalized);
    this.grants.set(pluginId, grant);
  }

  revoke(pluginId: string): void {
    this.grants.delete(pluginId);
  }

  /** Consults the permission policy once per not-yet-granted capability request. */
  private async requestGrants(pluginId: string, requests: readonly { readonly name: string; readonly reason: string; readonly optional?: boolean }[], signal: AbortSignal): Promise<void> {
    for (const request of requests) {
      throwIfAborted(signal);
      if (this.grants.get(pluginId)?.has(request.name)) continue;
      if (!this.providers.has(request.name)) {
        if (request.optional === true) continue;
        throw new CapabilityUnavailableError(request.name);
      }
      if ((await this.policy.decide({ ...request, pluginId })) === false) {
        if (request.optional === true) continue;
        throw new PermissionDeniedError(pluginId, request.name, request.reason);
      }
      this.grant(pluginId, request.name);
    }
  }

  private async capability<T>(pluginId: string, name: string, signal?: AbortSignal): Promise<T> {
    if (!(this.grants.get(pluginId)?.has(name) ?? false)) throw new PermissionDeniedError(pluginId, name);
    const resolved = signal ?? new AbortController().signal;
    throwIfAborted(resolved);
    const provider = this.providers.get(name);
    if (provider === undefined) throw new CapabilityUnavailableError(name);
    return provider.provide({ pluginId, signal: resolved }) as Promise<T>;
  }

  private scope(pluginId: string, allowedNames: readonly string[], signal?: AbortSignal): CapabilityScope {
    const allowed = new Set(allowedNames);
    return Object.freeze({
      has: (name: string) => allowed.has(name) && (this.grants.get(pluginId)?.has(name) ?? false),
      get: async <T>(name: string) => {
        if (!allowed.has(name)) throw new PermissionDeniedError(pluginId, name, "The plugin did not request this capability.");
        return this.capability<T>(pluginId, name, signal);
      },
    });
  }

  // ------------------------------------------------------- processors and ui

  async process(value: JsonValue, signal: AbortSignal = new AbortController().signal): Promise<JsonValue> {
    let result = value;
    for (const processor of [...this.processorMap.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortedError("Operation cancelled.");
      result = await processor.process(result, signal);
      if (!isJsonValue(result)) throw new KernelError("INVALID_PROCESSOR_OUTPUT", `Processor “${processor.id}” returned a non-JSON value.`);
    }
    return result;
  }

  mountUi(container: HTMLElement): () => void {
    const mounted: MountedUi[] = [];
    this.uiMounts.add(mounted);
    for (const contribution of [...this.uiMap.values()].sort((left, right) => left.id.localeCompare(right.id))) {
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
      for (const item of mounted.reverse()) this.releaseMountedUi(item);
      this.uiMounts.delete(mounted);
    };
  }

  uiContributions(): readonly UiContribution[] {
    return [...this.uiMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  processors(): readonly DataProcessor[] {
    return [...this.processorMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private releaseMountedUi(item: MountedUi): void {
    if (item.removed) return;
    item.removed = true;
    try { item.cleanup?.(); } catch { /* A broken UI cleanup must not block other slots. */ }
    finally { item.slot.remove(); }
  }

  private removeMountedUi(contribution: UiContribution): void {
    for (const mounted of this.uiMounts) {
      for (const item of mounted.filter((candidate) => candidate.contribution === contribution)) this.releaseMountedUi(item);
    }
  }

  // ---------------------------------------------------------------- plugins

  isInstalled(pluginId: string): boolean {
    return this.installed.has(pluginId);
  }

  manifests(): readonly PluginManifest[] {
    return [...this.installed.values()].map(({ manifest }) => manifest);
  }

  async install(plugin: Plugin, signal = new AbortController().signal): Promise<PluginHandle> {
    validateManifest(plugin.manifest);
    const manifest: PluginManifest = Object.freeze({
      ...plugin.manifest,
      permissions: Object.freeze(plugin.manifest.permissions.map((permission) => Object.freeze({ ...permission }))),
    });
    if (this.installed.has(manifest.id) || this.installing.has(manifest.id)) throw new PluginError("DUPLICATE_PLUGIN", `Plugin “${manifest.id}” is already installed or installing.`);
    if (signal.aborted) throw abortedError("Plugin installation was cancelled.");
    this.installing.add(manifest.id);

    const ownership: (() => void)[] = [];
    const gate = { value: true };
    const lifecycle = new AbortController();
    let published = false;
    const publish = (): void => {
      if (published) this.changed();
    };
    const declared = new Set(manifest.permissions.map((permission) => permission.name));

    const relayAbort = () => lifecycle.abort(signal.reason);
    signal.addEventListener("abort", relayAbort, { once: true });

    try {
      const context: PluginContext = {
        manifest,
        signal: lifecycle.signal,
        logger: loggerFor(manifest.id),
        capabilities: this.scope(manifest.id, [...declared], lifecycle.signal),
        registerTool: (tool) => {
          this.assertActive(gate, manifest.id);
          for (const capability of tool.requiredCapabilities ?? []) {
            if (!declared.has(capability)) {
              throw new PluginError(
                "PLUGIN_PERMISSION_MISSING",
                `Tool “${tool.name}” requires “${capability}”, but plugin “${manifest.id}” did not request it.`,
              );
            }
          }
          const unregisterTool = this.register(tool, manifest.id);
          const unregister = ownContribution(ownership, () => {
            unregisterTool();
            publish();
          });
          publish();
          return unregister;
        },
        registerCapability: (contribution) => {
          this.assertActive(gate, manifest.id);
          const unregisterCapability = this.provide(contribution.name, contribution.provider);
          const unregister = ownContribution(ownership, () => {
            unregisterCapability();
            publish();
          });
          publish();
          return unregister;
        },
        registerModelAdapter: (adapter) => {
          this.assertActive(gate, manifest.id);
          this.addModel(adapter);
          const unregister = ownContribution(ownership, () => {
            if (this.models.get(adapter.id) === adapter) this.models.delete(adapter.id);
            publish();
          });
          publish();
          return unregister;
        },
        registerProcessor: (processor) => {
          this.assertActive(gate, manifest.id);
          if (typeof processor !== "object" || processor === null || typeof processor.id !== "string" || !processor.id.trim() || typeof processor.description !== "string" || !processor.description.trim() || typeof processor.process !== "function") {
            throw new PluginError("INVALID_PROCESSOR", "Processors need an ID, description, and process function.");
          }
          if (this.processorMap.has(processor.id)) throw new PluginError("DUPLICATE_PROCESSOR", `Processor “${processor.id}” is already registered.`);
          this.processorMap.set(processor.id, processor);
          const unregister = ownContribution(ownership, () => {
            if (this.processorMap.get(processor.id) === processor) this.processorMap.delete(processor.id);
            publish();
          });
          publish();
          return unregister;
        },
        registerUi: (contribution) => {
          this.assertActive(gate, manifest.id);
          if (typeof contribution !== "object" || contribution === null || typeof contribution.id !== "string" || !contribution.id.trim() || typeof contribution.mount !== "function") {
            throw new PluginError("INVALID_UI_CONTRIBUTION", "UI contributions need an ID and mount function.");
          }
          if (this.uiMap.has(contribution.id)) throw new PluginError("DUPLICATE_UI_CONTRIBUTION", `UI contribution “${contribution.id}” is already registered.`);
          this.uiMap.set(contribution.id, contribution);
          const unregister = ownContribution(ownership, () => {
            if (this.uiMap.get(contribution.id) === contribution) {
              this.uiMap.delete(contribution.id);
              this.removeMountedUi(contribution);
            }
            publish();
          });
          publish();
          return unregister;
        },
      };
      Object.freeze(context);

      await plugin.setup(context);
      await this.requestGrants(manifest.id, manifest.permissions, signal);
      if (signal.aborted) throw abortedError("Plugin installation was cancelled.");
      const installed: Installed = { manifest, plugin, context, ownership, lifecycle, gate, active: true };
      this.installed.set(manifest.id, installed);
      published = true;
      this.changed();
      return {
        manifest,
        uninstall: async () => {
          await this.remove(installed);
        },
      };
    } catch (error) {
      gate.value = false;
      lifecycle.abort(error);
      releaseOwned(ownership);
      this.revoke(manifest.id);
      throw error;
    } finally {
      signal.removeEventListener("abort", relayAbort);
      this.installing.delete(manifest.id);
    }
  }

  async uninstall(pluginId: string): Promise<boolean> {
    const installed = this.installed.get(pluginId);
    return installed === undefined ? false : this.remove(installed);
  }

  private async remove(installed: Installed): Promise<boolean> {
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
      installed.lifecycle.abort(abortedError("Plugin was uninstalled."));
      releaseOwned(installed.ownership);
      const pluginId = installed.manifest.id;
      for (const [name, tool] of this.tools) {
        if (tool.pluginId === pluginId) {
          this.tools.delete(name);
          this.toolDescriptors = undefined;
        }
      }
      this.revoke(pluginId);
      if (this.installed.get(pluginId) === installed) this.installed.delete(pluginId);
      this.changed();
    }
    if (teardownFailed) throw teardownError;
    return true;
  }
}
