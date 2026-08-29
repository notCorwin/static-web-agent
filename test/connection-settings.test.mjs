import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectionSettings, saveConnectionSettings, validateConnectionDraft } from "../dist/app-entry.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("connection validation keeps only the three selected fields", () => {
  assert.equal(validateConnectionDraft({ endpoint: "not a url", model: "", apiKey: "" }).settings, undefined);
  const result = validateConnectionDraft({ endpoint: " https://example.test/v1 ", model: " demo ", apiKey: "secret" });
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.settings, { endpoint: "https://example.test/v1", model: "demo", apiKey: "secret" });
});

test("connection settings persist locally while arbitrary invalid values are ignored", () => {
  const fakeStorage = storage();
  const settings = { endpoint: "https://example.test/v1", model: "demo", apiKey: "secret" };
  saveConnectionSettings(settings, fakeStorage);
  assert.deepEqual(loadConnectionSettings(fakeStorage), settings);
  fakeStorage.setItem("static-web-agent.connection", "not-json");
  assert.equal(loadConnectionSettings(fakeStorage), undefined);
  fakeStorage.setItem("static-web-agent.connection", JSON.stringify({ endpoint: "", model: "", apiKey: "secret" }));
  assert.equal(loadConnectionSettings(fakeStorage), undefined);
  fakeStorage.setItem("static-web-agent.connection", JSON.stringify({ endpoint: " https://example.test/v1 ", model: " demo ", apiKey: "secret" }));
  assert.deepEqual(loadConnectionSettings(fakeStorage), settings);
  saveConnectionSettings({ endpoint: "invalid", model: "", apiKey: "secret" }, fakeStorage);
  assert.deepEqual(loadConnectionSettings(fakeStorage), settings);
});

test("connection settings do not inherit a missing API key", () => {
  const key = "apiKey";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, { configurable: true, value: "polluted-key" });
  try {
    const fakeStorage = storage();
    fakeStorage.setItem("static-web-agent.connection", JSON.stringify({ endpoint: "https://example.test/v1", model: "demo" }));
    assert.equal(loadConnectionSettings(fakeStorage), undefined);
  } finally {
    if (previous === undefined) delete Object.prototype[key];
    else Object.defineProperty(Object.prototype, key, previous);
  }
});
