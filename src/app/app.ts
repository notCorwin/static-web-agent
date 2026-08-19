import { createBrowserAgentHarness, type BrowserAgentHarness, type BrowserAgentHarnessPluginHandle } from "../harness.js";
import { createBrowserStateStore } from "../core/state.js";
import { createRemoteModelPlugin } from "../plugins/remote-model.js";
import { createChatState, isMessageEnvelope, normalizeMessages, type ChatState } from "./chat.js";
import { createPendingAttachment, disposeAttachmentEngines, processAttachmentFiles, type AttachmentProgress, type PendingAttachment, type PreparedAttachments } from "./attachments.js";
import { DEFAULT_THINKING_LEVEL, isConnectionSettings, loadConnectionSettings, saveConnectionSettings, THINKING_LEVELS, type ConnectionSettings } from "./connection-settings.js";
import { renderRichContent } from "./rich-content.js";
import { messageElement, messageElements, renderShell, streamingToolElement, textElement, thinkingElement, toolGroupElement, updateStreamingToolElement, updateThinkingElement, updateToolGroupElement, type AppElements } from "./view.js";
import type { AgentEvent, ModelAttachment, ModelMessage, Plugin, ToolCall, ToolCallDelta, ToolExecutionResult, UserMessage } from "../core/types.js";
import type { StateStore } from "../core/types.js";

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

type PendingStreamSegment =
  | { readonly key: string; readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly key: string; readonly kind: "tools"; readonly toolKeys: readonly string[] };

interface VisionRetry {
  readonly content: string;
  readonly files: readonly PendingAttachment[];
}

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
  private chat: ChatState = createChatState();
  private store!: StateStore;
  private harness: BrowserAgentHarness | undefined;
  private remoteHandle: BrowserAgentHarnessPluginHandle | undefined;
  private uiCleanup: (() => void) | undefined;
  private ready = false;
  private busy = false;
  private runController: AbortController | undefined;
  private pendingToolCalls: readonly ToolCallDelta[] = [];
  private liveToolEntries: readonly LiveToolEntry[] = [];
  private liveToolSequence = 0;
  private pendingStream: readonly PendingStreamSegment[] = [];
  private pendingStreamSequence = 0;
  private chatRenderScheduled = false;
  private chatScrollScheduled = false;
  private chatFollowScheduled = false;
  private userScrollGesture = false;
  private userScrollGestureTimer: number | undefined;
  private followChat = true;
  private lastChatScrollTop = 0;
  private chatObserver: MutationObserver | undefined;
  private renderedMessages: readonly ModelMessage[] | undefined;
  private renderedModelId: string | undefined;
  private renderedConnectionEditing = false;
  private connectionEditing = false;
  private autoConnectStarted = false;
  private pendingAttachments: readonly PendingAttachment[] = [];
  private readonly modelAttachments = new Map<string, ModelAttachment>();
  private visionRetry: VisionRetry | undefined;
  private attachmentProgress: AttachmentProgress | undefined;
  private readonly elements: AppElements;

  constructor(root: HTMLElement, options: AgentAppOptions = {}) {
    this.root = root;
    this.options = options;
    this.elements = {};
  }

  get runtime(): BrowserAgentHarness | undefined {
    return this.harness;
  }

  async start(): Promise<void> {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    Object.assign(this.elements, renderShell(this.root));
    this.bindEvents();
    this.chat = createChatState();
    this.store = createBrowserStateStore({ databaseName: "static-web-agent", objectStoreName: "workspace" });
    const savedSettings = await loadConnectionSettings(this.store);
    this.applyConnectionSettings(savedSettings);
    this.harness = await createBrowserAgentHarness({
      stateStore: this.store,
      ...(this.options.plugins === undefined ? {} : { plugins: this.options.plugins }),
      ...(this.options.initialModelId === undefined ? {} : { initialModelId: this.options.initialModelId }),
    });
    this.harness.subscribe(() => {
      if (this.ready) {
        this.renderExtensions();
        this.renderChat();
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
    await disposeAttachmentEngines();
    this.chatObserver?.disconnect();
    this.chatObserver = undefined;
    this.chatScrollScheduled = false;
    this.chatFollowScheduled = false;
    if (this.userScrollGestureTimer !== undefined) window.clearTimeout(this.userScrollGestureTimer);
    this.userScrollGestureTimer = undefined;
    this.userScrollGesture = false;
    this.followChat = true;
    this.lastChatScrollTop = 0;
    this.pendingToolCalls = [];
    this.liveToolEntries = [];
    this.liveToolSequence = 0;
    this.pendingStream = [];
    this.pendingStreamSequence = 0;
    this.renderedMessages = undefined;
    this.renderedModelId = undefined;
    this.renderedConnectionEditing = false;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    await this.harness?.dispose();
    this.harness = undefined;
    this.remoteHandle = undefined;
    this.pendingAttachments = [];
    this.modelAttachments.clear();
    this.visionRetry = undefined;
    this.attachmentProgress = undefined;
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
    this.elements["attachment-button"]?.addEventListener("click", () => {
      if (this.busy) return;
      (this.elements["attachment-input"] as HTMLInputElement | undefined)?.click();
    });
    this.elements["attachment-input"]?.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      this.queueAttachments(input.files === null ? [] : [...input.files]);
      input.value = "";
    });
    this.elements["attachment-list"]?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const remove = target.closest<HTMLButtonElement>("button[data-attachment-id]");
      if (remove !== null) {
        this.removeAttachment(remove.dataset.attachmentId ?? "");
        return;
      }
      const retry = target.closest<HTMLButtonElement>("button[data-action=vision-fallback]");
      if (retry !== null) void this.retryWithLocalOcr();
    });
    const chat = this.elements["chat-log"];
    chat?.addEventListener("scroll", () => this.scheduleChatFollowState(), { passive: true });
    chat?.addEventListener("wheel", (event) => {
      this.markUserScrollGesture();
      if (event.deltaY < 0) {
        this.followChat = false;
        this.scheduleChatFollowState();
      }
    }, { passive: true });
    chat?.addEventListener("touchmove", () => this.markUserScrollGesture(), { passive: true });
    chat?.addEventListener("pointerdown", () => this.markUserScrollGesture(), { passive: true });
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
        if (this.followChat) this.scheduleChatScroll();
      });
      this.chatObserver.observe(chat, { childList: true, subtree: true });
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
    const thinkingLevel = this.elements["thinking-level"] as HTMLSelectElement | undefined;
    const supportsVision = this.elements["model-vision"] as HTMLInputElement | undefined;
    if (endpoint !== undefined) endpoint.value = settings.endpoint;
    if (model !== undefined) model.value = settings.model;
    if (apiKey !== undefined) apiKey.value = settings.apiKey;
    if (thinkingLevel !== undefined) thinkingLevel.value = settings.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    if (supportsVision !== undefined) supportsVision.checked = settings.supportsVision === true;
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
    const requestedThinkingLevel = String(data.get("thinkingLevel") ?? DEFAULT_THINKING_LEVEL);
    const supportsVision = data.get("supportsVision") === "on";
    const thinkingLevel = THINKING_LEVELS.includes(requestedThinkingLevel as typeof THINKING_LEVELS[number])
      ? requestedThinkingLevel as typeof THINKING_LEVELS[number]
      : DEFAULT_THINKING_LEVEL;
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
    return { endpoint, model, apiKey, thinkingLevel, supportsVision };
  }

  private confirmDraft(): boolean {
    const input = this.elements["message-input"] as HTMLTextAreaElement | undefined;
    if (input === undefined || input.value.trim().length === 0 || typeof window.confirm !== "function") return true;
    return window.confirm("Discard this unsent draft?");
  }

  private visionEnabled(): boolean {
    return (this.elements["model-vision"] as HTMLInputElement | undefined)?.checked === true;
  }

  private queueAttachments(files: readonly File[]): void {
    if (files.length === 0) return;
    this.visionRetry = undefined;
    this.pendingAttachments = [...this.pendingAttachments, ...files.map((file) => createPendingAttachment(file))];
    this.renderAttachmentList();
  }

  private removeAttachment(id: string): void {
    if (this.busy || id.length === 0) return;
    this.pendingAttachments = this.pendingAttachments.filter((attachment) => attachment.id !== id);
    this.renderAttachmentList();
  }

  private attachmentProgressLabel(progress: AttachmentProgress): string {
    const phase = progress.phase === "reading"
      ? "Reading"
      : progress.phase === "document"
        ? "Parsing document"
        : progress.phase === "rendering"
          ? "Rendering PDF"
          : progress.phase === "ocr"
            ? "Running local OCR"
            : "Ready";
    return `${phase}${progress.detail === undefined ? "" : ` · ${progress.detail}`}`;
  }

  private renderAttachmentList(): void {
    const list = this.elements["attachment-list"];
    if (list === undefined) return;
    list.replaceChildren();
    for (const attachment of this.pendingAttachments) {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      const label = document.createElement("span");
      label.className = "attachment-chip-label";
      label.textContent = attachment.name;
      label.title = attachment.name;
      chip.append(label);
      if (!this.busy) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-chip-remove";
        remove.dataset.attachmentId = attachment.id;
        remove.setAttribute("aria-label", `Remove ${attachment.name}`);
        remove.title = "Remove attachment";
        remove.textContent = "×";
        chip.append(remove);
      }
      list.append(chip);
    }
    if (this.attachmentProgress !== undefined) {
      const status = document.createElement("span");
      status.className = "attachment-status";
      status.textContent = this.attachmentProgressLabel(this.attachmentProgress);
      list.append(status);
    }
    if (this.visionRetry !== undefined && !this.busy) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-button attachment-fallback-button";
      retry.dataset.action = "vision-fallback";
      retry.textContent = "改用本地 OCR 并重发";
      list.append(retry);
    }
  }

  private collectModelAttachments(): ModelAttachment[] {
    const ids = new Set<string>();
    for (const message of this.chat.messages) {
      if (message.role !== "user") continue;
      for (const id of message.attachmentIds ?? []) ids.add(id);
    }
    return [...ids].flatMap((id) => {
      const attachment = this.modelAttachments.get(id);
      return attachment === undefined ? [] : [attachment];
    });
  }

  private async retryWithLocalOcr(): Promise<void> {
    if (this.busy || this.visionRetry === undefined) return;
    const retry = this.visionRetry;
    this.visionRetry = undefined;
    this.pendingAttachments = [...retry.files];
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    input.value = retry.content;
    this.resizeMessageInput();
    await this.sendMessage(true);
  }

  private async sendMessage(forceLocalOcr = false): Promise<void> {
    if (!this.ready) {
      this.notify("Starting chat…");
      return;
    }
    if (this.busy) return;
    const harness = this.harness;
    if (harness === undefined || harness.snapshot().selectedModelId === undefined) {
      this.notify("Connect a remote model before sending.", "error");
      return;
    }
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    const rawContent = input.value.trim();
    const selectedAttachments = [...this.pendingAttachments];
    if (!rawContent && selectedAttachments.length === 0) {
      this.notify("Write a message before sending.", "error");
      input.focus();
      return;
    }
    const controller = new AbortController();
    this.runController = controller;
    this.followChat = true;
    this.chatRenderScheduled = false;
    this.setBusy(true);
    let prepared: PreparedAttachments | undefined;
    try {
      if (selectedAttachments.length > 0) {
        prepared = await processAttachmentFiles(
          selectedAttachments,
          forceLocalOcr ? false : this.visionEnabled(),
          controller.signal,
          {},
          (progress) => {
            this.attachmentProgress = progress;
            this.renderAttachmentList();
          },
        );
        this.attachmentProgress = undefined;
        for (const attachment of prepared.attachments) this.modelAttachments.set(attachment.id, attachment);
      }
      const prompt = [
        rawContent,
        prepared?.content,
      ].filter((value): value is string => value !== undefined && value.trim().length > 0).join("\n\n");
      const processed = await harness.process({
        role: "user",
        content: prompt || "Please analyze the attached files.",
      }, controller.signal);
      if (!isMessageEnvelope(processed) || processed.role !== "user" || typeof processed.content !== "string") {
        throw new Error("A message processor must return a user message.");
      }
      const content = processed.content.trim();
      if (!content) throw new Error("The processed message is empty.");
      const processedAttachmentIds = Array.isArray(processed.attachmentIds)
        ? processed.attachmentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      const attachmentIds = [...new Set([...processedAttachmentIds, ...(prepared?.attachmentIds ?? [])])];
      const userMessage: UserMessage = {
        role: "user",
        content,
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
      };
      this.chat.messages = normalizeMessages([...this.chat.messages, userMessage]);
      input.value = "";
      this.pendingAttachments = [];
      this.visionRetry = undefined;
      this.resizeMessageInput();
      this.pendingToolCalls = [];
      this.liveToolEntries = [];
      this.liveToolSequence = 0;
      this.pendingStream = [];
      this.pendingStreamSequence = 0;
      this.renderAll();
      const modelAttachments = this.collectModelAttachments();
      const result = await harness.run({
        messages: this.chat.messages,
        ...(modelAttachments.length === 0 ? {} : { attachments: modelAttachments }),
        signal: controller.signal,
        onEvent: (event) => this.handleAgentEvent(event),
      });
      this.chat.messages = normalizeMessages(result.messages);
      if (result.status === "completed") this.notify("Response complete.", "success");
      else if (result.status === "cancelled") this.notify("Run cancelled.", "error");
      else if (result.status === "max-turns") this.notify("Run stopped at the turn limit.", "error");
      else {
        if (prepared?.usedVision) {
          this.visionRetry = { content: rawContent, files: selectedAttachments };
          this.pendingAttachments = [...selectedAttachments];
          this.notify("The vision request failed. You can retry once with local OCR.", "error");
        } else {
          this.notify(result.error?.message ?? "The model could not complete this run.", "error");
        }
      }
    } catch (error) {
      if (prepared?.usedVision && !controller.signal.aborted) {
        this.visionRetry = { content: rawContent, files: selectedAttachments };
        this.pendingAttachments = [...selectedAttachments];
        this.notify("The vision request failed. You can retry once with local OCR.", "error");
      } else {
        this.notify(error instanceof Error ? error.message : "The run failed.", "error");
      }
    } finally {
      this.attachmentProgress = undefined;
      this.pendingToolCalls = [];
      this.liveToolEntries = [];
      this.pendingStream = [];
      this.pendingStreamSequence = 0;
      this.runController = undefined;
      this.setBusy(false);
      this.renderAll();
      this.focusComposer(true);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text-delta":
        this.appendPendingStreamText("text", event.delta);
        this.notify("Receiving response…");
        this.scheduleChatRender();
        break;
      case "reasoning-delta":
        this.appendPendingStreamText("thinking", event.delta);
        this.notify("Thinking…");
        this.scheduleChatRender();
        break;
      case "model-started":
        this.pendingToolCalls = [];
        this.ensurePendingThinking();
        this.notify(`Thinking · turn ${event.turn}…`);
        // Paint the open thinking placeholder immediately so very short
        // streams cannot finish before the first animation-frame update.
        this.renderChat();
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
        const liveKey = liveEntry?.key ?? `live-${++this.liveToolSequence}`;
        this.replaceLiveToolEntry({ key: liveKey, status: "preparing", delta: merged });
        this.appendPendingTool(liveKey);
        this.notify(`${merged.name?.trim() || "Tool"} · preparing…`);
        this.scheduleChatRender();
        break;
      }
      case "tool-started":
        {
          const pendingIndex = this.pendingToolCalls.findIndex((delta) => delta.id === event.call.id || delta.name === event.call.name);
          if (pendingIndex >= 0) this.pendingToolCalls = this.pendingToolCalls.filter((_, index) => index !== pendingIndex);
        }
        const liveEntry = this.liveToolEntries.find((entry) => entry.status === "preparing" && (entry.delta.id === event.call.id || entry.delta.name === event.call.name));
        const liveKey = liveEntry?.key ?? `live-${++this.liveToolSequence}`;
        this.replaceLiveToolEntry({ key: liveKey, status: "running", call: event.call });
        this.appendPendingTool(liveKey);
        this.notify(`Running ${event.call.name}…`);
        this.renderChat();
        break;
      case "tool-finished":
        {
          const liveEntry = this.liveToolEntries.find((entry) => entry.status === "running" && (entry.call.id === event.call.id || entry.call.name === event.call.name));
          this.replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++this.liveToolSequence}`, status: "finished", call: event.call, result: event.result });
        }
        this.notify(event.result.ok ? `Finished ${event.call.name}.` : `${event.call.name} returned an error.`, event.result.ok ? "success" : "error");
        this.renderChat();
        break;
      case "run-error":
        this.notify(event.error.message, "error");
        break;
      case "run-finished":
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
    send.hidden = !value;
    send.setAttribute("aria-busy", String(value));
    send.setAttribute("aria-label", value ? "Stop generation" : "Send message");
    send.classList.toggle("stop-button", value);
    const label = send.querySelector<HTMLElement>(".button-label");
    if (label !== null) label.textContent = value ? "Stop" : "Send";
    input.disabled = value;
    const attachmentButton = this.elements["attachment-button"] as HTMLButtonElement | undefined;
    if (attachmentButton !== undefined) attachmentButton.disabled = value;
    const spinner = send.querySelector<HTMLElement>(".spinner");
    if (spinner !== null) spinner.hidden = true;
    this.renderAttachmentList();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.elements[id];
    if (element === undefined) throw new Error(`UI element “${id}” is missing.`);
    return element as T;
  }

  private renderAll(): void {
    this.renderChat();
    this.renderExtensions();
    this.renderAttachmentList();
  }

  private scheduleChatRender(): void {
    if (this.chatRenderScheduled) return;
    this.chatRenderScheduled = true;
    const render = () => {
      if (!this.chatRenderScheduled) return;
      this.chatRenderScheduled = false;
      if (this.ready) this.renderChat();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(render);
    // A backgrounded or headless tab may throttle animation frames. The
    // timeout is a safety net and is ignored when the frame already flushed.
    window.setTimeout(render, 50);
  }

  private renderChat(): void {
    const chat = this.elements["chat-log"];
    const conversation = this.elements["conversation-content"];
    const connectionCard = this.elements["connection-card"];
    if (chat === undefined || conversation === undefined || connectionCard === undefined) return;
    chat.setAttribute("aria-busy", String(this.busy));
    const selectedModelId = this.harness?.snapshot().selectedModelId;
    connectionCard.hidden = selectedModelId !== undefined && !this.connectionEditing;
    const fullRender = this.renderedMessages !== this.chat.messages
      || this.renderedModelId !== selectedModelId
      || this.renderedConnectionEditing !== this.connectionEditing;
    if (fullRender) {
      conversation.replaceChildren();
      if (this.chat.messages.length === 0 && this.pendingStream.length === 0 && this.liveToolEntries.length === 0) {
        if (selectedModelId !== undefined) {
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
        conversation.append(...messageElements(this.chat.messages, this.modelAttachments));
        this.appendPendingMessages(conversation);
      }
      this.renderedMessages = this.chat.messages;
      this.renderedModelId = selectedModelId;
      this.renderedConnectionEditing = this.connectionEditing;
    } else {
      this.updatePendingMessages(conversation);
    }
    if (this.followChat || this.chat.messages.length === 0) this.scrollChatToBottom();
    else this.updateScrollButton();
  }

  private appendPendingStreamText(kind: "text" | "thinking", delta: string): void {
    if (delta.length === 0) return;
    const last = this.pendingStream.at(-1);
    if (last?.kind === kind) {
      this.pendingStream = [...this.pendingStream.slice(0, -1), { ...last, text: last.text + delta }];
      return;
    }
    this.pendingStream = [...this.pendingStream, { key: `stream-${++this.pendingStreamSequence}`, kind, text: delta }];
  }

  private ensurePendingThinking(): void {
    const last = this.pendingStream.at(-1);
    if (last?.kind === "thinking" && last.text.length === 0) return;
    this.pendingStream = [...this.pendingStream, { key: `stream-${++this.pendingStreamSequence}`, kind: "thinking", text: "" }];
    this.scheduleChatRender();
  }

  private appendPendingTool(key: string): void {
    if (this.pendingStream.some((segment) => segment.kind === "tools" && segment.toolKeys.includes(key))) return;
    const last = this.pendingStream.at(-1);
    if (last?.kind === "tools") {
      this.pendingStream = [...this.pendingStream.slice(0, -1), { ...last, toolKeys: [...last.toolKeys, key] }];
      return;
    }
    this.pendingStream = [...this.pendingStream, { key: `stream-${++this.pendingStreamSequence}`, kind: "tools", toolKeys: [key] }];
  }

  private pendingToolEntries(keys: readonly string[]): LiveToolEntry[] {
    return keys.flatMap((key) => {
      const entry = this.liveToolEntries.find((candidate) => candidate.key === key);
      return entry === undefined ? [] : [entry];
    });
  }

  private pendingAssistantElement(segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): HTMLElement | null {
    const element = segment.kind === "thinking"
      ? messageElement({ role: "assistant", content: "", reasoning: segment.text }, true)
      : messageElement({ role: "assistant", content: segment.text }, true);
    if (element !== null) element.dataset.streamKey = segment.key;
    return element;
  }

  private updatePendingAssistantElement(element: HTMLElement, segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): void {
    if (segment.kind === "thinking") {
      element.querySelector(":scope > .message-body")?.remove();
      let thinking = element.querySelector<HTMLDetailsElement>(":scope > .thinking-block");
      if (thinking === null) {
        thinking = thinkingElement(segment.text, true);
        element.prepend(thinking);
      } else {
        updateThinkingElement(thinking, segment.text, true);
      }
      return;
    }
    element.querySelector(":scope > .thinking-block")?.remove();
    if (segment.text.trim().length === 0) {
      element.querySelector(":scope > .message-body")?.remove();
      return;
    }
    let body = element.querySelector<HTMLElement>(":scope > .message-body");
    if (body === null) {
      body = document.createElement("div");
      body.className = "message-body";
      element.append(body);
    }
    if (body.dataset.renderedSource === segment.text) return;
    body.dataset.renderedSource = segment.text;
    renderRichContent(body, segment.text, { streaming: true });
  }

  private pendingToolGroupElement(
    segment: Extract<PendingStreamSegment, { readonly kind: "tools" }>,
    existing: HTMLDetailsElement | undefined,
  ): HTMLDetailsElement | undefined {
    const existingItems = new Map<string, HTMLDetailsElement>();
    if (existing !== undefined) {
      for (const item of existing.querySelectorAll<HTMLDetailsElement>(":scope > .tool-group-body > details.tool-detail")) {
        if (item.dataset.toolKey !== undefined) existingItems.set(item.dataset.toolKey, item);
      }
    }
    const items: HTMLElement[] = [];
    for (const entry of this.pendingToolEntries(segment.toolKeys)) {
      let item = existingItems.get(entry.key);
      if (item === undefined) item = this.createLiveToolElement(entry);
      if (item === undefined) continue;
      this.updateLiveToolElement(item, entry);
      items.push(item);
      existingItems.delete(entry.key);
    }
    if (items.length === 0) return undefined;
    const group = existing ?? toolGroupElement(items, true);
    group.dataset.streamKey = segment.key;
    if (existing !== undefined) updateToolGroupElement(group, items, true);
    return group;
  }

  private appendPendingMessages(conversation: HTMLElement): void {
    for (const segment of this.pendingStream) {
      if (segment.kind === "tools") {
        const group = this.pendingToolGroupElement(segment, undefined);
        if (group !== undefined) conversation.append(group);
        continue;
      }
      const element = this.pendingAssistantElement(segment);
      if (element !== null) conversation.append(element);
    }
  }

  private updatePendingMessages(conversation: HTMLElement): void {
    const existing = new Map<string, HTMLElement>();
    for (const element of conversation.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")) {
      if (element.dataset.streamKey !== undefined) existing.set(element.dataset.streamKey, element);
    }
    const desired: HTMLElement[] = [];
    for (const segment of this.pendingStream) {
      const current = existing.get(segment.key);
      if (segment.kind === "tools") {
        const group = this.pendingToolGroupElement(segment, current instanceof HTMLDetailsElement ? current : undefined);
        if (group !== undefined) desired.push(group);
      } else {
        let element = current;
        if (element === undefined || !element.classList.contains("message")) {
          element?.remove();
          element = this.pendingAssistantElement(segment) ?? undefined;
        } else {
          this.updatePendingAssistantElement(element, segment);
        }
        if (element !== undefined) desired.push(element);
      }
      existing.delete(segment.key);
    }
    for (const element of existing.values()) element.remove();
    const currentOrder = Array.from(conversation.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.streamKey !== undefined);
    const sameOrder = currentOrder.length === desired.length && currentOrder.every((element, index) => element === desired[index]);
    if (!sameOrder) conversation.append(...desired);
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
    if (!(element instanceof HTMLDetailsElement)) return undefined;
    element.dataset.toolKey = entry.key;
    return element;
  }

  private updateLiveToolElement(details: HTMLDetailsElement, entry: LiveToolEntry): void {
    if (entry.status === "preparing") {
      updateStreamingToolElement(details, entry.delta, entry.key);
      return;
    }
    const nextClassName = `tool-detail pending${entry.status === "finished" ? " tool-call-complete" : ""}`;
    if (details.className !== nextClassName) details.className = nextClassName;
    details.dataset.toolKey = entry.key;
    const summary = details.querySelector<HTMLElement>(":scope > .tool-summary");
    const body = details.querySelector<HTMLElement>(":scope > .tool-detail-body");
    if (summary === null || body === null) return;
    const nextSummary = entry.status === "running"
      ? `${entry.call.name} · running`
      : `${entry.call.name}${entry.result.ok ? " · complete" : " · error"}`;
    const nextBody = entry.status === "running" ? `Running ${entry.call.name}…` : this.liveToolResultContent(entry.result);
    if (summary.textContent !== nextSummary) summary.textContent = nextSummary;
    body.classList.toggle("tool-error", entry.status === "finished" && !entry.result.ok);
    if (body.textContent !== nextBody) body.textContent = nextBody;
    if (!details.open) details.open = true;
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

  private scheduleChatFollowState(): void {
    const chat = this.elements["chat-log"];
    if (chat === undefined) return;
    const scrollingUp = chat.scrollTop < this.lastChatScrollTop - 1;
    this.lastChatScrollTop = chat.scrollTop;
    if (scrollingUp) this.followChat = false;
    if (this.chatFollowScheduled) return;
    this.chatFollowScheduled = true;
    const update = () => {
      if (!this.chatFollowScheduled) return;
      this.chatFollowScheduled = false;
      this.updateChatFollowState();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
    window.setTimeout(update, 50);
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
    chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight);
    this.lastChatScrollTop = chat.scrollTop;
    this.scheduleChatScroll();
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
      if (!this.chatScrollScheduled) return;
      this.chatScrollScheduled = false;
      if (this.followChat) {
        const chat = this.elements["chat-log"];
        if (chat !== undefined) {
          const nextTop = Math.max(0, chat.scrollHeight - chat.clientHeight);
          if (chat.scrollTop !== nextTop) {
            chat.scrollTop = nextTop;
            this.lastChatScrollTop = chat.scrollTop;
          }
        }
        this.updateScrollButton();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    window.setTimeout(scroll, 50);
  }

  private renderExtensions(): void {
    if (this.harness === undefined) return;
    const extensionHost = this.elements["extension-host"];
    if (extensionHost === undefined) return;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    extensionHost.replaceChildren();
    this.uiCleanup = this.harness.mountUi(extensionHost);
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
      const harness = this.harness;
      if (harness === undefined) throw new Error("The Browser Agent Harness is not ready.");
      const handle = await harness.install(createRemoteModelPlugin({
        endpoint: values.endpoint,
        model: values.model,
        apiKey: values.apiKey,
        supportsVision: values.supportsVision,
        reasoning: values.thinkingLevel,
      }));
      this.remoteHandle = handle;
      harness.selectModel("remote-model");
      await saveConnectionSettings(this.store, values);
      await this.saveBrowserCredential(values);
      this.connectionEditing = false;
      this.element("connection-status").textContent = "Remote model selected. Connection settings saved in this browser.";
      this.notify("Remote model selected.", "success");
    } catch (error) {
      if (this.remoteHandle !== undefined) {
        await this.remoteHandle.uninstall();
        this.remoteHandle = undefined;
      }
      this.harness?.clearModel();
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
    if (!this.ready || this.harness?.snapshot().selectedModelId !== undefined) return;
    const settings = credentialSettings === undefined
      ? savedSettings
      : {
        endpoint: savedSettings?.endpoint || credentialSettings.endpoint,
        model: credentialSettings.model || savedSettings?.model || "",
        apiKey: credentialSettings.apiKey || savedSettings?.apiKey || "",
        thinkingLevel: savedSettings?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        supportsVision: savedSettings?.supportsVision ?? false,
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
