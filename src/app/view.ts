import type { ModelAttachment, ModelMessage, ToolCallDelta } from "../core/types.js";
import { bindCopyButton, renderRichContent } from "./rich-content.js";

export type AppElements = Record<string, HTMLElement>;

export function textElement(tag: keyof HTMLElementTagNameMap, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  return element;
}

export function renderShell(root: HTMLElement): AppElements {
  root.innerHTML = `
    <div class="app-shell">
      <main class="workspace" id="main-content" tabindex="-1" aria-label="Chat workspace">
        <div class="extension-host" id="extension-host" aria-label="Plugin extensions"></div>

        <section class="chat-scroll" id="chat-log" aria-label="Conversation" aria-busy="true">
          <section class="connection-card" id="connection-card" aria-labelledby="connection-title">
            <div class="connection-intro">
              <h2 id="connection-title">Connect your cloud model</h2>
              <button class="primary-button connection-save-button" id="connection-submit" form="connection-form" type="submit"><span class="button-content"><span class="button-label">Save</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
            </div>
            <form class="connection-form" id="connection-form" novalidate>
              <div class="field">
                <label for="model-endpoint">OpenAI-compatible endpoint or API base</label>
                <input id="model-endpoint" name="endpoint" type="url" inputmode="url" autocomplete="url" aria-describedby="endpoint-error" aria-invalid="false" placeholder="https://provider.example/v1 or …/chat/completions" />
                <p class="field-error" id="endpoint-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field credential-field">
                <label for="model-name">Model name</label>
                <input id="model-name" name="model" type="text" inputmode="text" autocomplete="username" aria-describedby="model-error" aria-invalid="false" placeholder="model-name…" />
                <p class="field-error" id="model-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field credential-field api-key-field">
                <label for="model-key">API key</label>
                <input id="model-key" name="apiKey" type="password" autocomplete="current-password" placeholder="Paste a key…" />
              </div>
              <div class="field thinking-level-field">
                <label for="thinking-level">Thinking level</label>
                <select id="thinking-level" name="thinkingLevel" aria-describedby="thinking-level-help">
                  <option value="provider-default">Auto (provider default)</option>
                  <option value="none">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Maximum</option>
                </select>
                <p class="field-help" id="thinking-level-help">Controls how much reasoning the model is asked to use. Providers may ignore unsupported levels.</p>
              </div>
              <div class="vision-setting">
                <label class="checkbox-label" for="model-vision">
                  <input id="model-vision" name="supportsVision" type="checkbox" />
                  <span>Model supports image input</span>
                </label>
              </div>
              <p class="credential-status sr-only" id="credential-status" role="status" aria-live="polite">The model name is the password-manager username; the API key is the password; endpoint is saved locally.</p>
              <p class="connection-status sr-only" id="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
            </form>
          </section>
          <div class="conversation-content" id="conversation-content">
            <div class="loading-state" role="status" aria-live="polite">
              <span class="loading-line loading-line-wide" aria-hidden="true"></span>
              <span class="loading-line loading-line-short" aria-hidden="true"></span>
              <span class="loading-label">Starting chat…</span>
            </div>
          </div>
          <button class="scroll-bottom-button" id="scroll-bottom-button" type="button" aria-label="Scroll to latest response" title="Scroll to latest response" hidden>
            <span aria-hidden="true">↓</span>
          </button>
        </section>
        <div class="composer-wrap">
          <form class="composer" id="composer-form">
            <label class="sr-only" for="message-input">Message the agent</label>
            <div class="attachment-bar" id="attachment-bar">
              <input id="attachment-input" type="file" accept="image/*,.pdf,.doc,.docx,.odt,.rtf,.epub,.ppt,.pptx,.xls,.xlsx,.csv,.txt" multiple hidden />
              <div class="attachment-list" id="attachment-list" aria-live="polite"></div>
            </div>
            <div class="composer-input-row">
              <button class="icon-button attachment-button" id="attachment-button" type="button" aria-label="Attach files" title="Attach files">＋</button>
              <textarea id="message-input" name="message" rows="1" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true"></textarea>
              <button class="primary-button send-button" id="send-button" type="submit" aria-label="Stop generation" hidden><span class="button-content"><span class="stop-icon" aria-hidden="true"></span><span class="button-label sr-only">Stop</span></span></button>
            </div>
            <p class="status-message sr-only" id="run-status" role="status" aria-live="polite" aria-atomic="true"></p>
          </form>
        </div>
      </main>
    </div>
  `;
  const elements: AppElements = {};
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) elements[element.id] = element;
  return elements;
}

function attachmentNamesForMessage(message: ModelMessage, attachmentNames: ReadonlyMap<string, ModelAttachment> | undefined): readonly string[] {
  if (message.role !== "user" || message.attachmentIds === undefined || attachmentNames === undefined) return [];
  return message.attachmentIds.map((id) => attachmentNames.get(id)?.name ?? id);
}

export function messageElement(message: ModelMessage, pending = false, messageIndex?: number, attachmentNames?: ReadonlyMap<string, ModelAttachment>): HTMLElement | null {
  if (message.role === "tool") {
    const details = document.createElement("details");
    details.className = `tool-detail${pending ? " pending" : ""}`;
    details.dataset.toolKey = message.callId;
    const summary = document.createElement("summary");
    summary.className = "tool-summary";
    summary.setAttribute("translate", "no");
    summary.textContent = pending ? `${message.name} · running` : `${message.name}${message.isError === true ? " · error" : ""}`;
    const body = document.createElement("div");
    body.className = "tool-detail-body";
    if (message.isError === true) body.classList.add("tool-error");
    body.textContent = message.content;
    details.append(summary, body);
    return details;
  }
  const hasReasoning = message.role === "assistant" && message.reasoning !== undefined && message.reasoning.trim().length > 0;
  const hasPendingReasoning = message.role === "assistant" && pending && message.reasoning !== undefined;
  if (message.role === "assistant" && message.content.trim().length === 0 && !hasReasoning && !hasPendingReasoning) return null;

  const article = document.createElement("article");
  article.className = `message ${message.role}${pending ? " pending" : ""}`;
  if (messageIndex !== undefined) article.dataset.messageIndex = String(messageIndex);
  if (hasReasoning || hasPendingReasoning) article.append(thinkingElement(message.reasoning ?? "", pending));
  if (message.content.length > 0) {
    const body = document.createElement("div");
    body.className = "message-body";
    if (pending) renderRichContent(body, message.content, { streaming: true });
    else if (message.role === "assistant" || message.role === "user") renderRichContent(body, message.content);
    else body.textContent = message.content;
    article.append(body);
  }
  const names = attachmentNamesForMessage(message, attachmentNames);
  if (names.length > 0) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    for (const name of names) {
      const chip = document.createElement("span");
      chip.className = "message-attachment-chip";
      chip.textContent = name;
      chip.title = name;
      attachments.append(chip);
    }
    article.append(attachments);
  }
  if ((message.role === "assistant" || message.role === "user") && !pending) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-action copy-message-button";
    copy.setAttribute("aria-label", "Copy message");
    copy.title = "Copy message";
    copy.textContent = "⧉";
    bindCopyButton(copy, message.content);
    actions.append(copy);
    if (message.role === "user" && messageIndex !== undefined) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "message-action edit-message-button";
      edit.dataset.action = "edit-message";
      edit.dataset.messageIndex = String(messageIndex);
      edit.setAttribute("aria-label", "Edit and resend message");
      edit.title = "Edit and resend";
      edit.textContent = "✎";
      actions.append(edit);
    }
    article.append(actions);
  }
  return article;
}

export function thinkingElement(reasoning: string, pending = false): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = `thinking-block${pending ? " pending" : ""}`;
  details.dataset.thinking = "true";
  const summary = document.createElement("summary");
  summary.className = "thinking-summary";
  summary.textContent = pending ? "Thinking…" : "Thinking";
  const body = document.createElement("div");
  body.className = "thinking-body";
  if (pending) {
    body.dataset.renderedSource = reasoning;
    renderRichContent(body, reasoning, { streaming: true });
  }
  else renderRichContent(body, reasoning);
  details.append(summary, body);
  details.open = pending;
  return details;
}

export function updateThinkingElement(details: HTMLDetailsElement, reasoning: string, pending = true): void {
  details.className = `thinking-block${pending ? " pending" : ""}`;
  details.dataset.thinking = "true";
  const summary = details.querySelector<HTMLElement>(":scope > .thinking-summary");
  const body = details.querySelector<HTMLElement>(":scope > .thinking-body");
  if (summary === null || body === null) return;
  summary.textContent = pending ? "Thinking…" : "Thinking";
  if (pending) {
    if (body.dataset.renderedSource !== reasoning) {
      body.dataset.renderedSource = reasoning;
      renderRichContent(body, reasoning, { streaming: true });
    }
  } else {
    body.replaceChildren();
    renderRichContent(body, reasoning);
  }
  details.open = pending;
}

export function toolGroupElement(items: readonly HTMLElement[], active = false): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = `tool-group${active ? " pending" : ""}`;
  details.dataset.toolKey = "tool-group";
  const summary = document.createElement("summary");
  summary.className = "tool-group-summary";
  summary.textContent = active
    ? `Calling ${items.length} tool${items.length === 1 ? "" : "s"}…`
    : `Called ${items.length} tool${items.length === 1 ? "" : "s"}`;
  const body = document.createElement("div");
  body.className = "tool-group-body";
  body.append(...items);
  details.append(summary, body);
  details.open = active;
  for (const item of items) {
    if (item instanceof HTMLDetailsElement) item.open = active;
  }
  details.addEventListener("toggle", () => {
    for (const child of body.querySelectorAll<HTMLDetailsElement>(":scope > details.tool-detail")) child.open = details.open;
  });
  return details;
}

export function updateToolGroupElement(details: HTMLDetailsElement, items: readonly HTMLElement[], active = false): void {
  details.className = `tool-group${active ? " pending" : ""}`;
  details.dataset.toolKey = "tool-group";
  const summary = details.querySelector<HTMLElement>(":scope > .tool-group-summary");
  const body = details.querySelector<HTMLElement>(":scope > .tool-group-body");
  if (summary === null || body === null) return;
  summary.textContent = active
    ? `Calling ${items.length} tool${items.length === 1 ? "" : "s"}…`
    : `Called ${items.length} tool${items.length === 1 ? "" : "s"}`;
  const nextItems = new Set(items);
  for (const child of Array.from(body.children)) {
    if (!nextItems.has(child as HTMLElement)) child.remove();
  }
  const currentItems = Array.from(body.children);
  const sameOrder = currentItems.length === items.length && currentItems.every((child, index) => child === items[index]);
  if (!sameOrder) body.append(...items);
  details.open = active;
  if (active) {
    for (const item of items) {
      if (item instanceof HTMLDetailsElement) item.open = true;
    }
  }
}

export function messageElements(messages: readonly ModelMessage[], attachmentNames?: ReadonlyMap<string, ModelAttachment>): HTMLElement[] {
  const result: HTMLElement[] = [];
  let toolItems: HTMLElement[] = [];
  const flushTools = (): void => {
    if (toolItems.length > 0) result.push(toolGroupElement(toolItems));
    toolItems = [];
  };
  messages.forEach((message, index) => {
    const element = messageElement(message, false, index, attachmentNames);
    if (element === null) return;
    if (message.role === "tool") toolItems.push(element);
    else {
      flushTools();
      result.push(element);
    }
  });
  flushTools();
  return result;
}

export function streamingToolElement(delta: ToolCallDelta, key = `stream-${delta.index}`): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "tool-detail pending tool-call-stream";
  details.dataset.toolKey = key;
  const summary = document.createElement("summary");
  summary.className = "tool-summary";
  summary.setAttribute("translate", "no");
  summary.textContent = `${delta.name?.trim() || "tool"} · preparing`;
  const body = document.createElement("div");
  body.className = "tool-detail-body";
  body.textContent = delta.arguments?.trim() || "Waiting for arguments…";
  details.append(summary, body);
  return details;
}

export function updateStreamingToolElement(details: HTMLDetailsElement, delta: ToolCallDelta, key = `stream-${delta.index}`): void {
  details.className = "tool-detail pending tool-call-stream";
  details.dataset.toolKey = key;
  const summary = details.querySelector<HTMLElement>(":scope > .tool-summary");
  const body = details.querySelector<HTMLElement>(":scope > .tool-detail-body");
  if (summary === null || body === null) return;
  const nextSummary = `${delta.name?.trim() || "tool"} · preparing`;
  const nextBody = delta.arguments?.trim() || "Waiting for arguments…";
  if (summary.textContent !== nextSummary) summary.textContent = nextSummary;
  if (body.textContent !== nextBody) body.textContent = nextBody;
  if (!details.open) details.open = true;
}
