# Browser Agent Harness

This project is a small browser-native Agent Harness for general work. The
model may be remote, but the Agent loop, page execution, state, and UI run in
the current browser page. There is no backend, localhost service, extension,
native helper, plugin marketplace, or hidden persistence layer.

## Run the reference UI

```sh
npm install
npm run build
```

Serve `dist/` with any static HTTP server and open `dist/index.html`.

```sh
npm run check     # TypeScript
npm test          # build, boundary tests, and Chromium smoke test when available
npm run test:browser
```

The UI is intentionally small: one OpenAI-compatible connection, an
in-memory multi-turn chat, streamed model output, one `page.run` Meta Tool,
expandable raw tool traces, best-effort stop, and edit-and-rerun. Endpoint,
model name, and API key are stored in browser-local storage for reconnection;
conversation messages are not restored after refresh.

The model request goes directly from the browser to the configured endpoint,
so CORS, authentication, provider behavior, context limits, and browser
resource limits remain real constraints.

## Harness API

The recommended integration is one Harness with one provider-neutral model:

```ts
import { createHarness } from "./dist/index.js";

const harness = await createHarness({
  model: {
    id: "demo",
    async *stream({ messages, tools }) {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "completed", message: { role: "assistant", content: "done" } };
        return;
      }
      yield {
        type: "completed",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: tools[0].name, arguments: { code: "return input.value", input: { value: 42 } } }],
        },
      };
    },
  },
});

const result = await harness.run({
  messages: [{ role: "user", content: "Run the demo." }],
});
console.log(result.response?.content); // done
await harness.dispose();
```

`createHarness()` provides exactly one default tool descriptor:

- `page.run` executes model-supplied JavaScript in the current page realm;
- `code` is the JavaScript source and `input` is optional JSON input;
- the result contains a JSON value, captured console lines, and elapsed time.

The page executor is trusted same-page code, not a security sandbox. It cannot
provide shell commands, native processes, arbitrary host file paths, other
tabs, or browser APIs that the page does not actually have.

The Agent executes formal tool calls sequentially. Invalid tool input and page
execution failures become structured tool results for the model to interpret.
Only model tool calls execute; ordinary model text is never parsed as a
command. Model transport or protocol errors end the run. Cancellation is
cooperative: code that blocks the page or ignores its signal may continue to
hold the page.

## Provider boundary

`src/adapters/ai-sdk.ts` contains the optional OpenAI-compatible adapter. It
normalizes provider streaming into the core model contract; the core does not
depend on a provider. Hosts may supply any adapter implementing `ModelAdapter`.

The package entry points are deliberately narrow:

| Entry point | Purpose |
| --- | --- |
| `dist/index.js` | Harness, Agent, page runtime, schemas, and public types |
| `dist/remote.js` | Optional OpenAI-compatible adapter |
| `dist/app-entry.js` | Reference chat UI and connection helpers |

There is no public Kernel, Plugin, Capability, Worker runtime, attachment
pipeline, transcript store, or second tool registry to maintain.

## Browser boundary

The project is static and local-first. The Harness does not bypass same-origin
policy, CORS, CSP, browser permissions, user-gesture requirements, or missing
Web APIs. Different browsers may expose different capabilities. If a desired
operation is not available in the current page, the real browser error is the
boundary.

MIT. See [`LICENSE`](./LICENSE).
