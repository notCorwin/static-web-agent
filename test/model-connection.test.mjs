import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStateStore } from "../dist/index.js";
import { loadConnectionSettings } from "../dist/app-entry.js";
import { createModelConnection, validateConnectionDraft } from "../dist/app/model-connection.js";

function settings(overrides = {}) {
  return {
    endpoint: "https://saved.example/v1",
    model: "saved-model",
    apiKey: "saved-key",
    thinkingLevel: "high",
    supportsVision: true,
    ...overrides,
  };
}

function fakeHarness({ failInstall = false, failSelect = false } = {}) {
  const events = [];
  let selectedModelId;
  return {
    events,
    get selectedModelId() {
      return selectedModelId;
    },
    async install(plugin) {
      events.push(`install:${plugin.manifest.id}`);
      if (failInstall) throw new Error("install failed");
      let removed = false;
      return {
        manifest: plugin.manifest,
        async uninstall() {
          if (removed) return;
          removed = true;
          events.push(`uninstall:${plugin.manifest.id}`);
        },
      };
    },
    selectModel(id) {
      events.push(`select:${id}`);
      if (failSelect) throw new Error("selection failed");
      selectedModelId = id;
    },
    clearModel() {
      events.push("clear");
      selectedModelId = undefined;
    },
  };
}

test("model connection validates drafts and preserves restore merge precedence", async () => {
  assert.deepEqual(validateConnectionDraft({ endpoint: "", model: "", apiKey: "", thinkingLevel: "bad", supportsVision: false }).errors, {
    endpoint: "Enter the model endpoint.",
    model: "Enter a model name.",
  });
  assert.deepEqual(validateConnectionDraft({ endpoint: "ftp://example.test", model: "demo", apiKey: "", thinkingLevel: "bad", supportsVision: false }).errors, {
    endpoint: "Use an http:// or https:// endpoint.",
  });

  const connection = createModelConnection({
    harness: fakeHarness(),
    store: new MemoryStateStore(),
    credentials: {
      read: async () => ({ endpoint: "https://credential.example/v1", model: "credential-model", apiKey: "credential-key" }),
    },
  });
  const restored = await connection.restore(settings());
  assert.equal(restored.source, "credential");
  assert.deepEqual(restored.settings, settings({ model: "credential-model", apiKey: "credential-key" }));

  const localFallback = createModelConnection({
    harness: fakeHarness(),
    store: new MemoryStateStore(),
    credentials: { read: async () => { throw new Error("credential unavailable"); } },
  });
  const fallback = await localFallback.restore(settings());
  assert.equal(fallback.source, "local");
  assert.deepEqual(fallback.settings, settings());
});

test("model connection replaces the selected model and rolls back failed selection", async () => {
  const harness = fakeHarness();
  const state = new MemoryStateStore();
  const connection = createModelConnection({ harness, store: state, credentials: { save: async () => {} } });
  await connection.connect(settings({ model: "first" }));
  await connection.connect(settings({ model: "second" }));
  assert.deepEqual(harness.events, [
    "install:remote-model",
    "select:remote-model",
    "uninstall:remote-model",
    "install:remote-model",
    "select:remote-model",
  ]);
  assert.equal((await loadConnectionSettings(state)).model, "second");

  const failedHarness = fakeHarness({ failSelect: true });
  const failed = createModelConnection({ harness: failedHarness, store: new MemoryStateStore() });
  await assert.rejects(failed.connect(settings()), /selection failed/);
  assert.deepEqual(failedHarness.events, ["install:remote-model", "select:remote-model", "uninstall:remote-model", "clear"]);
});

test("credential management failure degrades to local settings without failing connection", async () => {
  const state = new MemoryStateStore();
  const connection = createModelConnection({
    harness: fakeHarness(),
    store: state,
    credentials: { save: async () => { throw new Error("password manager rejected the credential"); } },
  });
  const result = await connection.connect(settings());
  assert.equal(result.credentialSaved, false);
  assert.deepEqual(await loadConnectionSettings(state), settings());
});
