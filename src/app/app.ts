import { Agent } from "../core/agent.js";
import { CapabilityManager } from "../core/capabilities.js";
import { PluginManager } from "../core/plugin-manager.js";
import { BrowserWorkerRuntime } from "../core/runtime.js";
import { isJsonValue } from "../core/schema.js";
import { createBrowserStateStore, MemoryStateStore, PrefixedStateStore } from "../core/state.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { EchoModelAdapter } from "../adapters/echo-model.js";
import { OpenAICompatibleAdapter, type BrowserFetcher } from "../adapters/openai-compatible.js";
import { createJavaScriptRuntimePlugin } from "../plugins/javascript-runtime.js";
import { createStoragePlugin } from "../plugins/storage.js";
import type {
  AgentEvent,
  JsonValue,
  ModelMessage,
  PluginHandle,
  StorageCapability,
  ToolCall,
} from "../core/types.js";
import type { StateStore } from "../core/types.js";

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ModelMessage[];
}

interface ConversationIndexItem {
  id: string;
  title: string;
  updatedAt: number;
}

interface NetworkCapability {
  readonly fetch: BrowserFetcher;
}

interface ConnectionValues {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCall(value: unknown): ToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isJsonValue(value.arguments)) return undefined;
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function parseMessage(value: unknown): ModelMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string") return undefined;
  if ((value.role === "system" || value.role === "user") && typeof value.content === "string") {
    return { role: value.role, content: value.content };
  }
  if (value.role === "assistant" && typeof value.content === "string") {
    if (value.toolCalls === undefined) return { role: "assistant", content: value.content };
    if (!Array.isArray(value.toolCalls)) return undefined;
    const toolCalls = value.toolCalls.map(parseToolCall);
    if (toolCalls.some((call) => call === undefined)) return undefined;
    return { role: "assistant", content: value.content, toolCalls: toolCalls as ToolCall[] };
  }
  if (value.role === "tool" && typeof value.callId === "string" && typeof value.name === "string" && typeof value.content === "string") {
    return value.isError === true
      ? { role: "tool", callId: value.callId, name: value.name, content: value.content, isError: true }
      : { role: "tool", callId: value.callId, name: value.name, content: value.content };
  }
  return undefined;
}

function parseMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  const messages = value.map(parseMessage);
  return messages.every((message): message is ModelMessage => message !== undefined) ? messages : [];
}

function parseConversation(value: unknown): Conversation | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number" || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages: parseMessages(value.messages),
  };
}

function parseIndex(value: unknown): ConversationIndexItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) return [];
    return [{ id: item.id, title: item.title, updatedAt: item.updatedAt }];
  });
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function conversationValue(conversation: Conversation): JsonValue {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages as unknown as JsonValue,
  };
}

function titleFor(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact || "New session";
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function textElement(tag: keyof HTMLElementTagNameMap, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  return element;
}

export class AgentApp {
  private readonly root: HTMLElement;
  private store!: StateStore;
  private capabilities!: CapabilityManager;
  private tools!: ToolRegistry;
  private plugins!: PluginManager;
  private agent!: Agent;
  private readonly runtime = new BrowserWorkerRuntime();
  private readonly echo = new EchoModelAdapter();
  private conversations = new Map<string, Conversation>();
  private activeId = "";
  private runtimeHandle: PluginHandle | undefined;
  private storageHandle: PluginHandle | undefined;
  private activeModelLabel = "Local demo";
  private ready = false;
  private busy = false;
  private runController: AbortController | undefined;
  private pendingText = "";
  private pendingTool: ToolCall | undefined;
  private chatRenderScheduled = false;
  private readonly elements: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    this.renderShell();
    this.bindEvents();
    this.store = createBrowserStateStore({ databaseName: "static-web-agent", objectStoreName: "workspace" });
    this.capabilities = new CapabilityManager({
      decide: ({ pluginId, name, reason }) => {
        if (typeof window.confirm !== "function") return false;
        return window.confirm(`Allow “${pluginId}” to use the “${name}” capability?\n\n${reason}`);
      },
    });
    this.capabilities.register("runtime", { provide: () => this.runtime });
    this.capabilities.register("network", { provide: () => ({ fetch: globalThis.fetch.bind(globalThis) }) });
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
    this.agent = new Agent(this.echo, this.tools);
    await this.loadConversations();
    this.ready = true;
    this.renderAll();
    this.focusComposer();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar" aria-label="Workspace navigation">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">∿</div>
            <div>
              <div class="brand-name" translate="no">Static Web Agent</div>
              <p class="brand-subtitle">Browser-native workspace</p>
            </div>
          </div>
          <button class="primary-button new-session" id="new-session" type="button">＋ New session</button>
          <section class="sidebar-section" aria-labelledby="sessions-heading">
            <div class="section-heading"><h2 id="sessions-heading">Sessions</h2><span class="count" id="session-count">0</span></div>
            <ul class="session-list" id="session-list"></ul>
          </section>
          <div class="sidebar-footer">
            <div class="storage-status"><span class="status-dot" aria-hidden="true"></span><span id="storage-label">Local state</span></div>
            <span>Nothing leaves this browser unless you connect a model.</span>
          </div>
        </aside>

        <main class="workspace" id="main-content" tabindex="-1">
          <header class="topbar">
            <div class="title-wrap">
              <h1 id="conversation-title">New session</h1>
              <p id="conversation-meta">Local-first conversation</p>
            </div>
            <div class="topbar-actions">
              <span class="model-chip" id="model-chip">Model · <strong>Local demo</strong></span>
            </div>
          </header>

          <details class="connection-details" id="connection-details">
            <summary>Connect a model adapter</summary>
            <form class="connection-form" id="connection-form" novalidate>
              <div class="field">
                <label for="model-endpoint">OpenAI-compatible endpoint</label>
                <input id="model-endpoint" name="endpoint" type="url" inputmode="url" autocomplete="url" aria-describedby="endpoint-error" aria-invalid="false" placeholder="https://provider.example/v1/chat/completions…" />
                <p class="field-error" id="endpoint-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-name">Model</label>
                <input id="model-name" name="model" type="text" inputmode="text" autocomplete="off" aria-describedby="model-error" aria-invalid="false" placeholder="model-name…" />
                <p class="field-error" id="model-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-key">API key <span class="faint">(session only)</span></label>
                <input id="model-key" name="apiKey" type="password" autocomplete="new-password" aria-describedby="key-help" placeholder="Paste a key…" />
                <p class="field-help" id="key-help">Accepted by the endpoint, never saved here.</p>
              </div>
              <button class="primary-button" type="submit"><span class="button-content"><span class="button-label">Use remote</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
              <button class="secondary-button" id="use-local" type="button">Use local</button>
              <p class="connection-note">Requests go directly from this page to the endpoint. The endpoint must permit browser CORS; the API key is never persisted.</p>
              <p class="connection-status" id="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
            </form>
          </details>

          <section class="chat-scroll" id="chat-log" aria-label="Conversation" aria-busy="true">
            <div class="loading-state" role="status" aria-live="polite">
              <span class="loading-line loading-line-wide" aria-hidden="true"></span>
              <span class="loading-line loading-line-short" aria-hidden="true"></span>
              <span class="loading-label">Loading local sessions…</span>
            </div>
          </section>
          <div class="composer-wrap">
            <form class="composer" id="composer-form">
              <label class="sr-only" for="message-input">Message the agent</label>
              <textarea id="message-input" name="message" rows="3" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true"></textarea>
              <button class="primary-button send-button" id="send-button" type="submit" aria-label="Send message"><span class="button-content"><span class="button-label">Send</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
              <div class="composer-actions">
                <p class="composer-hint">Enter adds a line · ⌘/Ctrl&nbsp;+&nbsp;Enter sends</p>
                <button class="secondary-button danger cancel-button" id="cancel-button" type="button" hidden>Cancel run</button>
              </div>
              <p class="status-message" id="run-status" role="status" aria-live="polite" aria-atomic="true"></p>
            </form>
          </div>
        </main>

        <aside class="tools-panel" aria-label="Runtime surface">
          <div class="panel-heading"><h2>Capabilities</h2><span class="count" id="enabled-count">0</span></div>
          <p class="panel-intro">Tools are plugins. Each plugin is off until you enable it and approve its browser capabilities.</p>
          <div class="permission-card" id="runtime-card">
            <h3>JavaScript runtime</h3>
            <p>Run small transformations in a time-limited worker. No agent capability objects are passed in.</p>
            <button class="secondary-button" id="runtime-action" type="button">Enable plugin</button>
          </div>
          <div class="permission-card" id="storage-card">
            <h3>Local storage tool</h3>
            <p>Give the agent a namespaced key-value store backed by this browser's local state.</p>
            <button class="secondary-button" id="storage-action" type="button">Enable plugin</button>
          </div>
          <div class="tool-list" id="tool-list" aria-label="Enabled tools"></div>
        </aside>
      </div>
    `;
    for (const element of this.root.querySelectorAll<HTMLElement>("[id]")) this.elements[element.id] = element;
  }

  private bindEvents(): void {
    this.elements["new-session"]?.addEventListener("click", () => void this.createSession());
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
    this.elements["use-local"]?.addEventListener("click", () => this.useLocalModel());
    this.elements["connection-details"]?.addEventListener("toggle", () => {
      const details = this.elements["connection-details"] as HTMLDetailsElement;
      const urlOpen = new URL(window.location.href).searchParams.get("connect") === "1";
      if (details.open !== urlOpen) this.updateUrl(true);
    });
    for (const field of ["model-endpoint", "model-name"]) {
      this.elements[field]?.addEventListener("input", () => this.clearFieldError(field));
    }
    window.addEventListener("popstate", () => void this.selectFromUrl());
    window.addEventListener("beforeunload", (event) => {
      const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
      if (this.busy || input === undefined || input.value.trim().length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  private async loadConversations(): Promise<void> {
    const index = parseIndex(await this.store.get("conversations:index"));
    for (const item of index) {
      const conversation = parseConversation(await this.store.get(`conversation:${item.id}`));
      if (conversation !== undefined) this.conversations.set(conversation.id, conversation);
    }
    if (this.conversations.size === 0) {
      const conversation = this.makeConversation();
      this.conversations.set(conversation.id, conversation);
      await this.persist(conversation);
    }
    const requested = new URLSearchParams(window.location.search).get("session");
    this.activeId = requested !== null && this.conversations.has(requested) ? requested : this.sortedConversations()[0]?.id ?? "";
    this.syncConnectionPanelFromUrl();
    this.updateUrl(false);
  }

  private makeConversation(): Conversation {
    const timestamp = Date.now();
    return { id: newId(), title: "New session", createdAt: timestamp, updatedAt: timestamp, messages: [] };
  }

  private async persist(conversation: Conversation): Promise<void> {
    conversation.updatedAt = Date.now();
    this.conversations.set(conversation.id, conversation);
    await this.store.set(`conversation:${conversation.id}`, conversationValue(conversation));
    const index = this.sortedConversations().map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
    await this.store.set("conversations:index", index as unknown as JsonValue);
  }

  private sortedConversations(): Conversation[] {
    return [...this.conversations.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private activeConversation(): Conversation {
    const conversation = this.conversations.get(this.activeId);
    if (conversation === undefined) throw new Error("Active session is unavailable.");
    return conversation;
  }

  private async createSession(): Promise<void> {
    if (!this.ready || this.busy || !this.confirmDraft()) return;
    const conversation = this.makeConversation();
    this.conversations.set(conversation.id, conversation);
    this.activeId = conversation.id;
    await this.persist(conversation);
    this.updateUrl(true);
    this.renderAll();
    this.notify("New session ready.", "success");
    this.focusComposer(true);
  }

  private async selectFromUrl(): Promise<void> {
    if (!this.ready) return;
    this.syncConnectionPanelFromUrl();
    const requested = new URLSearchParams(window.location.search).get("session");
    if (requested === this.activeId) return;
    if (requested === null || !this.conversations.has(requested)) {
      this.updateUrl(false);
      return;
    }
    if (this.busy || !this.confirmDraft()) {
      this.updateUrl(false);
      return;
    }
    this.activeId = requested;
    this.pendingText = "";
    this.pendingTool = undefined;
    this.renderAll();
    this.focusComposer(true);
  }

  private async selectSession(id: string): Promise<void> {
    if (!this.ready || this.busy || !this.conversations.has(id) || id === this.activeId || !this.confirmDraft()) return;
    this.activeId = id;
    this.pendingText = "";
    this.pendingTool = undefined;
    this.updateUrl(true);
    this.renderAll();
    this.focusComposer(true);
  }

  private updateUrl(push: boolean): void {
    const url = new URL(window.location.href);
    url.searchParams.set("session", this.activeId);
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
      this.notify("Loading local sessions…");
      return;
    }
    if (this.busy) return;
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    const content = input.value.trim();
    if (!content) {
      this.notify("Write a message before sending.", "error");
      input.focus();
      return;
    }

    const conversation = this.activeConversation();
    conversation.messages = [...conversation.messages, { role: "user", content }];
    if (conversation.messages.filter((message) => message.role === "user").length === 1) conversation.title = titleFor(content);
    input.value = "";
    this.pendingText = "";
    this.pendingTool = undefined;
    try {
      await this.persist(conversation);
    } catch (error) {
      this.notify(error instanceof Error ? `State could not be persisted: ${error.message}` : "State could not be persisted.", "error");
    }
    this.setBusy(true);
    this.renderAll();
    const controller = new AbortController();
    this.runController = controller;
    try {
      const result = await this.agent.run({
        messages: conversation.messages,
        signal: controller.signal,
        maxTurns: 8,
        toolTimeoutMs: 10_000,
        onEvent: (event) => this.handleAgentEvent(event),
      });
      conversation.messages = [...result.messages];
      await this.persist(conversation);
      if (result.status === "completed") this.notify("Response complete.", "success");
      else if (result.status === "cancelled") this.notify("Run cancelled. The conversation was saved.", "error");
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
        this.notify("Thinking…");
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
    this.renderSessions();
    this.renderTools();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.elements[id];
    if (element === undefined) throw new Error(`UI element “${id}” is missing.`);
    return element as T;
  }

  private renderAll(): void {
    this.renderSessions();
    this.renderHeader();
    this.renderChat();
    this.renderTools();
    this.element("storage-label").textContent = this.store instanceof MemoryStateStore ? "Session state · memory" : "Local state · IndexedDB";
  }

  private renderHeader(): void {
    const conversation = this.activeConversation();
    this.element("conversation-title").textContent = conversation.title;
    this.element("conversation-meta").textContent = `${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"} · updated ${formatTime(conversation.updatedAt)}`;
    this.element("model-chip").replaceChildren(textElement("span", "Model · "), textElement("strong", this.activeModelLabel));
    document.title = `${conversation.title} · Static Web Agent`;
  }

  private renderSessions(): void {
    const list = this.elements["session-list"];
    if (list === undefined) return;
    list.replaceChildren();
    for (const conversation of this.sortedConversations()) {
      const item = document.createElement("li");
      item.className = "session-item";
      const button = document.createElement("button");
      button.className = "session-button";
      button.type = "button";
      button.textContent = conversation.title;
      button.title = `${conversation.title} · ${formatTime(conversation.updatedAt)}`;
      button.setAttribute("aria-current", conversation.id === this.activeId ? "page" : "false");
      button.disabled = this.busy;
      button.addEventListener("click", () => void this.selectSession(conversation.id));
      item.append(button);
      list.append(item);
    }
    this.element("session-count").textContent = String(this.conversations.size);
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
    const conversation = this.activeConversation();
    if (conversation.messages.length === 0 && this.pendingText.length === 0 && this.pendingTool === undefined) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const icon = textElement("div", "✦", "empty-icon");
      icon.setAttribute("aria-hidden", "true");
      empty.append(icon, textElement("h2", "A quiet place to think."), textElement("p", "Start with a question, a draft, or a small task. Your sessions stay in this browser by default."));
      chat.append(empty);
    } else {
      for (const message of conversation.messages) chat.append(this.messageElement(message));
      if (this.pendingText.length > 0) chat.append(this.messageElement({ role: "assistant", content: this.pendingText }, true));
      if (this.pendingTool !== undefined) {
        const toolMessage: ModelMessage = { role: "tool", callId: this.pendingTool.id, name: this.pendingTool.name, content: `Running ${this.pendingTool.name}…` };
        chat.append(this.messageElement(toolMessage, true));
      }
    }
    if (nearBottom || conversation.messages.length === 0) chat.scrollTop = chat.scrollHeight;
  }

  private messageElement(message: ModelMessage, pending = false): HTMLElement {
    const article = document.createElement("article");
    article.className = `message ${message.role}${pending ? " pending" : ""}`;
    const header = document.createElement("div");
    header.className = "message-header";
    header.textContent = message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : message.role === "tool" ? message.name : "System";
    if (message.role === "tool") header.setAttribute("translate", "no");
    article.append(header);
    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "tool" && message.isError === true) body.classList.add("tool-error");
    body.textContent = message.content;
    article.append(body);
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const calls = document.createElement("div");
      calls.className = "tool-call-list";
      for (const call of message.toolCalls) {
        const tag = textElement("span", call.name, "tool-call-tag");
        tag.setAttribute("translate", "no");
        calls.append(tag);
      }
      article.append(calls);
    }
    return article;
  }

  private renderTools(): void {
    if (this.plugins === undefined) return;
    const runtimeAction = this.elements["runtime-action"] as HTMLButtonElement;
    const storageAction = this.elements["storage-action"] as HTMLButtonElement;
    runtimeAction.textContent = this.runtimeHandle === undefined ? "Enable plugin" : "Disable plugin";
    storageAction.textContent = this.storageHandle === undefined ? "Enable plugin" : "Disable plugin";
    runtimeAction.disabled = this.busy;
    storageAction.disabled = this.busy;
    const runtimeCard = this.element("runtime-card");
    const storageCard = this.element("storage-card");
    runtimeCard.setAttribute("aria-busy", String(runtimeAction.disabled));
    storageCard.setAttribute("aria-busy", String(storageAction.disabled));
    const list = this.element("tool-list");
    list.replaceChildren();
    for (const descriptor of this.tools.descriptors()) {
      const entry = document.createElement("div");
      entry.className = "tool-entry";
      const name = textElement("strong", descriptor.name, "tool-name");
      name.setAttribute("translate", "no");
      entry.append(name, textElement("span", descriptor.description));
      for (const capability of descriptor.requiredCapabilities) entry.append(textElement("span", `Requires · ${capability}`, "capability-chip"));
      list.append(entry);
    }
    this.element("enabled-count").textContent = String(this.tools.descriptors().length);
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
    if (!this.ready) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const spinner = submit?.querySelector<HTMLElement>(".spinner");
    const values = this.connectionValues(form);
    if (values === undefined) return;
    const { endpoint, model, apiKey } = values;
    if (submit !== null && submit !== undefined) submit.disabled = true;
    if (spinner !== null && spinner !== undefined) spinner.hidden = false;
    try {
      await this.capabilities.request("model-client", [{ name: "network", reason: "Send conversation messages to the configured model endpoint." }]);
      const network = await this.capabilities.get<NetworkCapability>("model-client", "network");
      const adapter = new OpenAICompatibleAdapter({ endpoint, model, apiKey, fetcher: network.fetch });
      this.agent.setModel(adapter);
      this.activeModelLabel = `Remote · ${model}`;
      this.element("connection-status").textContent = "Connected for this tab. The key remains in memory only.";
      this.renderHeader();
      this.notify("Remote model selected.", "success");
    } catch (error) {
      this.element("connection-status").textContent = error instanceof Error ? error.message : "Could not connect the model.";
      this.notify(this.element("connection-status").textContent, "error");
    } finally {
      if (submit !== null && submit !== undefined) submit.disabled = false;
      if (spinner !== null && spinner !== undefined) spinner.hidden = true;
    }
  }

  private useLocalModel(): void {
    if (!this.ready || this.busy) return;
    this.agent.setModel(this.echo);
    this.capabilities.revoke("model-client");
    this.activeModelLabel = "Local demo";
    this.element("connection-status").textContent = "Using the offline local demo model.";
    this.renderHeader();
    this.notify("Local model selected.", "success");
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

export async function startApp(root: HTMLElement): Promise<void> {
  const app = new AgentApp(root);
  await app.start();
}