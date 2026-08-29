# Project Charter

## Identity

This project is a minimal, browser-native Agent Harness for general
non-programming work. It should feel like Codex or Claude Code at the runtime
level: a user gives an Agent a goal, and the Agent can decide how to complete
it. The browser is the execution environment, not a thin client for a hidden
server.

The primary product is the reusable Harness. The reference UI exists to make
the Harness usable and observable; it must not define the core architecture.

## Core contract

The core does only the following:

- accepts a provider-neutral model through one simple recommended entry point;
- runs the model/tool loop;
- exposes one general page-JavaScript Meta Tool by default;
- executes formal tool calls in order;
- streams model and tool events;
- returns tool failures to the model as results;
- supports cooperative cancellation and returns the final result.

The model decides its own plan, steps, and completion condition. The Harness
must not impose a planning mode, task template, role, workflow, or domain
prompt.

Only formal tool calls are executable. Never guess commands from ordinary
model text.

The Meta Tool lets the model write JavaScript that runs in the Harness page
and can use the Web APIs actually available there. It is the general extension
mechanism for browser work; do not create one maintained wrapper or tool for
each Web API.

The Meta Tool returns readable text or JSON. Common non-JSON values may be
represented by a compact summary. Do not create a hidden resource-handle,
temporary-object, or private-workspace protocol. If the Agent needs state, it
can use the page's own Web APIs such as `sessionStorage`, `IndexedDB`, or page
objects.

Tool failures are information for the model. The model may retry, change
approach, or explain the failure. A model transport failure or invalid model
response ends the run and is shown to the user.

There are no default limits on turns, tool calls, or execution time. A host
may add its own resource limits for its deployment, but the reference UI must
not impose them. A synchronous infinite loop in page code may freeze the page;
manual cancellation is not a guaranteed recovery mechanism for blocked page
JavaScript.

## Trust and browser boundary

This is a personal, trusted work environment. The page Meta Tool has the same
page-level access as the Harness and may read or change the Harness DOM,
browser storage, network state, and other page state. The application does
not provide a permission manager, per-call approval, sandbox for generated
page code, or first-run warning.

The project remains a static web application:

- no application backend, localhost service, daemon, native helper, or browser
  extension;
- no remote plugin loader or online plugin marketplace;
- no access to arbitrary host files, native processes, or other browser tabs;
- no bypass of same-origin policy, CORS, browser permissions, user-gesture
  requirements, CSP, or unavailable Web APIs;
- no promise that different browsers expose the same capabilities;
- no promise that a deployment with a strict ban on runtime-generated
  JavaScript can provide the full Meta Tool.

Remote models are requested directly from the browser. CORS, authentication,
provider behavior, context limits, browser resources, and native permission
prompts remain real external constraints. Page navigation is not intercepted
by the core; the embedding host decides how navigation should affect its UI.

## Model and state boundaries

The core remains provider-neutral. The reference UI may provide one
OpenAI-compatible Endpoint connection, but provider-specific fields and
behavior belong outside the core model contract.

The reference UI has one active connection. It stores the Endpoint, model
name, and key in browser-local storage and restores them automatically. This
is convenience storage, not server-grade secret protection.

The host or reference UI owns the current in-memory conversation. Chat
messages are not restored after refresh or page close. The core does not own
conversation history, branching, multi-session storage, or remote persistence.

## Reference UI

Keep the UI chat-first and small. It includes:

- multi-turn input and output;
- streamed model output;
- expandable Meta Tool cards showing the complete raw code, input, result,
  error, and timing;
- stop/cancel with already-produced content retained and marked stopped;
- editing a message by replacing everything after it and running again;
- one OpenAI-compatible Endpoint, model name, and key configuration.

Do not add attachments, files, PDF, OCR, vision settings, model thinking
controls, conversation history, multiple sessions, plugin panels, extra
tools, separate raw-debug views, result export, or background scheduling.

## Architecture rules

Keep the public API small and make the simple Harness entry point the only
recommended integration path. Do not expose or grow a second public platform
around Kernel, Plugin, Capability, Processor, UI-slot, or generic tool
registration APIs.

The page executor may be a built-in/default module, but it is not a general
plugin system. Do not add domain-specific tools, API catalogs, provider logic,
permission layers, hidden state managers, or alternate execution runtimes to
the core.

Prefer Web Platform APIs and the existing standard library over dependencies.
Delete code and abstractions before adding new ones. Do not add speculative
configuration, compatibility layers, frameworks, or wrappers. Measure before
keeping a performance optimization.

Breaking old public APIs is allowed when they conflict with this charter.

## Transitional code

The current repository contains transitional platform and reference-app
features that do not define the target architecture. Do not expand them.
Remove them progressively when implementation work resumes, including the
old plugin/capability/permission platform, Worker runtime, attachment and
PDF/OCR pipeline, transcript persistence, extra tools, extension UI, and
provider-specific advanced settings.

## Validation

Changes to the runtime must be tested at the boundary, not only by inspecting
internal functions. At minimum, verify:

- a formal model tool call reaches the page Meta Tool;
- real page JavaScript can use an available Web API and return a readable
  result;
- multiple calls execute in order;
- tool errors return to the model;
- model transport errors end the run visibly;
- streaming, manual cancellation, retained partial output, and edit/rerun
  behavior work;
- connection settings restore while chat history does not;
- the static build and a real browser smoke test pass.

Do not add a cross-browser compatibility matrix or API-by-API test suite.
When a requested capability is unavailable, test and report the real browser
failure instead of simulating it.
