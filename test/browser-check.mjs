import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const candidates = [
  process.env.BROWSER_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value) => value !== undefined);

async function findBrowser() {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return undefined;
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => resolve(body));
  });
}

async function startServer() {
  let requests = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/v1/chat/completions") {
      requests += 1;
      let body = {};
      try { body = JSON.parse(await readBody(request)); } catch { /* The adapter will report malformed provider input. */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((message) => message?.role === "user");
      if (lastUser?.content === "Fail after tool" && messages.at(-1)?.role === "tool") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "intentional provider failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (lastUser?.content === "Keep my place") {
        let index = 0;
        const write = () => {
          if (index < 80) {
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "streaming response " } }] })}\n\n`);
            index += 1;
            setTimeout(write, 10);
          } else {
            response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          }
        };
        write();
        return;
      } else if (lastUser?.content === "Fail during model") {
        const code = "return { partial: true }";
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-browser", type: "function", function: { name: "page_run", arguments: JSON.stringify({ code }) } }] } }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ error: { message: "intentional model failure" } })}\n\n`);
        return;
      } else if (messages.at(-1)?.role === "tool") {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done from browser" } }] })}\n\n`);
      } else {
        const code = lastUser?.content === "Cancel this run"
          ? "await new Promise((resolve) => setTimeout(resolve, 5000)); return \"late\""
          : "return { title: document.title, answer: 40 + 2 }";
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-browser", type: "function", function: { name: "page_run", arguments: JSON.stringify({ code }) } }] } }] })}\n\n`);
        response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      }
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }

    try {
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = normalize(join(root, relative));
      if (!file.startsWith(`${root}/`)) throw new Error("outside root");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, requests: () => requests };
}

function waitForOutput(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 60_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited before DevTools started (${code}).`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    const onExit = () => {
      child.off("exit", onExit);
      resolve();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

class CdpPage {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(`[console.error] ${message.params.args?.map((argument) => argument.description ?? argument.value ?? "").join(" ") ?? "console.error"}`);
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.consoleErrors.push(`[uncaught] ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "Uncaught browser exception"}`);
      }
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
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    return result.result?.value;
  }

  close() { this.socket.close(); }
}

async function waitFor(page, expression, timeoutMs = 10_000) {
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

const { server, port, requests } = await startServer();
const profile = await mkdtemp(join(tmpdir(), "static-web-agent-browser-"));
const child = spawn(browser, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
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
  const targets = await (await fetch(`http://${devtools.host}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  if (target === undefined) throw new Error("Chromium did not expose a page target.");
  page = new CdpPage(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await waitFor(page, "document.querySelector('.app-shell') !== null");

  const initial = await page.evaluate(`({
    connectionVisible: document.querySelector('#connection-card')?.hidden === false,
    sendVisible: document.querySelector('#send-button')?.hidden === false,
    sendDisabled: document.querySelector('#send-button')?.disabled === true,
    chatNotBusy: document.querySelector('#chat-log')?.getAttribute('aria-busy') === 'false',
    noAttachments: document.querySelector('#attachment-input') === null,
    noThinking: document.querySelector('#thinking-level') === null,
    noPluginUi: document.querySelector('.extension-host') === null,
    oneToolName: document.querySelector('#connection-card') !== null,
  })`);
  assert.deepEqual(initial, { connectionVisible: true, sendVisible: true, sendDisabled: true, chatNotBusy: true, noAttachments: true, noThinking: true, noPluginUi: true, oneToolName: true });
  assert.equal(await page.evaluate("document.activeElement?.id"), "model-endpoint", "the first connection field should receive initial focus");

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = 'http://127.0.0.1:${port}/v1';
    document.querySelector('#model-name').value = 'browser-test';
    document.querySelector('#model-key').value = 'local-test-key';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#message-input')?.disabled === false");
  assert.equal(await page.evaluate("localStorage.getItem('static-web-agent.connection') !== null"), true);
  assert.equal(await page.evaluate("document.querySelector('.empty-state p')?.textContent"), "Connected to Browser Test. Ask the agent to do something.");
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === false");
  assert.deepEqual(await page.evaluate(`({
    text: document.querySelector('#open-settings')?.textContent,
    label: document.querySelector('#open-settings')?.getAttribute('aria-label'),
    expanded: document.querySelector('#open-settings')?.getAttribute('aria-expanded'),
  })`), { text: "Close", label: "Close connection settings", expanded: "true" });
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = 'bad';
    document.querySelector('#model-name').value = '';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#model-endpoint')?.getAttribute('aria-invalid') === 'true' && document.querySelector('#model-name')?.getAttribute('aria-invalid') === 'true'");
  assert.equal(await page.evaluate("document.activeElement?.id"), "model-endpoint", "validation should focus the first invalid field");
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");
  assert.deepEqual(await page.evaluate(`({
    endpoint: document.querySelector('#model-endpoint')?.value,
    model: document.querySelector('#model-name')?.value,
    endpointError: document.querySelector('#endpoint-error')?.textContent,
    modelError: document.querySelector('#model-error')?.textContent,
  })`), { endpoint: `http://127.0.0.1:${port}/v1`, model: "browser-test", endpointError: "", modelError: "" });
  await page.evaluate(`(() => {
    document.querySelector('#open-settings').click();
    document.querySelector('#model-name').value = 'browser-test-switched';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");
  assert.equal(await page.evaluate("document.querySelector('.empty-state p')?.textContent"), "Connected to Browser Test Switched. Ask the agent to do something.");
  await page.evaluate(`(() => {
    document.querySelector('#open-settings').click();
    document.querySelector('#model-name').value = 'browser-test';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'line one\\nline two';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.ok(await page.evaluate("document.querySelector('#message-input').clientHeight > 44 && document.querySelector('#message-input').scrollHeight <= document.querySelector('#message-input').clientHeight"), "multi-line input must remain visible");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.deepEqual(await page.evaluate(`({ text: document.querySelector('#send-button')?.textContent, disabled: document.querySelector('#send-button')?.disabled, busy: document.querySelector('#chat-log')?.getAttribute('aria-busy') })`), { text: "Send", disabled: false, busy: "false" });
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === false");
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");

  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Use the page tool';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "[...document.querySelectorAll('.message.assistant .message-body')].at(-1)?.textContent.includes('done from browser') === true");
  const toolTrace = await page.evaluate(`(() => ({
    count: document.querySelectorAll('.tool-trace').length,
    code: document.querySelector('.trace-code')?.textContent,
    result: document.querySelectorAll('.trace-value').item(document.querySelectorAll('.trace-value').length - 1)?.textContent,
    requestCount: ${requests()},
  }))()`);
  assert.equal(toolTrace.count, 1);
  assert.match(toolTrace.code, /document\.title/);
  assert.match(toolTrace.result, /42/);
  assert.equal(toolTrace.requestCount, 2);
  assert.equal(await page.evaluate("document.querySelector('#chat-log')?.getAttribute('aria-busy')"), "false");
  assert.equal(await page.evaluate("[...document.querySelectorAll('.message.assistant')].find((node) => node.querySelector('.tool-trace') !== null && node.querySelector('.message-body') === null)?.querySelectorAll('.message-action').length"), 0, "tool-only assistant messages should not show an empty Copy action");

  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Cancel this run';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelectorAll('.tool-trace summary').item(document.querySelectorAll('.tool-trace summary').length - 1)?.textContent.includes('running') === true");
  await page.evaluate(`(() => {
    document.querySelector('#open-settings').click();
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#send-button')?.textContent === 'Send' && document.querySelector('#connection-card')?.hidden === true");
  assert.equal(await page.evaluate("document.querySelector('#run-status')?.textContent"), "Connected to Browser Test.");

  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Cancel this run';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelectorAll('.tool-trace summary').item(document.querySelectorAll('.tool-trace summary').length - 1)?.textContent.includes('running') === true");
  await page.evaluate("document.querySelector('#send-button').click()");
  await waitFor(page, "document.querySelector('.stream-status')?.textContent === 'Stopped' && document.querySelector('#send-button')?.textContent === 'Send'");
  assert.equal(await page.evaluate("document.querySelectorAll('.tool-trace').length"), 3);
  const tracesAfterStop = await page.evaluate(`(() => [...document.querySelectorAll('.tool-trace')].map((trace) => [...trace.querySelectorAll('.trace-section')].map((section) => [section.querySelector('h3')?.textContent, section.querySelector('pre')?.textContent])))()`);
  assert.match(JSON.stringify(tracesAfterStop[0]), /42/);
  assert.match(JSON.stringify(tracesAfterStop[1]), /MODEL_REPLACED/);
  assert.match(JSON.stringify(tracesAfterStop[2]), /ABORTED/);
  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Continue after stopping';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelectorAll('.message.assistant .message-body').length === 2");
  assert.equal(await page.evaluate("document.querySelector('.message.assistant:last-of-type .message-body')?.textContent"), "done from browser");

  await page.evaluate(`(() => {
    document.querySelector('[data-action="edit-message"]').click();
    const editor = document.querySelector('.message-edit textarea');
    editor.value = 'Run it again';
    document.querySelector('[data-action="save-edit"]').click();
  })()`);
  await waitFor(page, "document.querySelectorAll('.message.user').length === 1 && document.querySelectorAll('.message.assistant .message-body').length === 1");
  assert.equal(await page.evaluate("document.querySelector('.message.assistant .message-body')?.textContent"), "done from browser");

  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(page, "document.querySelector('#message-input')?.disabled === false");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await page.evaluate("document.querySelectorAll('.message').length"), 0, "conversation should not be restored");

  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Use the page tool';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "[...document.querySelectorAll('.message.assistant .message-body')].at(-1)?.textContent.includes('done from browser') === true");
  await page.evaluate("document.querySelectorAll('.tool-trace').item(document.querySelectorAll('.tool-trace').length - 1).open = true");
  assert.equal(await page.evaluate("document.querySelectorAll('.tool-trace').item(document.querySelectorAll('.tool-trace').length - 1)?.open"), true);
  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Keep my place';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.streaming-run .message-body')?.textContent.length > 1000");
  const scrollBefore = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    chat.scrollTop = 0;
    chat.dispatchEvent(new Event('scroll'));
    return { top: chat.scrollTop, overflow: chat.scrollHeight - chat.clientHeight };
  })()`);
  assert.equal(scrollBefore.top, 0);
  assert.ok(scrollBefore.overflow > 80);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await page.evaluate("document.querySelector('#chat-log')?.scrollTop"), 0, "streaming must respect a manual scroll-up");
  assert.equal(await page.evaluate("document.querySelectorAll('.tool-trace').item(document.querySelectorAll('.tool-trace').length - 1)?.open"), true, "expanded tool details must survive later streaming");
  await waitFor(page, "document.querySelector('#send-button')?.textContent === 'Send'");
  const scrollBeforeSettings = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    chat.scrollTop = chat.scrollHeight;
    chat.dispatchEvent(new Event('scroll'));
    return chat.scrollTop;
  })()`);
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === false");
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");
  assert.ok(Math.abs(await page.evaluate("document.querySelector('#chat-log')?.scrollTop") - scrollBeforeSettings) < 2, "closing settings must restore the conversation position");
  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Fail during model';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.stream-error') !== null");
  assert.equal(await page.evaluate("document.querySelector('#run-status')?.textContent"), "Run failed. See the error above.");
  const tracesAfterModelFailure = await page.evaluate(`(() => [...document.querySelectorAll('.tool-trace')].map((trace) => ({
    summary: trace.querySelector('summary')?.textContent,
    code: trace.querySelector('.trace-code')?.textContent,
  })) )()`);
  assert.equal(tracesAfterModelFailure.length, 2);
  assert.match(tracesAfterModelFailure.at(-1).summary, /preparing|running/);
  assert.match(tracesAfterModelFailure.at(-1).code, /partial/);

  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Fail after tool';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.stream-error') !== null");
  assert.equal(await page.evaluate("document.querySelectorAll('.tool-trace').length"), 2, "failed runs should not duplicate committed tool traces");

  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Use the page tool';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "[...document.querySelectorAll('.message.assistant .message-body')].at(-1)?.textContent.includes('done from browser') === true");
  const reusedToolCall = await page.evaluate(`(() => {
    const traces = [...document.querySelectorAll('.tool-trace')];
    return { firstOpen: traces[0]?.open, lastOpen: traces.at(-1)?.open };
  })()`);
  assert.equal(reusedToolCall.firstOpen, true, "the original expanded tool must stay open");
  assert.equal(reusedToolCall.lastOpen, false, "a reused call ID must not expand the new tool card");

  await page.evaluate(`document.querySelector('#open-settings').click()`);
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === false");
  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = 'http://127.0.0.1:${port}/missing';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#message-input')?.disabled === false");
  await page.evaluate(`(() => {
    document.querySelector('#message-input').value = 'Show the provider error';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.stream-error') !== null");
  assert.match(await page.evaluate("document.querySelector('.stream-error')?.textContent"), /Not Found|failed|error/i);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 280, height: 300, deviceScaleFactor: 1, mobile: false });
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === false");
  const compactSettings = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    const card = document.querySelector('#connection-card');
    const endpoint = document.querySelector('#model-endpoint');
    return {
      pageWidth: document.documentElement.scrollWidth,
      card: card?.getBoundingClientRect().toJSON(),
      endpoint: endpoint?.getBoundingClientRect().toJSON(),
      chat: chat?.getBoundingClientRect().toJSON(),
      focused: document.activeElement?.id,
    };
  })()`);
  assert.equal(compactSettings.pageWidth, 280);
  assert.ok(compactSettings.endpoint.top >= compactSettings.card.top && compactSettings.endpoint.bottom <= compactSettings.chat.bottom, "the required endpoint stays visible in a short settings card");
  assert.equal(compactSettings.focused, "model-endpoint");
  await page.evaluate("document.querySelector('#open-settings').click()");
  await waitFor(page, "document.querySelector('#connection-card')?.hidden === true");
  await page.evaluate(`(() => {
    const edits = [...document.querySelectorAll('[data-action="edit-message"]')];
    edits.at(-1)?.click();
  })()`);
  await waitFor(page, "document.querySelector('.message-edit') !== null");
  const compactEditor = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    const edit = document.querySelector('.message-edit');
    return {
      chat: chat?.getBoundingClientRect().toJSON(),
      edit: edit?.getBoundingClientRect().toJSON(),
      buttons: [...(edit?.querySelectorAll('button') ?? [])].map((node) => node.getBoundingClientRect().toJSON()),
    };
  })()`);
  assert.ok(compactEditor.edit.top >= compactEditor.chat.top && compactEditor.edit.bottom <= compactEditor.chat.bottom, `the compact editor stays inside the short chat viewport: ${JSON.stringify(compactEditor)}`);
  assert.ok(compactEditor.buttons.every((button) => button.top >= compactEditor.chat.top && button.bottom <= compactEditor.chat.bottom), `compact edit actions stay reachable: ${JSON.stringify(compactEditor)}`);
  await page.evaluate("document.querySelector('[data-action=\"cancel-edit\"]')?.click()");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = Array.from({ length: 20 }, (_, index) => 'line ' + (index + 1)).join('\\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const compactComposer = await page.evaluate(`(() => ({
    chat: document.querySelector('#chat-log')?.getBoundingClientRect().toJSON(),
    composer: document.querySelector('.composer-wrap')?.getBoundingClientRect().toJSON(),
    input: document.querySelector('#message-input')?.getBoundingClientRect().toJSON(),
    send: document.querySelector('#send-button')?.getBoundingClientRect().toJSON(),
    status: document.querySelector('#run-status')?.getBoundingClientRect().toJSON(),
    pageHeight: document.documentElement.scrollHeight,
  }))()`);
  assert.ok(compactComposer.composer.top >= compactComposer.chat.bottom - 1, "a long short-screen composer must not overlap the chat");
  assert.ok(compactComposer.composer.bottom <= 300 && compactComposer.send.bottom <= 300 && compactComposer.status.bottom <= 300, "short-screen composer controls stay inside the viewport");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.send("Emulation.clearDeviceMetricsOverride");
  assert.deepEqual(page.consoleErrors, [], `browser console errors: ${page.consoleErrors.join(" | ")}`);
  console.log("Browser smoke passed.");
} finally {
  page?.close();
  child.kill();
  await waitForExit(child);
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
