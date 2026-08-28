import { DOMPurify, marked } from "../vendor/markdown-runtime.js";

// katex and mermaid load only when content actually uses them; the markdown
// runtime (marked + DOMPurify) is small enough to keep on the startup path.
let katexModule: Promise<typeof import("../vendor/katex-runtime.js")> | undefined;
let mermaidModule: Promise<typeof import("../vendor/mermaid-runtime.js")> | undefined;
let katexStylesLoaded = false;

function ensureKatexStyles(): void {
  if (katexStylesLoaded) return;
  if (document.querySelector('link[data-katex-style]') !== null) {
    katexStylesLoaded = true;
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.katexStyle = "true";
  const href = new URL("vendor/katex/katex.min.css", document.baseURI);
  const version = document.querySelector<HTMLMetaElement>('meta[name="build-version"]')?.content;
  if (version !== undefined && version.length > 0) href.searchParams.set("v", version);
  link.href = href.toString();
  document.head.append(link);
  katexStylesLoaded = true;
}

function loadKatex(): Promise<typeof import("../vendor/katex-runtime.js")> {
  return (katexModule ??= import("../vendor/katex-runtime.js"));
}

function loadMermaid(): Promise<typeof import("../vendor/mermaid-runtime.js")> {
  return (mermaidModule ??= import("../vendor/mermaid-runtime.js"));
}

let mermaidConfigured = false;
let mermaidSequence = 0;

export interface RichContentOptions {
  readonly streaming?: boolean;
}

interface CommentSyntax {
  readonly line: readonly string[];
  readonly block: readonly { readonly start: string; readonly end: string }[];
}

const mathPattern = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|(?<!\\)\$([^$\n]+?)\$/g;
const streamingMarkdownPattern = /[`*_\[\]<>]|\\[`*_{}\[\]<>#$|~]|~~|https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.\w+|&(?:#\d+|#x[\da-f]+|\w+);|(?:^|\n)[ \t]{0,3}#{1,6}(?:\s|$)|(?:^|\n)(?: {4}|\t)|(?:^|\n)[ \t]*(?:[-+>]\s|\d+[.)]\s|[-=]{2,}[ \t]*(?:\n|$))/gi;
const markdownTablePattern = /(?:^|\n)[^|\n]*\|[^\n]*(?:\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?)+[ \t]*\|?[ \t]*\r?(?:\n|$))/gi;
const STREAMING_MARKDOWN_TAIL_LIMIT = 4096;
interface StreamingSourceState {
  source: string;
  hasMarkdown: boolean;
  prefixLength: number;
  tailNodes: Node[];
  rawTailNode: HTMLElement | undefined;
  safeBoundary: number;
  fenceOpen: boolean;
  fenceChar: string;
  fenceLength: number;
  linePrefix: string;
  lineHasContent: boolean;
  lineLeadingSpaces: number;
  lineFenceChar: string;
  lineFenceLength: number;
  lineFencePhase: "leading" | "marker" | "trailing" | "invalid";
}

const streamingSources = new WeakMap<HTMLElement, StreamingSourceState>();

function streamingState(source: string, hasMarkdown: boolean): StreamingSourceState {
  const state: StreamingSourceState = {
    source: "",
    hasMarkdown,
    prefixLength: 0,
    tailNodes: [],
    rawTailNode: undefined,
    safeBoundary: 0,
    fenceOpen: false,
    fenceChar: "",
    fenceLength: 0,
    linePrefix: "",
    lineHasContent: false,
    lineLeadingSpaces: 0,
    lineFenceChar: "",
    lineFenceLength: 0,
    lineFencePhase: "leading",
  };
  if (hasMarkdown) scanStreamingBoundary(state, source, 0);
  state.source = source;
  return state;
}

function streamingFenceStart(source: string, offset: number): number | undefined {
  const match = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/.exec(source.slice(offset));
  if (match === null) return undefined;
  const markerOffset = offset + match.index + (match[0].startsWith("\n") ? 1 : 0);
  return source.lastIndexOf("\n", markerOffset - 1) + 1;
}

function streamingStateFromPlain(source: string, lateFenceStart?: number): StreamingSourceState {
  const state = streamingState("", true);
  const cutoff = Math.max(0, source.length - STREAMING_MARKDOWN_TAIL_LIMIT);
  state.prefixLength = Math.min(source.lastIndexOf("\n", cutoff) + 1, lateFenceStart ?? Number.POSITIVE_INFINITY);
  state.safeBoundary = state.prefixLength;
  // ponytail: a late Markdown marker only needs the bounded tail to recover fence state; the confirmed plain prefix stays untouched.
  scanStreamingBoundary(state, source.slice(state.prefixLength), state.prefixLength);
  state.source = source;
  return state;
}

function scanStreamingBoundary(state: StreamingSourceState, delta: string, offset: number): void {
  let position = offset;
  for (const character of delta) {
    if (character === "\n") {
      const wasFenceOpen = state.fenceOpen;
      const fence = state.linePrefix.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (fence !== null) {
        const marker = fence[1] ?? "";
        const markerChar = marker[0] ?? "";
        if (!state.fenceOpen) {
          state.fenceOpen = true;
          state.fenceChar = markerChar;
          state.fenceLength = Math.max(marker.length, state.lineFenceLength);
        }
        else if (state.lineFencePhase !== "invalid"
          && markerChar === state.fenceChar
          && state.lineFenceLength >= state.fenceLength) {
          state.fenceOpen = false;
        }
      }
      if (wasFenceOpen && !state.fenceOpen) state.safeBoundary = position + 1;
      else if (!state.fenceOpen && !state.lineHasContent) state.safeBoundary = position + 1;
      else if (!state.fenceOpen && position + 1 - state.prefixLength >= STREAMING_MARKDOWN_TAIL_LIMIT) {
        // ponytail: cap reparsing for long line-oriented Markdown; final render restores exact block semantics.
        state.safeBoundary = position + 1;
      }
      state.linePrefix = "";
      state.lineHasContent = false;
      state.lineLeadingSpaces = 0;
      state.lineFenceChar = "";
      state.lineFenceLength = 0;
      state.lineFencePhase = "leading";
    }
    else if (character !== "\r") {
      if (state.linePrefix.length < 16) state.linePrefix += character;
      if (character !== " " && character !== "\t") state.lineHasContent = true;
      if (state.lineFencePhase === "leading") {
        if (character === " " || character === "\t") {
          if (state.lineLeadingSpaces < 3) state.lineLeadingSpaces += 1;
          else state.lineFencePhase = "invalid";
        }
        else if (character === "`" || character === "~") {
          state.lineFenceChar = character;
          state.lineFenceLength = 1;
          state.lineFencePhase = "marker";
        }
        else state.lineFencePhase = "invalid";
      }
      else if (state.lineFencePhase === "marker") {
        if (character === state.lineFenceChar) state.lineFenceLength += 1;
        else if (character === " " || character === "\t") state.lineFencePhase = "trailing";
        else state.lineFencePhase = "invalid";
      }
      else if (state.lineFencePhase === "trailing" && character !== " " && character !== "\t") state.lineFencePhase = "invalid";
    }
    position += character.length;
  }
}

function regexMatchedAfter(pattern: RegExp, source: string, boundary: number): boolean {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index + match[0].length > boundary) {
      pattern.lastIndex = 0;
      return true;
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return false;
}

function markdownFragment(source: string): DocumentFragment {
  if (source.length === 0) return document.createDocumentFragment();
  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true });
  const html = typeof rendered === "string" ? rendered : source;
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true } });
}

function streamingTailHost(node: Node | undefined): HTMLElement | undefined {
  if (!(node instanceof HTMLElement)) return undefined;
  return ["P", "H1", "H2", "H3", "LI", "BLOCKQUOTE", "TD", "TH"].includes(node.tagName) ? node : undefined;
}

function appendStreamingRawTail(container: HTMLElement, state: StreamingSourceState): void {
  const tail = document.createElement("span");
  tail.className = "streaming-tail";
  const text = document.createTextNode("");
  tail.append(text);
  const host = streamingTailHost(state.tailNodes.at(-1));
  if (host === undefined) {
    container.append(tail);
    state.tailNodes.push(tail);
  } else host.append(tail);
  state.rawTailNode = tail;
}

function appendStreamingCodeDelta(container: HTMLElement, state: StreamingSourceState, delta: string): boolean {
  if (!state.fenceOpen || /```|~~~/.test(delta)) return false;
  const code = container.lastElementChild?.querySelector<HTMLElement>(":scope > code");
  const text = code?.lastChild;
  if (!(text instanceof Text)) return false;
  // ponytail: an open fenced block is already escaped by the browser Text node; reparse only when a fence closes.
  text.appendData(delta);
  return true;
}

function trimOpenFencePlaceholder(tail: DocumentFragment, state: StreamingSourceState): void {
  if (!state.fenceOpen || state.source.endsWith("\n") || state.source.endsWith("\r")) return;
  const pre = tail.lastElementChild;
  const code = pre instanceof HTMLElement && pre.tagName === "PRE" ? pre.firstElementChild : undefined;
  const text = code?.lastChild;
  if (text instanceof Text && text.data.endsWith("\n")) {
    // ponytail: marked adds a sentinel newline to an open fence; remove it until the stream supplies one.
    text.deleteData(text.data.length - 1, 1);
  }
}

function renderStreamingMarkdown(container: HTMLElement, state: StreamingSourceState): void {
  for (const node of state.tailNodes) node.parentNode?.removeChild(node);
  state.rawTailNode = undefined;
  if (state.safeBoundary > state.prefixLength) {
    const stable = markdownFragment(state.source.slice(state.prefixLength, state.safeBoundary));
    container.append(stable);
    state.prefixLength = state.safeBoundary;
  }
  const tail = markdownFragment(state.source.slice(state.prefixLength));
  trimOpenFencePlaceholder(tail, state);
  state.tailNodes = Array.from(tail.childNodes);
  container.append(tail);
  if (!state.fenceOpen && state.safeBoundary === state.prefixLength && state.source.length - state.prefixLength >= STREAMING_MARKDOWN_TAIL_LIMIT) {
    // ponytail: keep a long unterminated line as escaped text after one parse; reparse when syntax or a boundary arrives.
    appendStreamingRawTail(container, state);
  }
}

function streamingMarkdownWasAdded(previous: string | undefined, delta: string, appended: boolean): boolean {
  const tail = appended && previous !== undefined ? previous.slice(-256) : "";
  const candidate = appended ? tail + delta : delta;
  const boundary = appended ? tail.length : 0;
  if (regexMatchedAfter(streamingMarkdownPattern, candidate, boundary)) return true;
  if (!candidate.includes("|")) return false;
  return regexMatchedAfter(markdownTablePattern, candidate, boundary);
}

function hasMarkdownSyntax(source: string): boolean {
  return regexMatchedAfter(streamingMarkdownPattern, source, 0) || (source.includes("|") && regexMatchedAfter(markdownTablePattern, source, 0));
}

function containsMath(source: string): boolean {
  if (!source.includes("$") && !source.includes("\\")) return false;
  mathPattern.lastIndex = 0;
  const found = mathPattern.test(source);
  mathPattern.lastIndex = 0;
  return found;
}

async function renderMath(container: HTMLElement): Promise<void> {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.TEXT_NODE && current.parentElement?.closest("code, pre, .katex, .mermaid-diagram") === null) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  // Skip the katex download entirely when no math syntax is present.
  if (!textNodes.some((node) => containsMath(node.nodeValue ?? ""))) return;
  ensureKatexStyles();
  const { katex } = await loadKatex();
  if (!container.isConnected) return;

  for (const node of textNodes) {
    if (!node.isConnected || !container.contains(node)) continue;
    const source = node.nodeValue ?? "";
    mathPattern.lastIndex = 0;
    let match = mathPattern.exec(source);
    if (match === null) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (match !== null) {
      if (match.index > cursor) fragment.append(source.slice(cursor, match.index));
      const expression = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
      const displayMode = match[1] !== undefined || match[3] !== undefined;
      try {
        const template = document.createElement("template");
        template.innerHTML = katex.renderToString(expression, { displayMode, throwOnError: false, strict: "ignore" });
        fragment.append(template.content.cloneNode(true));
      } catch {
        fragment.append(match[0]);
      }
      cursor = match.index + match[0].length;
      match = mathPattern.exec(source);
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    node.replaceWith(fragment);
  }
}

async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre > code.language-mermaid, pre > code.lang-mermaid, code.language-mermaid"));
  if (blocks.length === 0) return;
  const { mermaid } = await loadMermaid();
  if (!container.isConnected) return;
  if (!mermaidConfigured) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    mermaidConfigured = true;
  }

  for (const block of blocks) {
    if (!block.isConnected || !container.contains(block)) continue;
    const host = block.parentElement?.tagName === "PRE" ? block.parentElement : block;
    const source = block.textContent ?? "";
    const diagram = document.createElement("div");
    diagram.className = "mermaid-diagram";
    diagram.setAttribute("role", "img");
    diagram.setAttribute("aria-label", "Mermaid diagram");
    diagram.textContent = "Rendering diagram…";
    host.replaceWith(diagram);

    try {
      const id = `mermaid-diagram-${++mermaidSequence}`;
      const rendered = await mermaid.render(id, source);
      if (!diagram.isConnected) return;
      diagram.innerHTML = String(DOMPurify.sanitize(rendered.svg, { ADD_TAGS: ["foreignObject"] }));
      rendered.bindFunctions?.(diagram);
    } catch {
      const fallback = document.createElement("pre");
      fallback.className = "mermaid-fallback";
      fallback.textContent = source;
      diagram.replaceChildren(fallback);
      diagram.setAttribute("aria-label", "Mermaid diagram source");
    }
  }
}

function commentSyntax(language: string): CommentSyntax {
  const normalized = language.toLowerCase().replace(/^language-/, "");
  const cLike = { line: ["//"], block: [{ start: "/*", end: "*/" }] };
  if (["js", "jsx", "javascript", "ts", "tsx", "typescript", "java", "c", "h", "cpp", "c++", "cc", "cxx", "csharp", "cs", "go", "rust", "rs", "swift", "kotlin", "kt", "dart", "php", "scala", "groovy", "solidity", "zig", "d"].includes(normalized)) return cLike;
  if (["css", "scss", "sass", "less"].includes(normalized)) return { line: [], block: [{ start: "/*", end: "*/" }] };
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(normalized)) return { line: [], block: [{ start: "<!--", end: "-->" }] };
  if (["sql", "ada"].includes(normalized)) return { line: ["--"], block: [{ start: "/*", end: "*/" }] };
  if (["lua"].includes(normalized)) return { line: ["--"], block: [{ start: "--[[", end: "]]" }] };
  if (["haskell", "hs", "elm"].includes(normalized)) return { line: ["--"], block: [{ start: "{-", end: "-}" }] };
  if (["pascal", "delphi"].includes(normalized)) return { line: ["//"], block: [{ start: "{", end: "}" }, { start: "(*", end: "*)" }] };
  if (["matlab", "octave", "tex", "latex"].includes(normalized)) return { line: ["%"], block: [] };
  if (["fortran", "f", "f90", "f95"].includes(normalized)) return { line: ["!"], block: [] };
  if (["lisp", "scheme", "clojure", "clj", "racket"].includes(normalized)) return { line: [";"], block: [] };
  if (["erlang", "prolog"].includes(normalized)) return { line: ["%"], block: [] };
  if (["python", "py", "ruby", "rb", "shell", "bash", "sh", "zsh", "fish", "powershell", "ps1", "yaml", "yml", "toml", "dockerfile", "makefile", "perl", "pl", "r", "rscript", "elixir", "ex", "nim", "cmake"].includes(normalized)) return { line: ["#"], block: [] };
  return { line: ["//", "#", "--"], block: [{ start: "/*", end: "*/" }, { start: "<!--", end: "-->" }] };
}

function stripComments(source: string, syntax: CommentSyntax): string {
  let result = "";
  let index = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockEnd = "";
  while (index < source.length) {
    const character = source[index] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      index += 1;
      continue;
    }
    if (blockEnd !== "") {
      if (source.startsWith(blockEnd, index)) {
        index += blockEnd.length;
        blockEnd = "";
      } else {
        if (character === "\n") result += character;
        index += 1;
      }
      continue;
    }
    if (quote !== "") {
      result += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    const block = syntax.block.find((candidate) => source.startsWith(candidate.start, index));
    if (block !== undefined) {
      index += block.start.length;
      blockEnd = block.end;
      continue;
    }
    const line = syntax.line.find((marker) => source.startsWith(marker, index));
    if (line !== undefined) {
      index += line.length;
      lineComment = true;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    result += character;
    index += 1;
  }
  return result.replace(/[ \t]+(?=\r?\n)/g, "");
}

export async function copyText(source: string): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(source);
      return;
    }
  } catch {
    // Fall through to the legacy browser-native copy path.
  }
  const helper = document.createElement("textarea");
  helper.value = source;
  helper.setAttribute("readonly", "true");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("Clipboard access was unavailable.");
}

export function bindCopyButton(button: HTMLButtonElement, source: string): void {
  const label = button.textContent ?? "Copy";
  button.addEventListener("click", () => {
    void copyText(source).then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = label; }, 1400);
    }).catch(() => {
      button.textContent = "Copy failed";
      window.setTimeout(() => { button.textContent = label; }, 1800);
    });
  });
}

function enhanceCodeBlocks(container: HTMLElement): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLPreElement>("pre"))) {
    const code = pre.firstElementChild;
    if (!(code instanceof HTMLElement) || code.tagName !== "CODE") continue;
    if (code.classList.contains("language-mermaid") || code.classList.contains("lang-mermaid")) continue;
    const source = code.textContent ?? "";
    const languageClass = Array.from(code.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length) ?? "";
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    toolbar.setAttribute("aria-label", "Code actions");
    if (language !== "") {
      const languageLabel = document.createElement("span");
      languageLabel.className = "code-language";
      languageLabel.textContent = language;
      languageLabel.setAttribute("translate", "no");
      toolbar.append(languageLabel);
    }
    const actions = document.createElement("span");
    actions.className = "code-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy-button";
    copy.dataset.copyMode = "source";
    copy.textContent = "Copy";
    bindCopyButton(copy, source);
    const cleanCopy = document.createElement("button");
    cleanCopy.type = "button";
    cleanCopy.className = "code-copy-clean-button";
    cleanCopy.dataset.copyMode = "without-comments";
    cleanCopy.textContent = "Copy without comments";
    bindCopyButton(cleanCopy, stripComments(source, commentSyntax(language)));
    actions.append(copy, cleanCopy);
    toolbar.append(actions);
    pre.replaceWith(wrapper);
    wrapper.append(toolbar, pre);
  }
}

export function renderRichContent(container: HTMLElement, source: string, options: RichContentOptions = {}): void {
  let previousStreamingSource: string | undefined;
  let previousStreamingState: StreamingSourceState | undefined;
  let streamingStateValue: StreamingSourceState | undefined;
  let hasStreamingMarkdown = false;
  let appended = false;
  let streamingDelta: string | undefined;
  let streamingMarkdownAdded = false;
  if (options.streaming === true) {
    previousStreamingState = streamingSources.get(container);
    previousStreamingSource = previousStreamingState?.source;
    if (previousStreamingSource === source) return;
    // ponytail: stream segments are append-only, so a bounded prefix check avoids O(n) reconciliation; use a rolling hash if edits become valid.
    const prefixLength = Math.min(32, previousStreamingSource?.length ?? 0);
    appended = previousStreamingSource !== undefined
      && source.length > previousStreamingSource.length
      && source.slice(0, prefixLength) === previousStreamingSource.slice(0, prefixLength);
    const delta = appended ? source.slice(previousStreamingSource!.length) : source;
    streamingDelta = delta;
    const canAppendInline = appended && previousStreamingSource !== undefined
      && !previousStreamingSource.endsWith("\n") && !delta.includes("\n") && !delta.includes("\r");
    // ponytail: rich streams only need marker detection on the same-line append fast path; line-boundary frames reparse their tail anyway.
    streamingMarkdownAdded = previousStreamingState?.hasMarkdown === true
      ? canAppendInline && streamingMarkdownWasAdded(previousStreamingSource, delta, appended)
      : streamingMarkdownWasAdded(previousStreamingSource, delta, appended);
    hasStreamingMarkdown = previousStreamingState?.hasMarkdown === true || streamingMarkdownAdded;
    if (appended && previousStreamingState !== undefined && previousStreamingState.hasMarkdown === true) {
      scanStreamingBoundary(previousStreamingState, delta, previousStreamingSource!.length);
      previousStreamingState.source = source;
      streamingStateValue = previousStreamingState;
    }
    else if (hasStreamingMarkdown) {
      streamingStateValue = appended && previousStreamingState?.hasMarkdown === false
        ? streamingStateFromPlain(source, streamingFenceStart(source, previousStreamingSource?.length ?? 0))
        : streamingState(source, true);
    }
    else {
      streamingStateValue = previousStreamingState ?? streamingState(source, false);
      streamingStateValue.source = source;
    }
    streamingStateValue.hasMarkdown = hasStreamingMarkdown;
    streamingSources.set(container, streamingStateValue);
  } else streamingSources.delete(container);
  if (options.streaming === true && !hasStreamingMarkdown) {
    if (!container.classList.contains("plain-text")) container.classList.add("plain-text");
    const text = container.firstChild;
    if (text instanceof Text && text === container.lastChild && appended && previousStreamingSource !== undefined) {
      text.appendData(source.slice(previousStreamingSource.length));
    }
    else container.textContent = source;
    return;
  }
  if (options.streaming === true && hasStreamingMarkdown && container.classList.contains("plain-text")) container.classList.remove("plain-text");
  if (options.streaming === true && appended && streamingDelta !== undefined && previousStreamingSource !== undefined
    && !previousStreamingSource.endsWith("\n") && !streamingDelta.includes("\r") && !streamingDelta.includes("\n") && !streamingMarkdownAdded) {
    const block = container.lastElementChild;
    const text = block?.lastChild;
    if (text instanceof Text) {
      text.appendData(streamingDelta);
      return;
    }
  }
  if (options.streaming === true && appended && streamingDelta !== undefined && streamingStateValue?.rawTailNode !== undefined
    && !streamingMarkdownAdded && !streamingDelta.includes("\r") && !streamingDelta.includes("\n") && !streamingStateValue.fenceOpen) {
    const text = streamingStateValue.rawTailNode.firstChild;
    if (text instanceof Text) text.appendData(streamingDelta);
    else streamingStateValue.rawTailNode.textContent = streamingDelta;
    return;
  }
  if (options.streaming === true && hasStreamingMarkdown && streamingStateValue !== undefined) {
    if (!appended || previousStreamingState === undefined || previousStreamingState.hasMarkdown !== true) {
      if (appended && previousStreamingState?.hasMarkdown === false && streamingStateValue.prefixLength > 0) {
        const prefix = document.createElement("span");
        prefix.className = "streaming-plain-prefix";
        prefix.textContent = source.slice(0, streamingStateValue.prefixLength);
        container.replaceChildren(prefix);
      } else container.replaceChildren();
    }
    if (appended && streamingDelta !== undefined && appendStreamingCodeDelta(container, streamingStateValue, streamingDelta)) return;
    renderStreamingMarkdown(container, streamingStateValue);
    return;
  }
  const hasMarkdown = hasMarkdownSyntax(source);
  const hasMath = containsMath(source);
  if (!hasMarkdown && !hasMath) {
    // ponytail: plain output stays one escaped Text node; rich syntax still uses the full parser.
    if (!container.classList.contains("plain-text")) container.classList.add("plain-text");
    container.textContent = source;
    return;
  }
  if (container.classList.contains("plain-text")) container.classList.remove("plain-text");
  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true });
  const html = typeof rendered === "string" ? rendered : source;
  container.innerHTML = String(DOMPurify.sanitize(html));
  if (options.streaming === true) return;
  enhanceCodeBlocks(container);
  // ponytail: avoid a full text walk and code-block query when the source cannot contain either enhancement.
  if (hasMath) void renderMath(container);
  if (source.includes("mermaid")) void renderMermaidBlocks(container);
}
