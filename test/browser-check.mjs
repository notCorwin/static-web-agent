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
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (pathname === "/test-sse" || pathname === "/test-hang") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write('data: {"choices":[{"delta":{"content":"sse"}}]}\n\n');
        if (pathname === "/test-sse") {
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
  return { server, port: server.address().port };
}

function waitForOutput(child, timeoutMs = 10_000) {
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
      }, 3_000);
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

const { server, port } = await startStaticServer();
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
  `http://127.0.0.1:${port}/index.html`,
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
  await waitFor(page, "document.querySelector('.app-shell') !== null && document.querySelector('#message-input')?.disabled === false && !document.querySelector('.loading-state')");

  await page.evaluate("window.confirm = () => true");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '/calc 2 * (3 + 4)';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  try {
    await waitFor(page, "document.querySelector('.message.assistant .message-body')?.textContent === 'Result: 14'");
  } catch (error) {
    console.log("Browser UI state:", await page.evaluate("({ chat: document.querySelector('#chat-log')?.textContent, status: document.querySelector('#run-status')?.textContent, busy: document.querySelector('#send-button')?.disabled })"));
    throw error;
  }

  const persisted = await page.evaluate("document.querySelector('.message.user .message-body')?.textContent === '/calc 2 * (3 + 4)'");
  assert.equal(persisted, true, "the browser UI should render the sent message before reload");
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(page, "document.querySelector('#runtime-action') !== null && document.querySelector('#runtime-action')?.disabled === false && document.querySelector('.empty-state') !== null && document.querySelectorAll('.message').length === 0 && !document.querySelector('.loading-state')");
  const resetState = await page.evaluate(`({
    noSessionControls: document.querySelector('#new-session') === null && document.querySelector('#session-list') === null && document.querySelector('#session-count') === null,
    noSessionUrl: !new URL(location.href).searchParams.has('session'),
    lightTheme: getComputedStyle(document.documentElement).colorScheme === 'light',
    emptyChat: document.querySelector('.empty-state') !== null,
  })`);
  assert.deepEqual(resetState, { noSessionControls: true, noSessionUrl: true, lightTheme: true, emptyChat: true });
  await page.evaluate("window.confirm = () => true");

  await page.evaluate("document.querySelector('#runtime-action').click()");
  try {
    await waitFor(page, "document.querySelector('#tool-list')?.textContent.includes('runtime.javascript')");
  } catch (error) {
    console.log("Plugin UI state:", await page.evaluate("({ action: document.querySelector('#runtime-action')?.textContent, tools: document.querySelector('#tool-list')?.textContent, status: document.querySelector('#run-status')?.textContent })"));
    throw error;
  }
  await page.evaluate("document.querySelector('#runtime-action').click()");
  await waitFor(page, "!document.querySelector('#tool-list')?.textContent.includes('runtime.javascript')");
  await page.evaluate("document.querySelector('#storage-action').click()");
  await waitFor(page, "document.querySelector('#tool-list')?.textContent.includes('storage.local')");
  await page.evaluate("document.querySelector('#storage-action').click()");
  await waitFor(page, "!document.querySelector('#tool-list')?.textContent.includes('storage.local')");

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-sse';
    document.querySelector('#model-name').value = 'browser-test';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = 'remote request';
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent === 'sse'");
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
  await waitFor(page, "document.querySelector('#cancel-button')?.hidden === false");
  await page.evaluate("document.querySelector('#cancel-button').click()");
  await waitFor(page, "document.querySelector('#run-status')?.textContent.includes('cancelled')");

  const browserBoundaries = await page.evaluate(`(async () => {
    const { Agent, AgentApp, BrowserWorkerRuntime, CapabilityManager, IndexedDbStateStore, OpenAICompatibleAdapter, PluginManager, ToolRegistry } = await import('/dist/index.js');
    const runtime = new BrowserWorkerRuntime();
    const value = await runtime.execute('return input.value + 1', { value: 2 });
    let timedOut = false;
    try { await runtime.execute('await new Promise(() => {})', null, { timeoutMs: 10 }); } catch (error) { timedOut = error.code === 'RUNTIME_TIMEOUT'; }

    const databaseName = 'browser-test-' + crypto.randomUUID();
    const state = new IndexedDbStateStore({ databaseName, objectStoreName: 'state' });
    await state.apply([{ type: 'set', key: 'item', value: { ok: true } }]);
    const stored = await state.get('item');
    await state.clear();

    const adapter = new OpenAICompatibleAdapter({
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
    const appPlugin = {
      manifest: { apiVersion: '1', id: 'app-browser-plugin', name: 'App browser plugin', version: '1', permissions: [] },
      setup(context) { context.registerUi({ id: 'app.browser.ui', mount: (container) => { container.textContent = 'app extension'; } }); },
    };
    const app = new AgentApp(appRoot, { plugins: [appPlugin] });
    await app.start();
    const appExtension = appRoot.textContent.includes('app extension');
    await app.stop();
    appRoot.remove();

    return {
      worker: value.value === 3,
      workerTimeout: timedOut,
      indexedDb: stored?.ok === true,
      sse: events.at(-1)?.type === 'completed' && events.at(-1)?.message.content === 'sse',
      cancelled: cancellation.status === 'cancelled' && cancelled,
      pluginUi: mounted && processed === 'ok!' && removedOnUninstall && pluginTools.get('browser.tool') === undefined && extensionRoot.textContent === '' && appExtension,
    };
  })()`);
  assert.deepEqual(browserBoundaries, { worker: true, workerTimeout: true, indexedDb: true, sse: true, cancelled: true, pluginUi: true });
  console.log("Browser checks passed: UI, in-memory reset, plugin toggle, Worker, IndexedDB, SSE, and cancellation.");
} finally {
  await page?.close();
  child.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
