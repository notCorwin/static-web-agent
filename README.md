# Browser Agent Harness

Browser Agent Harness is a browser-native, extensible runtime for building agents that can call tools, use explicit capabilities, load trusted plugins, and connect to any provider through a small model-adapter boundary. The runtime, state, orchestration, and tool execution stay in the page. There is no backend, localhost service, browser extension, native helper, remote plugin loader, or npm publishing workflow.

This repository is designed to be forked. The small Harness API is the recommended host integration; the complete chat workspace is a reference application that can be replaced without changing the kernel.

## Fork and run

```sh
npm install
npm run build
```

Serve `dist/` from a static HTTP server and open `dist/index.html`. A server is needed for browser modules; it is only a static-file server, not an application backend.

```sh
npm run check     # strict TypeScript check
npm test          # build, Node boundary tests, and Chromium checks when available
npm run test:browser
```

The build writes `dist/version.json`, versions browser module and stylesheet requests, removes stale output, and copies the reference application's local assets. Browser checks use `BROWSER_PATH` or a detected Chromium/Chrome binary. Set `REQUIRE_BROWSER=1` when browser coverage must not be skipped.

## Smallest useful Harness

The following is a complete provider-free tool loop. It can be saved as a browser module in a fork after `npm run build` and uses only the light entry point.

```js
import {
  MemoryStateStore,
  createBrowserAgentHarness,
} from "./dist/index.js";

const demo = {
  manifest: {
    apiVersion: "1",
    id: "demo-plugin",
    name: "Demo",
    version: "1.0.0",
    permissions: [],
  },
  setup(context) {
    context.registerTool({
      name: "demo.echo",
      description: "Return the supplied value.",
      inputSchema: {
        type: "object",
        properties: { value: {} },
        required: ["value"],
        additionalProperties: false,
      },
      execute: (input) => input,
    });
    context.registerModelAdapter({
      id: "demo-model",
      async *stream({ messages }) {
        if (messages.some((message) => message.role === "tool")) {
          yield { type: "completed", message: { role: "assistant", content: "tool completed" } };
          return;
        }
        yield {
          type: "completed",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "demo.echo", arguments: { value: "hello" } }],
          },
        };
      },
    });
  },
};

const harness = await createBrowserAgentHarness({
  defaultPlugins: false,
  plugins: [demo],
  stateStore: new MemoryStateStore(),
  initialModelId: "demo-model",
});
const result = await harness.run({ messages: [{ role: "user", content: "run the demo" }] });
console.log(result.response?.content); // tool completed
await harness.dispose();
```

`createBrowserAgentHarness(options?)` installs the standard browser capabilities and, by default, the `javascript-runtime`, `local-storage`, and `browser-api` plugins. It intentionally installs no model. Set `defaultPlugins: false` when a host wants a completely empty registry.

## Harness surface

The facade owns lifecycle and is the recommended composition boundary:

- `install(plugin)` and `uninstall(pluginId)` register trusted ESM plugins. The returned handle delegates its uninstall through the Harness so model selection and snapshots stay consistent.
- `selectModel(id)` and `clearModel()` control the selected provider-neutral adapter. Unknown IDs raise `KernelError` with `MODEL_NOT_FOUND`.
- `run(request)` fixes the selected adapter for that run, while the live tool registry remains available to each turn. Runs can execute in parallel and accept the existing cancellation, timeout, limits, attachment side-channel, and event options.
- `process(value, signal)` runs registered data processors; `mountUi(container)` mounts registered UI contributions and returns their cleanup function.
- `snapshot()` returns lifecycle status, selected model, sorted plugin manifests, model descriptors, and tool descriptors. `subscribe(listener)` immediately sends the current snapshot and sends later plugin, model, tool, and disposal changes.
- `dispose()` is idempotent, aborts active runs, and unloads plugins in reverse installation order. Same-realm JavaScript that ignores `AbortSignal` cannot be forcibly terminated by a browser page.

After disposal, operations fail with a structured `KernelError` using `HARNESS_DISPOSED`. Starting a run without a selected model uses `MODEL_NOT_SELECTED`. These errors are part of the facade boundary; lower-level registries remain public for advanced hosts that need direct composition.

## Plugins and capabilities

Plugins are host-imported, trusted same-realm modules. Their API is versioned with `manifest.apiVersion: "1"` and can contribute tools, capabilities, model adapters, processors, and UI:

```ts
const plugin: Plugin = {
  manifest: {
    apiVersion: "1",
    id: "clock",
    name: "Clock",
    version: "1.0.0",
    permissions: [{ name: "page", reason: "Read the current page clock." }],
  },
  setup(context) {
    context.registerTool({
      name: "clock.now",
      description: "Read the current time.",
      inputSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: ["page"],
      execute: async (_, tool) => {
        const page = await tool.getCapability<PageRuntime>("page");
        return (await page.execute("return new Date().toISOString()", null, { signal: tool.signal })).value;
      },
    });
  },
};
```

A capability is a named, injected boundary such as `network`, `storage`, `runtime`, or `page`. A plugin declares the permissions it needs; the Capability Manager authorizes those requests and supplies the provider. The default Harness policy automatically approves plugins the host explicitly imports. Hosts that need review or denial can inject `permissionPolicy`:

```ts
const harness = await createBrowserAgentHarness({
  permissionPolicy: { decide: ({ pluginId, name, reason }) => askUser(pluginId, name, reason) },
});
```

Capability authorization is policy, not a sandbox for plugin source. Do not install untrusted ESM. Worker JavaScript receives no application capability objects, but it is still a resource/lifecycle boundary rather than hostile-code isolation.

## Models and entry points

Model adapters implement the provider-neutral `ModelAdapter` interface: an ID, optional `supportsVision` flag, and an async stream of normalized text, reasoning, tool-call, usage, and completion events. The Agent loop does not know which provider is behind the adapter.

The module graph is intentionally split:

| Entry point | Use | Loads |
| --- | --- | --- |
| `src/index.ts` / `dist/index.js` | Harness and kernel consumers | Core, Harness, and light browser plugins only |
| `src/remote.ts` / `dist/remote.js` | Optional OpenAI-compatible model adapter | AI SDK and remote-model plugin |
| `src/app-entry.ts` / `dist/app-entry.js` | Complete reference workspace | Chat UI, attachments, Markdown/PDF/OCR/rendering, and app orchestration |

For a remote model, import it explicitly and install it like any other plugin:

```ts
import { createRemoteModelPlugin } from "./dist/remote.js";

const handle = await harness.install(createRemoteModelPlugin({
  endpoint: "https://example.com/v1",
  model: "example-model",
  apiKey: "provided-by-the-host",
}));
harness.selectModel("remote-model");
// await handle.uninstall();
```

The remote adapter uses ordinary browser `fetch` and therefore remains subject to CORS, provider authentication, context limits, and network availability. A host can supply its own adapter without importing the AI SDK.

## Replacing the reference UI

`src/app-entry.ts` is deliberately explicit. It exports `AgentApp` and `startApp` plus the reference chat/attachment/settings helpers; it is not re-exported by the light entry point. The reference workspace keeps the existing in-memory chat behavior, current-tab attachment processing, Markdown/KaTeX/Mermaid rendering, IndexedDB connection settings, dynamic extension UI, cancellation, and remote SSE flow. Forks can keep that UI, replace it, or call the Harness from a different view.

The reference app stores connection settings in its existing browser-local IndexedDB database (`static-web-agent`, `workspace` object store) and keeps chat messages and attachment bytes in memory. The `local-storage` plugin uses its own `plugin:<plugin-id>` namespace; it does not share or rewrite the app's connection-settings record.

PDF attachments are processed page by page with PDF.js: pages with a non-empty text layer become ordered text blocks, while image-only pages are rendered for vision or local PaddleOCR. The public attachment operation is now options-based:

```ts
const prepared = await processAttachmentFiles(files, {
  supportsVision: true,
  signal: controller.signal,
  onProgress: (progress) => console.log(progress.phase, progress.attachment.name),
});
```

`app-entry` keeps `processAttachmentFiles`, `PreparedAttachments`, `AttachmentProgress`, and the existing error codes. Engine adapters are internal to the intake module; the old aggregate dependency fields and legacy positional arguments are not part of the app contract. Local OCR selects WebGPU automatically and falls back to the bundled WASM runtime.

## Browser security boundaries

The browser sandbox is intentional. The Harness does not emulate shell commands, arbitrary host filesystem paths, native processes, unrestricted cross-origin requests, other tabs, or unavailable browser APIs. `browser.evaluate` uses the current page realm and can only call the APIs that page actually has. Providers, CORS, same-origin policy, permissions, memory/CPU, and context windows remain external limits.

No remote persistence, plugin marketplace, background daemon, extension, Builder DSL, audio/video parts, arbitrary-file content parts, or npm release process is required by this project.

## Migration from the old aggregate entry

Consumers that previously imported everything from `src/index.ts` should choose an explicit boundary:

```ts
import { createBrowserAgentHarness } from "./dist/index.js";
import { createRemoteModelPlugin } from "./dist/remote.js";
import { AgentApp, startApp } from "./dist/app-entry.js";
```

The kernel, Agent loop, Plugin API v1, JSON tool contracts, and string-message plus image-attachment side channel remain compatible. The split only prevents lightweight Harness consumers from loading the reference application's heavy modules.

## License

MIT. See [`LICENSE`](./LICENSE), Copyright (c) 2026 notCorwin.
