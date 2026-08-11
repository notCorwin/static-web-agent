## Project

This project is a browser-native, extensible agent runtime.

The LLM may be remote, but all agent execution, tool orchestration, state management, storage, plugins, and runtime capabilities must execute directly inside the browser.

The long-term goal is to make the runtime maximally extensible without coupling the agent core to individual tools or providers.

## Core Principles

1. **Browser-native first**
   - Do not introduce a backend server.
   - Do not require localhost services.
   - Do not require browser extensions.
   - Do not require native applications.
   - Use standard browser capabilities whenever possible.
2. **Keep the kernel minimal**
   - The core should provide orchestration, tool dispatch, capability management, state, permissions, and lifecycle management.
   - Domain-specific functionality must not be hard-coded into the kernel.
3. **Everything is a capability**
   - Expose functionality through explicit, typed capability interfaces.
   - Prefer composable primitives over large specialized APIs.
   - New browser APIs should be introducible as capabilities without changing the agent architecture.
4. **Tools are plugins**
   - Tools must be dynamically registerable and removable.
   - Tool implementations must remain independent from the LLM provider.
   - Plugins must declare the capabilities and permissions they require.
   - Avoid adding built-in tools when the same functionality can exist as a plugin.
5. **Runtime over tool proliferation**
   - Prefer general execution primitives over hundreds of narrowly scoped tools.
   - JavaScript and WebAssembly should be first-class execution targets.
   - Sandboxed code execution must not implicitly gain privileged capabilities.
6. **Provider independence**
   - The agent runtime must not depend on OpenAI-, Anthropic-, Google-, or other provider-specific semantics.
   - Normalize model messages, tool calls, streaming, errors, and usage at the provider boundary.
   - Provider-specific features belong in adapters.
7. **Local-first state**
   - Persistent application state belongs in browser storage such as IndexedDB or OPFS.
   - Do not introduce remote persistence as a requirement.
   - Users should retain control over locally stored data.
8. **Explicit security boundaries**
   - Treat LLM output, tool arguments, web content, plugin code, and external data as untrusted.
   - Privileged operations must pass through explicit capability and permission checks.
   - Never bypass browser security mechanisms.
   - Do not simulate capabilities that the browser does not actually provide.

## Architecture

Prefer this dependency direction:

```
UI
↓
Agent
↓
Kernel
├── Model Adapter
├── Tool Registry
├── Capability Manager
├── Runtime
├── State
└── Plugin System
      ↓
Browser APIs
```

Dependencies should point toward abstractions rather than concrete providers or tools.

The kernel must not import domain-specific plugins.

## Tool Model

Every tool should expose a machine-readable contract containing at least:

- name
- description
- input schema
- output contract
- required capabilities
- execution handler

Tool discovery and registration must be runtime-driven rather than based on hard-coded switch statements.

Prefer:

```
registry.register(tool)
```

over:

```
if (toolName === "foo") ...
else if (toolName === "bar") ...
```

## Capability Model

Capabilities represent privileged access to browser functionality.

Examples:

```
network
storage
filesystem
clipboard
media
notifications
workers
wasm
ui
```

Plugins request capabilities; they do not own unrestricted access to the environment.

Keep policy separate from mechanism:

```
Plugin
  ↓ requests
Capability Manager
  ↓ authorizes
Capability Implementation
  ↓
Browser API
```

## Agent Loop

Keep the agent loop model-agnostic and tool-agnostic.

Conceptually:

```
model()
  ↓
tool calls
  ↓
validate
  ↓
authorize
  ↓
execute
  ↓
tool results
  ↓
model()
```

Do not place business logic inside the loop.

The loop should support cancellation, timeouts, streaming, multiple tool calls, structured errors, and deterministic termination conditions.

## Plugins

Design plugins so that third-party functionality can be added without modifying the core.

A plugin should be able to contribute:

- tools
- capabilities adapters
- model adapters
- UI components
- data processors
- runtime modules

Plugin APIs must be versioned.

Do not expose internal kernel implementation details as public plugin APIs.

## Interoperability

Prefer open and portable interfaces.

Where useful, adapters may support protocols or schemas such as:

- MCP
- OpenAPI
- JSON Schema
- standard HTTP APIs

These are interoperability layers, not architectural foundations.

The core must remain usable without them.

## Browser Constraints

The browser sandbox is an intentional architectural boundary.

Do not design features that silently assume access to:

- arbitrary shell commands
- arbitrary host filesystem paths
- native processes
- unrestricted cross-origin resources
- other browser tabs or origins
- privileged browser APIs unavailable to normal web pages

If a requested feature cannot be implemented faithfully within the browser, expose the limitation explicitly instead of introducing hidden infrastructure.

## Engineering Rules

- Use TypeScript for core runtime code.
- Prefer Web Platform APIs over dependencies.
- Add dependencies only when they provide substantial functionality that would be costly or risky to reproduce.
- Keep public APIs small and typed.
- Avoid global mutable state.
- Separate interfaces from implementations.
- Prefer dependency injection at system boundaries.
- Keep modules independently testable.
- Do not optimize by weakening architectural boundaries.

## Testing

Changes to the kernel, tool protocol, capability system, plugin API, persistence layer, or agent loop require tests.

Test behavior at architectural boundaries rather than implementation details.

At minimum, verify:

```
tool registration
schema validation
permission enforcement
tool execution
tool errors
agent cancellation
agent termination
provider normalization
plugin isolation
state persistence
```

Browser-specific behavior should be tested in an actual browser environment when practical.

## Before Making Architectural Changes

Before introducing a new subsystem, dependency, abstraction, or privileged API, determine:

1. Can this be implemented as a plugin?
2. Can an existing capability express it?
3. Is this browser-native?
4. Does it couple the kernel to a provider or domain?
5. Does it expand the trusted computing base?
6. Is the abstraction necessary now?

Prefer extending existing primitives over introducing parallel systems.

## Definition of Done

A change is complete only when:

- the implementation works,
- architectural boundaries remain intact,
- relevant tests pass,
- public types remain coherent,
- no unnecessary dependency was introduced,
- security implications were considered,
- documentation is updated when a public contract changes.