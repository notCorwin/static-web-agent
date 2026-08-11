import type { ModelMessage } from "../core/types.js";

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
      <aside class="sidebar" aria-label="Workspace navigation">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">∿</div>
          <div>
            <div class="brand-name" translate="no">Static Web Agent</div>
            <p class="brand-subtitle">Browser-native workspace</p>
          </div>
        </div>
        <div class="sidebar-footer">
          <div class="storage-status"><span class="status-dot" aria-hidden="true"></span><span id="storage-label">In-memory chat</span></div>
          <span>Chat records clear when you refresh.</span>
        </div>
      </aside>

      <main class="workspace" id="main-content" tabindex="-1">
        <header class="topbar">
          <div class="title-wrap">
            <h1 id="conversation-title">Chat</h1>
            <p id="conversation-meta">In memory · clears on refresh</p>
          </div>
          <div class="topbar-actions">
            <span class="model-chip" id="model-chip">Model · <strong>Offline assistant</strong></span>
          </div>
        </header>

        <details class="connection-details" id="connection-details">
          <summary>Connect an OpenAI-compatible model</summary>
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
              <label for="model-key">API key <span class="faint">(not saved)</span></label>
              <input id="model-key" name="apiKey" type="password" autocomplete="new-password" aria-describedby="key-help" placeholder="Paste a key…" />
              <p class="field-help" id="key-help">Accepted by the endpoint, never saved here.</p>
            </div>
            <button class="primary-button" type="submit"><span class="button-content"><span class="button-label">Use remote</span><span class="spinner" hidden aria-hidden="true"></span></span></button>
            <button class="secondary-button" id="use-local" type="button">Use offline</button>
            <p class="connection-note">Requests go directly from this page to the endpoint. The endpoint must permit browser CORS; the API key is never persisted.</p>
            <p class="connection-status" id="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
          </form>
        </details>

        <section class="chat-scroll" id="chat-log" aria-label="Conversation" aria-busy="true">
          <div class="loading-state" role="status" aria-live="polite">
            <span class="loading-line loading-line-wide" aria-hidden="true"></span>
            <span class="loading-line loading-line-short" aria-hidden="true"></span>
            <span class="loading-label">Starting chat…</span>
          </div>
        </section>
        <div class="composer-wrap">
          <form class="composer" id="composer-form">
            <label class="sr-only" for="message-input">Message the agent</label>
            <textarea id="message-input" name="message" rows="3" maxlength="20000" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true"></textarea>
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
        <p class="panel-intro">Tools and extensions are opt-in. Each plugin must request its browser capabilities.</p>
        <div class="permission-card" id="runtime-card">
          <h3>JavaScript runtime</h3>
          <p>Run small transformations in a time-limited worker. This is not a security sandbox.</p>
          <button class="secondary-button" id="runtime-action" type="button">Enable plugin</button>
        </div>
        <div class="permission-card" id="storage-card">
          <h3>Local storage tool</h3>
          <p>Give the agent a namespaced key-value store backed by this browser's local state.</p>
          <button class="secondary-button" id="storage-action" type="button">Enable plugin</button>
        </div>
        <div class="extension-host" id="extension-host" aria-label="Plugin extensions"></div>
        <div class="tool-list" id="tool-list" aria-label="Enabled tools"></div>
      </aside>
    </div>
  `;
  const elements: AppElements = {};
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) elements[element.id] = element;
  return elements;
}

export function messageElement(message: ModelMessage, pending = false): HTMLElement {
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
