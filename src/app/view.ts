import type { ModelMessage } from "../core/types.js";
import { renderRichContent } from "./rich-content.js";

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
        <div class="composer-wrap">
          <form class="composer" id="composer-form">
            <label class="sr-only" for="message-input">Message the agent</label>
            <textarea id="message-input" name="message" rows="2" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true"></textarea>
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

export function messageElement(message: ModelMessage, pending = false): HTMLElement | null {
  if (message.role === "tool") {
    const details = document.createElement("details");
    details.className = `tool-detail${pending ? " pending" : ""}`;
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
  const header = document.createElement("div");
  header.className = "message-header";
  header.textContent = message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System";
  article.append(header);
  const body = document.createElement("div");
  body.className = "message-body";
  if (message.role === "assistant" || message.role === "user") renderRichContent(body, message.content);
  else body.textContent = message.content;
  article.append(body);
  return article;
}
