# Static Web Agent

Static Web Agent is a browser-native, local-first agent runtime. The model may be remote, but orchestration, tool dispatch, permissions, persistence, plugins, and runtime execution stay in the page. There is no backend, localhost service, extension, or native helper.

## Run

```sh
npm install
npm run build
```

Serve the repository root (or `dist/`) from a static HTTP server and open `index.html`. A static server is only needed because browser module imports are restricted on `file://`; it is not an application backend. `npm test` runs the boundary tests after compiling the TypeScript source.

The page starts with an offline echo adapter. The **Connect a model adapter** panel accepts any OpenAI-compatible streaming endpoint. Requests are made directly from the browser and therefore require CORS support. API keys are kept in memory for the current tab and are never written to IndexedDB.

## GitHub Pages

Every push to `master` runs `.github/workflows/deploy-pages.yml`, builds `dist/`, runs the tests, and publishes the artifact with GitHub Pages. For this repository the site URL is:

<https://notcorwin.github.io/static-web-agent/>

If Pages has not been enabled yet, open **Settings → Pages** in GitHub and select **GitHub Actions** as the source once; subsequent pushes deploy automatically. The artifact uses relative asset paths, so it also works under the repository subpath.

## Architecture

The dependency direction is:

```text
UI → Agent → Kernel
             ├─ Model adapter
             ├─ Tool registry
             ├─ Capability manager
             ├─ Runtime
             ├─ State store
             └─ Plugin manager → Browser APIs
```

The kernel does not know about the example JavaScript or storage plugins. A tool is registered at runtime with a name, description, JSON Schema input/output contracts, required capabilities, and an execution handler.

### Public modules

- `src/core/types.ts` — provider-independent contracts and JSON boundary types.
- `src/core/schema.ts` — dependency-free JSON Schema validation for untrusted tool arguments and outputs.
- `src/core/tool-registry.ts` — dynamic registration, discovery, validation, execution, and structured tool errors.
- `src/core/capabilities.ts` — provider registration, explicit permission policy, grants, revocation, and scoped access.
- `src/core/agent.ts` — cancellable model/tool loop with multiple calls, model and tool timeouts, max-turn termination, streaming events, and normalized errors.
- `src/core/plugin-manager.ts` — versioned plugin lifecycle and contribution cleanup.
- `src/core/state.ts` — IndexedDB persistence with a memory fallback and namespaced stores.
- `src/core/runtime.ts` — time-limited worker execution. It passes no capability objects to executed code.
- `src/adapters/openai-compatible.ts` — an optional provider-boundary adapter for OpenAI-compatible SSE responses.

## Plugins and permissions

Plugins receive a narrow `PluginContext`. They can contribute tools, capability providers, model adapters, processors, and UI mounts without receiving the kernel's internal maps. A plugin must declare every capability required by its tools. Installation requests those capabilities through the injected `PermissionPolicy`; the default kernel policy denies all requests.

The UI's example plugins are deliberately opt-in:

- **JavaScript runtime** registers `runtime.javascript` and requests `runtime`; code is an async function body with `input` and a capability-free `console` parameter.
- **Local storage** registers `storage.local` and requests `storage`; its keys are isolated under the plugin namespace.

Browser worker execution is a resource and lifecycle boundary, not a security boundary for hostile code. A worker has browser ambient APIs, and masking common APIs is best-effort. Do not install or run untrusted plugin source as if it were a security sandbox. Privileged application functionality must still be exposed through capabilities and explicit permission checks.

## Browser constraints

The runtime does not emulate shell commands, arbitrary host filesystem access, unrestricted cross-origin access, other-tab access, or unavailable browser APIs. New browser features should be added as capability implementations or plugins. Remote model access is subject to the browser's normal CORS and credential rules.

## Checks

```sh
npm run check   # strict TypeScript type check
npm test        # build + node:test architectural boundary checks
```
