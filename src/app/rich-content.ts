import { DOMPurify, marked } from "../vendor/markdown-runtime.js";

// katex and mermaid load only when content actually uses them; the markdown
// runtime (marked + DOMPurify) is small enough to keep on the startup path.
let katexModule: Promise<typeof import("../vendor/katex-runtime.js")> | undefined;
let mermaidModule: Promise<typeof import("../vendor/mermaid-runtime.js")> | undefined;

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

function containsMath(source: string): boolean {
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
  const { katex } = await loadKatex();

  for (const node of textNodes) {
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
  if (!mermaidConfigured) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    mermaidConfigured = true;
  }

  for (const block of blocks) {
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
  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true });
  const html = typeof rendered === "string" ? rendered : source;
  container.innerHTML = String(DOMPurify.sanitize(html));
  if (options.streaming === true) return;
  enhanceCodeBlocks(container);
  void renderMath(container);
  void renderMermaidBlocks(container);
}
