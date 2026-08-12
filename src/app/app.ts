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
import { isConnectionSettings, loadConnectionSettings, saveConnectionSettings, type ConnectionSettings } from "./connection-settings.js";
import { messageElement, messageElements, renderShell, streamingToolElement, textElement, toolGroupElement, updateStreamingToolElement, updateToolGroupElement, type AppElements } from "./view.js";
import { renderRichContent } from "./rich-content.js";
import type { AgentEvent, ModelMessage, Plugin, PluginHandle, StorageCapability, ToolCall, ToolCallDelta, ToolExecutionResult } from "../core/types.js";
import type { BrowserFetcher } from "../adapters/ai-sdk.js";
import type { StateStore } from "../core/types.js";

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

interface BrowserCredentialManager {
  readonly get?: (options: { readonly password: true; readonly mediation: "silent" }) => Promise<unknown>;
  readonly store?: (credential: unknown) => Promise<unknown>;
}

interface BrowserPasswordCredentialData {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly password?: unknown;
}

interface BrowserConnectionCredential {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

type LiveToolEntry =
  | { readonly key: string; readonly status: "preparing"; readonly delta: ToolCallDelta }
  | { readonly key: string; readonly status: "running"; readonly call: ToolCall }
  | { readonly key: string; readonly status: "finished"; readonly call: ToolCall; readonly result: ToolExecutionResult };

function browserEndpoint(value: unknown): string {
  if (typeof value !== "string") return "";
  const endpoint = value.trim();
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:" ? endpoint : "";
  } catch {
    return "";
  }
}

function displayModelName(value: string): string {
  return value.trim().replace(/^.*\//, "").replace(/:.*$/, "").replace(/-/g, " ").trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export interface AgentAppOptions {
  readonly plugins?: readonly Plugin[];
  readonly initialModelId?: string;
  readonly autoConnect?: boolean;
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
  private pendingToolCalls: readonly ToolCallDelta[] = [];
  private liveToolEntries: readonly LiveToolEntry[] = [];
  private liveToolSequence = 0;
  private chatRenderScheduled = false;
  private chatScrollScheduled = false;
  private userScrollGesture = false;
  private userScrollGestureTimer: number | undefined;
  private followChat = true;
  private chatObserver: MutationObserver | undefined;
  private renderedMessages: readonly ModelMessage[] | undefined;
  private renderedAgent: Agent | undefined;
  private renderedConnectionEditing = false;
  private connectionEditing = false;
  private autoConnectStarted = false;
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
    const savedSettings = await loadConnectionSettings(this.store);
    this.applyConnectionSettings(savedSettings);
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
    this.normalizeUrl(false);
    this.ready = true;
    this.renderAll();
    this.resizeMessageInput();
    this.focusComposer();
    if (this.options.autoConnect !== false) void this.autoConnect(savedSettings);
  }

  async stop(): Promise<void> {
    this.runController?.abort();
    this.chatObserver?.disconnect();
    this.chatObserver = undefined;
    this.chatScrollScheduled = false;
    if (this.userScrollGestureTimer !== undefined) window.clearTimeout(this.userScrollGestureTimer);
    this.userScrollGestureTimer = undefined;
    this.userScrollGesture = false;
    this.followChat = true;
    this.pendingToolCalls = [];
    this.liveToolEntries = [];
    this.liveToolSequence = 0;
    this.renderedMessages = undefined;
    this.renderedAgent = undefined;
    this.renderedConnectionEditing = false;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    if (this.remoteHandle !== undefined) await this.remoteHandle.uninstall();
    if (this.browserHandle !== undefined) await this.browserHandle.uninstall();
    if (this.runtimeHandle !== undefined) await this.runtimeHandle.uninstall();
    if (this.storageHandle !== undefined) await this.storageHandle.uninstall();
    for (const handle of this.extensionHandles.reverse()) await handle.uninstall();
    this.agent = undefined;
    this.connectionEditing = false;
    this.autoConnectStarted = false;
    this.ready = false;
  }

  private bindEvents(): void {
    this.elements["composer-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.busy) {
        this.runController?.abort();
        return;
      }
      void this.sendMessage();
    });
    const messageInput = this.elements["message-input"] as HTMLTextAreaElement | undefined;
    messageInput?.addEventListener("input", () => this.resizeMessageInput());
    messageInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        const start = messageInput.selectionStart;
        const end = messageInput.selectionEnd;
        messageInput.setRangeText("\n", start, end, "end");
        messageInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (this.busy) this.runController?.abort();
      else void this.sendMessage();
    });
    const chat = this.elements["chat-log"];
    chat?.addEventListener("scroll", () => this.updateChatFollowState(), { passive: true });
    const markUserScroll = () => this.markUserScrollGesture();
    chat?.addEventListener("wheel", markUserScroll, { passive: true });
    chat?.addEventListener("touchmove", markUserScroll, { passive: true });
    chat?.addEventListener("pointerdown", markUserScroll, { passive: true });
    this.elements["scroll-bottom-button"]?.addEventListener("click", () => {
      this.followChat = true;
      this.scrollChatToBottom();
      this.updateScrollButton();
    });
    this.elements["conversation-content"]?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      if (button === null) return;
      const index = Number.parseInt(button.dataset.messageIndex ?? "", 10);
      if (!Number.isInteger(index)) return;
      if (button.dataset.action === "edit-message") this.startMessageEdit(index);
      else if (button.dataset.action === "cancel-edit") this.cancelMessageEdit();
      else if (button.dataset.action === "save-edit") {
        const editor = button.closest<HTMLElement>(".message-edit");
        const input = editor?.querySelector<HTMLTextAreaElement>("textarea");
        if (input !== null && input !== undefined) void this.resendEditedMessage(index, input.value);
      }
    });
    if (chat !== undefined && typeof MutationObserver === "function") {
      this.chatObserver = new MutationObserver(() => {
        if (this.followChat && this.busy) this.scheduleChatScroll();
      });
      this.chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
    }
    this.elements["connection-form"]?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.connectRemote(event.currentTarget as HTMLFormElement);
    });
    for (const field of ["model-endpoint", "model-name"]) {
      this.elements[field]?.addEventListener("input", () => this.clearFieldError(field));
    }
    window.addEventListener("popstate", () => {
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
    url.searchParams.delete("connect");
    if (push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
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
    this.followChat = true;
    this.chatRenderScheduled = false;
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
      this.resizeMessageInput();
      this.pendingText = "";
      this.pendingTool = undefined;
      this.pendingToolCalls = [];
      this.liveToolEntries = [];
      this.liveToolSequence = 0;
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
      this.pendingToolCalls = [];
      this.liveToolEntries = [];
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
        this.pendingToolCalls = [];
        this.notify(`Thinking · turn ${event.turn}…`);
        break;
      case "tool-call-delta": {
        const previous = this.pendingToolCalls.find((delta) => delta.index === event.delta.index);
        const merged: { index: number; id?: string; name?: string; arguments?: string } = { index: event.delta.index };
        const id = event.delta.id ?? previous?.id;
        const name = event.delta.name === undefined && previous?.name === undefined ? undefined : `${previous?.name ?? ""}${event.delta.name ?? ""}`;
        const argumentsValue = event.delta.arguments === undefined && previous?.arguments === undefined ? undefined : `${previous?.arguments ?? ""}${event.delta.arguments ?? ""}`;
        if (id !== undefined) merged.id = id;
        if (name !== undefined) merged.name = name;
        if (argumentsValue !== undefined) merged.arguments = argumentsValue;
        this.pendingToolCalls = [...this.pendingToolCalls.filter((delta) => delta.index !== event.delta.index), merged].sort((left, right) => left.index - right.index);
        const liveEntry = this.liveToolEntries.find((entry) => entry.status === "preparing" && entry.delta.index === merged.index);
        this.replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++this.liveToolSequence}`, status: "preparing", delta: merged });
        this.notify(`${merged.name?.trim() || "Tool"} · preparing…`);
        this.scheduleChatRender();
        break;
      }
      case "tool-started":
        {
          const pendingIndex = this.pendingToolCalls.findIndex((delta) => delta.id === event.call.id || (delta.id === undefined && delta.name === event.call.name));
          if (pendingIndex >= 0) this.pendingToolCalls = this.pendingToolCalls.filter((_, index) => index !== pendingIndex);
        }
        const liveEntry = this.liveToolEntries.find((entry) => entry.status === "preparing" && (entry.delta.id === event.call.id || (entry.delta.id === undefined && entry.delta.name === event.call.name)));
        this.replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++this.liveToolSequence}`, status: "running", call: event.call });
        this.pendingTool = event.call;
        this.notify(`Running ${event.call.name}…`);
        this.renderChat();
        break;
      case "tool-finished":
        {
          const liveEntry = this.liveToolEntries.find((entry) => entry.status === "running" && entry.call.id === event.call.id);
          this.replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++this.liveToolSequence}`, status: "finished", call: event.call, result: event.result });
        }
        this.pendingTool = undefined;
        this.notify(event.result.ok ? `Finished ${event.call.name}.` : `${event.call.name} returned an error.`, event.result.ok ? "success" : "error");
        this.renderChat();
        break;
      case "run-error":
        this.notify(event.error.message, "error");
        break;
      case "run-finished":
        this.pendingTool = undefined;
        this.pendingToolCalls = [];
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
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    send.disabled = false;
    send.setAttribute("aria-busy", String(value));
    send.setAttribute("aria-label", value ? "Stop generation" : "Send message");
    send.classList.toggle("stop-button", value);
    const label = send.querySelector<HTMLElement>(".button-label");
    if (label !== null) label.textContent = value ? "Stop" : "Send";
    input.disabled = value;
    const spinner = send.querySelector<HTMLElement>(".spinner");
    if (spinner !== null) spinner.hidden = true;
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
    if (typeof queueMicrotask === "function") queueMicrotask(render);
    else setTimeout(render, 0);
  }

  private renderChat(): void {
    const chat = this.elements["chat-log"];
    const conversation = this.elements["conversation-content"];
    const connectionCard = this.elements["connection-card"];
    if (chat === undefined || conversation === undefined || connectionCard === undefined) return;
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    if (nearBottom) this.followChat = true;
    chat.setAttribute("aria-busy", String(this.busy));
    connectionCard.hidden = this.agent !== undefined && !this.connectionEditing;
    const fullRender = this.renderedMessages !== this.chat.messages
      || this.renderedAgent !== this.agent
      || this.renderedConnectionEditing !== this.connectionEditing;
    if (fullRender) {
      conversation.replaceChildren();
      if (this.chat.messages.length === 0 && this.pendingText.length === 0 && this.liveToolEntries.length === 0) {
        if (this.agent !== undefined) {
          const welcome = document.createElement("div");
          welcome.className = "empty-state";
          const icon = textElement("div", "✦", "empty-icon");
          icon.setAttribute("aria-hidden", "true");
          const modelName = displayModelName((this.elements["model-name"] as HTMLInputElement | undefined)?.value ?? "") || "Welcome";
          welcome.append(icon, textElement("h2", modelName), textElement("p", "Your cloud model is connected. Ask anything to begin."));
          const change = document.createElement("button");
          change.className = "secondary-button";
          change.type = "button";
          change.textContent = "Change connection";
          change.addEventListener("click", () => {
            this.connectionEditing = true;
            this.renderChat();
            queueMicrotask(() => this.element<HTMLInputElement>("model-endpoint").focus());
          });
          welcome.append(change);
          conversation.append(welcome);
        }
      } else {
        conversation.append(...messageElements(this.chat.messages));
        this.appendPendingMessages(conversation);
      }
      this.renderedMessages = this.chat.messages;
      this.renderedAgent = this.agent;
      this.renderedConnectionEditing = this.connectionEditing;
    } else {
      this.updatePendingMessages(conversation);
    }
    if (this.followChat || this.chat.messages.length === 0) this.scrollChatToBottom();
    this.updateScrollButton();
  }

  private appendPendingMessages(conversation: HTMLElement, openKeys: ReadonlySet<string> = new Set()): void {
    if (this.pendingText.length > 0) {
      const element = messageElement({ role: "assistant", content: this.pendingText }, true);
      if (element !== null) conversation.append(element);
    }
    const pendingTools = this.liveToolEntries.flatMap((entry) => {
      const element = this.createLiveToolElement(entry);
      return element === undefined ? [] : [element];
    });
    if (pendingTools.length > 0) {
      const group = toolGroupElement(pendingTools, true);
      if (openKeys.has("tool-group")) group.open = true;
      conversation.append(group);
    }
  }

  private updatePendingMessages(conversation: HTMLElement): void {
    let pendingAssistant = conversation.querySelector<HTMLElement>(":scope > .message.assistant.pending");
    if (this.pendingText.length > 0) {
      if (pendingAssistant === null) {
        pendingAssistant = messageElement({ role: "assistant", content: this.pendingText }, true);
        if (pendingAssistant !== null) conversation.append(pendingAssistant);
      } else {
        const body = pendingAssistant.querySelector<HTMLElement>(":scope > .message-body");
        if (body !== null) {
          body.replaceChildren();
          renderRichContent(body, this.pendingText);
        }
      }
    } else {
      pendingAssistant?.remove();
      pendingAssistant = null;
    }

    let group = conversation.querySelector<HTMLDetailsElement>(":scope > details.tool-group.pending");
    const existingItems = new Map<string, HTMLDetailsElement>();
    if (group !== null) {
      for (const item of group.querySelectorAll<HTMLDetailsElement>(":scope > .tool-group-body > details.tool-detail")) {
        if (item.dataset.toolKey !== undefined) existingItems.set(item.dataset.toolKey, item);
      }
    }
    const items: HTMLElement[] = [];
    for (const entry of this.liveToolEntries) {
      let item = existingItems.get(entry.key);
      if (item === undefined) item = this.createLiveToolElement(entry);
      if (item === undefined) continue;
      this.updateLiveToolElement(item, entry);
      items.push(item);
      existingItems.delete(entry.key);
    }
    if (items.length === 0) {
      group?.remove();
      return;
    }
    if (group === null) {
      group = toolGroupElement(items, true);
      conversation.append(group);
    } else {
      updateToolGroupElement(group, items, true);
    }
  }

  private replaceLiveToolEntry(entry: LiveToolEntry): void {
    const index = this.liveToolEntries.findIndex((current) => current.key === entry.key);
    this.liveToolEntries = index < 0
      ? [...this.liveToolEntries, entry]
      : this.liveToolEntries.map((current, currentIndex) => currentIndex === index ? entry : current);
  }

  private liveToolResultContent(result: ToolExecutionResult): string {
    return result.ok
      ? JSON.stringify(result.value, null, 2)
      : JSON.stringify({ error: result.error }, null, 2);
  }

  private createLiveToolElement(entry: LiveToolEntry): HTMLDetailsElement | undefined {
    if (entry.status === "preparing") return streamingToolElement(entry.delta, entry.key);
    const content = entry.status === "running" ? `Running ${entry.call.name}…` : this.liveToolResultContent(entry.result);
    const element = messageElement({
      role: "tool",
      callId: entry.call.id,
      name: entry.call.name,
      content,
      isError: entry.status === "finished" && !entry.result.ok,
    }, true);
    return element instanceof HTMLDetailsElement ? element : undefined;
  }

  private updateLiveToolElement(details: HTMLDetailsElement, entry: LiveToolEntry): void {
    if (entry.status === "preparing") {
      updateStreamingToolElement(details, entry.delta, entry.key);
      return;
    }
    details.className = `tool-detail pending${entry.status === "finished" ? " tool-call-complete" : ""}`;
    details.dataset.toolKey = entry.key;
    const summary = details.querySelector<HTMLElement>(":scope > .tool-summary");
    const body = details.querySelector<HTMLElement>(":scope > .tool-detail-body");
    if (summary === null || body === null) return;
    summary.textContent = entry.status === "running"
      ? `${entry.call.name} · running`
      : `${entry.call.name}${entry.result.ok ? " · complete" : " · error"}`;
    body.classList.toggle("tool-error", entry.status === "finished" && !entry.result.ok);
    body.textContent = entry.status === "running" ? `Running ${entry.call.name}…` : this.liveToolResultContent(entry.result);
    details.open = true;
  }

  private updateChatFollowState(): void {
    const chat = this.elements["chat-log"];
    if (chat === undefined) return;
    if (this.busy && this.followChat && !this.userScrollGesture) {
      this.updateScrollButton();
      return;
    }
    this.followChat = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    this.updateScrollButton();
  }

  private markUserScrollGesture(): void {
    this.userScrollGesture = true;
    if (this.userScrollGestureTimer !== undefined) window.clearTimeout(this.userScrollGestureTimer);
    this.userScrollGestureTimer = window.setTimeout(() => {
      this.userScrollGesture = false;
      this.userScrollGestureTimer = undefined;
    }, 250);
  }

  private scrollChatToBottom(): void {
    const chat = this.elements["chat-log"];
    if (chat === undefined) return;
    chat.scrollTop = chat.scrollHeight;
    this.scheduleChatScroll();
    const settle = () => {
      if (!this.followChat) return;
      const currentChat = this.elements["chat-log"];
      if (currentChat !== undefined) currentChat.scrollTop = currentChat.scrollHeight;
      this.updateScrollButton();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(settle);
    setTimeout(settle, 0);
    this.updateScrollButton();
  }

  private updateScrollButton(): void {
    const chat = this.elements["chat-log"];
    const button = this.elements["scroll-bottom-button"];
    if (chat === undefined || button === undefined) return;
    button.hidden = this.followChat || chat.scrollHeight <= chat.clientHeight + 1;
  }

  private resizeMessageInput(): void {
    const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
    if (input === undefined) return;
    input.style.height = "auto";
    input.style.overflowY = "hidden";
    const maxHeight = Number.parseFloat(getComputedStyle(input).maxHeight);
    const height = Number.isFinite(maxHeight) ? Math.min(input.scrollHeight, maxHeight) : input.scrollHeight;
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > height + 1 ? "auto" : "hidden";
  }

  private startMessageEdit(index: number): void {
    if (this.busy) return;
    const message = this.chat.messages[index];
    if (message?.role !== "user") return;
    const article = this.elements["conversation-content"]?.querySelector<HTMLElement>(`.message.user[data-message-index="${index}"]`);
    const body = article?.querySelector<HTMLElement>(":scope > .message-body");
    if (body === null || body === undefined || body.querySelector(".message-edit") !== null) return;
    const editor = document.createElement("div");
    editor.className = "message-edit";
    const input = document.createElement("textarea");
    input.rows = Math.min(8, Math.max(2, message.content.split("\n").length));
    input.value = message.content;
    input.setAttribute("aria-label", "Edit message");
    const actions = document.createElement("div");
    actions.className = "message-edit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.dataset.action = "cancel-edit";
    cancel.dataset.messageIndex = String(index);
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.dataset.action = "save-edit";
    save.dataset.messageIndex = String(index);
    save.textContent = "Send";
    actions.append(cancel, save);
    editor.append(input, actions);
    body.replaceChildren(editor);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelMessageEdit();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.resendEditedMessage(index, input.value);
      }
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  private cancelMessageEdit(): void {
    this.renderedMessages = undefined;
    this.renderChat();
  }

  private async resendEditedMessage(index: number, content: string): Promise<void> {
    if (this.busy) return;
    const message = this.chat.messages[index];
    const next = content.trim();
    if (message?.role !== "user" || next.length === 0) {
      this.notify("Write a message before sending.", "error");
      return;
    }
    this.chat.messages = normalizeMessages(this.chat.messages.slice(0, index));
    this.renderedMessages = undefined;
    this.renderChat();
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    input.value = next;
    await this.sendMessage();
  }

  private scheduleChatScroll(): void {
    if (this.chatScrollScheduled || !this.followChat) return;
    this.chatScrollScheduled = true;
    const scroll = () => {
      this.chatScrollScheduled = false;
      if (this.followChat) {
        const chat = this.elements["chat-log"];
        if (chat !== undefined) chat.scrollTop = chat.scrollHeight;
        this.updateScrollButton();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else setTimeout(scroll, 0);
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

  private async connectRemote(form: HTMLFormElement, automatic = false): Promise<void> {
    if (!this.ready || this.busy) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const spinner = submit?.querySelector<HTMLElement>(".spinner");
    const values = this.connectionValues(form);
    if (values === undefined) return;
    if (automatic) this.element("connection-status").textContent = "Restoring your saved cloud model…";
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
      await this.saveBrowserCredential(values);
      this.connectionEditing = false;
      this.element("connection-status").textContent = "Remote model selected. Connection settings saved in this browser.";
      this.notify("Remote model selected.", "success");
    } catch (error) {
      this.agent = undefined;
      this.connectionEditing = true;
      this.element("connection-status").textContent = error instanceof Error ? error.message : "Could not select the model.";
      this.notify(this.element("connection-status").textContent, "error");
    } finally {
      if (submit !== null && submit !== undefined) submit.disabled = false;
      if (spinner !== null && spinner !== undefined) spinner.hidden = true;
      this.renderChat();
    }
  }

  private async autoConnect(savedSettings: ConnectionSettings | undefined): Promise<void> {
    if (this.autoConnectStarted || !this.ready) return;
    this.autoConnectStarted = true;
    const credentialSettings = await this.readBrowserCredential();
    if (!this.ready || this.agent !== undefined) return;
    const settings = credentialSettings === undefined
      ? savedSettings
      : {
        endpoint: savedSettings?.endpoint || credentialSettings.endpoint,
        model: credentialSettings.model || savedSettings?.model || "",
        apiKey: credentialSettings.apiKey || savedSettings?.apiKey || "",
      };
    if (settings === undefined) return;
    if (!settings.endpoint || !settings.model) return;
    this.applyConnectionSettings(settings);
    const form = this.elements["connection-form"];
    if (!(form instanceof HTMLFormElement)) return;
    if (credentialSettings !== undefined) {
      this.element("credential-status").textContent = "Restoring a saved connection from this browser's password manager.";
    } else {
      this.element("credential-status").textContent = "Restoring a saved connection from this browser's local settings.";
    }
    await this.connectRemote(form, true);
  }

  private browserCredentialManager(): BrowserCredentialManager | undefined {
    const credentials = (navigator as Navigator & { readonly credentials?: unknown }).credentials;
    if (typeof credentials !== "object" || credentials === null) return undefined;
    const manager = credentials as BrowserCredentialManager;
    if (typeof manager.get !== "function" && typeof manager.store !== "function") return undefined;
    return manager;
  }

  private async readBrowserCredential(): Promise<BrowserConnectionCredential | undefined> {
    const credentials = this.browserCredentialManager();
    const get = credentials?.get;
    if (credentials === undefined || get === undefined) return undefined;
    try {
      const value = await get.call(credentials, { password: true, mediation: "silent" });
      if (typeof value !== "object" || value === null) return undefined;
      const data = value as BrowserPasswordCredentialData;
      const id = typeof data.id === "string" ? data.id.trim() : "";
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const apiKey = typeof data.password === "string" ? data.password : "";
      const endpoint = browserEndpoint(name);
      if (id) {
        try {
          const parsed: unknown = JSON.parse(id);
          if (isConnectionSettings(parsed) && parsed.endpoint && parsed.model && parsed.apiKey) return parsed;
        } catch {
          // The browser credential is not using the legacy serialized shape.
        }
      }
      if (id && apiKey && !browserEndpoint(id)) return { endpoint, model: id, apiKey };
      const legacyEndpoint = browserEndpoint(id);
      if (legacyEndpoint && name && apiKey) return { endpoint: legacyEndpoint, model: name, apiKey };
    } catch {
      // Credential Management is optional and may be unavailable in this context.
    }
    return undefined;
  }

  private async saveBrowserCredential(settings: ConnectionSettings): Promise<void> {
    if (!settings.apiKey) return;
    const credentials = this.browserCredentialManager();
    const store = credentials?.store;
    const PasswordCredential = (globalThis as typeof globalThis & {
      readonly PasswordCredential?: new (data: { readonly id: string; readonly name: string; readonly password: string }) => unknown;
    }).PasswordCredential;
    if (credentials === undefined || store === undefined || PasswordCredential === undefined) return;
    try {
      const credential = new PasswordCredential({ id: settings.model, name: settings.endpoint, password: settings.apiKey });
      await store.call(credentials, credential);
      this.element("credential-status").textContent = "Saved the model name as the password-manager username and the API key as the password; endpoint saved locally.";
    } catch {
      // A password manager may reject programmatic storage; local settings remain available.
    }
  }

  private notify(message: string, kind: "normal" | "success" | "error" = "normal"): void {
    const status = this.element("run-status");
    status.textContent = message;
    status.className = `status-message sr-only ${kind === "normal" ? "" : kind}`;
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
