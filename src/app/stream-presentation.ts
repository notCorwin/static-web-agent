import type { AgentEvent, ToolCall, ToolCallDelta, ToolExecutionResult } from "../core/types.js";
import { renderRichContent } from "./rich-content.js";
import { messageElement, streamingToolElement, thinkingElement, toolGroupElement, updateStreamingToolElement, updateThinkingElement, updateToolGroupElement } from "./view.js";

const pendingAssistantSources = new WeakMap<HTMLElement, string>();

export type LiveToolEntry =
  | { readonly key: string; readonly status: "preparing"; readonly delta: ToolCallDelta }
  | { readonly key: string; readonly status: "running"; readonly call: ToolCall }
  | { readonly key: string; readonly status: "finished"; readonly call: ToolCall; readonly result: ToolExecutionResult };

export type PendingStreamSegment =
  | { readonly key: string; readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly key: string; readonly kind: "tools"; readonly toolKeys: readonly string[] };

interface PendingText {
  readonly chunks: string[];
  value: string;
}

type PendingStreamDraft =
  | { readonly key: string; readonly kind: "text" | "thinking"; readonly text: PendingText }
  | { readonly key: string; readonly kind: "tools"; readonly toolKeys: readonly string[] };

interface PendingToolDraft {
  readonly key: string;
  readonly index: number;
  id?: string;
  readonly name: PendingText;
  readonly arguments: PendingText;
}

type InternalLiveToolEntry =
  | { readonly key: string; readonly status: "preparing"; readonly draft: PendingToolDraft }
  | Extract<LiveToolEntry, { readonly status: "running" | "finished" }>;

const pendingToolItems = new WeakMap<HTMLDetailsElement, Map<string, HTMLDetailsElement>>();
const renderedLiveToolEntries = new WeakMap<HTMLDetailsElement, LiveToolEntry>();
const PENDING_CHUNK_COMPACT_THRESHOLD = 256;

function pendingText(): PendingText {
  return { chunks: [], value: "" };
}

function appendPendingText(buffer: PendingText, value: string): void {
  if (buffer.chunks.length >= PENDING_CHUNK_COMPACT_THRESHOLD) {
    // ponytail: detached streams can defer reads; compact chunk metadata without reparsing the text.
    buffer.value += buffer.chunks.join("");
    buffer.chunks.length = 0;
  }
  buffer.chunks.push(value);
}

function readPendingText(buffer: PendingText): string {
  if (buffer.chunks.length > 0) {
    // ponytail: stream text is append-only, so each chunk is joined once; use a rope if edits ever become valid.
    buffer.value += buffer.chunks.join("");
    buffer.chunks.length = 0;
  }
  return buffer.value;
}

function pendingTextIsEmpty(buffer: PendingText): boolean {
  return buffer.value.length === 0 && buffer.chunks.length === 0;
}

export interface StreamPresentationSnapshot {
  readonly pendingToolCalls: readonly ToolCallDelta[];
  readonly liveToolEntries: readonly LiveToolEntry[];
  readonly pendingStream: readonly PendingStreamSegment[];
  readonly contentRevision: number;
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
  readonly renderViewport?: (followChat: boolean, viewport: StreamViewport) => void;
}

export interface StreamPresentation {
  readonly handle: (event: AgentEvent) => boolean;
  readonly snapshot: () => StreamPresentationSnapshot;
  readonly isFollowingChat: () => boolean;
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

interface StreamContentSnapshot {
  readonly pendingToolCalls: readonly ToolCallDelta[];
  readonly liveToolEntries: readonly LiveToolEntry[];
  readonly pendingStream: readonly PendingStreamSegment[];
}

function immutableContent(
  pendingToolCalls: readonly ToolCallDelta[],
  liveToolEntries: readonly LiveToolEntry[],
  pendingStream: readonly PendingStreamSegment[],
): StreamContentSnapshot {
  return Object.freeze({
    pendingToolCalls: Object.freeze([...pendingToolCalls]),
    liveToolEntries: Object.freeze(liveToolEntries.map((entry) => Object.freeze(entry))),
    pendingStream: Object.freeze(pendingStream.map((segment) => Object.freeze(
      segment.kind === "tools" ? { ...segment, toolKeys: Object.freeze([...segment.toolKeys]) } : { ...segment },
    ))),
  });
}

function immutableSnapshot(
  content: StreamContentSnapshot,
  contentRevision: number,
  followChat: boolean,
  showScrollButton: boolean,
  scrollToLatest: boolean,
): StreamPresentationSnapshot {
  return Object.freeze({
    ...content,
    contentRevision,
    followChat,
    showScrollButton,
    scrollToLatest,
  });
}

export function createStreamPresentation(adapter: StreamPresentationAdapter): StreamPresentation {
  const pendingToolDrafts = new Map<number, PendingToolDraft>();
  let liveToolEntries: InternalLiveToolEntry[] = [];
  let liveToolSequence = 0;
  let pendingStream: PendingStreamDraft[] = [];
  let pendingStreamSequence = 0;
  let busy = false;
  let followChat = true;
  let userScrollGesture = false;
  let userScrollGestureTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let lastScrollTop = 0;
  let viewport: StreamViewport | undefined;
  let scrollRequest = false;
  let renderedViewportFollow: boolean | undefined;
  let renderedViewportButton: boolean | undefined;
  let contentRevision = 0;
  let materializedContent: StreamContentSnapshot | undefined;

  const invalidateContent = (): void => {
    contentRevision += 1;
    materializedContent = undefined;
  };

  const showScrollButton = (): boolean => {
    if (followChat || viewport === undefined) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1;
  };

  const materializeToolDelta = (draft: PendingToolDraft): ToolCallDelta => ({
    index: draft.index,
    ...(draft.id === undefined ? {} : { id: draft.id }),
    ...(pendingTextIsEmpty(draft.name) ? {} : { name: readPendingText(draft.name) }),
    ...(pendingTextIsEmpty(draft.arguments) ? {} : { arguments: readPendingText(draft.arguments) }),
  });

  const currentContent = (): StreamContentSnapshot => {
    if (materializedContent !== undefined) return materializedContent;
    const toolDeltas = new Map<PendingToolDraft, ToolCallDelta>();
    const deltaFor = (draft: PendingToolDraft): ToolCallDelta => {
      const existing = toolDeltas.get(draft);
      if (existing !== undefined) return existing;
      const delta = Object.freeze(materializeToolDelta(draft));
      toolDeltas.set(draft, delta);
      return delta;
    };
    materializedContent = immutableContent(
      [...pendingToolDrafts.values()].sort((left, right) => left.index - right.index).map(deltaFor),
      liveToolEntries.map((entry): LiveToolEntry => entry.status === "preparing"
        ? { key: entry.key, status: entry.status, delta: deltaFor(entry.draft) }
        : entry),
      pendingStream.map((segment) => segment.kind === "tools" ? segment : {
        key: segment.key,
        kind: segment.kind,
        text: readPendingText(segment.text),
      }),
    );
    return materializedContent;
  };

  const currentSnapshot = (): StreamPresentationSnapshot => immutableSnapshot(
    currentContent(),
    contentRevision,
    followChat,
    showScrollButton(),
    scrollRequest,
  );

  const replaceLiveToolEntry = (entry: InternalLiveToolEntry): void => {
    const index = liveToolEntries.findIndex((current) => current.key === entry.key);
    if (index < 0) liveToolEntries.push(entry);
    else liveToolEntries[index] = entry;
  };

  const appendPendingStreamText = (kind: "text" | "thinking", delta: string): void => {
    if (delta.length === 0) return;
    let last = pendingStream.at(-1);
    if (kind === "text" && last?.kind === "thinking" && pendingTextIsEmpty(last.text)) {
      pendingStream.pop();
      last = pendingStream.at(-1);
    }
    if (last?.kind === kind) {
      appendPendingText(last.text, delta);
      return;
    }
    const text = pendingText();
    appendPendingText(text, delta);
    pendingStream.push({ key: `stream-${++pendingStreamSequence}`, kind, text });
  };

  const ensurePendingThinking = (): void => {
    const last = pendingStream.at(-1);
    if (last?.kind === "thinking" && pendingTextIsEmpty(last.text)) return;
    pendingStream.push({ key: `stream-${++pendingStreamSequence}`, kind: "thinking", text: pendingText() });
  };

  const appendPendingTool = (key: string): void => {
    if (pendingStream.some((segment) => segment.kind === "tools" && segment.toolKeys.includes(key))) return;
    let last = pendingStream.at(-1);
    if (last?.kind === "thinking" && pendingTextIsEmpty(last.text)) {
      pendingStream.pop();
      last = pendingStream.at(-1);
    }
    if (last?.kind === "tools") {
      pendingStream[pendingStream.length - 1] = { ...last, toolKeys: [...last.toolKeys, key] };
      return;
    }
    pendingStream.push({ key: `stream-${++pendingStreamSequence}`, kind: "tools", toolKeys: [key] });
  };

  const handle = (event: AgentEvent): boolean => {
    switch (event.type) {
      case "text-delta":
        appendPendingStreamText("text", event.delta);
        if (event.delta.length === 0) return false;
        invalidateContent();
        return true;
      case "reasoning-delta":
        appendPendingStreamText("thinking", event.delta);
        if (event.delta.length === 0) return false;
        invalidateContent();
        return true;
      case "model-started":
        pendingToolDrafts.clear();
        ensurePendingThinking();
        invalidateContent();
        return true;
      case "tool-call-delta": {
        let draft = pendingToolDrafts.get(event.delta.index);
        let changed = false;
        if (draft === undefined) {
          draft = { key: `live-${++liveToolSequence}`, index: event.delta.index, name: pendingText(), arguments: pendingText() };
          pendingToolDrafts.set(draft.index, draft);
          liveToolEntries.push({ key: draft.key, status: "preparing", draft });
          appendPendingTool(draft.key);
          changed = true;
        }
        if (event.delta.id !== undefined && draft.id !== event.delta.id) {
          draft.id = event.delta.id;
          changed = true;
        }
        if (event.delta.name !== undefined && event.delta.name.length > 0) {
          appendPendingText(draft.name, event.delta.name);
          changed = true;
        }
        if (event.delta.arguments !== undefined && event.delta.arguments.length > 0) {
          appendPendingText(draft.arguments, event.delta.arguments);
          changed = true;
        }
        if (!changed) return false;
        invalidateContent();
        return true;
      }
      case "tool-started": {
        for (const [index, draft] of pendingToolDrafts) {
          if (draft.id === event.call.id || readPendingText(draft.name) === event.call.name) pendingToolDrafts.delete(index);
        }
        const liveEntry = liveToolEntries.find((entry) => entry.status === "preparing" && (entry.draft.id === event.call.id || readPendingText(entry.draft.name) === event.call.name));
        const liveKey = liveEntry?.key ?? `live-${++liveToolSequence}`;
        replaceLiveToolEntry({ key: liveKey, status: "running", call: event.call });
        appendPendingTool(liveKey);
        invalidateContent();
        return true;
      }
      case "tool-finished": {
        const liveEntry = liveToolEntries.find((entry) => entry.status === "running" && (entry.call.id === event.call.id || entry.call.name === event.call.name));
        replaceLiveToolEntry({ key: liveEntry?.key ?? `live-${++liveToolSequence}`, status: "finished", call: event.call, result: event.result });
        invalidateContent();
        return true;
      }
      case "run-finished":
        pendingToolDrafts.clear();
        invalidateContent();
        return true;
      case "run-started":
      case "run-error":
      case "assistant-message":
        return false;
    }
  };

  const resetPending = (): void => {
    pendingToolDrafts.clear();
    liveToolEntries = [];
    liveToolSequence = 0;
    pendingStream = [];
    pendingStreamSequence = 0;
    invalidateContent();
  };

  const reset = (): void => {
    resetPending();
    busy = false;
    followChat = true;
    userScrollGesture = false;
    lastScrollTop = 0;
    viewport = undefined;
    scrollRequest = false;
    renderedViewportFollow = undefined;
    renderedViewportButton = undefined;
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
    isFollowingChat: () => followChat,
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
      const measuredViewport: StreamViewport = {
        scrollTop: nextViewport.scrollTop,
        scrollHeight: nextViewport.scrollHeight,
        clientHeight: nextViewport.clientHeight,
      };
      viewport = measuredViewport;
      const scrollingUp = measuredViewport.scrollTop < lastScrollTop - 1;
      lastScrollTop = measuredViewport.scrollTop;
      if (scrollingUp) followChat = false;
      else if (!(busy && followChat && !userScrollGesture)) {
        followChat = measuredViewport.scrollHeight - measuredViewport.scrollTop - measuredViewport.clientHeight < 90;
      }
      if (!followChat) scrollRequest = false;
      const showButton = showScrollButton();
      if (renderedViewportFollow !== followChat || renderedViewportButton !== showButton) {
        renderedViewportFollow = followChat;
        renderedViewportButton = showButton;
        adapter.renderViewport?.(followChat, measuredViewport);
      }
    },
    recordProgrammaticScroll: (scrollTop) => {
      lastScrollTop = scrollTop;
      if (viewport !== undefined) viewport = { ...viewport, scrollTop };
    },
    markUserScrollGesture: (scrollingUp = false) => {
      userScrollGesture = true;
      scrollRequest = false;
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
  // ponytail: running/finished entries are immutable; cache their rendered JSON until the entry identity changes.
  if (entry.status !== "preparing" && renderedLiveToolEntries.get(details) === entry) return;
  if (entry.status === "preparing") {
    updateStreamingToolElement(details, entry.delta, entry.key);
    renderedLiveToolEntries.delete(details);
    return;
  }
  const nextClassName = `tool-detail pending${entry.status === "finished" ? " tool-call-complete" : ""}`;
  if (details.className !== nextClassName) details.className = nextClassName;
  if (details.dataset.toolKey !== entry.key) details.dataset.toolKey = entry.key;
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
  renderedLiveToolEntries.set(details, entry);
}

function pendingAssistantElement(segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): HTMLElement | null {
  const element = segment.kind === "thinking"
    ? messageElement({ role: "assistant", content: "", reasoning: segment.text }, true)
    : messageElement({ role: "assistant", content: segment.text }, true);
  if (element !== null) {
    element.dataset.streamKey = segment.key;
    pendingAssistantSources.set(element, segment.text);
  }
  return element;
}

function updatePendingAssistantElement(element: HTMLElement, segment: Extract<PendingStreamSegment, { readonly kind: "text" | "thinking" }>): void {
  // ponytail: unchanged interleaved segments keep their DOM; only the hot tail updates per frame.
  if (pendingAssistantSources.get(element) === segment.text) return;
  pendingAssistantSources.set(element, segment.text);
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
  // ponytail: stream segments are append-only and created only for non-empty deltas; avoid rescanning the growing text.
  if (segment.text.length === 0) {
    element.querySelector(":scope > .message-body")?.remove();
    return;
  }
  let body = element.querySelector<HTMLElement>(":scope > .message-body");
  if (body === null) {
    body = document.createElement("div");
    body.className = "message-body";
    element.append(body);
  }
  renderRichContent(body, segment.text, { streaming: true });
}

function pendingToolGroupElement(
  segment: Extract<PendingStreamSegment, { readonly kind: "tools" }>,
  entries: ReadonlyMap<string, LiveToolEntry>,
  existing: HTMLDetailsElement | undefined,
): HTMLDetailsElement | undefined {
  let existingItems = existing === undefined ? undefined : pendingToolItems.get(existing);
  if (existing !== undefined && existingItems === undefined) {
    existingItems = new Map<string, HTMLDetailsElement>();
    for (const item of existing.querySelectorAll<HTMLDetailsElement>(":scope > .tool-group-body > details.tool-detail")) {
      if (item.dataset.toolKey !== undefined) existingItems.set(item.dataset.toolKey, item);
    }
    pendingToolItems.set(existing, existingItems);
  }
  const items: HTMLElement[] = [];
  let structureChanged = false;
  for (const key of segment.toolKeys) {
    const entry = entries.get(key);
    if (entry === undefined) continue;
    let item = existingItems?.get(entry.key);
    if (item === undefined) {
      item = createLiveToolElement(entry);
      structureChanged = true;
    }
    if (item === undefined) continue;
    updateLiveToolElement(item, entry);
    items.push(item);
  }
  if (items.length === 0) return undefined;
  const group = existing ?? toolGroupElement(items, true);
  if (group.dataset.streamKey !== segment.key) group.dataset.streamKey = segment.key;
  // ponytail: tool keys are append-only; avoid rescanning the group's children on every argument delta.
  if (existing !== undefined && (structureChanged || !group.open)) updateToolGroupElement(group, items, true);
  const nextItems = existingItems ?? new Map<string, HTMLDetailsElement>();
  for (const item of items) {
    const key = item.dataset.toolKey;
    if (key !== undefined) nextItems.set(key, item as HTMLDetailsElement);
  }
  pendingToolItems.set(group, nextItems);
  return group;
}

function updatePendingMessages(
  conversation: HTMLElement,
  snapshot: StreamPresentationSnapshot,
  existing: Map<string, HTMLElement>,
): void {
  const desired: HTMLElement[] = [];
  const liveToolEntries = new Map(snapshot.liveToolEntries.map((entry) => [entry.key, entry]));
  for (const segment of snapshot.pendingStream) {
    const current = existing.get(segment.key);
    if (segment.kind === "tools") {
      const group = pendingToolGroupElement(segment, liveToolEntries, current instanceof HTMLDetailsElement ? current : undefined);
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
  existing.clear();
  for (const element of desired) {
    const key = element.dataset.streamKey;
    if (key !== undefined) existing.set(key, element);
  }
  let cursor = conversation.lastElementChild;
  let sameOrder = true;
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    if (cursor !== desired[index]) {
      sameOrder = false;
      break;
    }
    cursor = cursor?.previousElementSibling ?? null;
  }
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
  let renderedContentRevision = -1;
  const pendingElements = new Map<string, HTMLElement>();
  const updateButton = (followChat: boolean, viewport: StreamViewport = options.chat): void => {
    if (followChat) {
      if (!options.scrollButton.hidden) options.scrollButton.hidden = true;
      return;
    }
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const hidden = distance <= 1;
    if (options.scrollButton.hidden !== hidden) options.scrollButton.hidden = hidden;
  };
  const scrollToBottom = (): void => {
    const scrollTop = Math.max(0, options.chat.scrollHeight - options.chat.clientHeight);
    if (Math.abs(options.chat.scrollTop - scrollTop) <= 1) return;
    options.chat.scrollTop = scrollTop;
    options.onProgrammaticScroll(scrollTop);
  };
  return {
    renderViewport: updateButton,
    render: (snapshot) => {
      if (snapshot.contentRevision !== renderedContentRevision) {
        updatePendingMessages(options.conversation, snapshot, pendingElements);
        renderedContentRevision = snapshot.contentRevision;
      }
      if (snapshot.followChat || !options.hasCommittedMessages() || snapshot.scrollToLatest) {
        scrollToBottom();
        if (!options.scrollButton.hidden) options.scrollButton.hidden = true;
      } else updateButton(snapshot.followChat);
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
