import type { AgentEvent, ToolCall, ToolCallDelta, ToolExecutionResult } from "../core/types.js";
import { renderRichContent } from "./rich-content.js";
import { messageElement, streamingToolElement, thinkingElement, toolGroupElement, updateStreamingToolElement, updateThinkingElement, updateToolGroupElement } from "./view.js";

export type LiveToolEntry =
  | { readonly key: string; readonly status: "preparing"; readonly delta: ToolCallDelta }
  | { readonly key: string; readonly status: "running"; readonly call: ToolCall }
  | { readonly key: string; readonly status: "finished"; readonly call: ToolCall; readonly result: ToolExecutionResult };

export type PendingStreamSegment =
  | { readonly key: string; readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly key: string; readonly kind: "tools"; readonly toolKeys: readonly string[] };

export interface StreamPresentationSnapshot {
  readonly pendingToolCalls: readonly ToolCallDelta[];
  readonly liveToolEntries: readonly LiveToolEntry[];
  readonly pendingStream: readonly PendingStreamSegment[];
  readonly followChat: boolean;
  readonly showScrollButton: boolean;
  readonly scrollToLatest: boolean;
}

export interface StreamViewport {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface StreamPresentationAdapter {
  readonly render: (snapshot: StreamPresentationSnapshot) => void;
}

export interface StreamPresentation {
  readonly handle: (event: AgentEvent) => void;
  readonly snapshot: () => StreamPresentationSnapshot;
  readonly render: () => void;
  readonly startRun: () => void;
  readonly resetPending: () => void;
  readonly reset: () => void;
  readonly setBusy: (busy: boolean) => void;
  readonly onScroll: (viewport: StreamViewport) => void;
  readonly recordProgrammaticScroll: (scrollTop: number) => void;
  readonly markUserScrollGesture: (scrollingUp?: boolean) => void;
  readonly scrollToLatest: () => void;
}

function immutableSnapshot(
  pendingToolCalls: readonly ToolCallDelta[],
  liveToolEntries: readonly LiveToolEntry[],
  pendingStream: readonly PendingStreamSegment[],
  followChat: boolean,
  showScrollButton: boolean,
  scrollToLatest: boolean,
): StreamPresentationSnapshot {
  return Object.freeze({
    pendingToolCalls: Object.freeze([...pendingToolCalls]),
    liveToolEntries: Object.freeze(liveToolEntries.map((entry) => Object.freeze(entry))),
    pendingStream: Object.freeze(pendingStream.map((segment) => Object.freeze(
      segment.kind === "tools" ? { ...segment, toolKeys: Object.freeze([...segment.toolKeys]) } : { ...segment },
    ))),
    followChat,
    showScrollButton,
    scrollToLatest,
  });
}

export function createStreamPresentation(adapter: StreamPresentationAdapter): StreamPresentation {
  let pendingToolCalls: ToolCallDelta[] = [];
  let liveToolEntries: LiveToolEntry[] = [];
  let liveToolSequence = 0;
  let pendingStream: PendingStreamSegment[] = [];
  let pendingStreamSequence = 0;
  let busy = false;
  let followChat = true;
  let userScrollGesture = false;
  let userScrollGestureTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let lastScrollTop = 0;
  let viewport: StreamViewport | undefined;
  let scrollRequest = false;

  const showScrollButton = (): boolean => {
    if (followChat || viewport === undefined) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1;
  };

  const currentSnapshot = (): StreamPresentationSnapshot => immutableSnapshot(
    pendingToolCalls,
    liveToolEntries,
    pendingStream,
    followChat,
    showScrollButton(),
    scrollRequest,
  );

  const replaceLiveToolEntry = (entry: LiveToolEntry): void => {
    const index = liveToolEntries.findIndex((current) => current.key === entry.key);
    liveToolEntries = index < 0
      ? [...liveToolEntries, entry]
      : liveToolEntries.map((current, currentIndex) => currentIndex === index ? entry : current);
  };

  const appendPendingStreamText = (kind: "text" | "thinking", delta: string): void => {
    if (delta.length === 0) return;
    const last = pendingStream.at(-1);
    if (last?.kind === kind) {
      pendingStream = [...pendingStream.slice(0, -1), { ...last, text: last.text + delta }];
      return;
    }
    pendingStream = [...pendingStream, { key: `stream-${++pendingStreamSequence}`, kind, text: delta }];
  };

  const ensurePendingThinking = (): void => {
    const last = pendingStream.at(-1);
    if (last?.kind === "thinking" && last.text.length === 0) return;
    pendingStream = [...pendingStream, { key: `stream-${++pendingStreamSequence}`, kind: "thinking", text: "" }];
  };

  const appendPendingTool = (key: string): void => {
    if (pendingStream.some((segment) => segment.kind === "tools" && segment.toolKeys.includes(key))) return;
    const last = pendingStream.at(-1);
    if (last?.kind === "tools") {
      pendingStream = [...pendingStream.slice(0, -1), { ...last, toolKeys: [...last.toolKeys, key] }];
      return;
    }
    pendingStream = [...pendingStream, { key: `stream-${++pendingStreamSequence}`, kind: "tools", toolKeys: [key] }];
  };

  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "text-delta":
        appendPendingStreamText("text", event.delta);
        break;
      case "reasoning-delta":
        appendPendingStreamText("thinking", event.delta);
        break;
      case "model-started":
        pendingToolCalls = [];
        ensurePendingThinking();
        break;
      case "tool-call-delta": {
        const previous = pendingToolCalls.find((delta) => delta.index === event.delta.index);
        const merged: { index: number; id?: string; name?: string; arguments?: string } = { index: event.delta.index };
        const id = event.delta.id ?? previous?.id;
        const name = event.delta.name === undefined && previous?.name === undefined ? undefined : `${previous?.name ?? ""}${event.delta.name ?? ""}`;
        const argumentsValue = event.delta.arguments === undefined && previous?.arguments === undefined ? undefined : `${previous?.arguments ?? ""}${event.delta.arguments ?? ""}`;
        if (id !== undefined) merged.id = id;
        if (name !== undefined) merged.name = name;
        if (argumentsValue !== undefined) merged.arguments = argumentsValue;
        pendingToolCalls = [...pendingToolCalls.filter((delta) => delta.index !== event.delta.index), merged]
          .sort((left, right) => left.index - right.index);
        const liveEntry = liveToolEntries.find((entry) => entry.status === "preparing" && entry.delta.index === merged.index);
        const liveKey = liveEntry?.key ?? `live-${++liveToolSequence}`;
        replaceLiveToolEntry({ key: liveKey, status: "preparing", delta: merged });
        appendPendingTool(liveKey);
        break;
      }
      case "tool-started": {
        pendingToolCalls = pendingToolCalls.filter((delta) => delta.id !== event.call.id && delta.name !== event.call.name);
        const liveEntry = liveToolEntries.find((entry) => entry.status === "preparing" && (entry.delta.id === event.call.id || entry.delta.name === event.call.name));
        const liveKey = liveEntry?.key ?? `live-${++liveToolSequence}`;
        replaceLiveToolEntry({ key: liveKey, status: "running", call: event.call });
        appendPendingTool(liveKey);
        break;
      }
      case "tool-finished": {
        const liveEntry = liveToolEntries.find((entry) => entry.status === "running" && (entry.call.id === event.call.id || entry.call.name === event.call.name));
        replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++liveToolSequence}`, status: "finished", call: event.call, result: event.result });
        break;
      }
      case "run-finished":
        pendingToolCalls = [];
        break;
      case "run-started":
      case "run-error":
      case "assistant-message":
        break;
    }
  };

  const resetPending = (): void => {
    pendingToolCalls = [];
    liveToolEntries = [];
    liveToolSequence = 0;
    pendingStream = [];
    pendingStreamSequence = 0;
  };

  const reset = (): void => {
    resetPending();
    busy = false;
    followChat = true;
    userScrollGesture = false;
    lastScrollTop = 0;
    viewport = undefined;
    scrollRequest = false;
    if (userScrollGestureTimer !== undefined) globalThis.clearTimeout(userScrollGestureTimer);
    userScrollGestureTimer = undefined;
  };

  const render = (): void => {
    const snapshot = currentSnapshot();
    adapter.render(snapshot);
    scrollRequest = false;
  };

  return {
    handle,
    snapshot: currentSnapshot,
    render,
    startRun: () => {
      followChat = true;
      scrollRequest = true;
      resetPending();
    },
    resetPending,
    reset,
    setBusy: (nextBusy) => {
      busy = nextBusy;
    },
    onScroll: (nextViewport) => {
      viewport = nextViewport;
      const scrollingUp = nextViewport.scrollTop < lastScrollTop - 1;
      lastScrollTop = nextViewport.scrollTop;
      if (scrollingUp) followChat = false;
      if (!(busy && followChat && !userScrollGesture)) {
        followChat = nextViewport.scrollHeight - nextViewport.scrollTop - nextViewport.clientHeight < 90;
      }
    },
    recordProgrammaticScroll: (scrollTop) => {
      lastScrollTop = scrollTop;
      if (viewport !== undefined) viewport = { ...viewport, scrollTop };
    },
    markUserScrollGesture: (scrollingUp = false) => {
      userScrollGesture = true;
      if (scrollingUp) followChat = false;
      if (userScrollGestureTimer !== undefined) globalThis.clearTimeout(userScrollGestureTimer);
      userScrollGestureTimer = globalThis.setTimeout(() => {
        userScrollGesture = false;
        userScrollGestureTimer = undefined;
      }, 250);
    },
    scrollToLatest: () => {
      followChat = true;
      scrollRequest = true;
    },
  };
}

function liveToolResultContent(result: ToolExecutionResult): string {
  return result.ok ? JSON.stringify(result.value, null, 2) : JSON.stringify({ error: result.error }, null, 2);
}

function createLiveToolElement(entry: LiveToolEntry): HTMLDetailsElement | undefined {
  if (entry.status === "preparing") return streamingToolElement(entry.delta, entry.key);
  const content = entry.status === "running" ? `Running ${entry.call.name}…` : liveToolResultContent(entry.result);
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

function updateLiveToolElement(details: HTMLDetailsElement, entry: LiveToolEntry): void {
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
  const nextBody = entry.status === "running" ? `Running ${entry.call.name}…` : liveToolResultContent(entry.result);
  if (summary.textContent !== nextSummary) summary.textContent = nextSummary;
  body.classList.toggle("tool-error", entry.status === "finished" && !entry.result.ok);
  if (body.textContent !== nextBody) body.textContent = nextBody;
  if (!details.open) details.open = true;
}

function pendingAssistantElement(segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): HTMLElement | null {
  const element = segment.kind === "thinking"
    ? messageElement({ role: "assistant", content: "", reasoning: segment.text }, true)
    : messageElement({ role: "assistant", content: segment.text }, true);
  if (element !== null) element.dataset.streamKey = segment.key;
  return element;
}

function updatePendingAssistantElement(element: HTMLElement, segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): void {
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

function pendingToolGroupElement(
  segment: Extract<PendingStreamSegment, { readonly kind: "tools" }>,
  entries: readonly LiveToolEntry[],
  existing: HTMLDetailsElement | undefined,
): HTMLDetailsElement | undefined {
  const existingItems = new Map<string, HTMLDetailsElement>();
  if (existing !== undefined) {
    for (const item of existing.querySelectorAll<HTMLDetailsElement>(":scope > .tool-group-body > details.tool-detail")) {
      if (item.dataset.toolKey !== undefined) existingItems.set(item.dataset.toolKey, item);
    }
  }
  const items: HTMLElement[] = [];
  for (const key of segment.toolKeys) {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry === undefined) continue;
    let item = existingItems.get(entry.key);
    if (item === undefined) item = createLiveToolElement(entry);
    if (item === undefined) continue;
    updateLiveToolElement(item, entry);
    items.push(item);
    existingItems.delete(entry.key);
  }
  if (items.length === 0) return undefined;
  const group = existing ?? toolGroupElement(items, true);
  group.dataset.streamKey = segment.key;
  if (existing !== undefined) updateToolGroupElement(group, items, true);
  return group;
}

function updatePendingMessages(conversation: HTMLElement, snapshot: StreamPresentationSnapshot): void {
  const existing = new Map<string, HTMLElement>();
  for (const element of conversation.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")) {
    if (element.dataset.streamKey !== undefined) existing.set(element.dataset.streamKey, element);
  }
  const desired: HTMLElement[] = [];
  for (const segment of snapshot.pendingStream) {
    const current = existing.get(segment.key);
    if (segment.kind === "tools") {
      const group = pendingToolGroupElement(segment, snapshot.liveToolEntries, current instanceof HTMLDetailsElement ? current : undefined);
      if (group !== undefined) desired.push(group);
    } else {
      let element = current;
      if (element === undefined || !element.classList.contains("message")) {
        element?.remove();
        element = pendingAssistantElement(segment) ?? undefined;
      } else {
        updatePendingAssistantElement(element, segment);
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

export interface DomStreamPresentationAdapterOptions {
  readonly conversation: HTMLElement;
  readonly chat: HTMLElement;
  readonly scrollButton: HTMLElement;
  readonly hasCommittedMessages: () => boolean;
  readonly onProgrammaticScroll: (scrollTop: number) => void;
}

export function createDomStreamPresentationAdapter(options: DomStreamPresentationAdapterOptions): StreamPresentationAdapter {
  let scheduled = false;
  let latest: StreamPresentationSnapshot | undefined;
  const updateButton = (snapshot: StreamPresentationSnapshot): void => {
    const distance = options.chat.scrollHeight - options.chat.scrollTop - options.chat.clientHeight;
    options.scrollButton.hidden = snapshot.followChat || distance <= 1;
  };
  const scrollToBottom = (): void => {
    options.chat.scrollTop = Math.max(0, options.chat.scrollHeight - options.chat.clientHeight);
    options.onProgrammaticScroll(options.chat.scrollTop);
  };
  const scroll = (): void => {
    if (!scheduled) return;
    scheduled = false;
    const snapshot = latest;
    if (snapshot !== undefined && (snapshot.followChat || !options.hasCommittedMessages() || snapshot.scrollToLatest)) {
      scrollToBottom();
    }
    if (snapshot !== undefined) updateButton(snapshot);
  };
  const scheduleScroll = (): void => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    globalThis.setTimeout(scroll, 50);
  };
  return {
    render: (snapshot) => {
      latest = snapshot;
      updatePendingMessages(options.conversation, snapshot);
      updateButton(snapshot);
      if (snapshot.followChat || !options.hasCommittedMessages() || snapshot.scrollToLatest) {
        scrollToBottom();
        scheduleScroll();
        updateButton(snapshot);
      }
    },
  };
}

export interface MemoryStreamPresentationAdapter extends StreamPresentationAdapter {
  readonly snapshots: StreamPresentationSnapshot[];
}

export function createMemoryStreamPresentationAdapter(): MemoryStreamPresentationAdapter {
  const snapshots: StreamPresentationSnapshot[] = [];
  return { snapshots, render: (snapshot) => { snapshots.push(snapshot); } };
}
