# Static Web Agent

Static Web Agent is a browser-native agent workspace. Conversation state, orchestration, tools, plugins, and workers run in the page. Chat history is held in memory and clears when the page is refreshed. A remote model is connected directly from the browser; there is no application backend, localhost service, extension, or native helper.

## Run

```sh
npm install
npm run build
```

Serve `dist/` from a static HTTP server and open `index.html` after building. The repository root also works for development, but it does not contain the generated release manifest. A server is needed because browser module imports are restricted on `file://`; it is not an application backend.

```sh
npm test          # typecheck, Node boundary tests, and browser checks when Chromium is available
npm run check     # strict TypeScript check
npm run test:browser
```

Each production build writes a release version to `dist/version.json`, adds that version to every browser module and stylesheet request, and removes stale files from `dist`. The app checks the release manifest on startup with a cache-busting request and reloads itself when a newer deployment is available. The deployment workflow also verifies that the published Pages response exposes the commit that triggered the deployment.

The browser checks use `BROWSER_PATH` or a detected Chromium/Chrome binary. If no browser is installed they print an explicit skip message; set `BROWSER_PATH` in CI when browser coverage is required (and `REQUIRE_BROWSER=1` to turn absence into a failure).

## Connect a model

The workspace requires an OpenAI-compatible remote model for chat. Enter the endpoint, model, API key, and Thinking level in the welcome area; the connection form is shown until a model is selected, then the connected welcome message replaces it. The Thinking level is saved in local browser state and defaults to the provider's setting. Requests are sent directly from the browser.

## Remote models

The connection form installs a model plugin for the current tab. It accepts an OpenAI-compatible API base such as `https://openrouter.ai/api/v1` or a full `/chat/completions` endpoint, sends requests directly from the browser, and requires normal browser CORS permissions. Versioned API bases automatically receive the `/chat/completions` suffix. The first message verifies the endpoint; selecting the model itself does not make a network request. After a successful selection, the endpoint, model, and API key are saved in this browser's local IndexedDB. When the Credential Management API and a browser password manager are available, the model name is stored as the password credential's username, while the endpoint remains automatically saved in IndexedDB; the saved values are silently merged on the next visit. Older credentials that used the endpoint as the username remain readable. The key is not sent anywhere except the configured endpoint; treat it as sensitive data because same-origin page code can read browser storage.

Provider failures, HTTP errors, empty responses, malformed tool arguments, malformed SSE, incomplete SSE streams, and cancellation are returned as structured model errors. Reasoning/Thinking deltas are streamed through the provider-neutral model boundary and displayed live; completed Thinking blocks are collapsed by default and can be expanded manually. The selected Thinking level is passed through AI SDK Core's portable `reasoning` option when the provider supports it. The browser adapter removes AI SDK's diagnostic `User-Agent` request header because Safari rejects that forbidden header during cross-origin CORS requests. The application does not add a default model deadline; the provider, browser, or an explicit caller cancellation can still end a request.

## Attachments

Use the `＋` control beside the composer to attach images, PDFs, office documents, CSV, or text files. Files are retained only in the current page memory and are discarded on refresh; the Agent has no file tool or filesystem capability and cannot reopen an attachment on its own. Attachment processing is lazy, cancellable, and runs with same-origin static assets:

- Images and scanned PDF pages are sent as image parts only when `Model supports image input` is explicitly enabled. The model capability is never inferred from its name.
- With vision disabled, images and scanned PDF pages are recognized locally by PaddleOCR.js in a Worker using the smaller non-JSEP same-origin ONNX Runtime WASM runtime and model assets. Multiple images/pages are sent through batched detection/recognition calls. OCR text is sent to the configured model instead of the original image.
- Text-bearing PDFs and ordinary DOCX, PPTX, XLSX, CSV, and text files are converted to Markdown by anydoc in the browser. PDFs that produce no meaningful text fall back to PDF.js page rendering and then use the vision/OCR route above, preserving page order.
- Original bytes are not written to chat state or browser persistence. Only a vision-enabled model request can contain original image bytes. A failed vision request is not retried automatically; the composer offers an explicit local-OCR retry.

The build packages anydoc WASM, PDF.js, PaddleOCR.js, ONNX Runtime WASM, and the two PP-OCRv5 mobile model archives into `dist/`. The PaddleOCR runtime is loaded only when a non-vision image or scanned page actually needs OCR, so vision-enabled image uploads avoid OCR initialization.

## Message rendering

User and assistant messages render locally with GitHub-flavored Markdown, fenced code blocks, KaTeX math (`$...$`, `\(...\)`, `$$...$$`, and `\[...\]`), and Mermaid fenced flowcharts. Markdown is sanitized before it reaches the DOM, Mermaid runs with strict security settings, and an invalid diagram falls back to its source text. Code blocks provide one-click copy and a language-aware copy-without-comments action; whole user and assistant messages can also be copied. User messages expose edit-and-resend on hover. Consecutive tool calls are grouped under one collapsed parent and expand together on click; streamed tool-call fragments appear in that group as they arrive. The composer is one line by default and grows automatically for multiline input up to a capped height. Press Enter to send; press Cmd/Ctrl+Enter to insert a newline. The idle send control is hidden; while a run is producing output, a circular stop control with a square icon appears. The conversation follows the bottom unless you scroll upward manually; the centered arrow button returns to and follows the latest output. The interface follows the operating system's light/dark appearance.

## Runtime architecture

```text
UI
↓
AgentApp → in-memory chat state
↓
Agent
├─ Model adapter registry
├─ Tool registry
├─ Capability manager
├─ Plugin manager
├─ Browser worker runtime
├─ Browser page runtime
└─ State store (IndexedDB → memory fallback)
```

Important modules:

- `src/core/agent.ts` — cancellable model/tool loop. By default it continues until the model completes or the caller aborts; optional caller-supplied turn, size, and deadline controls remain available for applications that want them. Ordinary same-realm plugin code must cooperate with an abort signal because JavaScript cannot forcibly kill an arbitrary Promise.
- `src/core/plugin-manager.ts` — lifecycle-scoped registration for tools, capabilities, model adapters, processors, and UI contributions.
- `src/core/state.ts` — atomic state batches and a resilient IndexedDB store that switches to an in-memory shadow on failure.
- `src/app/chat.ts` — in-memory chat state without an application-defined history or message-size ceiling.
- `src/app/view.ts` — shell and message rendering kept separate from application orchestration.
- `src/adapters/ai-sdk.ts` — the sole remote model adapter, backed by Vercel AI SDK Core and its OpenAI-compatible provider.
- `src/core/page-runtime.ts` and `src/plugins/browser-api.ts` — main-realm Web API execution and the `browser.inspect` / `browser.evaluate` tools.

Plugins are code-loaded modules, not discovered or downloaded by the application. Consumers can provide trusted plugins through `startApp(root, { plugins, initialModelId })`. A plugin can register a model adapter, processor, or UI contribution; the application uses the adapter registry, runs processors on outgoing user-message envelopes, and mounts UI contributions in the extension host. Plugin setup registers contributions; capability access is available after installation (tools normally request it during execution). Uninstalling a plugin removes all of its contributions and closes its registration context.

The built-in JavaScript worker, local storage, and Browser API plugins are enabled by default. `browser.inspect` reports the current page environment, while `browser.evaluate` is the general Web API escape hatch: the Agent can execute asynchronous JavaScript in the page realm and use the actual DOM, fetch, storage, crypto, WebSocket, timers, workers, and other APIs exposed by that browser tab. The application no longer imposes fixed message, request, tool-call, tool-output, code, response, processor, or runtime-duration ceilings. Manifest-declared plugin capabilities are granted automatically in this workspace; plugins are still trusted same-realm modules. Chat history is never written to the browser state store; the local storage plugin keeps its own namespaced values independently.

## Security boundaries

Plugins execute as trusted same-realm JavaScript. Their `PluginContext` is narrow, but a normal page cannot prevent plugin module code from using ambient browser APIs; capability permissions are therefore contribution/operation policy, not a sandbox for hostile plugin source. Do not install untrusted plugin modules.

Worker JavaScript receives no application capability objects, but the application no longer masks ambient Web APIs or imposes a default code/output/deadline ceiling. It is a resource and lifecycle boundary, not a security sandbox. Do not treat the JavaScript runtime or any plugin as hostile-code isolation.

The Browser API plugin runs in the current page's main realm, so it cannot grant powers the browser does not expose. The runtime does not emulate shell commands, arbitrary host filesystem access, unrestricted cross-origin access, other browser tabs, or unavailable browser APIs. Page code is not forcibly killable when it blocks the main thread; cancellation remains cooperative through `signal`. Provider context windows, browser memory/CPU, same-origin policy, CORS, and operating-system permissions remain platform boundaries rather than application-defined ceilings.
