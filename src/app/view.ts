import type { ModelMessage, ToolCallDelta } from "../core/types.js";
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
              <div class="connection-icon" aria-hidden="true">✦</div>
              <div>
                <h2 id="connection-title">Connect your cloud model</h2>
                <p>Enter your OpenAI-compatible endpoint, model name, and API key. The model name is used as your password-manager username; the endpoint is remembered locally.</p>
              </div>
            </div>
            <form class="connection-form" id="connection-form" novalidate>
              <div class="field">
                <label for="model-endpoint">OpenAI-compatible endpoint or API base <span class="faint">(saved locally)</span></label>
                <input id="model-endpoint" name="endpoint" type="url" inputmode="url" autocomplete="url" aria-describedby="endpoint-error" aria-invalid="false" placeholder="https://provider.example/v1 or …/chat/completions" />
                <p class="field-error" id="endpoint-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-name">Model name <span class="faint">(password-manager username)</span></label>
                <input id="model-name" name="model" type="text" inputmode="text" autocomplete="username" aria-describedby="model-error" aria-invalid="false" placeholder="model-name…" />
                <p class="field-error" id="model-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-key">API key <span class="faint">(saved locally)</span></label>
                <input id="model-key" name="apiKey" type="password" autocomplete="current-password" aria-describedby="key-help" placeholder="Paste a key…" />
                <p class="field-help" id="key-help">Stored locally and offered to the browser password manager when supported.</p>
              </div>
              <button class="primary-button" type="submit"><span class="button-content"><span class="button-label">Connect model</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
              <p class="connection-note">Requests go directly from this page to the endpoint. The endpoint must permit browser CORS; connection settings, including the API key, are stored only in this browser.</p>
              <p class="credential-status" id="credential-status" role="status" aria-live="polite">The model name is the password-manager username; endpoint is saved locally.</p>
              <p class="connection-status" id="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
            </form>
          </section>
          <div class="conversation-content" id="conversation-content">
            <div class="loading-state" role="status" aria-live="polite">
              <span class="loading-line loading-line-wide" aria-hidden="true"></span>
              <span class="loading-line loading-line-short" aria-hidden="true"></span>
              <span class="loading-label">Starting chat…</span>
            </div>
          </div>
        </section>
        <button class="scroll-bottom-button" id="scroll-bottom-button" type="button" aria-label="Scroll to latest response" title="Scroll to latest response" hidden>
          <span aria-hidden="true">↓</span>
        </button>
        <div class="composer-wrap">
          <form class="composer" id="composer-form">
            <label class="sr-only" for="message-input">Message the agent</label>
            <textarea id="message-input" name="message" rows="1" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true"></textarea>
            <button class="primary-button send-button" id="send-button" type="submit" aria-label="Send message"><span class="button-content"><span class="button-label">Send</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
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

export function messageElement(message: ModelMessage, pending = false, messageIndex?: number): HTMLElement | null {
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
  if (message.role === "assistant" && message.content.trim().length === 0) return null;

  const article = document.createElement("article");
  article.className = `message ${message.role}${pending ? " pending" : ""}`;
  if (messageIndex !== undefined) article.dataset.messageIndex = String(messageIndex);
  const body = document.createElement("div");
  body.className = "message-body";
  if (message.role === "assistant" || message.role === "user") renderRichContent(body, message.content);
  else body.textContent = message.content;
  article.append(body);
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
  body.append(...items);
  details.open = active;
  if (active) {
    for (const item of items) {
      if (item instanceof HTMLDetailsElement) item.open = true;
    }
  }
}

export function messageElements(messages: readonly ModelMessage[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  let toolItems: HTMLElement[] = [];
  const flushTools = (): void => {
    if (toolItems.length > 0) result.push(toolGroupElement(toolItems));
    toolItems = [];
  };
  messages.forEach((message, index) => {
    const element = messageElement(message, false, index);
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

export function streamingToolElement(delta: ToolCallDelta): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "tool-detail pending tool-call-stream";
  details.dataset.toolKey = `stream-${delta.index}`;
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

export function updateStreamingToolElement(details: HTMLDetailsElement, delta: ToolCallDelta): void {
  details.className = "tool-detail pending tool-call-stream";
  details.dataset.toolKey = `stream-${delta.index}`;
  const summary = details.querySelector<HTMLElement>(":scope > .tool-summary");
  const body = details.querySelector<HTMLElement>(":scope > .tool-detail-body");
  if (summary === null || body === null) return;
  summary.textContent = `${delta.name?.trim() || "tool"} · preparing`;
  body.textContent = delta.arguments?.trim() || "Waiting for arguments…";
  details.open = true;
}
