import { createHarness, type Harness } from "../harness.js";
import type { AgentEvent, ModelMessage, ToolCall, ToolCallDelta, ToolExecutionResult } from "../core/types.js";
import { createModelConnection, type ModelConnection } from "./model-connection.js";
import { loadConnectionSettings, validateConnectionDraft, type ConnectionSettings } from "./connection-settings.js";
import { isVisibleAgentEvent, messageElements, renderShell, streamingElement, textElement, type AppElements, type StreamTool, type StreamView } from "./view.js";

const STREAM_RENDER_INTERVAL_MS = 32;

interface StreamState {
  text: string;
  tools: StreamTool[];
  error?: string;
  stopped?: boolean;
}

interface RetainedStream {
  readonly afterMessageIndex: number;
  readonly stream: StreamState;
}

function displayModelName(value: string): string {
  const name = value.trim().replace(/^.*\//, "").replace(/:.*$/, "").replace(/-/g, " ");
  const display = name.split(/\s+/).filter(Boolean).map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
  if (!display) return "Connected model";
  const characters = Array.from(display);
  return characters.length > 48 ? `${characters.slice(0, 47).join("").trimEnd()}…` : display;
}

function copyable(message: ModelMessage): string | undefined {
  return message.role === "system" || message.role === "tool" ? undefined : message.content;
}

function asErrorMessage(value: unknown): string {
  try {
    const message = value instanceof Error ? value.message : undefined;
    return typeof message === "string" && message.length > 0 ? message : "Operation failed.";
  } catch {
    return "Operation failed.";
  }
}

export interface AgentAppOptions {
  readonly autoConnect?: boolean;
}

export class AgentApp {
  private readonly root: HTMLElement;
  private readonly options: AgentAppOptions;
  private readonly elements: AppElements = {};
  private messages: ModelMessage[] = [];
  private harness: Harness | undefined;
  private modelConnection: ModelConnection | undefined;
  private eventController: AbortController | undefined;
  private runController: AbortController | undefined;
  private stream: StreamState | undefined;
  private ready = false;
  private busy = false;
  private connecting = false;
  private editingIndex: number | undefined;
  private connectionEditing = false;
  private connectedSettings: ConnectionSettings | undefined;
  private connectedModelName: string | undefined;
  private lifecycleGeneration = 0;
  private renderScheduled = false;
  private renderFrame: number | undefined;
  private renderTimer: number | undefined;
  private runStatus = "";
  private runStatusKind: "normal" | "success" | "error" = "normal";
  private connectionRunStatusBeforeEdit: { message: string; kind: "normal" | "success" | "error" } | undefined;
  private runRevision = 0;
  private connectionRunRevisionBeforeEdit: number | undefined;
  private messageEditRunStatusBefore: { message: string; kind: "normal" | "success" | "error" } | undefined;
  private followChat = true;
  private retainedStreams: RetainedStream[] = [];
  private streamAnchor: number | undefined;
  private renderedMessages: readonly ModelMessage[] | undefined;
  private renderedConnected: boolean | undefined;
  private renderedConnectedModelName: string | undefined;
  private renderedEditingIndex: number | undefined;
  private renderedRetainedStreams: readonly RetainedStream[] | undefined;
  private liveElement: HTMLElement | undefined;
  private connectionScrollTop: number | undefined;
  private connectionFollowChat: boolean | undefined;

  constructor(root: HTMLElement, options: AgentAppOptions = {}) {
    this.root = root;
    this.options = options;
  }

  get runtime(): Harness | undefined {
    return this.harness;
  }

  async start(): Promise<void> {
    if (this.ready || this.harness !== undefined || this.eventController !== undefined) await this.stop();
    const generation = ++this.lifecycleGeneration;
    Object.assign(this.elements, renderShell(this.root));
    this.messages = [];
    this.stream = undefined;
    this.retainedStreams = [];
    this.streamAnchor = undefined;
    this.runStatus = "";
    this.connectionRunStatusBeforeEdit = undefined;
    this.runRevision = 0;
    this.connectionRunRevisionBeforeEdit = undefined;
    this.messageEditRunStatusBefore = undefined;
    this.bindEvents();

    const harness = await createHarness();
    if (generation !== this.lifecycleGeneration) {
      await harness.dispose();
      return;
    }
    this.harness = harness;
    this.modelConnection = createModelConnection({ harness });
    const settings = loadConnectionSettings();
    this.applyConnectionSettings(settings);
    this.ready = true;
    this.render();
    if (settings === undefined) {
      this.element<HTMLInputElement>("model-endpoint").focus();
      this.keepConnectionFieldVisible();
      this.element("chat-log").scrollTop = 0;
    } else this.focusComposer();
    if (this.options.autoConnect !== false && settings !== undefined) void this.connectSettings(settings, true, generation);
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.runController?.abort();
    this.runController = undefined;
    this.eventController?.abort();
    this.eventController = undefined;
    if (this.renderFrame !== undefined) window.cancelAnimationFrame(this.renderFrame);
    if (this.renderTimer !== undefined) window.clearTimeout(this.renderTimer);
    this.renderFrame = undefined;
    this.renderTimer = undefined;
    this.renderScheduled = false;
    await this.harness?.dispose();
    this.harness = undefined;
    this.modelConnection = undefined;
    this.messages = [];
    this.stream = undefined;
    this.retainedStreams = [];
    this.streamAnchor = undefined;
    this.busy = false;
    this.connecting = false;
    this.editingIndex = undefined;
    this.connectionEditing = false;
    this.connectedSettings = undefined;
    this.connectedModelName = undefined;
    this.runStatus = "";
    this.runStatusKind = "normal";
    this.connectionRunStatusBeforeEdit = undefined;
    this.runRevision = 0;
    this.connectionRunRevisionBeforeEdit = undefined;
    this.messageEditRunStatusBefore = undefined;
    this.followChat = true;
    this.renderedMessages = undefined;
    this.renderedConnected = undefined;
    this.renderedConnectedModelName = undefined;
    this.renderedEditingIndex = undefined;
    this.renderedRetainedStreams = undefined;
    this.liveElement = undefined;
    this.connectionScrollTop = undefined;
    this.connectionFollowChat = undefined;
    this.ready = false;
    this.root.replaceChildren();
    for (const key of Object.keys(this.elements)) Reflect.deleteProperty(this.elements, key);
  }

  private bindEvents(): void {
    this.eventController?.abort();
    const controller = new AbortController();
    this.eventController = controller;
    const signal = controller.signal;
    const input = this.element<HTMLTextAreaElement>("message-input");
    const chat = this.element("chat-log");
    input.addEventListener("input", () => {
      if (input.value.trim().length > 0 && this.runStatus === "Write a message before sending.") this.setStatus("", "normal");
      const wasFollowing = this.followChat;
      if (!wasFollowing || this.connectionEditing) return;
      window.requestAnimationFrame(() => {
        if (!this.connectionEditing) chat.scrollTop = chat.scrollHeight;
      });
    }, { signal });
    this.element("composer-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.busy) {
        this.runController?.abort();
        input.focus();
      } else {
        input.focus();
        void this.sendMessage();
      }
    }, { signal });

    chat.addEventListener("scroll", () => {
      this.followChat = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    }, { signal, passive: true });
    window.addEventListener("resize", () => {
      const chat = this.element("chat-log");
      if (this.followChat && !this.connectionEditing && (this.messages.length > 0 || this.stream !== undefined)) chat.scrollTop = chat.scrollHeight;
      this.keepMessageEditVisible();
      if (this.connectionEditing || this.harness?.modelId === undefined) {
        this.keepConnectionFieldVisible();
        if (this.harness?.modelId === undefined) chat.scrollTop = 0;
        window.requestAnimationFrame(() => {
          if (this.connectionEditing || this.harness?.modelId === undefined) {
            this.keepConnectionFieldVisible();
            if (this.harness?.modelId === undefined) chat.scrollTop = 0;
          }
        });
      }
    }, { signal });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.busy && !event.isComposing) {
        event.preventDefault();
        this.runController?.abort();
      } else if (event.key === "Enter" && !event.isComposing) {
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        if (this.busy) this.runController?.abort();
        else void this.sendMessage();
      }
    }, { signal });

    this.element("connection-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.connectFromForm(event.currentTarget as HTMLFormElement);
    }, { signal });
    const connectionForm = this.element<HTMLFormElement>("connection-form");
    connectionForm.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      this.element<HTMLButtonElement>("open-settings").click();
    }, { signal });
    for (const id of ["model-endpoint", "model-name", "model-key"]) {
      this.element<HTMLInputElement>(id).addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        connectionForm.requestSubmit();
      }, { signal });
    }
    this.element("open-settings").addEventListener("click", () => {
      if (this.harness?.modelId === undefined) return;
      if (this.editingIndex !== undefined) {
        this.setStatus("Finish editing before changing the connection.", "error");
        this.focusMessageEdit();
        return;
      }
      if (this.connectionEditing) {
        const previousStatus = this.connectionRunStatusBeforeEdit;
        const runRevisionBeforeEdit = this.connectionRunRevisionBeforeEdit;
        const runChanged = runRevisionBeforeEdit !== undefined && runRevisionBeforeEdit !== this.runRevision;
        this.connectionRunStatusBeforeEdit = undefined;
        this.connectionRunRevisionBeforeEdit = undefined;
        this.connectionEditing = false;
        this.applyConnectionSettings(this.connectedSettings);
        this.clearFieldError("model-endpoint");
        this.clearFieldError("model-name");
        this.setConnectionStatus("");
        if (previousStatus !== undefined && !runChanged) this.setStatus(previousStatus.message, previousStatus.kind);
        this.render();
        this.restoreConnectionScroll(runChanged);
        this.focusComposer();
        return;
      }
      const chat = this.element("chat-log");
      this.connectionScrollTop = chat.scrollTop;
      this.connectionFollowChat = this.followChat;
      this.connectionRunStatusBeforeEdit = { message: this.runStatus, kind: this.runStatusKind };
      this.connectionRunRevisionBeforeEdit = this.runRevision;
      this.connectionEditing = true;
      this.render();
      this.element("chat-log").scrollTop = 0;
      const card = this.element("connection-card");
      const endpoint = this.element<HTMLInputElement>("model-endpoint");
      card.scrollTop = 0;
      endpoint.focus({ preventScroll: true });
      this.keepConnectionFieldVisible();
    }, { signal });

    for (const id of ["model-endpoint", "model-name"]) {
      this.element(id).addEventListener("input", () => this.clearFieldError(id), { signal });
    }
    const conversation = this.element("conversation-content");
    conversation.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || target.closest(".message-edit") === null) return;
      event.preventDefault();
      target.closest<HTMLElement>(".message-edit")?.querySelector<HTMLButtonElement>('[data-action="cancel-edit"]')?.click();
    }, { signal });
    conversation.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const summary = target.closest("summary");
      const details = summary?.parentElement;
      if (summary !== null && details instanceof HTMLDetailsElement) {
        const wasConnectionEditing = this.connectionEditing;
        if (wasConnectionEditing && !details.open) this.element<HTMLButtonElement>("open-settings").click();
        window.requestAnimationFrame(() => {
          if (!details.isConnected || !details.open || this.connectionEditing) return;
          this.keepToolVisible(details);
          if (wasConnectionEditing && summary instanceof HTMLElement) summary.focus({ preventScroll: true });
        });
      }
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      if (button === null) return;
      const index = Number.parseInt(button.dataset.messageIndex ?? "", 10);
      if (!Number.isInteger(index)) return;
      switch (button.dataset.action) {
        case "copy-message": {
          const message = this.messages[index];
          const content = message === undefined ? undefined : copyable(message);
          if (content !== undefined) void this.copyMessage(content);
          break;
        }
        case "edit-message":
          if (this.connectionEditing && !this.busy) this.element<HTMLButtonElement>("open-settings").click();
          this.startMessageEdit(index);
          break;
        case "cancel-edit":
          if (this.messageEditRunStatusBefore !== undefined) this.setStatus(this.messageEditRunStatusBefore.message, this.messageEditRunStatusBefore.kind);
          this.messageEditRunStatusBefore = undefined;
          this.editingIndex = undefined;
          this.render();
          this.focusComposer();
          break;
        case "save-edit": {
          const editor = button.closest<HTMLElement>(".message-edit");
          const value = editor?.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
          void this.resendEditedMessage(index, value);
          break;
        }
      }
    }, { signal });
  }

  private async copyMessage(content: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    const runRevision = this.runRevision;
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(content);
      if (generation !== this.lifecycleGeneration || this.busy || runRevision !== this.runRevision) return;
      this.setStatus("Copied.", "success");
    } catch (error) {
      if (generation !== this.lifecycleGeneration || this.busy || runRevision !== this.runRevision) return;
      this.setStatus(asErrorMessage(error), "error");
    }
  }

  private applyConnectionSettings(settings: ConnectionSettings | undefined): void {
    if (settings === undefined) return;
    this.element<HTMLInputElement>("model-endpoint").value = settings.endpoint;
    this.element<HTMLInputElement>("model-name").value = settings.model;
    this.element<HTMLInputElement>("model-key").value = settings.apiKey;
  }

  private readConnectionSettings(form: HTMLFormElement): ConnectionSettings | undefined {
    this.clearFieldError("model-endpoint");
    this.clearFieldError("model-name");
    const data = new FormData(form);
    const validation = validateConnectionDraft({
      endpoint: String(data.get("endpoint") ?? ""),
      model: String(data.get("model") ?? ""),
      apiKey: String(data.get("apiKey") ?? ""),
    });
    if (validation.errors.endpoint !== undefined) this.setFieldError("model-endpoint", validation.errors.endpoint);
    if (validation.errors.model !== undefined) this.setFieldError("model-name", validation.errors.model);
    if (validation.settings === undefined) {
      this.setStatus("Check the highlighted connection fields.", "error");
      this.element<HTMLInputElement>(validation.errors.endpoint !== undefined ? "model-endpoint" : "model-name").focus();
      return undefined;
    }
    return validation.settings;
  }

  private async connectFromForm(form: HTMLFormElement): Promise<void> {
    const settings = this.readConnectionSettings(form);
    if (settings !== undefined) await this.connectSettings(settings, false, this.lifecycleGeneration);
  }

  private async connectSettings(settings: ConnectionSettings, automatic: boolean, generation: number): Promise<void> {
    if (this.connecting || generation !== this.lifecycleGeneration) return;
    const connection = this.modelConnection;
    if (connection === undefined) return;
    if (this.connectedSettings !== undefined
      && this.connectedSettings.endpoint === settings.endpoint
      && this.connectedSettings.model === settings.model
      && this.connectedSettings.apiKey === settings.apiKey
      && this.connectionEditing) {
      const previousStatus = this.connectionRunStatusBeforeEdit;
      const runRevisionBeforeEdit = this.connectionRunRevisionBeforeEdit;
      const runChanged = runRevisionBeforeEdit !== undefined && runRevisionBeforeEdit !== this.runRevision;
      this.connectionRunStatusBeforeEdit = undefined;
      this.connectionRunRevisionBeforeEdit = undefined;
      this.connectionEditing = false;
      this.applyConnectionSettings(this.connectedSettings);
      this.setConnectionStatus("");
      if (previousStatus !== undefined && !runChanged) this.setStatus(previousStatus.message, previousStatus.kind);
      this.render();
      this.restoreConnectionScroll(runChanged);
      this.focusComposer();
      return;
    }
    this.connecting = true;
    this.setConnectionStatus(automatic ? "Restoring connection…" : "Connecting…");
    this.renderConnection();
    try {
      await connection.connect(settings);
      if (generation !== this.lifecycleGeneration) return;
      this.connectedSettings = settings;
      this.connectedModelName = settings.model;
      this.applyConnectionSettings(settings);
      this.connectionRunStatusBeforeEdit = undefined;
      this.connectionRunRevisionBeforeEdit = undefined;
      this.connectionEditing = false;
      this.setConnectionStatus("");
      this.setStatus(`Connected to ${displayModelName(settings.model)}.`, "success");
      this.render();
      this.restoreConnectionScroll();
      this.focusComposer();
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        this.setConnectionStatus(`Could not connect: ${asErrorMessage(error)}`);
        this.setStatus(automatic ? "Saved connection could not be restored." : "Connection failed.", "error");
        this.render();
      }
    } finally {
      if (generation === this.lifecycleGeneration) {
        this.connecting = false;
        this.render();
      }
    }
  }

  private async sendMessage(): Promise<void> {
    if (!this.ready || this.busy) return;
    if (this.harness?.modelId === undefined) {
      this.setStatus("Connect a model before sending.", "error");
      this.connectionEditing = true;
      this.render();
      return;
    }
    if (this.editingIndex !== undefined) {
      this.setStatus("Finish editing before sending.", "error");
      this.focusMessageEdit();
      return;
    }
    const input = this.element<HTMLTextAreaElement>("message-input");
    const content = input.value.trim();
    if (!content) {
      this.setStatus("Write a message before sending.", "error");
      input.focus();
      return;
    }
    this.retainEndedStream();
    this.messages = [...this.messages, { role: "user", content }];
    this.followChat = true;
    input.value = "";
    this.editingIndex = undefined;
    await this.runAgent();
  }

  private async runAgent(): Promise<void> {
    const harness = this.harness;
    if (harness === undefined || this.busy) return;
    const generation = this.lifecycleGeneration;
    const controller = new AbortController();
    this.runController = controller;
    this.runRevision += 1;
    this.streamAnchor = this.messages.length - 1;
    this.busy = true;
    this.stream = { text: "", tools: [] };
    this.setStatus("Running…", "normal");
    this.render();
    try {
      const result = await harness.run({
        messages: this.messages,
        signal: controller.signal,
        onEvent: (event) => {
          if (generation === this.lifecycleGeneration) this.handleAgentEvent(event);
        },
      });
      if (generation !== this.lifecycleGeneration) return;
      this.messages = [...result.messages];
      const retainPendingTools = (stream: StreamState): StreamTool[] => stream.tools.filter((item) => item.status !== "finished");
      if (result.status === "completed") {
        this.stream = undefined;
        this.streamAnchor = undefined;
        this.setStatus("Response complete.", "success");
      } else if (result.status === "cancelled") {
        const stream = this.stream ?? { text: "", tools: [] };
        const pendingTools = retainPendingTools(stream);
        this.stream = stream.text.length === 0 && pendingTools.length === 0
          ? undefined
          : { ...stream, tools: pendingTools, stopped: true };
        this.streamAnchor = this.messages.length - 1;
        if (result.error?.code !== "MODEL_REPLACED" && result.error?.code !== "MODEL_CLEARED") {
          this.setStatus("Stopped. The produced content was retained above.", "error");
        }
      } else if (result.status === "max-turns") {
        this.stream = undefined;
        this.streamAnchor = undefined;
        this.setStatus("Run stopped by the host limit.", "error");
      } else {
        const stream = this.stream ?? { text: "", tools: [] };
        this.stream = { ...stream, tools: retainPendingTools(stream), error: result.error?.message ?? "The model request failed." };
        this.streamAnchor = this.messages.length - 1;
        this.setStatus("Run failed. See the error above.", "error");
      }
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        this.stream = { ...(this.stream ?? { text: "", tools: [] }), error: asErrorMessage(error) };
        this.streamAnchor = this.messages.length - 1;
        this.setStatus("Run failed. See the error above.", "error");
      }
    } finally {
      if (generation === this.lifecycleGeneration) {
        this.runRevision += 1;
        this.busy = false;
        this.runController = undefined;
        this.render();
      }
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (!isVisibleAgentEvent(event)) return;
    const stream = this.stream ?? { text: "", tools: [] };
    switch (event.type) {
      case "text-delta":
        stream.text += event.delta;
        break;
      case "tool-call-delta":
        this.mergeToolDelta(stream, event.delta);
        break;
      case "tool-started":
        this.updateTool(stream, event.call, undefined, "running");
        break;
      case "tool-finished":
        this.updateTool(stream, event.call, event.result, "finished");
        break;
    }
    this.stream = stream;
    this.scheduleRender();
  }

  private mergeToolDelta(stream: StreamState, delta: ToolCallDelta): void {
    const index = stream.tools.findIndex((item) => item.status !== "finished" && (item.delta?.index === delta.index || (delta.id !== undefined && (item.call?.id === delta.id || item.delta?.id === delta.id))));
    const current = index < 0 ? undefined : stream.tools[index];
    const previous = current?.delta;
    const merged: ToolCallDelta = {
      index: delta.index,
      ...(delta.id === undefined ? previous?.id === undefined ? {} : { id: previous.id } : { id: delta.id }),
      ...(delta.name === undefined ? previous?.name === undefined ? {} : { name: previous.name } : { name: `${previous?.name ?? ""}${delta.name}` }),
      ...(delta.arguments === undefined ? previous?.arguments === undefined ? {} : { arguments: previous.arguments } : { arguments: `${previous?.arguments ?? ""}${delta.arguments}` }),
    };
    const next: StreamTool = { ...current, status: current?.status ?? "preparing", delta: merged };
    if (index < 0) stream.tools.push(next);
    else stream.tools[index] = next;
  }

  private updateTool(stream: StreamState, call: ToolCall, result: ToolExecutionResult | undefined, status: StreamTool["status"]): void {
    const index = stream.tools.findIndex((item) => item.status !== "finished" && (item.call?.id === call.id || item.delta?.id === call.id));
    const fallbackIndex = index >= 0
      ? index
      : stream.tools.findIndex((item) => item.status !== "finished" && item.call === undefined && item.delta?.name === call.name);
    const current = fallbackIndex < 0 ? undefined : stream.tools[fallbackIndex];
    const next: StreamTool = { status, ...(current?.delta === undefined ? {} : { delta: current.delta }), call, ...(result === undefined ? {} : { result }) };
    if (fallbackIndex < 0) stream.tools.push(next);
    else stream.tools[fallbackIndex] = next;
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const render = () => {
      this.renderScheduled = false;
      this.renderFrame = undefined;
      this.renderTimer = undefined;
      if (this.ready) this.renderConversation();
    };
    if (typeof window.requestAnimationFrame === "function") this.renderFrame = window.requestAnimationFrame(render);
    else this.renderTimer = window.setTimeout(render, STREAM_RENDER_INTERVAL_MS);
  }

  private render(): void {
    if (!this.ready) return;
    this.renderConnection();
    this.renderConversation();
    this.renderComposer();
  }

  private renderConnection(): void {
    const connected = this.harness?.modelId !== undefined;
    const card = this.element("connection-card");
    const chat = this.element("chat-log");
    chat.classList.toggle("connection-open", !connected || this.connectionEditing);
    chat.classList.toggle("settings-open", connected && this.connectionEditing);
    card.hidden = connected && !this.connectionEditing;
    const openSettings = this.element("open-settings");
    openSettings.hidden = !connected;
    openSettings.textContent = this.connectionEditing ? "Close" : "Connection";
    openSettings.setAttribute("aria-label", this.connectionEditing ? "Close connection settings" : "Open connection settings");
    openSettings.setAttribute("aria-expanded", String(this.connectionEditing));
    const submit = this.element<HTMLButtonElement>("connection-submit");
    submit.disabled = this.connecting;
    submit.textContent = this.connecting ? "Connecting…" : "Connect";
    this.element<HTMLFormElement>("connection-form").querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = this.connecting; });
  }

  private renderComposer(): void {
    const connected = this.harness?.modelId !== undefined;
    const input = this.element<HTMLTextAreaElement>("message-input");
    input.disabled = !connected;
    const button = this.element<HTMLButtonElement>("send-button");
    button.hidden = false;
    button.disabled = !this.busy && !connected;
    button.textContent = this.busy ? "Stop" : "Send";
    button.setAttribute("aria-label", this.busy ? "Stop generation" : "Send message");
    this.element("chat-log").setAttribute("aria-busy", String(this.busy));
    this.element("run-status").textContent = this.runStatus;
    this.element("run-status").className = `status-message ${this.runStatusKind}`;
  }

  private renderConversation(): void {
    const conversation = this.element("conversation-content");
    const chat = this.element("chat-log");
    const connected = this.harness?.modelId !== undefined;
    const streamingToolStates = new Map<string, boolean>();
    const streamingToolIds = new Map<string, boolean>();
    const activeStreamingSummary = this.liveElement !== undefined && document.activeElement?.tagName === "SUMMARY"
      ? document.activeElement.closest<HTMLDetailsElement>(".tool-trace[data-stream-tool-index]")
      : undefined;
    const focusedStreamingToolIndex = activeStreamingSummary?.dataset.streamToolIndex;
    const focusedStreamingToolId = activeStreamingSummary?.dataset.toolCallId;
    for (const details of this.liveElement?.querySelectorAll<HTMLDetailsElement>(".tool-trace") ?? []) {
      const index = details.dataset.streamToolIndex;
      if (index !== undefined) streamingToolStates.set(index, details.open);
      const id = details.dataset.toolCallId;
      if (id !== undefined) streamingToolIds.set(id, details.open);
    }
    this.liveElement?.remove();
    this.liveElement = undefined;
    const historyChanged = this.renderedMessages !== this.messages
      || this.renderedConnected !== connected
      || this.renderedConnectedModelName !== this.connectedModelName
      || this.renderedEditingIndex !== this.editingIndex
      || this.renderedRetainedStreams !== this.retainedStreams;

    if (historyChanged) {
      const openToolCallKeys = new Set(
        [...conversation.querySelectorAll<HTMLDetailsElement>(".tool-trace[data-tool-call-key][open]")].map((details) => details.dataset.toolCallKey),
      );
      conversation.replaceChildren();
      if (!connected) {
        conversation.append(textElement("div", "Connect a model to start a conversation.", "empty-state"));
      } else if (this.messages.length === 0 && this.stream === undefined && this.retainedStreams.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.append(textElement("h2", "Ready when you are"), textElement("p", `Connected to ${displayModelName(this.connectedModelName ?? this.harness?.modelId ?? "model")}. Ask the agent to do something.`));
        conversation.append(empty);
      } else {
        const history = messageElements(this.messages, this.editingIndex);
        const retainedAt = new Map<number, HTMLElement[]>();
        for (const retained of this.retainedStreams) {
          const element = streamingElement(retained.stream);
          if (element === undefined) continue;
          const position = history.findIndex((candidate) => Number(candidate.dataset.messageIndex ?? "") > retained.afterMessageIndex);
          const insertion = position < 0 ? history.length : position;
          retainedAt.set(insertion, [...(retainedAt.get(insertion) ?? []), element]);
        }
        for (let position = 0; position <= history.length; position += 1) {
          conversation.append(...(retainedAt.get(position) ?? []));
          const historyElement = history[position];
          if (historyElement !== undefined) conversation.append(historyElement);
        }
      }
      for (const details of conversation.querySelectorAll<HTMLDetailsElement>(".tool-trace[data-tool-call-key]")) {
        if (details.dataset.toolCallKey !== undefined && openToolCallKeys.has(details.dataset.toolCallKey)) details.open = true;
      }
      for (const [id, open] of streamingToolIds) {
        const details = [...conversation.querySelectorAll<HTMLDetailsElement>(".tool-trace[data-tool-call-id]")]
          .reverse()
          .find((candidate) => candidate.dataset.toolCallId === id);
        if (details !== undefined) details.open = open;
      }
      if (focusedStreamingToolId !== undefined) {
        const details = [...conversation.querySelectorAll<HTMLDetailsElement>(".tool-trace[data-tool-call-id]")]
          .reverse()
          .find((candidate) => candidate.dataset.toolCallId === focusedStreamingToolId);
        details?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
      this.renderedMessages = this.messages;
      this.renderedConnected = connected;
      this.renderedConnectedModelName = this.connectedModelName;
      this.renderedEditingIndex = this.editingIndex;
      this.renderedRetainedStreams = this.retainedStreams;
    }

    if (connected && this.stream !== undefined) {
      const live = streamingElement(this.stream as StreamView);
      if (live !== undefined) {
        for (const details of live.querySelectorAll<HTMLDetailsElement>(".tool-trace[data-stream-tool-index]")) {
          const index = details.dataset.streamToolIndex;
          if (index !== undefined && streamingToolStates.has(index)) details.open = streamingToolStates.get(index) === true;
        }
        conversation.append(live);
        this.liveElement = live;
        if (focusedStreamingToolIndex !== undefined) {
          const details = live.querySelector<HTMLDetailsElement>(`.tool-trace[data-stream-tool-index="${focusedStreamingToolIndex}"]`);
          details?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        }
      }
    }
    conversation.querySelectorAll<HTMLButtonElement>('[data-action="edit-message"]').forEach((button) => { button.disabled = this.busy; });
    if (this.messages.length === 0 && this.stream === undefined) chat.scrollTop = 0;
    else if (this.followChat && !this.connectionEditing) chat.scrollTop = chat.scrollHeight;
  }

  private startMessageEdit(index: number): void {
    if (this.busy || this.messages[index]?.role !== "user") return;
    this.messageEditRunStatusBefore = { message: this.runStatus, kind: this.runStatusKind };
    this.editingIndex = index;
    this.renderConversation();
    this.focusMessageEdit();
  }

  private keepMessageEditVisible(): void {
    if (this.editingIndex === undefined) return;
    this.element("conversation-content").querySelector<HTMLElement>(`.message[data-message-index="${this.editingIndex}"] .message-edit`)?.scrollIntoView({ block: "nearest" });
  }

  private focusMessageEdit(): void {
    if (this.editingIndex === undefined) return;
    this.keepMessageEditVisible();
    this.element("conversation-content").querySelector<HTMLTextAreaElement>(`.message[data-message-index="${this.editingIndex}"] .message-edit textarea`)?.focus({ preventScroll: true });
  }

  private keepToolVisible(details: HTMLDetailsElement): void {
    const chat = this.element("chat-log");
    const chatBounds = chat.getBoundingClientRect();
    const detailsBounds = details.getBoundingClientRect();
    const previousMessage = details.closest<HTMLElement>(".message")?.previousElementSibling;
    const groupTop = previousMessage?.classList.contains("user")
      ? previousMessage.getBoundingClientRect().top
      : detailsBounds.top;
    const followingResponse = details.closest<HTMLElement>(".message")?.nextElementSibling?.querySelector<HTMLElement>(".message-body");
    const followingResponseBounds = followingResponse?.getBoundingClientRect();
    const groupBottom = followingResponseBounds?.bottom ?? detailsBounds.bottom;
    const groupHeight = groupBottom - groupTop;
    const maxScroll = Math.max(0, chat.scrollHeight - chat.clientHeight);
    if (groupHeight > chat.clientHeight) {
      const anchorTop = previousMessage?.classList.contains("user") ? groupTop : detailsBounds.top;
      chat.scrollTop = Math.min(maxScroll, Math.max(0, chat.scrollTop + Math.round(anchorTop - chatBounds.top)));
      return;
    }
    if (groupBottom > chatBounds.bottom) chat.scrollTop = Math.min(maxScroll, chat.scrollTop + Math.ceil(groupBottom - chatBounds.bottom));
    else if (groupTop < chatBounds.top) chat.scrollTop = Math.max(0, chat.scrollTop + Math.floor(groupTop - chatBounds.top));
  }

  private async resendEditedMessage(index: number, value: string): Promise<void> {
    const content = value.trim();
    if (!content) {
      this.setStatus("The edited message cannot be empty.", "error");
      this.focusMessageEdit();
      return;
    }
    if (this.busy || this.messages[index]?.role !== "user") return;
    this.retainedStreams = this.retainedStreams.filter((item) => item.afterMessageIndex < index);
    this.stream = undefined;
    this.streamAnchor = undefined;
    this.messages = [...this.messages.slice(0, index), { role: "user", content }];
    this.followChat = true;
    this.messageEditRunStatusBefore = undefined;
    this.editingIndex = undefined;
    await this.runAgent();
    this.focusComposer();
  }

  private retainEndedStream(): void {
    const stream = this.stream;
    if (stream === undefined || (stream.stopped !== true && stream.error === undefined)) return;
    if (stream.text.length > 0 || stream.tools.length > 0 || stream.error !== undefined) {
      this.retainedStreams = [...this.retainedStreams, {
        afterMessageIndex: this.streamAnchor ?? this.messages.length - 1,
        stream,
      }];
    }
    this.stream = undefined;
    this.streamAnchor = undefined;
  }

  private setConnectionStatus(message: string): void {
    this.element("connection-status").textContent = message;
  }

  private restoreConnectionScroll(followNewContent = false): void {
    if (this.connectionScrollTop === undefined) return;
    const chat = this.element("chat-log");
    if (followNewContent && this.connectionFollowChat) {
      chat.scrollTop = chat.scrollHeight;
      this.followChat = true;
    } else {
      chat.scrollTop = this.connectionScrollTop;
      if (this.connectionFollowChat !== undefined) this.followChat = this.connectionFollowChat;
    }
    this.connectionScrollTop = undefined;
    this.connectionFollowChat = undefined;
  }

  private keepConnectionFieldVisible(): void {
    const card = this.element("connection-card");
    const active = document.activeElement;
    const form = this.element<HTMLFormElement>("connection-form");
    const field = active instanceof HTMLInputElement && active.form === form
      ? active
      : this.element<HTMLInputElement>("model-endpoint");
    const cardBounds = card.getBoundingClientRect();
    const fieldBounds = field.getBoundingClientRect();
    const maxScroll = Math.max(0, card.scrollHeight - card.clientHeight);
    if (fieldBounds.bottom > cardBounds.bottom) card.scrollTop = Math.min(maxScroll, card.scrollTop + Math.ceil(fieldBounds.bottom - cardBounds.bottom));
    else if (fieldBounds.top < cardBounds.top) card.scrollTop = Math.max(0, card.scrollTop + Math.floor(fieldBounds.top - cardBounds.top));
  }

  private setStatus(message: string, kind: "normal" | "success" | "error"): void {
    this.runStatus = message;
    this.runStatusKind = kind;
    if (this.ready) this.renderComposer();
  }

  private clearFieldError(id: string): void {
    const input = this.element<HTMLInputElement>(id);
    const errorId = id === "model-endpoint" ? "endpoint-error" : "model-error";
    input.setAttribute("aria-invalid", "false");
    this.element(errorId).textContent = "";
    if (this.runStatus === "Check the highlighted connection fields." && this.element<HTMLInputElement>("model-endpoint").getAttribute("aria-invalid") !== "true" && this.element<HTMLInputElement>("model-name").getAttribute("aria-invalid") !== "true") {
      if (this.busy) this.setStatus("Running…", "normal");
      else {
        const runChanged = this.connectionRunRevisionBeforeEdit !== undefined && this.connectionRunRevisionBeforeEdit !== this.runRevision;
        const previous = runChanged ? undefined : this.connectionRunStatusBeforeEdit;
        this.setStatus(previous?.message ?? "", previous?.kind ?? "normal");
      }
    }
  }

  private setFieldError(id: string, message: string): void {
    this.element<HTMLInputElement>(id).setAttribute("aria-invalid", "true");
    this.element(id === "model-endpoint" ? "endpoint-error" : "model-error").textContent = message;
  }

  private focusComposer(): void {
    if (this.harness?.modelId !== undefined) this.element<HTMLTextAreaElement>("message-input").focus();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.elements[id];
    if (element === undefined) throw new Error(`Missing app element: ${id}`);
    return element as T;
  }
}

export async function startApp(root: HTMLElement, options: AgentAppOptions = {}): Promise<AgentApp> {
  const app = new AgentApp(root, options);
  await app.start();
  return app;
}
