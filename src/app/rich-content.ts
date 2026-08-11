import { DOMPurify, katex, marked, mermaid } from "../vendor/rendering-runtime.js";

let mermaidConfigured = false;
let mermaidSequence = 0;

const mathPattern = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|(?<!\\)\$([^$\n]+?)\$/g;

function renderMath(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.TEXT_NODE && current.parentElement?.closest("code, pre, .katex, .mermaid-diagram") === null) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

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

function configureMermaid(): void {
  if (mermaidConfigured) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
  mermaidConfigured = true;
}

async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre > code.language-mermaid, pre > code.lang-mermaid, code.language-mermaid"));
  if (blocks.length === 0) return;
  configureMermaid();

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

export function renderRichContent(container: HTMLElement, source: string): void {
  const rendered = marked.parse(source, { async: false, breaks: true, gfm: true });
  const html = typeof rendered === "string" ? rendered : source;
  container.innerHTML = String(DOMPurify.sanitize(html));
  renderMath(container);
  void renderMermaidBlocks(container);
}
