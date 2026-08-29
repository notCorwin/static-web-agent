import assert from "node:assert/strict";
import test from "node:test";
import { AgentApp } from "../dist/app-entry.js";

test("sparse streamed tool indexes stay dense in the reference UI state", () => {
  const app = new AgentApp({});
  const stream = { text: "", tools: [] };
  app.mergeToolDelta(stream, { index: 1_000_000_000, id: "tool-1", name: "page.run", arguments: "{}" });
  assert.equal(stream.tools.length, 1);
  assert.equal(stream.tools[0].delta.index, 1_000_000_000);
});

test("completed streamed tool cards do not absorb a reused call ID", () => {
  const app = new AgentApp({});
  const stream = { text: "", tools: [] };
  app.mergeToolDelta(stream, { index: 0, id: "same", name: "page.run", arguments: "{}" });
  app.updateTool(stream, { id: "same", name: "page.run", arguments: {} }, { ok: true, value: null, durationMs: 0 }, "finished");
  app.mergeToolDelta(stream, { index: 0, id: "same", name: "page.run", arguments: "{}" });
  assert.equal(stream.tools.length, 2);
  assert.equal(stream.tools[0].status, "finished");
  assert.equal(stream.tools[1].status, "preparing");
});

test("late clipboard completion cannot update a stopped app", async () => {
  let release;
  const clipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => new Promise((resolve) => { release = resolve; }) },
  });
  try {
    const app = new AgentApp({ replaceChildren() {} });
    const statuses = [];
    app.setStatus = (message, kind) => statuses.push([message, kind]);
    const pending = app.copyMessage("old message");
    await app.stop();
    release();
    await pending;
    assert.deepEqual(statuses, []);
  } finally {
    if (clipboard === undefined) delete globalThis.navigator.clipboard;
    else Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: clipboard });
  }
});

test("hostile clipboard errors become a visible status", async () => {
  const source = new Error("copy failed");
  const hostile = new Proxy(source, { getPrototypeOf() { throw new Error("blocked prototype"); } });
  const clipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(hostile) },
  });
  try {
    const app = new AgentApp({});
    const statuses = [];
    app.setStatus = (message, kind) => statuses.push([message, kind]);
    await app.copyMessage("message");
    assert.deepEqual(statuses, [["Operation failed.", "error"]]);
  } finally {
    if (clipboard === undefined) delete globalThis.navigator.clipboard;
    else Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: clipboard });
  }
});
