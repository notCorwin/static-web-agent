import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, normalize, extname } from "node:path";

const root = process.cwd();
const browserCandidates = [
  process.env.BROWSER_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value) => value !== undefined);

async function findBrowser() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next platform location.
    }
  }
  return undefined;
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}

function createScannedPdf(pageCount = 1) {
  const pageRefs = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << >> >>"),
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function createMixedPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << >> >>",
    "<< /Length 41 >>\nstream\nBT /F1 18 Tf 20 60 Td (MIXED TEXT) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

async function startStaticServer() {
  let toolRequests = 0;
  let streamedToolRequests = 0;
  let failedVisionRequests = 0;
  const reasoningRequests = [];
  const visionRequests = [];
  const assetRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (pathname.includes("paddleocr") || pathname.includes("onnxruntime") || pathname.includes("pdfjs") || pathname.includes("anydoc")) assetRequests.push(pathname);
      if (pathname === "/test-sse" || pathname === "/test-rich" || pathname === "/test-tool" || pathname === "/test-tool-stream" || pathname === "/test-scroll" || pathname === "/test-hang" || pathname === "/test-reasoning" || pathname === "/test-vision" || pathname === "/test-vision-fail") {
        if (pathname === "/test-reasoning") {
          const rawBody = await new Promise((resolve) => {
            let body = "";
            request.on("data", (chunk) => { body += chunk.toString(); });
            request.on("end", () => resolve(body));
          });
          try { reasoningRequests.push(JSON.parse(rawBody)); } catch { reasoningRequests.push(undefined); }
        }
        if (pathname === "/test-vision" || pathname === "/test-vision-fail") {
          const rawBody = await new Promise((resolve) => {
            let body = "";
            request.on("data", (chunk) => { body += chunk.toString(); });
            request.on("end", () => resolve(body));
          });
          try {
            visionRequests.push(JSON.parse(rawBody));
          } catch {
            visionRequests.push(undefined);
          }
        }
        if (pathname === "/test-vision-fail" && failedVisionRequests++ === 0) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("intentional vision failure");
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (pathname === "/test-scroll") {
          const chunks = [
            "# Streaming heading\n\n",
            Array.from({ length: 32 }, (_, index) => `Scroll line ${index + 1}`).join("\n") + "\n",
            ...Array.from({ length: 20 }, (_, index) => `stream chunk ${index + 1}\n`),
            "The stream finished.\n",
          ];
          let index = 0;
          const sendChunk = () => {
            if (response.destroyed) return;
            if (index < chunks.length) {
              response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`);
              index += 1;
              setTimeout(sendChunk, 250);
              return;
            }
            response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            response.end("data: [DONE]\n\n");
          };
          sendChunk();
          return;
        }
        const content = pathname === "/test-rich"
          ? [
            "# Rich response",
            "",
            "Inline math: $x^2 + y^2 = z^2$.",
            "",
            "$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$",
            "",
            "```mermaid",
            "flowchart TD",
            "  Start[Start] --> Done[Done]",
            "```",
            "",
            "```javascript",
            "const value = 1; // remove line comment",
            "/* remove block comment */",
            "console.log(value);",
            "```",
          ].join("\n")
          : pathname === "/test-vision" || pathname === "/test-vision-fail"
            ? "vision complete"
            : pathname === "/test-tool" || pathname === "/test-tool-stream" || pathname === "/test-reasoning"
            ? "tool complete"
            : "sse";
        if (pathname === "/test-tool-stream" && streamedToolRequests++ === 0) {
          const firstArguments = JSON.stringify({ code: "await new Promise(resolve => setTimeout(resolve, 260)); return 42" });
          const secondArguments = JSON.stringify({ code: "await new Promise(resolve => setTimeout(resolve, 1200)); return 42" });
          const fragments = (value) => Array.from({ length: Math.ceil(value.length / 70) }, (_, index) => value.slice(index * 70, (index + 1) * 70));
          const toolChunks = [
            { index: 0, id: "browser-streamed-tool-call", function: { name: "runtime_" } },
            { index: 0, function: { name: "javascript" } },
            ...fragments(firstArguments).map((argumentsValue) => ({ index: 0, function: { arguments: argumentsValue } })),
            { index: 1, id: "browser-streamed-tool-call-2", function: { name: "runtime_" } },
            { index: 1, function: { name: "javascript" } },
            ...fragments(secondArguments).map((argumentsValue) => ({ index: 1, function: { arguments: argumentsValue } })),
          ];
          const chunks = [
            { type: "text", value: "Before tool\n" },
            ...toolChunks.map((value) => ({ type: "tool", value })),
            { type: "text", value: "After tool\n" },
          ];
          let index = 0;
          const sendToolChunk = () => {
            if (response.destroyed) return;
            if (index < chunks.length) {
              const chunk = chunks[index];
              const delta = chunk.type === "text" ? { content: chunk.value } : { tool_calls: [chunk.value] };
              response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
              index += 1;
              setTimeout(sendToolChunk, 65);
              return;
            }
            response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
            setTimeout(() => {
              response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
              response.end("data: [DONE]\n\n");
            }, 5);
          };
          sendToolChunk();
          return;
        }
        if (pathname === "/test-reasoning") {
          const chunks = [
            { choices: [{ delta: { reasoning_content: "first reasoning step\n" } }] },
            { choices: [{ delta: { reasoning_content: "second reasoning step\n" } }] },
            { choices: [{ delta: { content: "reasoning answer" } }] },
          ];
          let index = 0;
          const sendReasoningChunk = () => {
            if (response.destroyed) return;
            if (index < chunks.length) {
              response.write(`data: ${JSON.stringify(chunks[index])}\n\n`);
              index += 1;
              setTimeout(sendReasoningChunk, 1200);
              return;
            }
            response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            response.end("data: [DONE]\n\n");
          };
          setTimeout(sendReasoningChunk, 1200);
          return;
        } else if (pathname === "/test-tool" && toolRequests++ === 0) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "browser-tool-call", type: "function", function: { name: "runtime_javascript", arguments: '{"code":"return 42"}' } }] } }] })}\n\n`);
          response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        }
        if (pathname !== "/test-hang") {
          setTimeout(() => {
            response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            response.end("data: [DONE]\n\n");
          }, 5);
        }
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = normalize(join(root, relative));
      if (!file.startsWith(`${root}/`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, reasoningRequests, visionRequests, assetRequests };
}

function waitForOutput(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Chrome DevTools.")), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        child.stdout.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools started (${code}).`));
    });
  });
}

class CdpPage {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    }
    return result.result?.value;
  }

  async close() {
    this.socket.close();
  }
}

async function waitFor(page, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const browser = await findBrowser();
if (browser === undefined) {
  if (process.env.REQUIRE_BROWSER === "1") throw new Error("Browser checks require Chromium; set BROWSER_PATH.");
  console.log("Browser checks skipped: set BROWSER_PATH to a Chromium-based browser to run them.");
  process.exit(0);
}

const externalLongPdfPath = process.env.E2E_LONG_PDF_PATH;
const externalLongPdfPages = Number.parseInt(process.env.E2E_LONG_PDF_PAGES ?? "", 10);
const externalLongPdfVision = process.env.E2E_LONG_PDF_VISION !== "0";
const useWebGpu = process.env.E2E_WEBGPU === "1";
const externalLongPdfBase64 = externalLongPdfPath === undefined
  ? undefined
  : (await readFile(externalLongPdfPath)).toString("base64");
if (externalLongPdfBase64 !== undefined && !Number.isInteger(externalLongPdfPages)) {
  throw new Error("E2E_LONG_PDF_PAGES is required when E2E_LONG_PDF_PATH is set.");
}
const { server, port, reasoningRequests, visionRequests, assetRequests } = await startStaticServer();
const scannedPdfBase64 = Buffer.from(createScannedPdf()).toString("base64");
const longScannedPdfBase64 = Buffer.from(createScannedPdf(12)).toString("base64");
const mixedPdfBase64 = Buffer.from(createMixedPdf()).toString("base64");
const release = JSON.parse(await readFile(join(root, "dist/version.json"), "utf8"));
const profile = await mkdtemp(join(tmpdir(), "static-web-agent-browser-"));
const child = spawn(browser, [
  "--headless=new",
  "--no-sandbox",
  ...(useWebGpu ? ["--enable-unsafe-webgpu"] : ["--disable-gpu"]),
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/dist/index.html`,
], { stdio: ["ignore", "pipe", "pipe"] });

let page;
try {
  const debuggerUrl = await waitForOutput(child);
  const devtools = new URL(debuggerUrl);
  const pages = await (await fetch(`http://${devtools.host}/json/list`)).json();
  const target = pages.find((item) => item.type === "page");
  if (target === undefined) throw new Error("Chrome did not expose a page target.");
  page = new CdpPage(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1035, height: 922, deviceScaleFactor: 1, mobile: false });
  await waitFor(page, "document.querySelector('.app-shell') !== null && document.querySelector('#message-input')?.disabled === false && document.querySelector('#runtime-action') === null && document.querySelector('#storage-action') === null && document.querySelector('.sidebar') === null && document.querySelector('.tools-panel') === null && !document.querySelector('.loading-state')");
  const initialUi = await page.evaluate(`({
    noWorkspaceNavigation: document.querySelector('.sidebar') === null,
    noRuntimeSurface: document.querySelector('.tools-panel') === null,
    noOfflineControl: document.querySelector('#use-local') === null,
    noChatHeader: document.querySelector('.topbar') === null && document.querySelector('#conversation-title') === null && document.querySelector('#model-chip') === null,
    noConnectionBar: document.querySelector('#connection-details') === null && document.querySelector('#connection-card') !== null,
    connectionCardVisible: document.querySelector('#connection-card')?.hidden === false,
    noComposerRows: document.querySelector('.composer-hint') === null && getComputedStyle(document.querySelector('#run-status')).position === 'absolute',
    noSeparateCancelButton: document.querySelector('#cancel-button') === null,
    sendButtonHidden: document.querySelector('#send-button')?.hidden,
    sendButtonDisplay: getComputedStyle(document.querySelector('#send-button')).display,
    sendButtonLabel: document.querySelector('#send-button .button-label')?.textContent,
    compactComposer: parseFloat(getComputedStyle(document.querySelector('#message-input')).minHeight) <= 64,
  })`);
  assert.deepEqual(initialUi, { noWorkspaceNavigation: true, noRuntimeSurface: true, noOfflineControl: true, noChatHeader: true, noConnectionBar: true, connectionCardVisible: true, noComposerRows: true, noSeparateCancelButton: true, sendButtonHidden: true, sendButtonDisplay: "none", sendButtonLabel: "Stop", compactComposer: true });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await waitFor(page, "getComputedStyle(document.documentElement).colorScheme === 'dark'");
  const darkTheme = await page.evaluate(`(() => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
  }))()`);
  assert.deepEqual(darkTheme, { colorScheme: "dark", background: "rgb(17, 17, 17)", text: "rgb(244, 244, 244)" });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitFor(page, "getComputedStyle(document.documentElement).colorScheme === 'light'");
  assert.equal(await page.evaluate("document.querySelector('meta[name=\\\"build-version\\\"]')?.content"), release.version);
  const composerLayout = await page.evaluate(`(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
    return { bottomGap: shell.bottom - composer.bottom, composerTop: composer.top, viewportBottom: window.innerHeight };
  })()`);
  assert.ok(composerLayout.bottomGap <= 1, "the composer should stay at the bottom of the workspace");
  const connectionLayout = await page.evaluate(`(() => {
    const workspace = document.querySelector('#main-content').getBoundingClientRect();
    const card = document.querySelector('#connection-card').getBoundingClientRect();
    const inputTops = ['#model-endpoint', '#model-name', '#model-key'].map((selector) => document.querySelector(selector).getBoundingClientRect().top);
    const buttonTop = document.querySelector('#connection-form > .primary-button').getBoundingClientRect().top;
    return {
      cardCenter: { x: card.left + card.width / 2, y: card.top + card.height / 2 },
      workspaceCenter: { x: workspace.left + workspace.width / 2, y: workspace.top + workspace.height / 2 },
      inputTops,
      buttonTop,
      composerHeight: document.querySelector('#message-input').getBoundingClientRect().height,
      modelAutocomplete: document.querySelector('#model-name').autocomplete,
      keyAutocomplete: document.querySelector('#model-key').autocomplete,
      modelLabel: document.querySelector('label[for="model-name"]').textContent,
      endpointLabel: document.querySelector('label[for="model-endpoint"]').textContent,
      keyLabel: document.querySelector('label[for="model-key"]').textContent,
      keyHelp: document.querySelector('#key-help').textContent,
      thinkingValue: document.querySelector('#thinking-level').value,
      thinkingLabel: document.querySelector('label[for="thinking-level"]').textContent,
      thinkingHelp: document.querySelector('#thinking-level-help').textContent,
    };
  })()`);
  assert.ok(Math.abs(connectionLayout.cardCenter.x - connectionLayout.workspaceCenter.x) <= 1, "the connection card should be horizontally centered in the workspace");
  assert.ok(Math.abs(connectionLayout.cardCenter.y - connectionLayout.workspaceCenter.y) <= 1, "the connection card should be vertically centered in the workspace");
  assert.ok(Math.abs(connectionLayout.inputTops[1] - connectionLayout.inputTops[2]) <= 1, "model and API key inputs should share a top alignment");
  assert.ok(Math.abs(connectionLayout.buttonTop - connectionLayout.inputTops[1]) <= 2, "connection button should align with the model fields");
  assert.equal(connectionLayout.modelAutocomplete, "username");
  assert.equal(connectionLayout.keyAutocomplete, "current-password");
  assert.ok(connectionLayout.modelLabel.includes("password-manager username"), "the model name should be presented as the password-manager username");
  assert.ok(connectionLayout.endpointLabel.includes("saved locally"), "the endpoint should be presented as browser-local state");
  assert.ok(connectionLayout.keyLabel.includes("password manager + local"), "the API key should be presented as password-manager and local state");
  assert.ok(connectionLayout.keyHelp.includes("password-manager password"), "the API key help should explain its password-manager role");
  assert.equal(connectionLayout.thinkingValue, "provider-default");
  assert.ok(connectionLayout.thinkingLabel.includes("Thinking level"));
  assert.ok(connectionLayout.thinkingHelp.includes("reasoning"));
  assert.ok(connectionLayout.composerHeight <= 50, "the message composer should stay compact");
  const controlMetrics = await page.evaluate(`(() => ['#model-endpoint', '#model-name', '#model-key', '#thinking-level'].map((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return { selector, height: style.height, fontSize: style.fontSize, lineHeight: style.lineHeight, appearance: style.appearance };
  }))()`);
  assert.deepEqual(controlMetrics, [
    { selector: "#model-endpoint", height: "36px", fontSize: "16px", lineHeight: "20px", appearance: "none" },
    { selector: "#model-name", height: "36px", fontSize: "16px", lineHeight: "20px", appearance: "none" },
    { selector: "#model-key", height: "36px", fontSize: "16px", lineHeight: "20px", appearance: "none" },
    { selector: "#thinking-level", height: "36px", fontSize: "16px", lineHeight: "20px", appearance: "none" },
  ]);
  const connectionFocus = await page.evaluate(`(() => ['#model-endpoint', '#model-name', '#model-key', '#thinking-level'].map((selector) => {
    const input = document.querySelector(selector);
    input.focus();
    const style = getComputedStyle(input);
    return { selector, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow };
  }))()`);
  assert.deepEqual(connectionFocus, [
    { selector: "#model-endpoint", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px", boxShadow: "none" },
    { selector: "#model-name", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px", boxShadow: "none" },
    { selector: "#model-key", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px", boxShadow: "none" },
    { selector: "#thinking-level", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px", boxShadow: "none" },
  ]);
  const composerFocus = await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.focus();
    const inputStyle = getComputedStyle(input);
    const composerStyle = getComputedStyle(document.querySelector('.composer'));
    return { outlineWidth: inputStyle.outlineWidth, composerShadow: composerStyle.boxShadow };
  })()`);
  assert.deepEqual(composerFocus, { outlineWidth: "0px", composerShadow: "none" });

  const composerGrowth = await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    const setValue = (value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { height: input.getBoundingClientRect().height, overflowY: getComputedStyle(input).overflowY };
    };
    const singleLine = setValue('single line');
    const multiLine = setValue('line 1\\nline 2\\nline 3');
    const manyLines = setValue(Array.from({ length: 30 }, (_, index) => 'line ' + (index + 1)).join('\\n'));
    const maxHeight = Number.parseFloat(getComputedStyle(input).maxHeight);
    setValue('');
    return { singleLine, multiLine, manyLines, maxHeight };
  })()`);
  assert.ok(composerGrowth.singleLine.height < composerGrowth.multiLine.height, "the composer should grow for multiline input");
  assert.ok(composerGrowth.manyLines.height <= composerGrowth.maxHeight + 1, "the composer should stop growing at its max height");
  assert.equal(composerGrowth.manyLines.overflowY, "auto", "long multiline input should scroll inside the capped composer");

  await page.evaluate(`(() => {
    window.__permissionPrompted = false;
    window.confirm = () => {
      window.__permissionPrompted = true;
      return true;
    };
  })()`);
  const keyboardBehavior = await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'first';
    input.setSelectionRange(input.value.length, input.value.length);
    const sendEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const sendDispatch = input.dispatchEvent(sendEvent);
    const valueAfterSend = input.value;
    input.value = 'first';
    input.setSelectionRange(input.value.length, input.value.length);
    const newlineEvent = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    const newlineDispatch = input.dispatchEvent(newlineEvent);
    return { sendDispatch, valueAfterSend, newlineDispatch, valueAfterNewline: input.value };
  })()`);
  assert.deepEqual(keyboardBehavior, { sendDispatch: false, valueAfterSend: "first", newlineDispatch: false, valueAfterNewline: "first\n" });
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'message before connecting';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#run-status')?.textContent.includes('Connect a remote model')");
  await page.evaluate("document.querySelector('#message-input').value = ''");

  const firstPageTime = await page.evaluate("performance.timeOrigin");
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(page, `performance.timeOrigin > ${firstPageTime} && document.querySelector('#message-input')?.disabled === false && document.querySelector('#runtime-action') === null && document.querySelector('#connection-card')?.hidden === false && document.querySelectorAll('.message').length === 0 && !document.querySelector('.loading-state')`);
  const resetState = await page.evaluate(`({
    noSessionControls: document.querySelector('#new-session') === null && document.querySelector('#session-list') === null && document.querySelector('#session-count') === null,
    noSessionUrl: !new URL(location.href).searchParams.has('session'),
    lightTheme: getComputedStyle(document.documentElement).colorScheme === 'light',
    pureWhiteBackground: getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)',
    noDisconnectedWelcome: document.querySelector('.empty-state') === null,
    connectionCardVisible: document.querySelector('#connection-card')?.hidden === false,
  })`);
  assert.deepEqual(resetState, { noSessionControls: true, noSessionUrl: true, lightTheme: true, pureWhiteBackground: true, noDisconnectedWelcome: true, connectionCardVisible: true });
  await page.evaluate(`(() => {
    window.__permissionPrompted = false;
    window.confirm = () => {
      window.__permissionPrompted = true;
      return true;
    };
  })()`);

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-sse';
    document.querySelector('#model-name').value = 'vendor/browser-test:free';
    document.querySelector('#model-key').value = 'browser-test-key';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  assert.equal(await page.evaluate("window.__permissionPrompted === false"), true, "selecting a remote model should not show a capability confirmation");
  assert.equal(await page.evaluate("document.querySelector('.empty-state h2')?.textContent"), "Browser Test", "the connected welcome should show the normalized model name");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'remote request';
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'sse'");
  const messageStyles = await page.evaluate("(() => { const assistant = document.querySelector('.message.assistant'); const user = document.querySelector('.message.user'); const assistantBody = assistant.querySelector('.message-body'); const userBody = user.querySelector('.message-body'); const assistantStyle = getComputedStyle(assistant); const assistantBodyStyle = getComputedStyle(assistantBody); const userBodyStyle = getComputedStyle(userBody); return { assistantBorder: assistantBodyStyle.borderTopWidth, assistantBackground: assistantBodyStyle.backgroundColor, assistantPadding: assistantBodyStyle.padding, assistantAlign: assistantStyle.alignSelf, assistantWidth: assistantStyle.width, assistantHeaders: assistant.querySelectorAll('.message-header').length, userBorder: userBodyStyle.borderTopWidth, userPadding: userBodyStyle.padding, userHeaders: user.querySelectorAll('.message-header').length }; })()");
  assert.deepEqual({ ...messageStyles, assistantWidth: undefined }, { assistantBorder: "0px", assistantBackground: "rgba(0, 0, 0, 0)", assistantPadding: "0px", assistantAlign: "center", assistantWidth: undefined, assistantHeaders: 0, userBorder: "1px", userPadding: "13px 15px", userHeaders: 0 });
  assert.ok(Number.parseFloat(messageStyles.assistantWidth) > 900, "the assistant column should use the available wide layout");
  const messageAlignment = await page.evaluate(`(() => {
    const assistant = document.querySelector('.message.assistant').getBoundingClientRect();
    const user = document.querySelector('.message.user .message-body').getBoundingClientRect();
    return { userRight: user.right, assistantRight: assistant.right };
  })()`);
  assert.ok(Math.abs(messageAlignment.userRight - messageAlignment.assistantRight) <= 1, "the user bubble should align with the assistant column's right edge");
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-vision';
    document.querySelector('#model-vision').checked = false;
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const NativeWorker = window.Worker;
    const stats = { created: 0, terminated: 0, predicts: 0, predictBatchSizes: [], runtimes: [], delayed: false };
    window.__ocrWorkerStats = stats;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.__ocrWorker = String(url).includes('worker-entry');
        this.__ocrTimers = new Set();
        this.__ocrRequestTypes = new Map();
        if (this.__ocrWorker) {
          stats.created += 1;
          this.addEventListener('message', (event) => {
            const response = event.data;
            if (response?.kind !== 'worker-transport-response') return;
            const type = this.__ocrRequestTypes.get(response.requestId);
            this.__ocrRequestTypes.delete(response.requestId);
            if (response.status !== 'success') return;
            const runtime = type === 'init'
              ? response.payload?.summary
              : type === 'predict' && Array.isArray(response.payload)
                ? response.payload[0]?.runtime
                : undefined;
            if (runtime !== undefined) stats.runtimes.push(runtime);
          });
        }
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transferables) => {
          if (this.__ocrWorker && message?.kind === 'worker-transport-request') {
            this.__ocrRequestTypes.set(message.requestId, message.type);
            if (message.type === 'predict') {
              stats.predicts += 1;
              stats.predictBatchSizes.push(message.payload?.sources?.length ?? 0);
            }
          }
          if (this.__ocrWorker && stats.delayed && message?.kind === 'worker-transport-request' && message.type === 'predict') {
            const timer = setTimeout(() => {
              this.__ocrTimers.delete(timer);
              try { post(message, transferables); } catch {}
            }, 5000);
            this.__ocrTimers.add(timer);
            return;
          }
          post(message, transferables);
        };
      }

      terminate() {
        for (const timer of this.__ocrTimers) clearTimeout(timer);
        this.__ocrTimers.clear();
        if (this.__ocrWorker) stats.terminated += 1;
        return super.terminate();
      }
    };
  })()`);
  const previousOcrAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.font = '64px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('OCR E2E', canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error('Could not create OCR fixture.')) : resolve(value), 'image/png'));
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousOcrAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 120_000);
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  const ocrRequest = visionRequests.at(-1);
  const ocrMessage = ocrRequest?.messages?.findLast((message) => typeof message.content === "string" && message.content.toUpperCase().includes("OCR"));
  assert.equal(typeof ocrMessage?.content, "string");
  assert.ok(ocrMessage?.content.includes("OCR E2E"), "non-vision image uploads should preserve recognized OCR text");
  assert.equal(ocrRequest?.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")), false);
  const initialOcrStats = await page.evaluate("window.__ocrWorkerStats");
  assert.equal(initialOcrStats.predicts, 1, "one image should produce one OCR prediction");
  const initialRuntime = initialOcrStats.runtimes.at(-1);
  assert.equal(initialRuntime?.detProvider, useWebGpu ? "webgpu" : "wasm", "OCR detection provider should match the selected E2E backend");
  assert.equal(initialRuntime?.recProvider, useWebGpu ? "webgpu" : "wasm", "OCR recognition provider should match the selected E2E backend");
  assert.equal(initialRuntime?.webgpuAvailable, useWebGpu, "OCR runtime metadata should report WebGPU availability accurately");
  if (!useWebGpu) assert.ok(assetRequests.some((path) => path.endsWith("/ort-wasm-simd-threaded.jsep.wasm")), "local OCR should load the JSEP runtime");
  assert.equal(assetRequests.some((path) => path.endsWith("/ort-wasm-simd-threaded.wasm")), false, "local OCR should not load the legacy runtime");
  const predictsBeforeBatch = initialOcrStats.predicts;
  const previousBatchAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.font = '64px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('OCR E2E', canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error('Could not create batch fixture.')) : resolve(value), 'image/png'));
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'batch-a.png', { type: 'image/png' }));
    transfer.items.add(new File([blob], 'batch-b.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousBatchAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 120_000);
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true", 120_000);
  const batchOcrStats = await page.evaluate("window.__ocrWorkerStats");
  assert.equal(batchOcrStats.predicts - predictsBeforeBatch, 1, "two images should produce one batched OCR prediction");
  assert.equal(batchOcrStats.predictBatchSizes.at(-1), 2, "the OCR worker should receive both images in one batch");
  assert.ok(batchOcrStats.predictBatchSizes.every((size) => size <= 2), "the OCR worker should never receive more than two images at once");
  await page.evaluate(`(async () => {
    window.__ocrWorkerStats.delayed = true;
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.font = '64px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('OCR E2E', canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error('Could not create cancellation fixture.')) : resolve(value), 'image/png'));
    transfer.items.add(new File([blob], 'cancel.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#message-input').value = 'cancel OCR';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.evaluate("document.querySelector('#composer-form').requestSubmit()");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true", 2_000);
  const cancelledOcrStats = await page.evaluate("window.__ocrWorkerStats");
  assert.ok(cancelledOcrStats.terminated >= 1, "stopping local OCR should terminate its worker");
  const requestsBeforeRecreatedOcr = visionRequests.length;
  await page.evaluate(`(() => {
    window.__ocrWorkerStats.delayed = false;
    document.querySelector('#message-input').value = 'OCR after cancellation';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  const retryAfterCancellationDeadline = Date.now() + 120_000;
  while (visionRequests.length <= requestsBeforeRecreatedOcr && Date.now() < retryAfterCancellationDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (visionRequests.length <= requestsBeforeRecreatedOcr) throw new Error("Timed out waiting for OCR after cancellation.");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true", 120_000);
  const recreatedOcrStats = await page.evaluate("window.__ocrWorkerStats");
  assert.ok(recreatedOcrStats.created >= 2, "local OCR should recreate a worker after cancellation");
  assert.match(visionRequests.at(-1)?.messages?.findLast((message) => message.role === "user")?.content ?? "", /OCR E2E/);
  const previousMixedLocalAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob('${mixedPdfBase64}'), (value) => value.charCodeAt(0));
    transfer.items.add(new File([bytes], 'mixed.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#message-input').value = 'mixed local PDF';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousMixedLocalAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 30_000);
  const mixedLocalRequest = visionRequests.at(-1);
  const mixedLocalMessage = mixedLocalRequest?.messages?.findLast((message) => typeof message.content === "string" && message.content.includes("MIXED TEXT"));
  assert.equal(typeof mixedLocalMessage?.content, "string");
  assert.equal(mixedLocalRequest?.messages?.some((message) => Array.isArray(message.content)), false, "mixed local PDFs should not send page images");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  await page.evaluate(`(() => {
    document.querySelector('#model-vision').checked = true;
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'scan.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(page, "document.querySelector('.attachment-chip-label')?.textContent === 'scan.png'");
  await page.evaluate("document.querySelector('#composer-form').requestSubmit()");
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'", 20_000);
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  const visualRequest = visionRequests.at(-1);
  const visualMessage = visualRequest?.messages?.findLast((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  assert.equal(visualMessage?.content?.[0]?.type, "text");
  assert.equal(visualMessage?.content?.[1]?.type, "image_url");
  assert.match(visualMessage?.content?.[1]?.image_url?.url ?? "", /^data:image\/png;base64,/);
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-vision-fail';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.font = '64px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('OCR E2E', canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error('Could not create retry fixture.')) : resolve(value), 'image/png'));
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'retry.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#message-input').value = 'retry vision request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('[data-action=vision-fallback]') !== null", 20_000);
  const failedVisionRequest = visionRequests.at(-1);
  const failedVisionImageCount = failedVisionRequest?.messages?.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").length : 0), 0) ?? 0;
  const failedVisionUserCount = failedVisionRequest?.messages?.filter((message) => message.role === "user").length ?? 0;
  const failedVisionRequestCount = visionRequests.length;
  await page.evaluate("document.querySelector('[data-action=vision-fallback]').click()");
  const retryRequestDeadline = Date.now() + 120_000;
  while (visionRequests.length <= failedVisionRequestCount && Date.now() < retryRequestDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (visionRequests.length <= failedVisionRequestCount) throw new Error("Timed out waiting for local OCR retry request.");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true", 120_000);
  const retriedVisionRequest = visionRequests.at(-1);
  const retriedVisionImageCount = retriedVisionRequest?.messages?.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").length : 0), 0) ?? 0;
  const retriedVisionUserCount = retriedVisionRequest?.messages?.filter((message) => message.role === "user").length ?? 0;
  const retriedVisionMessage = retriedVisionRequest?.messages?.findLast((message) => message.role === "user");
  assert.equal(retriedVisionUserCount, failedVisionUserCount, "local OCR retry should replace the failed user turn");
  assert.equal(retriedVisionImageCount, failedVisionImageCount - 1, "local OCR retry should remove the failed visual attachment");
  assert.equal(typeof retriedVisionMessage?.content, "string");
  assert.match(retriedVisionMessage?.content ?? "", /OCR E2E/);
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  const previousAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new TextEncoder().encode('name,value\\nAlice,1\\n')], 'notes.csv', { type: 'text/csv' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 20_000);
  const documentRequest = visionRequests.at(-1);
  const documentMessage = documentRequest?.messages?.findLast((message) => typeof message.content === "string" && message.content.includes("Alice"));
  assert.equal(typeof documentMessage?.content, "string");
  assert.ok(documentMessage?.content.includes("Alice"), "ordinary documents should be converted to Markdown locally before sending");
  assert.ok(assetRequests.some((path) => path.endsWith("/app/assets/anydoc-worker.js")), "document conversion should run in its dedicated worker");
  assert.ok(assetRequests.some((path) => path.endsWith("/vendor/anydoc/anydoc_wasm_bg.wasm")), "the anydoc worker should load its WASM from the same origin");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  const previousMixedVisualAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob('${mixedPdfBase64}'), (value) => value.charCodeAt(0));
    transfer.items.add(new File([bytes], 'mixed.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousMixedVisualAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 30_000);
  const mixedVisualRequest = visionRequests.at(-1);
  const mixedVisualMessage = mixedVisualRequest?.messages?.findLast((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  assert.equal(mixedVisualMessage?.content?.filter((part) => part.type === "image_url").length, 1, "mixed PDFs should send only their image-only page");
  assert.ok(mixedVisualMessage?.content?.some((part) => part.type === "text" && part.text.includes("MIXED TEXT")), "mixed PDFs should retain their text page");
  await waitFor(page, "document.querySelector('#send-button')?.hidden === true");
  const previousPdfAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob('${scannedPdfBase64}'), (value) => value.charCodeAt(0));
    transfer.items.add(new File([bytes], 'scanned.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousPdfAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 30_000);
  const scannedPdfRequest = visionRequests.at(-1);
  const scannedPdfMessage = scannedPdfRequest?.messages?.findLast((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  assert.equal(scannedPdfMessage?.content?.[0]?.type, "text");
  assert.equal(scannedPdfMessage?.content?.[1]?.type, "image_url");
  assert.ok(assetRequests.some((path) => path.endsWith("/vendor/pdfjs/pdf.worker.mjs")), "scanned PDF rendering should use a dedicated PDF worker");
  const previousLongPdfAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
  await page.evaluate(`(() => {
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob('${longScannedPdfBase64}'), (value) => value.charCodeAt(0));
    transfer.items.add(new File([bytes], 'long-scanned.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#message-input').value = 'long PDF worker E2E';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousLongPdfAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 30_000);
  const longPdfAttachmentCount = await page.evaluate("Array.from(document.querySelectorAll('article.message.user')).at(-1)?.querySelectorAll('.message-attachment-chip').length ?? 0");
  assert.equal(longPdfAttachmentCount, 12, `long scanned PDF should retain all rendered page attachments in the user message, got ${longPdfAttachmentCount}`);
  const longPdfRequest = visionRequests.at(-1);
  const longPdfMessage = longPdfRequest?.messages?.findLast((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  assert.equal(longPdfMessage?.content?.filter((part) => part.type === "image_url").length, 12, "long scanned PDFs should render and retain every page without blocking the UI");
  if (externalLongPdfBase64 !== undefined) {
    await page.evaluate(`(() => {
      document.querySelector('#model-vision').checked = ${externalLongPdfVision ? "true" : "false"};
      document.querySelector('#connection-form').requestSubmit();
    })()`);
    await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
    const previousExternalPdfAssistantCount = await page.evaluate("document.querySelectorAll('.message.assistant .message-body').length");
    const externalPdfStartedAt = Date.now();
    await page.evaluate(`(() => {
      const input = document.querySelector('#attachment-input');
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob('${externalLongPdfBase64}'), (value) => value.charCodeAt(0));
      transfer.items.add(new File([bytes], 'folder-long-scanned.pdf', { type: 'application/pdf' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#message-input').value = 'folder long PDF worker E2E';
      document.querySelector('#composer-form').requestSubmit();
    })()`);
    await waitFor(page, `document.querySelectorAll('.message.assistant .message-body').length > ${previousExternalPdfAssistantCount} && Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'vision complete'`, 180_000);
    const externalPdfElapsedMs = Date.now() - externalPdfStartedAt;
    if (useWebGpu && !externalLongPdfVision && externalLongPdfPages === 1) assert.ok(externalPdfElapsedMs <= 60_000, `single-page WebGPU OCR took ${externalPdfElapsedMs}ms`);
    if (useWebGpu && !externalLongPdfVision && externalLongPdfPages === 35) assert.ok(externalPdfElapsedMs <= 180_000, `35-page WebGPU OCR took ${externalPdfElapsedMs}ms`);
    const externalAttachmentCount = await page.evaluate("Array.from(document.querySelectorAll('article.message.user')).at(-1)?.querySelectorAll('.message-attachment-chip').length ?? 0");
    assert.equal(externalAttachmentCount, externalLongPdfVision ? externalLongPdfPages : 0, "the folder PDF should expose visual page attachments only in vision mode");
    const externalRequest = visionRequests.at(-1);
    const externalMessage = externalRequest?.messages?.at(-1);
    if (externalLongPdfVision) {
      assert.equal(externalMessage?.content?.filter((part) => part.type === "image_url").length, externalLongPdfPages, "the folder PDF should send every rendered page to the vision model");
    } else {
      assert.equal(typeof externalMessage?.content, "string", "the local OCR route should send text instead of page images");
      assert.match(externalMessage?.content ?? "", /folder-long-scanned\.pdf/);
    }
  }
  if (externalLongPdfBase64 === undefined) {
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-rich';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = ['# User rich', '', 'User math: $a^2$'].join(String.fromCharCode(10));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.message.assistant:last-of-type .message-body h1')?.textContent === 'Rich response' && document.querySelector('.message.assistant:last-of-type .katex') !== null && document.querySelector('.message.assistant:last-of-type .mermaid-diagram svg') !== null", 20_000);
  const richFeatures = await page.evaluate("(() => { const assistant = Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1); const user = Array.from(document.querySelectorAll('.message.user .message-body')).at(-1); return { assistantMarkdown: assistant?.querySelector('h1')?.textContent === 'Rich response', assistantLatex: assistant?.querySelector('.katex') !== null, assistantMermaid: assistant?.querySelector('.mermaid-diagram svg') !== null, userMarkdown: user?.querySelector('h1')?.textContent === 'User rich', userLatex: user?.querySelector('.katex') !== null }; })()");
  assert.deepEqual(richFeatures, { assistantMarkdown: true, assistantLatex: true, assistantMermaid: true, userMarkdown: true, userLatex: true });
  await waitFor(page, "document.querySelector('.message.assistant:last-of-type .code-copy-button') !== null");
  await page.evaluate(`(() => {
    window.__copiedCode = [];
    const writeText = async (value) => window.__copiedCode.push(value);
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    } catch {
      navigator.clipboard.writeText = writeText;
    }
  })()`);
  await page.evaluate("document.querySelector('.message.assistant:last-of-type .code-copy-button').click()");
  await waitFor(page, "document.querySelector('.message.assistant:last-of-type .code-copy-button')?.textContent === 'Copied'");
  const copiedSource = await page.evaluate("window.__copiedCode.at(-1)");
  assert.ok(copiedSource.includes('remove line comment'), "the regular copy action should preserve comments");
  await page.evaluate("document.querySelector('.message.assistant:last-of-type .code-copy-clean-button').click()");
  await waitFor(page, "document.querySelector('.message.assistant:last-of-type .code-copy-clean-button')?.textContent === 'Copied'");
  const copiedWithoutComments = await page.evaluate("window.__copiedCode.at(-1)");
  assert.ok(!copiedWithoutComments.includes('remove line comment') && !copiedWithoutComments.includes('remove block comment'), "the comment-free copy action should remove line and block comments");
  await page.evaluate("document.querySelector('.message.assistant:last-of-type .copy-message-button').click()");
  await waitFor(page, "document.querySelector('.message.assistant:last-of-type .copy-message-button')?.textContent === 'Copied'");
  assert.ok((await page.evaluate("window.__copiedCode.at(-1)")) .includes('# Rich response'), "the assistant message should have a copy action");
  await page.evaluate(`(() => { const message = Array.from(document.querySelectorAll('.message.user')).find((item) => item.querySelector('.message-body')?.textContent.includes('User rich')); message?.querySelector('.copy-message-button')?.click(); })()`);
  await waitFor(page, `Array.from(document.querySelectorAll('.message.user')).find((item) => item.querySelector('.message-body')?.textContent.includes('User rich'))?.querySelector('.copy-message-button')?.textContent === 'Copied'`);
  assert.ok((await page.evaluate("window.__copiedCode.at(-1)")) .includes('# User rich'), "the user message should have a copy action");
  await page.evaluate(`(() => { const message = Array.from(document.querySelectorAll('.message.user')).find((item) => item.querySelector('.message-body')?.textContent.includes('User rich')); message?.querySelector('.edit-message-button')?.click(); })()`);
  await waitFor(page, "document.querySelector('.message-edit textarea') !== null");
  const editorFocus = await page.evaluate(`(() => {
    const editor = document.querySelector('.message-edit textarea');
    editor.focus();
    const style = getComputedStyle(editor);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow };
  })()`);
  assert.deepEqual(editorFocus, { outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px", boxShadow: "none" });
  await page.evaluate(`(() => {
    const editor = document.querySelector('.message-edit textarea');
    editor.value = '# Edited user rich\\n\\nUser math: $b^2$';
    document.querySelector('.message-edit [data-action=save-edit]').click();
  })()`);
  await waitFor(page, "Array.from(document.querySelectorAll('.message.user .message-body')).at(-1)?.textContent.includes('Edited user rich') && document.querySelector('.message.assistant:last-of-type .message-body h1')?.textContent === 'Rich response'", 20_000);
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-reasoning';
    document.querySelector('#thinking-level').value = 'high';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'reasoning request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.message.assistant.pending .thinking-block[open]') !== null", 5_000);
  const thinkingPlaceholder = await page.evaluate(`(() => ({
    summary: document.querySelector('.message.assistant.pending .thinking-summary')?.textContent,
    body: document.querySelector('.message.assistant.pending .thinking-body')?.textContent,
  }))()`);
  assert.deepEqual(thinkingPlaceholder, { summary: "Thinking…", body: "" });
  await waitFor(page, "document.querySelector('.message.assistant.pending .thinking-block[open] .thinking-body')?.textContent.includes('first reasoning step')", 20_000);
  const streamingThinking = await page.evaluate(`(() => ({
    summary: document.querySelector('.message.assistant.pending .thinking-summary')?.textContent,
    open: document.querySelector('.message.assistant.pending .thinking-block')?.open,
    body: document.querySelector('.message.assistant.pending .thinking-body')?.textContent,
  }))()`);
  assert.deepEqual(streamingThinking, { summary: "Thinking…", open: true, body: "first reasoning step\n" });
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'reasoning answer' && document.querySelector('#send-button .button-label')?.textContent === 'Send'", 20_000);
  const finishedThinking = await page.evaluate(`(() => {
    const block = document.querySelector('.message.assistant .thinking-block');
    return { summary: block?.querySelector('.thinking-summary')?.textContent, open: block?.open, body: block?.querySelector('.thinking-body')?.textContent };
  })()`);
  assert.equal(finishedThinking.summary, "Thinking");
  assert.equal(finishedThinking.open, false, "completed thinking should be collapsed by default");
  assert.ok(finishedThinking.body?.includes("first reasoning step") && finishedThinking.body.includes("second reasoning step"));
  assert.equal(reasoningRequests.at(-1)?.reasoning_effort, "high");
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-hang';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'cancel request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#send-button .button-label')?.textContent === 'Stop' && document.querySelector('#send-button')?.hidden === false && document.querySelector('#send-button')?.getAttribute('aria-label') === 'Stop generation'");
  const stopButton = await page.evaluate(`(() => {
    const button = document.querySelector('#send-button');
    const style = getComputedStyle(button);
    const icon = button.querySelector('.stop-icon');
    return { width: style.width, height: style.height, borderRadius: style.borderRadius, iconWidth: getComputedStyle(icon).width, iconHeight: getComputedStyle(icon).height };
  })()`);
  assert.deepEqual(stopButton, { width: "36px", height: "36px", borderRadius: "999px", iconWidth: "11px", iconHeight: "11px" });
  await page.evaluate("document.querySelector('#send-button').click()");
  await waitFor(page, "document.querySelector('#run-status')?.textContent.includes('cancelled')");
  await waitFor(page, "document.querySelector('#send-button .button-label')?.textContent === 'Send' && document.querySelector('#send-button')?.hidden === true");

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-scroll';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'scroll request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#send-button .button-label')?.textContent === 'Stop' && document.querySelector('.message.assistant.pending .message-body')?.textContent.includes('Scroll line 32')", 20_000);
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 100))");
  await waitFor(page, "(() => { const chat = document.querySelector('#chat-log'); return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 2; })()", 5_000);
  const midStreamScroll = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    const pendingBody = document.querySelector('.message.assistant.pending .message-body');
    return { overflow: chat.scrollHeight > chat.clientHeight, distance: chat.scrollHeight - chat.scrollTop - chat.clientHeight, pendingChildren: pendingBody?.children.length ?? 0, pendingHeading: pendingBody?.querySelector('h1')?.textContent ?? null };
  })()`);
  assert.equal(midStreamScroll.overflow, true);
  assert.ok(midStreamScroll.distance <= 2, "the conversation should follow the bottom while the model streams");
  assert.ok(midStreamScroll.pendingChildren > 0, "streaming text should render Markdown before completion");
  assert.equal(midStreamScroll.pendingHeading, "Streaming heading");
  await page.evaluate("(() => { const chat = document.querySelector('#chat-log'); chat.scrollTop = 0; chat.dispatchEvent(new Event('scroll')); })()");
  await waitFor(page, "document.querySelector('#scroll-bottom-button')?.hidden === false");
  const detachedStreamScroll = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    const firstMessage = document.querySelector('.message.user .message-body');
    return { distance: chat.scrollHeight - chat.scrollTop - chat.clientHeight, firstMessageHeight: firstMessage?.getBoundingClientRect().height ?? 0 };
  })()`);
  assert.ok(detachedStreamScroll.distance > 2, "scrolling upward should detach the stream from the bottom");
  assert.ok(detachedStreamScroll.firstMessageHeight > 0, "history should remain laid out while the model streams");
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.includes('The stream finished') && document.querySelector('#send-button .button-label')?.textContent === 'Send'", 20_000);
  const finishedStreamScroll = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  })()`);
  assert.ok(finishedStreamScroll > 2, "the conversation should preserve the user's position after streaming");
  const scrollButtonLayout = await page.evaluate(`(() => {
    const button = document.querySelector('#scroll-bottom-button').getBoundingClientRect();
    const workspace = document.querySelector('#main-content').getBoundingClientRect();
    return { buttonCenter: button.left + button.width / 2, workspaceCenter: workspace.left + workspace.width / 2 };
  })()`);
  assert.ok(Math.abs(scrollButtonLayout.buttonCenter - scrollButtonLayout.workspaceCenter) <= 1, "the scroll button should be horizontally centered");
  await page.evaluate("document.querySelector('#scroll-bottom-button').click()");
  await waitFor(page, "document.querySelector('#scroll-bottom-button')?.hidden === true && (() => { const chat = document.querySelector('#chat-log'); return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 2; })()");

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-tool-stream';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'streaming tool request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.tool-group .tool-call-stream') !== null", 20_000);
  const streamingTool = await page.evaluate(`(() => ({
    group: document.querySelector('.tool-group > .tool-group-summary')?.textContent,
    preparing: document.querySelector('.tool-call-stream .tool-summary')?.textContent,
    groupOpen: document.querySelector('.tool-group')?.open,
    childOpen: Array.from(document.querySelectorAll('.tool-group-body > .tool-detail')).map((detail) => detail.open),
    bodyVisible: document.querySelector('.tool-call-stream .tool-detail-body')?.getBoundingClientRect().height > 0,
  }))()`);
  assert.match(streamingTool.group ?? "", /^Calling \d+ tools?…$/);
  assert.ok(streamingTool.preparing?.includes("runtime_"));
  assert.equal(streamingTool.groupOpen, true, "the active tool group should be open while streaming");
  assert.ok(streamingTool.childOpen?.some(Boolean), "an active tool detail should be open while streaming");
  assert.equal(streamingTool.bodyVisible, true, "streaming tool arguments should be visible");
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant.pending .message-body')).some((body) => body.textContent.includes('After tool'))", 5_000);
  const interleavedStream = await page.evaluate(`(() => Array.from(document.querySelector('#conversation-content').children)
    .filter((element) => element.dataset.streamKey !== undefined)
    .map((element) => ({
      kind: element.classList.contains('message') ? 'assistant' : 'tools',
      text: element.textContent,
    })))()`);
  assert.deepEqual(interleavedStream.map((item) => item.kind), ["assistant", "assistant", "tools", "assistant"], "thinking, streamed text, and tool calls should keep provider event order");
  assert.ok(interleavedStream[0]?.text.includes("Thinking") && interleavedStream[1]?.text.includes("Before tool") && interleavedStream[3]?.text.includes("After tool"), "interleaved streamed text should stay on its original side of the tool group");
  await page.evaluate("(() => { window.__firstStreamingToolGroup = document.querySelector('.tool-group.pending'); window.__firstStreamingToolDetail = document.querySelector('.tool-call-stream'); })()");
  await waitFor(page, "document.querySelector('.tool-call-stream .tool-detail-body')?.textContent.includes('return')", 5_000);
  const streamingStability = await page.evaluate(`({
    groupStable: window.__firstStreamingToolGroup === document.querySelector('.tool-group.pending'),
    detailStable: window.__firstStreamingToolDetail === document.querySelector('.tool-call-stream'),
    argumentVisible: document.querySelector('.tool-call-stream .tool-detail-body')?.textContent.includes('return'),
  })`);
  assert.deepEqual(streamingStability, { groupStable: true, detailStable: true, argumentVisible: true }, "streaming tool DOM should update in place without flickering");
  await waitFor(page, "document.querySelector('.tool-group.pending .tool-detail.tool-call-complete') !== null && document.querySelectorAll('.tool-group.pending > .tool-group-body > .tool-detail').length === 2 && Array.from(document.querySelectorAll('.tool-group.pending > .tool-group-body > .tool-detail')).some((detail) => detail.querySelector('.tool-summary')?.textContent.includes('running'))", 20_000);
  const continuousTool = await page.evaluate(`(() => ({
    groupOpen: document.querySelector('.tool-group.pending')?.open,
    items: Array.from(document.querySelectorAll('.tool-group.pending > .tool-group-body > .tool-detail')).map((detail) => detail.querySelector('.tool-summary')?.textContent),
    completedBody: Array.from(document.querySelectorAll('.tool-group.pending > .tool-group-body > .tool-detail')).find((detail) => detail.querySelector('.tool-summary')?.textContent.includes('complete'))?.querySelector('.tool-detail-body')?.textContent,
  }))()`);
  assert.equal(continuousTool.groupOpen, true, "the live tool group should stay open between sequential tool calls");
  assert.equal(continuousTool.items.length, 2, "completed and running calls should remain in one live group");
  assert.ok(continuousTool.items.some((summary) => summary?.includes("complete")), "the completed call should remain visible");
  assert.ok(continuousTool.items.some((summary) => summary?.includes("running")), "the next running call should be visible in the same group");
  assert.ok(continuousTool.completedBody?.includes("42"), "the completed tool result should remain visible");
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.trim() === 'tool complete' && document.querySelector('.tool-detail') !== null", 20_000);
  const hiddenTool = await page.evaluate(`(() => ({
    noToolCallList: document.querySelector('.tool-call-list') === null,
    noEmptyToolAssistant: Array.from(document.querySelectorAll('.message.assistant .message-body')).every((body) => body.textContent !== ''),
    groupClosed: document.querySelector('.tool-group')?.open === false,
    groupSummary: document.querySelector('.tool-group-summary')?.textContent,
    groupItems: document.querySelectorAll('.tool-group-body > .tool-detail').length,
    detailsClosed: document.querySelector('.tool-detail')?.open === false,
    summary: document.querySelector('.tool-summary')?.textContent,
    bodyVisible: document.querySelector('.tool-detail-body')?.getBoundingClientRect().height > 0,
  }))()`);
  assert.deepEqual(hiddenTool, { noToolCallList: true, noEmptyToolAssistant: true, groupClosed: true, groupSummary: "Called 2 tools", groupItems: 2, detailsClosed: true, summary: "runtime.javascript", bodyVisible: false });
  const toolGroupLayout = await page.evaluate(`(() => {
    const group = document.querySelector('.tool-group').getBoundingClientRect();
    const assistant = document.querySelector('.message.assistant').getBoundingClientRect();
    return { groupCenter: group.left + group.width / 2, assistantCenter: assistant.left + assistant.width / 2 };
  })()`);
  assert.ok(Math.abs(toolGroupLayout.groupCenter - toolGroupLayout.assistantCenter) <= 1, "the tool group should align with the assistant column");
  await page.evaluate("document.querySelector('.tool-group-summary').click()");
  await waitFor(page, "document.querySelector('.tool-group')?.open === true && document.querySelector('.tool-detail')?.open === true");
  assert.equal(await page.evaluate("document.querySelector('.tool-detail-body')?.textContent.includes('42')"), true);

  const secondPageTime = await page.evaluate("performance.timeOrigin");
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(page, `performance.timeOrigin > ${secondPageTime} && document.querySelector('#runtime-action') === null && document.querySelector('.empty-state') !== null && document.querySelector('#connection-card')?.hidden === true && !document.querySelector('.loading-state')`);
  const savedConnection = await page.evaluate(`({
    endpoint: document.querySelector('#model-endpoint')?.value,
    model: document.querySelector('#model-name')?.value,
    apiKey: document.querySelector('#model-key')?.value,
    thinkingLevel: document.querySelector('#thinking-level')?.value,
  })`);
  assert.deepEqual(savedConnection, { endpoint: `http://127.0.0.1:${port}/test-tool-stream`, model: "vendor/browser-test:free", apiKey: "browser-test-key", thinkingLevel: "high" });
  await page.evaluate("window.confirm = () => true");

  const browserBoundaries = await page.evaluate(`(async () => {
    const { Agent, BrowserPageRuntime, BrowserWorkerRuntime, CapabilityManager, IndexedDbStateStore, PluginManager, ToolRegistry, createBrowserApiPlugin } = await import('/dist/index.js');
    const { AiSdkAdapter } = await import('/dist/remote.js');
    const { AgentApp } = await import('/dist/app-entry.js');
    const runtime = new BrowserWorkerRuntime();
    const value = await runtime.execute('return input.value + 1', { value: 2 });
    const largeWorkerValue = await runtime.execute('return "x".repeat(70_000)', null);
    const workerApis = await runtime.execute('return { fetch: typeof fetch, webSocket: typeof WebSocket }', null);
    let timedOut = false;
    try { await runtime.execute('await new Promise(() => {})', null, { timeoutMs: 10 }); } catch (error) { timedOut = error.code === 'RUNTIME_TIMEOUT'; }

    const pageRuntime = new BrowserPageRuntime();
    const pageValue = await pageRuntime.execute("console.log('page-runtime'); return { value: input.value + 1, title: document.title, hasFetch: typeof fetch === 'function' }", { value: 2 });
    const largePageValue = await pageRuntime.execute('return "x".repeat(70_000)', null);
    const pageCapabilities = new CapabilityManager({ decide: () => true });
    pageCapabilities.register('page', { provide: () => pageRuntime });
    const pageTools = new ToolRegistry(pageCapabilities);
    const pagePlugins = new PluginManager(pageTools, pageCapabilities);
    const pagePluginHandle = await pagePlugins.install(createBrowserApiPlugin());
    const inspected = await pageTools.execute('browser.inspect', {});
    const evaluated = await pageTools.execute('browser.evaluate', { code: "console.log('browser-tool'); return { value: input.value + 1, title: document.title }", input: { value: 41 } });
    let webTurn = 0;
    const webModel = { id: 'page-tool-agent', async *stream({ messages }) {
      if (webTurn++ === 0) {
        yield { type: 'completed', message: { role: 'assistant', content: '', toolCalls: [{ id: 'page-call', name: 'browser.evaluate', arguments: { code: 'return input.value + 1', input: { value: 41 } } }] } };
      } else {
        yield { type: 'completed', message: { role: 'assistant', content: messages.at(-1)?.content.includes('42') ? 'page tool result: 42' : 'page tool failed' } };
      }
    }};
    const webAgentResult = await new Agent(webModel, pageTools).run({ messages: [{ role: 'user', content: 'Use the page tool.' }] });
    const inspectedValue = inspected.ok ? inspected.value : undefined;
    const evaluatedValue = evaluated.ok ? evaluated.value : undefined;
    await pagePluginHandle.uninstall();

    const databaseName = 'browser-test-' + crypto.randomUUID();
    const state = new IndexedDbStateStore({ databaseName, objectStoreName: 'state' });
    await state.apply([{ type: 'set', key: 'item', value: { ok: true } }]);
    const stored = await state.get('item');
    await state.clear();

    const adapter = new AiSdkAdapter({
      endpoint: location.origin + '/test-sse', model: 'demo',
      fetcher: (input, init) => fetch(input, init),
    });
    const events = [];
    for await (const event of adapter.stream({ messages: [], tools: [], signal: new AbortController().signal })) events.push(event);

    const capabilities = new CapabilityManager();
    const tools = new ToolRegistry(capabilities);
    let cancelled = false;
    const model = { id: 'cancel-test', async *stream({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    }};
    const controller = new AbortController();
    const run = new Agent(model, tools).run({ messages: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const cancellation = await run;

    const pluginCapabilities = new CapabilityManager();
    const pluginTools = new ToolRegistry(pluginCapabilities);
    const pluginManager = new PluginManager(pluginTools, pluginCapabilities);
    const plugin = {
      manifest: { apiVersion: '1', id: 'browser-plugin', name: 'Browser plugin', version: '1', permissions: [] },
      setup(context) {
        context.registerTool({ name: 'browser.tool', description: 'browser test', inputSchema: { type: 'object' }, execute: () => ({ ok: true }) });
        context.registerProcessor({ id: 'browser.processor', description: 'browser test', process: (input) => typeof input === 'string' ? input + '!' : input });
        context.registerUi({ id: 'browser.ui', mount: (container) => { container.textContent = 'mounted'; return () => { container.textContent = ''; }; } });
      },
    };
    const pluginHandle = await pluginManager.install(plugin);
    const extensionRoot = document.createElement('div');
    const unmount = pluginManager.mountUi(extensionRoot);
    const mounted = extensionRoot.textContent === 'mounted';
    const processed = await pluginManager.process('ok');
    await pluginHandle.uninstall();
    const removedOnUninstall = extensionRoot.textContent === '';
    unmount();

    const appRoot = document.createElement('div');
    document.body.append(appRoot);
    window.confirm = () => { throw new Error('unexpected permission prompt'); };
    const appPlugin = {
      manifest: { apiVersion: '1', id: 'app-browser-plugin', name: 'App browser plugin', version: '1', permissions: [{ name: 'page', reason: 'browser test' }] },
      setup(context) {
        context.registerTool({ name: 'app.browser.tool', description: 'browser test', inputSchema: { type: 'object' }, requiredCapabilities: ['page'], execute: () => ({ ok: true }) });
        context.registerUi({ id: 'app.browser.ui', mount: (container) => { container.textContent = 'app extension'; } });
      },
    };
    const app = new AgentApp(appRoot, { plugins: [appPlugin], autoConnect: false });
    await app.start();
    const appExtension = appRoot.textContent.includes('app extension');
    const appSnapshot = app.runtime?.snapshot();
    const defaultTools = appSnapshot?.tools.map((descriptor) => descriptor.name) ?? [];
    const defaultPlugins = appSnapshot?.manifests.some((manifest) => manifest.id === 'javascript-runtime')
      && appSnapshot?.manifests.some((manifest) => manifest.id === 'local-storage')
      && appSnapshot?.manifests.some((manifest) => manifest.id === 'browser-api');
    await app.stop();
    appRoot.remove();

    return {
      worker: value.value === 3,
      workerUnboundedOutput: largeWorkerValue.value.length === 70_000,
      workerAmbientApis: workerApis.value?.fetch === 'function' && workerApis.value?.webSocket === 'function',
      workerTimeout: timedOut,
      pageRuntime: pageValue.value?.value === 3 && typeof pageValue.value?.title === 'string' && pageValue.value?.hasFetch === true && pageValue.logs.includes('page-runtime'),
      pageUnboundedOutput: largePageValue.value.length === 70_000,
      browserInspect: inspected.ok && inspectedValue?.apis?.fetch === true && typeof inspectedValue?.url === 'string',
      browserEvaluate: evaluated.ok && evaluatedValue?.value?.value === 42 && evaluatedValue?.logs.includes('browser-tool'),
      browserAgent: webAgentResult.status === 'completed' && webAgentResult.response?.content === 'page tool result: 42',
      indexedDb: stored?.ok === true,
      sse: events.at(-1)?.type === 'completed' && events.at(-1)?.message.content === 'sse',
      cancelled: cancellation.status === 'cancelled' && cancelled,
      defaultPlugins: defaultPlugins && defaultTools.includes('runtime.javascript') && defaultTools.includes('storage.local'),
      pluginUi: mounted && processed === 'ok!' && removedOnUninstall && pluginTools.get('browser.tool') === undefined && extensionRoot.textContent === '' && appExtension,
    };
  })()`);
  assert.deepEqual(browserBoundaries, { worker: true, workerUnboundedOutput: true, workerAmbientApis: true, workerTimeout: true, pageRuntime: true, pageUnboundedOutput: true, browserInspect: true, browserEvaluate: true, browserAgent: true, indexedDb: true, sse: true, cancelled: true, defaultPlugins: true, pluginUi: true });
  }
  console.log("Browser checks passed: compact UI, page Web APIs, remote-only chat, default plugins, IndexedDB, SSE, and cancellation.");
} finally {
  await page?.close();
  const childExited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGTERM");
  await childExited;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
