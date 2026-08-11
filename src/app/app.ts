import { Agent } from "../core/agent.js";
import { CapabilityManager } from "../core/capabilities.js";
import { BrowserPageRuntime } from "../core/page-runtime.js";
import { PluginManager } from "../core/plugin-manager.js";
import { BrowserWorkerRuntime } from "../core/runtime.js";
import { createBrowserStateStore, PrefixedStateStore } from "../core/state.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { createJavaScriptRuntimePlugin } from "../plugins/javascript-runtime.js";
import { createBrowserApiPlugin } from "../plugins/browser-api.js";
import { createRemoteModelPlugin } from "../plugins/remote-model.js";
import { createStoragePlugin } from "../plugins/storage.js";
import { createChatState, isMessageEnvelope, normalizeMessages, type ChatState } from "./chat.js";
import { loadConnectionSettings, saveConnectionSettings, type ConnectionSettings } from "./connection-settings.js";
import { messageElement, renderShell, textElement, type AppElements } from "./view.js";
import type { AgentEvent, ModelMessage, Plugin, PluginHandle, StorageCapability, ToolCall } from "../core/types.js";
import type { BrowserFetcher } from "../adapters/openai-compatible.js";
import type { StateStore } from "../core/types.js";

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

export interface AgentAppOptions {
  readonly plugins?: readonly Plugin[];
  readonly initialModelId?: string;
}

export class AgentApp {
  private readonly root: HTMLElement;
  private readonly options: AgentAppOptions;
  private readonly runtime = new BrowserWorkerRuntime();
  private readonly pageRuntime = new BrowserPageRuntime();
  private chat: ChatState = createChatState();
  private store!: StateStore;
  private capabilities!: CapabilityManager;
  private tools!: ToolRegistry;
  private plugins!: PluginManager;
  private agent: Agent | undefined;
  private remoteHandle: PluginHandle | undefined;
  private runtimeHandle: PluginHandle | undefined;
  private storageHandle: PluginHandle | undefined;
  private browserHandle: PluginHandle | undefined;
  private readonly extensionHandles: PluginHandle[] = [];
  private uiCleanup: (() => void) | undefined;
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
    this.applyConnectionSettings(await loadConnectionSettings(this.store));
    this.capabilities = new CapabilityManager({ decide: () => true });
    this.capabilities.register("runtime", { provide: () => this.runtime });
    this.capabilities.register("network", {
      provide: (): NetworkCapability => ({ fetch: globalThis.fetch.bind(globalThis) }),
    });
    this.capabilities.register("page", { provide: () => this.pageRuntime });
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
    this.tools = new ToolRegistry(this.capabilities);
    this.plugins = new PluginManager(this.tools, this.capabilities);
    try {
      this.runtimeHandle = await this.plugins.install(createJavaScriptRuntimePlugin());
      this.storageHandle = await this.plugins.install(createStoragePlugin());
      this.browserHandle = await this.plugins.install(createBrowserApiPlugin());
      for (const plugin of this.options.plugins ?? []) this.extensionHandles.push(await this.plugins.install(plugin));
    } catch (error) {
      if (this.storageHandle !== undefined) await this.storageHandle.uninstall();
      this.storageHandle = undefined;
      if (this.browserHandle !== undefined) await this.browserHandle.uninstall();
      this.browserHandle = undefined;
      if (this.runtimeHandle !== undefined) await this.runtimeHandle.uninstall();
      this.runtimeHandle = undefined;
      for (const handle of this.extensionHandles.reverse()) await handle.uninstall();
      throw error;
    }
    const model = this.options.initialModelId === undefined ? undefined : this.plugins.modelAdapter(this.options.initialModelId);
    if (this.options.initialModelId !== undefined && model === undefined) throw new Error(`Model adapter “${this.options.initialModelId}” is not available.`);
    if (model !== undefined) this.agent = new Agent(model, this.tools);
    this.plugins.subscribe(() => {
      if (this.ready) {
        this.renderExtensions();
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
    if (this.browserHandle !== undefined) await this.browserHandle.uninstall();
    if (this.runtimeHandle !== undefined) await this.runtimeHandle.uninstall();
    if (this.storageHandle !== undefined) await this.storageHandle.uninstall();
    for (const handle of this.extensionHandles.reverse()) await handle.uninstall();
    this.agent = undefined;
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
    this.elements["connection-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.connectRemote(event.currentTarget as HTMLFormElement);
    });
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

  private applyConnectionSettings(settings: ConnectionSettings | undefined): void {
    if (settings === undefined) return;
    const endpoint = this.elements["model-endpoint"] as HTMLInputElement | undefined;
    const model = this.elements["model-name"] as HTMLInputElement | undefined;
    const apiKey = this.elements["model-key"] as HTMLInputElement | undefined;
    if (endpoint !== undefined) endpoint.value = settings.endpoint;
    if (model !== undefined) model.value = settings.model;
    if (apiKey !== undefined) apiKey.value = settings.apiKey;
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

  private connectionValues(form: HTMLFormElement): ConnectionSettings | undefined {
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
    const agent = this.agent;
    if (agent === undefined) {
      this.notify("Connect a remote model before sending.", "error");
      return;
    }
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    const rawContent = input.value.trim();
    if (!rawContent) {
      this.notify("Write a message before sending.", "error");
      input.focus();
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
      if (!content) throw new Error("The processed message is empty.");
      this.chat.messages = normalizeMessages([...this.chat.messages, { role: "user", content }]);
      input.value = "";
      this.pendingText = "";
      this.pendingTool = undefined;
      this.renderAll();
      const result = await agent.run({
        messages: this.chat.messages,
        signal: controller.signal,
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
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.elements[id];
    if (element === undefined) throw new Error(`UI element “${id}” is missing.`);
    return element as T;
  }

  private renderAll(): void {
    this.renderChat();
    this.renderExtensions();
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
      empty.append(icon, textElement("h2", "A quiet place to think."), textElement("p", "Connect a model to start chatting. This chat clears when you refresh."));
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

  private renderExtensions(): void {
    if (this.plugins === undefined) return;
    const extensionHost = this.elements["extension-host"];
    if (extensionHost === undefined) return;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    extensionHost.replaceChildren();
    this.uiCleanup = this.plugins.mountUi(extensionHost);
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
      this.agent = undefined;
      const handle = await this.plugins.install(createRemoteModelPlugin(values));
      const adapter = this.plugins.modelAdapter("remote-model");
      if (adapter === undefined) throw new Error("The remote model plugin did not register an adapter.");
      this.remoteHandle = handle;
      this.agent = new Agent(adapter, this.tools);
      await saveConnectionSettings(this.store, values);
      this.element("connection-status").textContent = "Remote model selected. Connection settings saved in this browser.";
      this.notify("Remote model selected.", "success");
    } catch (error) {
      this.agent = undefined;
      this.element("connection-status").textContent = error instanceof Error ? error.message : "Could not select the model.";
      this.notify(this.element("connection-status").textContent, "error");
    } finally {
      if (submit !== null && submit !== undefined) submit.disabled = false;
      if (spinner !== null && spinner !== undefined) spinner.hidden = true;
    }
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
