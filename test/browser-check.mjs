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
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (messages.at(-1)?.role === "tool") {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done from browser" } }] })}\n\n`);
      } else {
        const code = lastUser?.content === "Cancel this run"
          ? "await new Promise((resolve) => setTimeout(resolve, 5000)); return \"late\""
          : "return { title: document.title, answer: 40 + 2 }";
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-browser-" + requests, type: "function", function: { name: "page_run", arguments: JSON.stringify({ code }) } }] } }] })}\n\n`);
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
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 30_000);
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

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = 'http://127.0.0.1:${port}/v1';
    document.querySelector('#model-name').value = 'browser-test';
    document.querySelector('#model-key').value = 'local-test-key';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#message-input')?.disabled === false");
  assert.equal(await page.evaluate("localStorage.getItem('static-web-agent.connection') !== null"), true);
  assert.deepEqual(await page.evaluate(`({ text: document.querySelector('#send-button')?.textContent, disabled: document.querySelector('#send-button')?.disabled, busy: document.querySelector('#chat-log')?.getAttribute('aria-busy') })`), { text: "Send", disabled: false, busy: "false" });

  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Use the page tool';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('.message.assistant .message-body')?.textContent.includes('done from browser') === true");
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

  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'Cancel this run';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelectorAll('.tool-trace summary').item(document.querySelectorAll('.tool-trace summary').length - 1)?.textContent.includes('running') === true");
  await page.evaluate("document.querySelector('#send-button').click()");
  await waitFor(page, "document.querySelector('.stream-status')?.textContent === 'Stopped' && document.querySelector('#send-button')?.textContent === 'Send'");
  assert.equal(await page.evaluate("document.querySelectorAll('.tool-trace').length"), 2);
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
  console.log("Browser smoke passed.");
} finally {
  page?.close();
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
