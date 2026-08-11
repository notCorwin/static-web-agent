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
  let toolRequests = 0;
  let streamedToolRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (pathname === "/test-sse" || pathname === "/test-rich" || pathname === "/test-tool" || pathname === "/test-tool-stream" || pathname === "/test-scroll" || pathname === "/test-hang") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (pathname === "/test-scroll") {
          const chunks = [
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
              setTimeout(sendChunk, 35);
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
          : pathname === "/test-tool" || pathname === "/test-tool-stream"
            ? "tool complete"
            : "sse";
        if (pathname === "/test-tool-stream" && streamedToolRequests++ === 0) {
          const chunks = [
            { index: 0, id: "browser-streamed-tool-call", function: { name: "runtime_" } },
            { index: 0, function: { name: "javascript", arguments: '{"code":"' } },
            { index: 0, function: { arguments: "return " } },
            { index: 0, function: { arguments: "42\"}" } },
            { index: 1, id: "browser-streamed-tool-call-2", function: { name: "runtime_" } },
            { index: 1, function: { name: "javascript", arguments: '{"code":"' } },
            { index: 1, function: { arguments: "return " } },
            { index: 1, function: { arguments: "42\"}" } },
          ];
          let index = 0;
          const sendToolChunk = () => {
            if (response.destroyed) return;
            if (index < chunks.length) {
              response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [chunks[index]] } }] })}\n\n`);
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
        if (pathname === "/test-tool" && toolRequests++ === 0) {
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
  return { server, port: server.address().port };
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
const release = JSON.parse(await readFile(join(root, "dist/version.json"), "utf8"));
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
    sendButtonLabel: document.querySelector('#send-button .button-label')?.textContent,
    compactComposer: parseFloat(getComputedStyle(document.querySelector('#message-input')).minHeight) <= 64,
  })`);
  assert.deepEqual(initialUi, { noWorkspaceNavigation: true, noRuntimeSurface: true, noOfflineControl: true, noChatHeader: true, noConnectionBar: true, connectionCardVisible: true, noComposerRows: true, noSeparateCancelButton: true, sendButtonLabel: "Send", compactComposer: true });
  assert.equal(await page.evaluate("document.querySelector('meta[name=\\\"build-version\\\"]')?.content"), release.version);
  const composerLayout = await page.evaluate(`(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
    return { bottomGap: shell.bottom - composer.bottom, composerTop: composer.top, viewportBottom: window.innerHeight };
  })()`);
  assert.ok(composerLayout.bottomGap <= 1, "the composer should stay at the bottom of the workspace");
  const connectionLayout = await page.evaluate(`(() => {
    const inputTops = ['#model-endpoint', '#model-name', '#model-key'].map((selector) => document.querySelector(selector).getBoundingClientRect().top);
    const buttonTop = document.querySelector('#connection-form > .primary-button').getBoundingClientRect().top;
    return {
      inputTops,
      buttonTop,
      composerHeight: document.querySelector('#message-input').getBoundingClientRect().height,
      modelAutocomplete: document.querySelector('#model-name').autocomplete,
      keyAutocomplete: document.querySelector('#model-key').autocomplete,
      modelLabel: document.querySelector('label[for="model-name"]').textContent,
      endpointLabel: document.querySelector('label[for="model-endpoint"]').textContent,
    };
  })()`);
  assert.ok(Math.abs(connectionLayout.inputTops[1] - connectionLayout.inputTops[2]) <= 1, "model and API key inputs should share a top alignment");
  assert.ok(Math.abs(connectionLayout.buttonTop - connectionLayout.inputTops[1]) <= 2, "connection button should align with the model fields");
  assert.equal(connectionLayout.modelAutocomplete, "username");
  assert.equal(connectionLayout.keyAutocomplete, "current-password");
  assert.ok(connectionLayout.modelLabel.includes("password-manager username"), "the model name should be presented as the password-manager username");
  assert.ok(connectionLayout.endpointLabel.includes("saved locally"), "the endpoint should be presented as browser-local state");
  assert.ok(connectionLayout.composerHeight <= 66, "the message composer should stay compact");
  const composerFocus = await page.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.focus();
    const inputStyle = getComputedStyle(input);
    const composerStyle = getComputedStyle(document.querySelector('.composer'));
    return { outlineWidth: inputStyle.outlineWidth, composerShadow: composerStyle.boxShadow };
  })()`);
  assert.deepEqual(composerFocus, { outlineWidth: "0px", composerShadow: "none" });

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
    noDisconnectedWelcome: document.querySelector('.empty-state') === null,
    connectionCardVisible: document.querySelector('#connection-card')?.hidden === false,
  })`);
  assert.deepEqual(resetState, { noSessionControls: true, noSessionUrl: true, lightTheme: true, noDisconnectedWelcome: true, connectionCardVisible: true });
  await page.evaluate(`(() => {
    window.__permissionPrompted = false;
    window.confirm = () => {
      window.__permissionPrompted = true;
      return true;
    };
  })()`);

  await page.evaluate(`(() => {
    document.querySelector('#model-endpoint').value = location.origin + '/test-sse';
    document.querySelector('#model-name').value = 'browser-test';
    document.querySelector('#model-key').value = 'browser-test-key';
    document.querySelector('#connection-form').requestSubmit();
  })()`);
  await waitFor(page, "document.querySelector('#connection-status')?.textContent.includes('Remote model selected')");
  assert.equal(await page.evaluate("window.__permissionPrompted === false"), true, "selecting a remote model should not show a capability confirmation");
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
  await page.evaluate(`document.querySelector('.message.user[data-message-index="2"] .copy-message-button').click()`);
  await waitFor(page, `document.querySelector('.message.user[data-message-index="2"] .copy-message-button')?.textContent === 'Copied'`);
  assert.ok((await page.evaluate("window.__copiedCode.at(-1)")) .includes('# User rich'), "the user message should have a copy action");
  await page.evaluate(`document.querySelector('.message.user[data-message-index="2"] .edit-message-button').click()`);
  await waitFor(page, "document.querySelector('.message-edit textarea') !== null");
  await page.evaluate(`(() => {
    const editor = document.querySelector('.message-edit textarea');
    editor.value = '# Edited user rich\\n\\nUser math: $b^2$';
    document.querySelector('.message-edit [data-action=save-edit]').click();
  })()`);
  await waitFor(page, "Array.from(document.querySelectorAll('.message.user .message-body')).at(-1)?.textContent.includes('Edited user rich') && document.querySelector('.message.assistant:last-of-type .message-body h1')?.textContent === 'Rich response'", 20_000);
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
  await waitFor(page, "document.querySelector('#send-button .button-label')?.textContent === 'Stop' && document.querySelector('#send-button')?.getAttribute('aria-label') === 'Stop generation'");
  await page.evaluate("document.querySelector('#send-button').click()");
  await waitFor(page, "document.querySelector('#run-status')?.textContent.includes('cancelled')");
  await waitFor(page, "document.querySelector('#send-button .button-label')?.textContent === 'Send'");

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
  const midStreamScroll = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    return { overflow: chat.scrollHeight > chat.clientHeight, distance: chat.scrollHeight - chat.scrollTop - chat.clientHeight };
  })()`);
  assert.equal(midStreamScroll.overflow, true);
  assert.ok(midStreamScroll.distance <= 2, "the conversation should follow the bottom while the model streams");
  await waitFor(page, "Array.from(document.querySelectorAll('.message.assistant .message-body')).at(-1)?.textContent.includes('The stream finished') && document.querySelector('#send-button .button-label')?.textContent === 'Send'", 20_000);
  await waitFor(page, "(() => { const chat = document.querySelector('#chat-log'); return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 2; })()", 5_000);
  const finishedStreamScroll = await page.evaluate(`(() => {
    const chat = document.querySelector('#chat-log');
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  })()`);
  assert.ok(finishedStreamScroll <= 2, "the conversation should remain at the bottom after streaming");
  await page.evaluate("(() => { const chat = document.querySelector('#chat-log'); chat.scrollTop = 0; chat.dispatchEvent(new Event('scroll')); })()");
  await waitFor(page, "document.querySelector('#scroll-bottom-button')?.hidden === false");
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
  }))()`);
  assert.equal(streamingTool.group, "Calling 1 tool…");
  assert.ok(streamingTool.preparing?.includes("runtime_"));
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
  })`);
  assert.deepEqual(savedConnection, { endpoint: `http://127.0.0.1:${port}/test-tool-stream`, model: "browser-test", apiKey: "browser-test-key" });
  await page.evaluate("window.confirm = () => true");

  const browserBoundaries = await page.evaluate(`(async () => {
    const { Agent, AgentApp, BrowserPageRuntime, BrowserWorkerRuntime, CapabilityManager, IndexedDbStateStore, OpenAICompatibleAdapter, PluginManager, ToolRegistry, createBrowserApiPlugin } = await import('/dist/index.js');
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
    const defaultTools = app.tools.descriptors().map((descriptor) => descriptor.name);
    const defaultPlugins = app.runtimeHandle !== undefined && app.storageHandle !== undefined && app.browserHandle !== undefined;
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
  await new Promise((resolve) => server.close(resolve));
}
