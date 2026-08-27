import { createHarness, type Harness } from "../harness.js";
import { createBrowserStateStore } from "../core/state.js";
import { isMessageEnvelope, normalizeMessages } from "./chat.js";
import { createAttachmentIntake, createPendingAttachment, type AttachmentIntake, type AttachmentProgress, type PendingAttachment, type PreparedAttachments } from "./attachments.js";
import { DEFAULT_THINKING_LEVEL, loadConnectionSettings, type ConnectionSettings } from "./connection-settings.js";
import { createModelConnection, validateConnectionDraft, type ModelConnection } from "./model-connection.js";
import { createDomStreamPresentationAdapter, createStreamPresentation, type StreamPresentation } from "./stream-presentation.js";
import { messageElements, renderShell, textElement, type AppElements } from "./view.js";
import type { AgentEvent, ModelAttachment, ModelMessage, Plugin, UserMessage } from "../core/types.js";
import type { StateStore } from "../core/types.js";

interface VisionRetry {
  readonly content: string;
  readonly files: readonly PendingAttachment[];
  readonly historyLength: number;
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
  private chat: { messages: ModelMessage[] } = { messages: [] };
  private store!: StateStore;
  private harness: Harness | undefined;
  private attachmentIntake: AttachmentIntake | undefined;
  private streamPresentation: StreamPresentation | undefined;
  private modelConnection: ModelConnection | undefined;
  private uiCleanup: (() => void) | undefined;
  private ready = false;
  private busy = false;
  private runController: AbortController | undefined;
  private chatRenderScheduled = false;
  private chatObserver: MutationObserver | undefined;
  private renderedMessages: readonly ModelMessage[] | undefined;
  private selectedModelId: string | undefined;
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

  get runtime(): Harness | undefined {
    return this.harness;
  }

  async start(): Promise<void> {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "auto";
    Object.assign(this.elements, renderShell(this.root));
    let streamPresentation: StreamPresentation | undefined;
    const streamAdapter = createDomStreamPresentationAdapter({
      conversation: this.element("conversation-content"),
      chat: this.element("chat-log"),
      scrollButton: this.element("scroll-bottom-button"),
      hasCommittedMessages: () => this.chat.messages.length > 0,
      onProgrammaticScroll: (scrollTop) => streamPresentation?.recordProgrammaticScroll(scrollTop),
    });
    streamPresentation = createStreamPresentation(streamAdapter);
    this.streamPresentation = streamPresentation;
    this.bindEvents();
    this.chat = { messages: [] };
    this.store = createBrowserStateStore({ databaseName: "static-web-agent", objectStoreName: "workspace" });
    const savedSettings = await loadConnectionSettings(this.store);
    this.applyConnectionSettings(savedSettings);
    this.attachmentIntake = createAttachmentIntake();
    this.harness = await createHarness({
      stateStore: this.store,
      ...(this.options.plugins === undefined ? {} : { plugins: this.options.plugins }),
      ...(this.options.initialModelId === undefined ? {} : { initialModelId: this.options.initialModelId }),
    });
    this.modelConnection = createModelConnection({ harness: this.harness, store: this.store });
    this.harness.subscribe((snapshot) => {
      this.selectedModelId = snapshot.selectedModelId;
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
    await this.attachmentIntake?.dispose();
    this.chatObserver?.disconnect();
    this.chatObserver = undefined;
    this.streamPresentation?.reset();
    this.streamPresentation = undefined;
    this.renderedMessages = undefined;
    this.selectedModelId = undefined;
    this.renderedModelId = undefined;
    this.renderedConnectionEditing = false;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    await this.harness?.dispose();
    this.harness = undefined;
    this.modelConnection = undefined;
    this.pendingAttachments = [];
    this.modelAttachments.clear();
    this.attachmentIntake = undefined;
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
    chat?.addEventListener("scroll", () => {
      if (this.streamPresentation !== undefined) {
        this.streamPresentation.onScroll(chat);
        this.streamPresentation.render();
      }
    }, { passive: true });
    chat?.addEventListener("wheel", (event) => {
      this.streamPresentation?.markUserScrollGesture(event.deltaY < 0);
      this.streamPresentation?.render();
    }, { passive: true });
    chat?.addEventListener("touchmove", () => {
      this.streamPresentation?.markUserScrollGesture();
      this.streamPresentation?.render();
    }, { passive: true });
    chat?.addEventListener("pointerdown", () => {
      this.streamPresentation?.markUserScrollGesture();
      this.streamPresentation?.render();
    }, { passive: true });
    this.elements["scroll-bottom-button"]?.addEventListener("click", () => {
      this.streamPresentation?.scrollToLatest();
      this.streamPresentation?.render();
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
        if (this.streamPresentation?.snapshot().followChat) this.scheduleChatRender();
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
    const validation = validateConnectionDraft({
      endpoint: String(data.get("endpoint") ?? ""),
      model: String(data.get("model") ?? ""),
      apiKey: String(data.get("apiKey") ?? ""),
      thinkingLevel: String(data.get("thinkingLevel") ?? DEFAULT_THINKING_LEVEL),
      supportsVision: data.get("supportsVision") === "on",
    });
    let firstInvalid: HTMLInputElement | undefined;
    if (validation.errors.endpoint !== undefined) {
      this.setFieldError("model-endpoint", validation.errors.endpoint);
      firstInvalid ??= this.elements["model-endpoint"] as HTMLInputElement;
    }
    if (validation.errors.model !== undefined) {
      this.setFieldError("model-name", validation.errors.model);
      firstInvalid ??= this.elements["model-name"] as HTMLInputElement;
    }
    if (firstInvalid !== undefined) {
      firstInvalid.focus();
      this.notify("Check the highlighted connection fields.", "error");
      return undefined;
    }
    return validation.settings;
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

  private pruneModelAttachments(): void {
    const liveIds = new Set<string>();
    for (const message of this.chat.messages) {
      if (message.role !== "user") continue;
      for (const id of message.attachmentIds ?? []) liveIds.add(id);
    }
    for (const id of this.modelAttachments.keys()) {
      if (!liveIds.has(id)) this.modelAttachments.delete(id);
    }
  }

  private async retryWithLocalOcr(): Promise<void> {
    if (this.busy || this.visionRetry === undefined) return;
    const retry = this.visionRetry;
    this.visionRetry = undefined;
    this.chat.messages = normalizeMessages(this.chat.messages.slice(0, retry.historyLength));
    this.pruneModelAttachments();
    this.renderedMessages = undefined;
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
    if (harness === undefined || this.selectedModelId === undefined) {
      this.notify("Connect a remote model before sending.", "error");
      return;
    }
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    const rawContent = input.value.trim();
    const selectedAttachments = [...this.pendingAttachments];
    const historyLength = this.chat.messages.length;
    if (!rawContent && selectedAttachments.length === 0) {
      this.notify("Write a message before sending.", "error");
      input.focus();
      return;
    }
    const controller = new AbortController();
    this.runController = controller;
    this.streamPresentation?.startRun();
    this.chatRenderScheduled = false;
    this.setBusy(true);
    let prepared: PreparedAttachments | undefined;
    try {
      if (selectedAttachments.length > 0) {
        const attachmentIntake = this.attachmentIntake;
        if (attachmentIntake === undefined) throw new Error("Attachment intake is not ready.");
        prepared = await attachmentIntake.process(selectedAttachments, {
          supportsVision: forceLocalOcr ? false : this.visionEnabled(),
          signal: controller.signal,
          onProgress: (progress) => {
            this.attachmentProgress = progress;
            this.renderAttachmentList();
          },
        });
        this.attachmentProgress = undefined;
        for (const attachment of prepared.attachments) this.modelAttachments.set(attachment.id, attachment);
      }
      const prompt = [
        rawContent,
        prepared?.content,
      ].filter((value): value is string => value !== undefined && value.trim().length > 0).join("\n\n");
      const processed = await harness.kernel.process({
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
      this.renderAll();
      const modelAttachments = this.collectModelAttachments();
      const result = await harness.run({
        messages: this.chat.messages,
        ...(modelAttachments.length === 0 ? {} : { attachments: modelAttachments }),
        signal: controller.signal,
        onEvent: (event) => this.handleAgentEvent(event),
      });
      this.chat.messages = normalizeMessages(result.messages);
      this.pruneModelAttachments();
      if (result.status === "completed") this.notify("Response complete.", "success");
      else if (result.status === "cancelled") this.notify("Run cancelled.", "error");
      else if (result.status === "max-turns") this.notify("Run stopped at the turn limit.", "error");
      else {
        if (prepared?.usedVision) {
          this.visionRetry = { content: rawContent, files: selectedAttachments, historyLength };
          this.pendingAttachments = [...selectedAttachments];
          this.notify("The vision request failed. You can retry once with local OCR.", "error");
        } else {
          this.notify(result.error?.message ?? "The model could not complete this run.", "error");
        }
      }
    } catch (error) {
      if (prepared?.usedVision && !controller.signal.aborted) {
        this.visionRetry = { content: rawContent, files: selectedAttachments, historyLength };
        this.pendingAttachments = [...selectedAttachments];
        this.notify("The vision request failed. You can retry once with local OCR.", "error");
      } else {
        this.notify(error instanceof Error ? error.message : "The run failed.", "error");
      }
    } finally {
      this.attachmentProgress = undefined;
      this.streamPresentation?.resetPending();
      this.runController = undefined;
      this.setBusy(false);
      this.renderAll();
      this.focusComposer(true);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    this.streamPresentation?.handle(event);
    switch (event.type) {
      case "text-delta":
        this.notify("Receiving response…");
        this.scheduleChatRender();
        break;
      case "reasoning-delta":
        this.notify("Thinking…");
        this.scheduleChatRender();
        break;
      case "model-started":
        this.notify(`Thinking · turn ${event.turn}…`);
        // Paint the open thinking placeholder immediately so very short
        // streams cannot finish before the first animation-frame update.
        this.renderChat();
        break;
      case "tool-call-delta": {
        const merged = this.streamPresentation?.snapshot().pendingToolCalls.find((delta) => delta.index === event.delta.index);
        this.notify(`${merged?.name?.trim() || "Tool"} · preparing…`);
        this.scheduleChatRender();
        break;
      }
      case "tool-started":
        this.notify(`Running ${event.call.name}…`);
        this.renderChat();
        break;
      case "tool-finished":
        this.notify(event.result.ok ? `Finished ${event.call.name}.` : `${event.call.name} returned an error.`, event.result.ok ? "success" : "error");
        this.renderChat();
        break;
      case "run-error":
        this.notify(event.error.message, "error");
        break;
      case "run-finished":
        this.renderChat();
        break;
      case "run-started":
      case "assistant-message":
        break;
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.streamPresentation?.setBusy(value);
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
    const stream = this.streamPresentation?.snapshot();
    const hasStreaming = (stream?.pendingStream.length ?? 0) > 0 || (stream?.liveToolEntries.length ?? 0) > 0;
    chat.setAttribute("aria-busy", String(this.busy));
    const selectedModelId = this.selectedModelId;
    connectionCard.hidden = selectedModelId !== undefined && !this.connectionEditing;
    const fullRender = this.renderedMessages !== this.chat.messages
      || this.renderedModelId !== selectedModelId
      || this.renderedConnectionEditing !== this.connectionEditing;
    if (fullRender) {
      conversation.replaceChildren();
      if (this.chat.messages.length === 0 && !hasStreaming) {
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
      }
      this.renderedMessages = this.chat.messages;
      this.renderedModelId = selectedModelId;
      this.renderedConnectionEditing = this.connectionEditing;
    } else {
      // The stream adapter owns incremental DOM updates.
    }
    this.streamPresentation?.render();
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
    this.pruneModelAttachments();
    this.renderedMessages = undefined;
    this.renderChat();
    const input = this.elements["message-input"] as HTMLTextAreaElement;
    input.value = next;
    await this.sendMessage();
  }

  private renderExtensions(): void {
    if (this.harness === undefined) return;
    const extensionHost = this.elements["extension-host"];
    if (extensionHost === undefined) return;
    this.uiCleanup?.();
    this.uiCleanup = undefined;
    extensionHost.replaceChildren();
    this.uiCleanup = this.harness.kernel.mountUi(extensionHost);
  }

  private async connectRemote(form: HTMLFormElement, automatic = false): Promise<void> {
    if (!this.ready || this.busy) return;
    const submit = this.elements["connection-submit"] as HTMLButtonElement | undefined;
    const spinner = submit?.querySelector<HTMLElement>(".spinner");
    const values = this.connectionValues(form);
    if (values === undefined) return;
    this.element("connection-status").className = "connection-status sr-only";
    this.element("connection-status").textContent = automatic ? "Restoring your saved cloud model…" : "";
    if (submit !== null && submit !== undefined) submit.disabled = true;
    if (spinner !== null && spinner !== undefined) spinner.hidden = false;
    try {
      const connection = this.modelConnection;
      if (connection === undefined) throw new Error("The Model Connection is not ready.");
      const result = await connection.connect(values);
      if (result.credentialSaved) {
        this.element("credential-status").textContent = "Saved the model name as the password-manager username and the API key as the password; endpoint saved locally.";
      }
      this.connectionEditing = false;
      this.element("connection-status").textContent = "Remote model selected. Connection settings saved in this browser.";
      this.notify("Remote model selected.", "success");
    } catch (error) {
      this.connectionEditing = true;
      const status = this.element("connection-status");
      status.className = "connection-status";
      status.textContent = error instanceof Error ? error.message : "Could not select the model.";
      this.notify(status.textContent, "error");
    } finally {
      if (submit !== null && submit !== undefined) submit.disabled = false;
      if (spinner !== null && spinner !== undefined) spinner.hidden = true;
      this.renderChat();
    }
  }

  private async autoConnect(savedSettings: ConnectionSettings | undefined): Promise<void> {
    if (this.autoConnectStarted || !this.ready) return;
    this.autoConnectStarted = true;
    const connection = this.modelConnection;
    if (connection === undefined) return;
    const restored = await connection.restore(savedSettings);
    if (!this.ready || this.selectedModelId !== undefined) return;
    const settings = restored.settings;
    if (settings === undefined) return;
    if (!settings.endpoint || !settings.model) return;
    this.applyConnectionSettings(settings);
    const form = this.elements["connection-form"];
    if (!(form instanceof HTMLFormElement)) return;
    if (restored.source === "credential") {
      this.element("credential-status").textContent = "Restoring a saved connection from this browser's password manager.";
    } else {
      this.element("credential-status").textContent = "Restoring a saved connection from this browser's local settings.";
    }
    await this.connectRemote(form, true);
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
