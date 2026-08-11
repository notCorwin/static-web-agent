# Static Web Agent

Static Web Agent is a browser-native agent workspace. Conversation state, orchestration, tools, plugins, and workers run in the page. Chat history is held in memory and clears when the page is refreshed. A remote model is connected directly from the browser; there is no application backend, localhost service, extension, or native helper.

## Run

```sh
npm install
npm run build
```

Serve the repository root (or `dist/`) from a static HTTP server and open `index.html`. A server is needed because browser module imports are restricted on `file://`; it is not an application backend.

```sh
npm test          # typecheck, Node boundary tests, and browser checks when Chromium is available
npm run check     # strict TypeScript check
npm run test:browser
```

The browser checks use `BROWSER_PATH` or a detected Chromium/Chrome binary. If no browser is installed they print an explicit skip message; set `BROWSER_PATH` in CI when browser coverage is required (and `REQUIRE_BROWSER=1` to turn absence into a failure).

## Connect a model

The workspace requires an OpenAI-compatible remote model for chat. Requests are sent directly from the browser after you configure the endpoint, model, and API key.

## Remote models

The connection panel installs a model plugin for the current tab. It accepts an OpenAI-compatible chat-completions endpoint, sends requests directly from the browser, and requires normal browser CORS permissions. The first message verifies the endpoint; selecting the model itself does not make a network request. After a successful selection, the endpoint, model, and API key are saved in this browser's local IndexedDB and restored into the connection form on the next visit. The key is not sent anywhere except the configured endpoint; treat it as sensitive data because same-origin page code can read browser storage.

Provider failures, HTTP errors, empty responses, malformed tool arguments, malformed SSE, incomplete SSE streams, cancellation, and request timeouts are returned as structured model errors.

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
└─ State store (IndexedDB → memory fallback)
```

Important modules:

- `src/core/agent.ts` — bounded, cancellable model/tool loop with model and tool deadlines. A deadline aborts the adapter/tool signal and ends the run; ordinary same-realm plugin code must cooperate with that signal because JavaScript cannot forcibly kill an arbitrary Promise.
- `src/core/plugin-manager.ts` — lifecycle-scoped registration for tools, capabilities, model adapters, processors, and UI contributions.
- `src/core/state.ts` — atomic state batches and a resilient IndexedDB store that switches to an in-memory shadow on failure.
- `src/app/chat.ts` — in-memory chat state and message limits.
- `src/app/view.ts` — shell and message rendering kept separate from application orchestration.
- `src/adapters/openai-compatible.ts` — provider-boundary normalization for JSON and SSE responses.

Plugins are code-loaded modules, not discovered or downloaded by the application. Consumers can provide trusted plugins through `startApp(root, { plugins, initialModelId })`. A plugin can register a model adapter, processor, or UI contribution; the application uses the adapter registry, runs processors on outgoing user-message envelopes, and mounts UI contributions in the extension host. Plugin setup registers contributions; capability access is available after installation (tools normally request it during execution). Uninstalling a plugin removes all of its contributions and closes its registration context.

The built-in JavaScript runtime and local storage plugins are enabled by default. The permission policy automatically grants those two built-in capabilities; extensions still require an explicit browser permission prompt. The application limits work to 200 messages per chat, 20,000 characters per message, 250,000 characters per conversation/model request, 16 tool calls per turn, and 16,000-character tool output. Chat history is never written to the browser state store; the local storage plugin keeps its own namespaced values independently.

## Security boundaries

Plugins execute as trusted same-realm JavaScript. Their `PluginContext` is narrow, but a normal page cannot prevent plugin module code from using ambient browser APIs; capability permissions are therefore contribution/operation policy, not a sandbox for hostile plugin source. Do not install untrusted plugin modules.

Worker JavaScript receives no application capability objects and is terminated on cancellation or timeout. A worker is a resource and lifecycle boundary, not a security sandbox: browser ambient APIs and same-origin communication may still be available. Do not treat the JavaScript runtime as a hostile-code sandbox.

The runtime does not emulate shell commands, arbitrary host filesystem access, unrestricted cross-origin access, other-tab access, or unavailable browser APIs.
