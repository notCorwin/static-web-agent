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
});
