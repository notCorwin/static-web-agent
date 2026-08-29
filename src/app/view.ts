import type { AgentEvent, ModelMessage, ToolCall, ToolCallDelta, ToolExecutionResult } from "../core/types.js";

export type AppElements = Record<string, HTMLElement>;

export interface StreamTool {
  readonly status: "preparing" | "running" | "finished";
  readonly call?: ToolCall;
  readonly delta?: ToolCallDelta;
  readonly result?: ToolExecutionResult;
}

export interface StreamView {
  readonly text: string;
  readonly tools: readonly StreamTool[];
  readonly error?: string;
  readonly stopped?: boolean;
}

export function textElement(tag: keyof HTMLElementTagNameMap, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  return element;
}

export function renderShell(root: HTMLElement): AppElements {
  root.innerHTML = `
    <div class="app-shell">
      <main class="workspace" id="main-content" tabindex="-1" aria-label="Agent chat">
        <header class="chat-header">
          <div>
            <p class="eyebrow">Browser Agent Harness</p>
            <h1>Chat with your agent</h1>
          </div>
          <button class="secondary-button settings-button" id="open-settings" type="button" aria-controls="connection-card" aria-expanded="false">Connection</button>
        </header>
        <section class="chat-scroll" id="chat-log" tabindex="0" aria-label="Conversation" aria-busy="false">
          <section class="connection-card" id="connection-card" aria-labelledby="connection-title">
            <div class="connection-intro">
              <div>
                <p class="eyebrow">One connection</p>
                <h2 id="connection-title">Connect a model</h2>
              </div>
              <button class="primary-button" id="connection-submit" form="connection-form" type="submit">Connect</button>
            </div>
            <form class="connection-form" id="connection-form" novalidate>
              <div class="field">
                <label for="model-endpoint">OpenAI-compatible endpoint</label>
                <input id="model-endpoint" name="endpoint" type="url" inputmode="url" autocomplete="url" aria-describedby="endpoint-error" aria-invalid="false" placeholder="https://provider.example/v1" />
                <p class="field-error" id="endpoint-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-name">Model name</label>
                <input id="model-name" name="model" type="text" autocomplete="off" aria-describedby="model-error" aria-invalid="false" placeholder="model-name" />
                <p class="field-error" id="model-error" role="status" aria-live="polite"></p>
              </div>
              <div class="field">
                <label for="model-key">API key</label>
                <input id="model-key" name="apiKey" type="password" autocomplete="off" placeholder="Optional" />
              </div>
              <p class="field-help">These three values are saved only in this browser for automatic reconnection. Requests still go directly to the endpoint.</p>
              <p class="connection-status" id="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
            </form>
          </section>
          <div class="conversation-content" id="conversation-content"></div>
        </section>
        <div class="composer-wrap">
          <form class="composer" id="composer-form">
            <label class="sr-only" for="message-input">Message the agent</label>
            <div class="composer-input-row">
              <textarea id="message-input" name="message" rows="1" inputmode="text" autocomplete="off" placeholder="Ask anything…" spellcheck="true" disabled></textarea>
              <button class="primary-button send-button" id="send-button" type="submit" aria-label="Send message" disabled>Send</button>
            </div>
            <p class="status-message" id="run-status" role="status" aria-live="polite" aria-atomic="true"></p>
          </form>
        </div>
      </main>
    </div>
  `;
  const elements: AppElements = {};
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) elements[element.id] = element;
  return elements;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function callCode(call: ToolCall | undefined, delta: ToolCallDelta | undefined): string {
  if (call !== undefined && typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments)) {
    const code = call.arguments.code;
    if (typeof code === "string") return code;
  }
  if (delta?.arguments !== undefined) return delta.arguments;
  return "";
}

function callInput(call: ToolCall | undefined): unknown {
  if (call === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) return null;
  return Object.hasOwn(call.arguments, "input") ? call.arguments.input : null;
}

function resultText(result: ToolExecutionResult | undefined, message: Extract<ModelMessage, { readonly role: "tool" }> | undefined): string | undefined {
  if (result !== undefined) return result.ok ? jsonText(result.value) : jsonText({ error: result.error });
  return message?.content;
}

function toolElement(
  call: ToolCall | undefined,
  delta: ToolCallDelta | undefined,
  result: ToolExecutionResult | undefined,
  message: Extract<ModelMessage, { readonly role: "tool" }> | undefined,
  status: "preparing" | "running" | "finished",
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = `tool-trace${status === "finished" && (result?.ok === false || message?.isError === true) ? " tool-error" : ""}`;
  if (call !== undefined) details.dataset.toolCallId = call.id;
  details.open = status !== "finished";
  const summary = document.createElement("summary");
  const name = call?.name ?? delta?.name?.trim() ?? "page.run";
  summary.textContent = `${name} · ${status === "preparing" ? "preparing" : status === "running" ? "running" : result?.ok === false || message?.isError === true ? "error" : "complete"}`;
  details.append(summary);

  const body = document.createElement("div");
  body.className = "tool-trace-body";
  const code = callCode(call, delta);
  body.append(traceSection("Code", code || "(not available yet)", true));
  body.append(traceSection("Input", call === undefined ? (delta?.arguments ?? "(preparing)") : jsonText(callInput(call)), false));
  const output = resultText(result, message);
  if (output !== undefined) body.append(traceSection(result?.ok === false || message?.isError === true ? "Error" : "Result", output, false));
  const duration = result?.durationMs ?? message?.durationMs;
  if (duration !== undefined) body.append(textElement("p", `${duration} ms`, "tool-timing"));
  details.append(body);
  return details;
}

function traceSection(label: string, value: string, code: boolean): HTMLElement {
  const section = document.createElement("section");
  section.className = "trace-section";
  section.append(textElement("h3", label));
  const pre = document.createElement("pre");
  pre.className = code ? "trace-code" : "trace-value";
  pre.textContent = value;
  section.append(pre);
  return section;
}

function messageElement(message: ModelMessage, index: number, results: ReadonlyMap<ToolCall, Extract<ModelMessage, { readonly role: "tool" }>>, editingIndex: number | undefined): HTMLElement | null {
  if (message.role === "system") return null;
  if (message.role === "tool") return toolElement(undefined, undefined, undefined, message, "finished");
  if (message.role === "assistant" && message.content.length === 0 && (message.toolCalls?.length ?? 0) === 0) return null;

  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.dataset.messageIndex = String(index);
  if (message.role === "user" && editingIndex === index) {
    const edit = document.createElement("div");
    edit.className = "message-edit";
    const input = document.createElement("textarea");
    input.value = message.content;
    input.rows = 3;
    input.setAttribute("aria-label", "Edit message");
    const actions = document.createElement("div");
    actions.className = "message-edit-actions";
    const cancel = document.createElement("button");
    cancel.className = "secondary-button";
    cancel.type = "button";
    cancel.dataset.action = "cancel-edit";
    cancel.dataset.messageIndex = String(index);
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "primary-button";
    save.type = "button";
    save.dataset.action = "save-edit";
    save.dataset.messageIndex = String(index);
    save.textContent = "Run again";
    actions.append(cancel, save);
    edit.append(input, actions);
    article.append(edit);
    return article;
  }

  if (message.content.length > 0) article.append(textElement("div", message.content, "message-body"));
  if (message.role === "assistant") {
    for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
      const details = toolElement(call, undefined, undefined, results.get(call), "finished");
      details.dataset.toolCallKey = `${index}:${callIndex}:${call.id}`;
      article.append(details);
    }
  }
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.className = "message-action";
  copy.type = "button";
  copy.dataset.action = "copy-message";
  copy.dataset.messageIndex = String(index);
  copy.textContent = "Copy";
  if (message.content.length > 0) actions.append(copy);
  if (message.role === "user") {
    const edit = document.createElement("button");
    edit.className = "message-action";
    edit.type = "button";
    edit.dataset.action = "edit-message";
    edit.dataset.messageIndex = String(index);
    edit.textContent = "Edit";
    actions.append(edit);
  }
  article.append(actions);
  return article;
}

export function messageElements(messages: readonly ModelMessage[], editingIndex?: number): HTMLElement[] {
  const results = new Map<ToolCall, Extract<ModelMessage, { readonly role: "tool" }>>();
  const pending = new Map<string, ToolCall>();
  const paired = new Set<Extract<ModelMessage, { readonly role: "tool" }>>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    } else if (message.role === "tool") {
      const call = pending.get(message.callId);
      if (call !== undefined) {
        results.set(call, message);
        paired.add(message);
        pending.delete(message.callId);
      }
    }
  }
  const result: HTMLElement[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool" && paired.has(message)) return;
    const element = messageElement(message, index, results, editingIndex);
    if (element !== null) result.push(element);
  });
  return result;
}

export function streamingElement(stream: StreamView): HTMLElement | undefined {
  if (stream.text.length === 0 && stream.tools.length === 0 && stream.error === undefined && stream.stopped !== true) return undefined;
  const wrapper = document.createElement("div");
  wrapper.className = `streaming-run${stream.stopped === true ? " stopped" : ""}`;
  if (stream.text.length > 0) wrapper.append(textElement("div", stream.text, "message-body"));
  for (const item of stream.tools) wrapper.append(toolElement(item.call, item.delta, item.result, undefined, item.status));
  if (stream.stopped === true) wrapper.append(textElement("p", "Stopped", "stream-status"));
  if (stream.error !== undefined) wrapper.append(textElement("p", stream.error, "stream-error"));
  return wrapper;
}

/** Keeps the app event union visible at this boundary without parsing ordinary text as commands. */
export function isVisibleAgentEvent(event: AgentEvent): boolean {
  return event.type === "text-delta" || event.type === "tool-call-delta" || event.type === "tool-started" || event.type === "tool-finished";
}
