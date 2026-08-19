import assert from "node:assert/strict";
import test from "node:test";
import {
  KernelError,
  MemoryStateStore,
  createBrowserAgentHarness,
} from "../dist/index.js";

function modelPlugin(id, response = id) {
  return {
    manifest: { apiVersion: "1", id: `${id}-plugin`, name: id, version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerModelAdapter({
        id,
        async *stream() {
          yield { type: "completed", message: { role: "assistant", content: response } };
        },
      });
    },
  };
}

test("browser harness preinstalls browser tools and exposes a light snapshot", async () => {
  const harness = await createBrowserAgentHarness({ stateStore: new MemoryStateStore() });
  const snapshot = harness.snapshot();

  assert.equal(snapshot.status, "active");
  assert.deepEqual(snapshot.manifests.map((manifest) => manifest.id), ["browser-api", "javascript-runtime", "local-storage"]);
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["browser.evaluate", "browser.inspect", "runtime.javascript", "storage.local"]);
  assert.deepEqual(snapshot.models, []);

  await harness.dispose();
  assert.equal(harness.snapshot().status, "disposed");
  assert.deepEqual(harness.snapshot().manifests, []);
  assert.deepEqual(harness.snapshot().tools, []);
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof KernelError && error.code === "HARNESS_DISPOSED");
  await harness.dispose();
});

test("harness installs trusted plugins, publishes snapshots, and rolls back failed installs", async () => {
  const harness = await createBrowserAgentHarness({ defaultPlugins: false, stateStore: new MemoryStateStore() });
  const snapshots = [];
  const unsubscribe = harness.subscribe((snapshot) => snapshots.push(snapshot));
  const plugin = {
    manifest: { apiVersion: "1", id: "echo-plugin", name: "Echo", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerTool({
        name: "example.echo",
        description: "Return the supplied value.",
        inputSchema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
        execute: (input) => input,
      });
      context.registerProcessor({ id: "example.upper", description: "Uppercase strings.", process: (value) => typeof value === "string" ? value.toUpperCase() : value });
    },
  };
  const handle = await harness.install(plugin);
  assert.equal(harness.snapshot().tools[0]?.name, "example.echo");
  assert.equal(await harness.process("hello"), "HELLO");
  assert.ok(snapshots.some((snapshot) => snapshot.manifests.some((manifest) => manifest.id === "echo-plugin")));

  const failed = {
    manifest: { apiVersion: "1", id: "failed-plugin", name: "Failed", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerTool({ name: "example.leak", description: "Must be removed.", inputSchema: { type: "object" }, execute: () => null });
      throw new Error("setup failed");
    },
  };
  await assert.rejects(harness.install(failed), /setup failed/);
  assert.equal(harness.snapshot().tools.some((tool) => tool.name === "example.leak"), false);

  await handle.uninstall();
  assert.equal(harness.snapshot().manifests.length, 0);
  unsubscribe();
  await harness.dispose();
});

test("initial plugin installation is atomic and tears down earlier plugins on failure", async () => {
  let teardownCount = 0;
  const good = {
    manifest: { apiVersion: "1", id: "good-plugin", name: "Good", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerTool({ name: "example.good", description: "Good.", inputSchema: { type: "object" }, execute: () => true });
    },
    teardown: () => { teardownCount += 1; },
  };
  const bad = {
    manifest: { apiVersion: "1", id: "bad-plugin", name: "Bad", version: "1.0.0", permissions: [] },
    setup() {
      throw new Error("initial setup failed");
    },
  };

  await assert.rejects(
    createBrowserAgentHarness({ defaultPlugins: false, plugins: [good, bad], stateStore: new MemoryStateStore() }),
    /initial setup failed/,
  );
  assert.equal(teardownCount, 1);
});

test("harness auto-grants declared permissions by default and allows policy overrides", async () => {
  const capabilityPlugin = {
    manifest: { apiVersion: "1", id: "capability-plugin", name: "Capability", version: "1.0.0", permissions: [{ name: "secret", reason: "test" }] },
    setup(context) {
      context.registerCapability({ name: "secret", provider: { provide: () => ({ value: 42 }) } });
      context.registerTool({
        name: "example.secret",
        description: "Read a secret.",
        inputSchema: { type: "object" },
        requiredCapabilities: ["secret"],
        execute: async (_, toolContext) => await toolContext.getCapability("secret"),
      });
    },
  };
  const allowed = await createBrowserAgentHarness({ defaultPlugins: false, plugins: [capabilityPlugin], stateStore: new MemoryStateStore() });
  const tool = allowed.snapshot().tools.find((descriptor) => descriptor.name === "example.secret");
  assert.ok(tool);
  await allowed.dispose();

  await assert.rejects(
    createBrowserAgentHarness({ defaultPlugins: false, permissionPolicy: { decide: () => false }, plugins: [capabilityPlugin], stateStore: new MemoryStateStore() }),
    (error) => error instanceof Error && error.code === "CAPABILITY_DENIED",
  );
});

test("harness selects and snapshots a model, supports parallel runs, and clears selection on uninstall", async () => {
  const harness = await createBrowserAgentHarness({ defaultPlugins: false, plugins: [modelPlugin("first")], initialModelId: "first", stateStore: new MemoryStateStore() });
  const [first, second] = await Promise.all([
    harness.run({ messages: [{ role: "user", content: "one" }] }),
    harness.run({ messages: [{ role: "user", content: "two" }] }),
  ]);
  assert.equal(first.response?.content, "first");
  assert.equal(second.response?.content, "first");
  assert.equal(harness.snapshot().selectedModelId, "first");

  assert.throws(() => harness.selectModel("missing"), (error) => error instanceof KernelError && error.code === "MODEL_NOT_FOUND");
  await harness.uninstall("first-plugin");
  assert.equal(harness.snapshot().selectedModelId, undefined);
  await assert.rejects(harness.run({ messages: [] }), (error) => error instanceof KernelError && error.code === "MODEL_NOT_SELECTED");
  await harness.dispose();
});

test("disposing a harness cancels an active run and keeps the operation structured", async () => {
  const plugin = {
    manifest: { apiVersion: "1", id: "waiting-plugin", name: "Waiting", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerModelAdapter({
        id: "waiting",
        async *stream({ signal }) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        },
      });
    },
  };
  const harness = await createBrowserAgentHarness({ defaultPlugins: false, plugins: [plugin], initialModelId: "waiting", stateStore: new MemoryStateStore() });
  const run = harness.run({ messages: [{ role: "user", content: "wait" }] });
  await harness.dispose();
  const result = await run;
  assert.equal(result.status, "cancelled");
  assert.equal(harness.snapshot().status, "disposed");
});

test("an injected state store keeps harness plugin namespaces isolated", async () => {
  const stateStore = new MemoryStateStore();
  const storagePlugin = (id) => ({
    manifest: { apiVersion: "1", id, name: id, version: "1.0.0", permissions: [{ name: "storage", reason: "test" }] },
    setup(context) {
      context.registerTool({
        name: `storage.${id}`,
        description: "Write and read one namespaced value.",
        inputSchema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
        requiredCapabilities: ["storage"],
        execute: async (input, toolContext) => {
          const storage = await toolContext.getCapability("storage");
          await storage.set("shared", input.value);
          return { value: await storage.get("shared") };
        },
      });
    },
  });
  const modelPlugin = {
    manifest: { apiVersion: "1", id: "storage-model-plugin", name: "Storage model", version: "1.0.0", permissions: [] },
    setup(context) {
      context.registerModelAdapter({
        id: "storage-model",
        async *stream({ messages }) {
          if (messages.some((message) => message.role === "tool")) {
            yield { type: "completed", message: { role: "assistant", content: "done" } };
            return;
          }
          const value = messages.some((message) => message.content === "b") ? "second" : "first";
          const tool = value === "first" ? "storage.storage-a" : "storage.storage-b";
          yield { type: "completed", message: { role: "assistant", content: "", toolCalls: [{ id: value, name: tool, arguments: { value } }] } };
        },
      });
    },
  };
  const harness = await createBrowserAgentHarness({
    defaultPlugins: false,
    plugins: [storagePlugin("storage-a"), storagePlugin("storage-b"), modelPlugin],
    initialModelId: "storage-model",
    stateStore,
  });
  await harness.run({ messages: [{ role: "user", content: "a" }] });
  await harness.run({ messages: [{ role: "user", content: "b" }] });
  assert.deepEqual(await stateStore.keys(), ["plugin:storage-a:shared", "plugin:storage-b:shared"]);
  assert.equal(await stateStore.get("plugin:storage-a:shared"), "first");
  assert.equal(await stateStore.get("plugin:storage-b:shared"), "second");
  await harness.dispose();
});
