import { Agent } from "../core/agent.js";
import { CapabilityManager } from "../core/capabilities.js";
import { PluginManager } from "../core/plugin-manager.js";
import { BrowserWorkerRuntime } from "../core/runtime.js";
import { createBrowserStateStore, PrefixedStateStore } from "../core/state.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { createJavaScriptRuntimePlugin } from "../plugins/javascript-runtime.js";
import { createLocalModelPlugin } from "../plugins/local-model.js";
import { createRemoteModelPlugin } from "../plugins/remote-model.js";
import { createStoragePlugin } from "../plugins/storage.js";
import { CHAT_LIMITS, createChatState, isMessageEnvelope, normalizeMessages, type ChatState } from "./chat.js";
import { messageElement, renderShell, textElement, type AppElements } from "./view.js";
import type { AgentEvent, ModelMessage, Plugin, PluginHandle, StorageCapability, ToolCall } from "../core/types.js";
import type { BrowserFetcher } from "../adapters/openai-compatible.js";
import type { StateStore } from "../core/types.js";

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

interface ConnectionValues {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface AgentAppOptions {
  readonly plugins?: readonly Plugin[];
  readonly initialModelId?: string;
}

export class AgentApp {
  private readonly root: HTMLElement;
  private readonly options: AgentAppOptions;
  private readonly runtime = new BrowserWorkerRuntime();
  private chat: ChatState = createChatState();
  private store!: StateStore;
  private capabilities!: CapabilityManager;
  private tools!: ToolRegistry;
  private plugins!: PluginManager;
  private agent!: Agent;
  private localHandle: PluginHandle | undefined;
  private remoteHandle: PluginHandle | undefined;
  private runtimeHandle: PluginHandle | undefined;
  private storageHandle: PluginHandle | undefined;
  private readonly extensionHandles: PluginHandle[] = [];
  private uiCleanup: (() => void) | undefined;
  private activeModelLabel = "Offline assistant";
  private ready = false;
  private busy = false;
  private runController: AbortController | undefined;
  private pendingText = "";
  private pendingTool: ToolCall | undefined;
  private chatRenderScheduled = false;
  private readonly elements: AppElements;

  constructor(root: HTMLElement, options: AgentAppOptions = {}) {
    this.root = root;
    this.options = options;
    this.elements = {};
  }

  async start(): Promise<void> {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    Object.assign(this.elements, renderShell(this.root));
    this.bindEvents();
    this.chat = createChatState();
    this.store = createBrowserStateStore({ databaseName: "static-web-agent", objectStoreName: "workspace" });
    this.capabilities = new CapabilityManager({
      decide: ({ pluginId, name, reason }) => {
        if (typeof window.confirm !== "function") return false;
        return window.confirm(`Allow “${pluginId}” to use the “${name}” capability?\n\n${reason}`);
      },
    });
    this.capabilities.register("runtime", { provide: () => this.runtime });
    this.capabilities.register("network", {
      provide: (): NetworkCapability => ({ fetch: globalThis.fetch.bind(globalThis) }),
    });
    this.capabilities.register("storage", {
      provide: ({ pluginId }): StorageCapability => {
        const scoped = new PrefixedStateStore(this.store, `plugin:${pluginId}`);
        return {
          get: (key) => scoped.get(key),
          set: (key, value) => scoped.set(key, value),
          remove: (key) => scoped.remove(key),
          keys: () => scoped.keys(),
        };
      },
    });
    this.tools = new ToolRegistry(this.capabilities, { maxInputChars: 16_000, maxOutputChars: 16_000 });
    this.plugins = new PluginManager(this.tools, this.capabilities);
    this.localHandle = await this.plugins.install(createLocalModelPlugin());
    try {
      for (const plugin of this.options.plugins ?? []) this.extensionHandles.push(await this.plugins.install(plugin));
    } catch (error) {
      for (const handle of this.extensionHandles.reverse()) await handle.uninstall();
      await this.localHandle.uninstall();
      this.localHandle = undefined;
      throw error;
    }
    const modelId = this.options.initialModelId ?? "local";
    const model = this.plugins.modelAdapter(modelId) ?? this.plugins.modelAdapter("local");
    if (model === undefined) throw new Error("No model adapter is available.");
    this.activeModelLabel = model.id === "local" ? "Offline assistant" : model.id;
    this.agent = new Agent(model, this.tools);
    this.plugins.subscribe(() => {
      if (this.ready) {
        this.renderTools();
        this.renderHeader();
      }
    });
    this.syncConnectionPanelFromUrl();
    this.normalizeUrl(false);
    this.ready = true;
    this.renderAll();
    this.focusComposer();
  }

  async stop(): Promise<void> {
    this.runController?.abort();
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    if (this.remoteHandle !== undefined) await this.remoteHandle.uninstall();
    if (this.runtimeHandle !== undefined) await this.runtimeHandle.uninstall();
    if (this.storageHandle !== undefined) await this.storageHandle.uninstall();
    for (const handle of this.extensionHandles.reverse()) await handle.uninstall();
    if (this.localHandle !== undefined) await this.localHandle.uninstall();
    this.ready = false;
  }

  private bindEvents(): void {
    this.elements["composer-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendMessage();
    });
    this.elements["message-input"]?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.elements["cancel-button"]?.addEventListener("click", () => this.runController?.abort());
    this.elements["runtime-action"]?.addEventListener("click", () => void this.toggleRuntime());
    this.elements["storage-action"]?.addEventListener("click", () => void this.toggleStorage());
    this.elements["connection-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.connectRemote(event.currentTarget as HTMLFormElement);
    });
    this.elements["use-local"]?.addEventListener("click", () => void this.useLocalModel());
    this.elements["connection-details"]?.addEventListener("toggle", () => {
      const details = this.elements["connection-details"] as HTMLDetailsElement;
      const urlOpen = new URL(window.location.href).searchParams.get("connect") === "1";
      if (details.open !== urlOpen) this.normalizeUrl(true);
    });
    for (const field of ["model-endpoint", "model-name"]) {
      this.elements[field]?.addEventListener("input", () => this.clearFieldError(field));
    }
    window.addEventListener("popstate", () => {
      this.syncConnectionPanelFromUrl();
      this.normalizeUrl(false);
    });
    window.addEventListener("beforeunload", (event) => {
      const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
      if (this.busy || input === undefined || input.value.trim().length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  private normalizeUrl(push: boolean): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    const details = this.elements["connection-details"] as HTMLDetailsElement | undefined;
    if (details?.open === true) url.searchParams.set("connect", "1");
    else url.searchParams.delete("connect");
    if (push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
  }

  private syncConnectionPanelFromUrl(): void {
    const details = this.elements["connection-details"] as HTMLDetailsElement | undefined;
    if (details !== undefined) details.open = new URL(window.location.href).searchParams.get("connect") === "1";
  }

  private clearFieldError(fieldId: string): void {
    const input = this.elements[fieldId] as HTMLInputElement | undefined;
    const error = this.elements[`${fieldId === "model-endpoint" ? "endpoint" : "model"}-error`] as HTMLElement | undefined;
    if (input === undefined || error === undefined) return;
    input.setAttribute("aria-invalid", "false");
    error.textContent = "";
  }

  private setFieldError(fieldId: string, message: string): void {
    const input = this.elements[fieldId] as HTMLInputElement | undefined;
    const error = this.elements[`${fieldId === "model-endpoint" ? "endpoint" : "model"}-error`] as HTMLElement | undefined;
    if (input === undefined || error === undefined) return;
    input.setAttribute("aria-invalid", "true");
    error.textContent = message;
  }

  private connectionValues(form: HTMLFormElement): ConnectionValues | undefined {
    this.clearFieldError("model-endpoint");
    this.clearFieldError("model-name");
    const data = new FormData(form);
    const endpoint = String(data.get("endpoint") ?? "").trim();
    const model = String(data.get("model") ?? "").trim();
    const apiKey = String(data.get("apiKey") ?? "");
    let firstInvalid: HTMLInputElement | undefined;
    if (!endpoint) {
      this.setFieldError("model-endpoint", "Enter the model endpoint.");
      firstInvalid ??= this.elements["model-endpoint"] as HTMLInputElement;
    } else {
      try {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        this.setFieldError("model-endpoint", "Use an http:// or https:// endpoint.");
        firstInvalid ??= this.elements["model-endpoint"] as HTMLInputElement;
      }
    }
    if (!model) {
      this.setFieldError("model-name", "Enter a model name.");
      firstInvalid ??= this.elements["model-name"] as HTMLInputElement;
    }
    if (firstInvalid !== undefined) {
      firstInvalid.focus();
      this.notify("Check the highlighted connection fields.", "error");
      return undefined;
    }
    return { endpoint, model, apiKey };
  }

  private confirmDraft(): boolean {
    const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
    if (input === undefined || input.value.trim().length === 0 || typeof window.confirm !== "function") return true;
    return window.confirm("Discard this unsent draft?");
  }

  private async sendMessage(): Promise<void> {
    if (!this.ready) {
      this.notify("Starting chat…");
      return;
    }
    if (this.busy) return;
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    const rawContent = input.value.trim();
    if (!rawContent) {
      this.notify("Write a message before sending.", "error");
      input.focus();
      return;
    }
    if (rawContent.length > CHAT_LIMITS.maxMessageChars) {
      this.notify(`Messages are limited to ${CHAT_LIMITS.maxMessageChars} characters.`, "error");
      return;
    }

    const controller = new AbortController();
    this.runController = controller;
    this.setBusy(true);
    try {
      const processed = await this.plugins.process({ role: "user", content: rawContent }, controller.signal);
      if (!isMessageEnvelope(processed) || processed.role !== "user" || typeof processed.content !== "string") {
        throw new Error("A message processor must return a user message.");
      }
      const content = processed.content.trim();
      if (!content || content.length > CHAT_LIMITS.maxMessageChars) throw new Error("The processed message is empty or too large.");
      this.chat.messages = normalizeMessages([...this.chat.messages, { role: "user", content }]);
      input.value = "";
      this.pendingText = "";
      this.pendingTool = undefined;
      this.renderAll();
      const result = await this.agent.run({
        messages: this.chat.messages,
        signal: controller.signal,
        maxTurns: 8,
        toolTimeoutMs: 10_000,
        limits: {
          maxMessages: CHAT_LIMITS.maxMessages,
          maxMessageChars: CHAT_LIMITS.maxMessageChars,
          maxRequestChars: CHAT_LIMITS.maxConversationChars,
          maxToolOutputChars: 16_000,
          maxToolCallsPerTurn: 16,
        },
        onEvent: (event) => this.handleAgentEvent(event),
      });
      this.chat.messages = normalizeMessages(result.messages);
      if (result.status === "completed") this.notify("Response complete.", "success");
      else if (result.status === "cancelled") this.notify("Run cancelled.", "error");
      else if (result.status === "max-turns") this.notify("Run stopped at the turn limit.", "error");
      else this.notify(result.error?.message ?? "The model could not complete this run.", "error");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "The run failed.", "error");
    } finally {
      this.pendingText = "";
      this.pendingTool = undefined;
      this.runController = undefined;
      this.setBusy(false);
      this.renderAll();
      this.focusComposer(true);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text-delta":
        this.pendingText += event.delta;
        this.notify("Receiving response…");
        this.scheduleChatRender();
        break;
      case "model-started":
        this.notify(`Thinking · turn ${event.turn}…`);
        break;
      case "tool-started":
        this.pendingTool = event.call;
        this.notify(`Running ${event.call.name}…`);
        this.renderChat();
        break;
      case "tool-finished":
        this.pendingTool = undefined;
        this.notify(event.result.ok ? `Finished ${event.call.name}.` : `${event.call.name} returned an error.`, event.result.ok ? "success" : "error");
        this.renderChat();
        break;
      case "run-error":
        this.notify(event.error.message, "error");
        break;
      case "run-finished":
        this.pendingTool = undefined;
        this.renderChat();
        break;
      case "run-started":
      case "assistant-message":
        break;
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    const send = this.elements["send-button"] as HTMLButtonElement;
    const cancel = this.elements["cancel-button"] as HTMLButtonElement;
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    send.disabled = value;
    send.setAttribute("aria-busy", String(value));
    cancel.hidden = !value;
    input.disabled = value;
    const spinner = send.querySelector<HTMLElement>(".spinner");
    if (spinner !== null) spinner.hidden = !value;
    this.renderTools();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.elements[id];
    if (element === undefined) throw new Error(`UI element “${id}” is missing.`);
    return element as T;
  }

  private renderAll(): void {
    this.renderHeader();
    this.renderChat();
    this.renderTools();
  }

  private renderHeader(): void {
    this.element("conversation-title").textContent = "Chat";
    this.element("conversation-meta").textContent = `${this.chat.messages.length} message${this.chat.messages.length === 1 ? "" : "s"} · clears on refresh`;
    this.element("model-chip").replaceChildren(textElement("span", "Model · "), textElement("strong", this.activeModelLabel));
    document.title = "Static Web Agent";
  }

  private scheduleChatRender(): void {
    if (this.chatRenderScheduled) return;
    this.chatRenderScheduled = true;
    const render = () => {
      this.chatRenderScheduled = false;
      if (this.ready) this.renderChat();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(render);
    else setTimeout(render, 0);
  }

  private renderChat(): void {
    const chat = this.elements["chat-log"];
    if (chat === undefined) return;
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    chat.setAttribute("aria-busy", String(this.busy));
    chat.replaceChildren();
    if (this.chat.messages.length === 0 && this.pendingText.length === 0 && this.pendingTool === undefined) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const icon = textElement("div", "✦", "empty-icon");
      icon.setAttribute("aria-hidden", "true");
      empty.append(icon, textElement("h2", "A quiet place to think."), textElement("p", "Start with /help for offline commands, or connect a model for open-ended answers. This chat clears when you refresh."));
      chat.append(empty);
    } else {
      for (const message of this.chat.messages) chat.append(messageElement(message));
      if (this.pendingText.length > 0) chat.append(messageElement({ role: "assistant", content: this.pendingText }, true));
      if (this.pendingTool !== undefined) {
        const toolMessage: ModelMessage = { role: "tool", callId: this.pendingTool.id, name: this.pendingTool.name, content: `Running ${this.pendingTool.name}…` };
        chat.append(messageElement(toolMessage, true));
      }
    }
    if (nearBottom || this.chat.messages.length === 0) chat.scrollTop = chat.scrollHeight;
  }

  private renderTools(): void {
    if (this.plugins === undefined) return;
    const runtimeAction = this.elements["runtime-action"] as HTMLButtonElement;
    const storageAction = this.elements["storage-action"] as HTMLButtonElement;
    runtimeAction.textContent = this.runtimeHandle === undefined ? "Enable plugin" : "Disable plugin";
    storageAction.textContent = this.storageHandle === undefined ? "Enable plugin" : "Disable plugin";
    runtimeAction.disabled = this.busy;
    storageAction.disabled = this.busy;
    this.element("runtime-card").setAttribute("aria-busy", String(runtimeAction.disabled));
    this.element("storage-card").setAttribute("aria-busy", String(storageAction.disabled));
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    const extensionHost = this.element("extension-host");
    extensionHost.replaceChildren();
    this.uiCleanup = this.plugins.mountUi(extensionHost);
    const list = this.element("tool-list");
    list.replaceChildren();
    const descriptors = this.tools.descriptors();
    for (const descriptor of descriptors) {
      const entry = document.createElement("div");
      entry.className = "tool-entry";
      const name = textElement("strong", descriptor.name, "tool-name");
      name.setAttribute("translate", "no");
      entry.append(name, textElement("span", descriptor.description));
      for (const capability of descriptor.requiredCapabilities) entry.append(textElement("span", `Requires · ${capability}`, "capability-chip"));
      list.append(entry);
    }
    this.element("enabled-count").textContent = String(descriptors.length);
  }

  private async toggleRuntime(): Promise<void> {
    if (!this.ready || this.busy) return;
    const button = this.elements["runtime-action"] as HTMLButtonElement;
    button.disabled = true;
    try {
      if (this.runtimeHandle !== undefined) {
        await this.runtimeHandle.uninstall();
        this.runtimeHandle = undefined;
        this.notify("JavaScript runtime disabled.", "success");
      } else {
        this.runtimeHandle = await this.plugins.install(createJavaScriptRuntimePlugin());
        this.notify("JavaScript runtime enabled.", "success");
      }
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "Could not change the runtime plugin.", "error");
    } finally {
      button.disabled = false;
      this.renderTools();
    }
  }

  private async toggleStorage(): Promise<void> {
    if (!this.ready || this.busy) return;
    const button = this.elements["storage-action"] as HTMLButtonElement;
    button.disabled = true;
    try {
      if (this.storageHandle !== undefined) {
        await this.storageHandle.uninstall();
        this.storageHandle = undefined;
        this.notify("Local storage tool disabled.", "success");
      } else {
        this.storageHandle = await this.plugins.install(createStoragePlugin());
        this.notify("Local storage tool enabled.", "success");
      }
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "Could not change the storage plugin.", "error");
    } finally {
      button.disabled = false;
      this.renderTools();
    }
  }

  private async connectRemote(form: HTMLFormElement): Promise<void> {
    if (!this.ready || this.busy) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const spinner = submit?.querySelector<HTMLElement>(".spinner");
    const values = this.connectionValues(form);
    if (values === undefined) return;
    if (submit !== null && submit !== undefined) submit.disabled = true;
    if (spinner !== null && spinner !== undefined) spinner.hidden = false;
    try {
      if (this.remoteHandle !== undefined) {
        await this.remoteHandle.uninstall();
        this.remoteHandle = undefined;
      }
      const handle = await this.plugins.install(createRemoteModelPlugin(values));
      const adapter = this.plugins.modelAdapter("remote-model");
      if (adapter === undefined) throw new Error("The remote model plugin did not register an adapter.");
      this.remoteHandle = handle;
      this.agent.setModel(adapter);
      this.activeModelLabel = `Remote · ${values.model}`;
      this.element("connection-status").textContent = "Remote model selected. The first message will verify the endpoint; the key remains in memory only.";
      this.renderHeader();
      this.notify("Remote model selected.", "success");
    } catch (error) {
      this.agent.setModel(this.plugins.modelAdapter("local")!);
      this.activeModelLabel = "Offline assistant";
      this.element("connection-status").textContent = error instanceof Error ? error.message : "Could not select the model.";
      this.notify(this.element("connection-status").textContent, "error");
    } finally {
      if (submit !== null && submit !== undefined) submit.disabled = false;
      if (spinner !== null && spinner !== undefined) spinner.hidden = true;
    }
  }

  private async useLocalModel(): Promise<void> {
    if (!this.ready || this.busy) return;
    if (this.remoteHandle !== undefined) {
      await this.remoteHandle.uninstall();
      this.remoteHandle = undefined;
    }
    const local = this.plugins.modelAdapter("local");
    if (local === undefined) {
      this.notify("The offline model is unavailable.", "error");
      return;
    }
    this.agent.setModel(local);
    this.activeModelLabel = "Offline assistant";
    this.element("connection-status").textContent = "Using the offline assistant. No model request leaves this browser.";
    this.renderHeader();
    this.notify("Offline model selected.", "success");
  }

  private notify(message: string, kind: "normal" | "success" | "error" = "normal"): void {
    const status = this.element("run-status");
    status.textContent = message;
    status.className = `status-message ${kind === "normal" ? "" : kind}`;
  }

  private focusComposer(force = false): void {
    if (!force && window.matchMedia("(max-width: 720px)").matches) return;
    queueMicrotask(() => {
      const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
      const active = document.activeElement;
      if (input === undefined || (!force && active !== document.body && active !== this.root)) return;
      input.focus();
    });
  }
}

export async function startApp(root: HTMLElement, options: AgentAppOptions = {}): Promise<AgentApp> {
  const app = new AgentApp(root, options);
  await app.start();
  return app;
}
