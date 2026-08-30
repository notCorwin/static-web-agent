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

test("completed tool calls keep same-name cards separate without deltas", () => {
  const app = new AgentApp({});
  const stream = { text: "", tools: [] };
  const calls = [
    { id: "one", name: "page.run", arguments: { code: "return 1" } },
    { id: "two", name: "page.run", arguments: { code: "return 2" } },
  ];
  app.updateTool(stream, calls[0], undefined, "running");
  app.updateTool(stream, calls[1], undefined, "running");
  assert.deepEqual(stream.tools.map((item) => item.call.id), ["one", "two"]);
  app.updateTool(stream, calls[0], { ok: true, value: 1, durationMs: 0 }, "finished");
  app.updateTool(stream, calls[1], { ok: true, value: 2, durationMs: 0 }, "finished");
  assert.deepEqual(stream.tools.map((item) => item.status), ["finished", "finished"]);
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

test("clipboard feedback does not replace an active run status", async () => {
  const clipboard = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  try {
    const app = new AgentApp({});
    app.busy = true;
    app.runRevision = 1;
    const statuses = [];
    app.setStatus = (message, kind) => statuses.push([message, kind]);
    await app.copyMessage("message");
    assert.deepEqual(statuses, []);
  } finally {
    if (clipboard === undefined) delete globalThis.navigator.clipboard;
    else Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: clipboard });
  }
});

test("stopping the app releases conversation and DOM state", async () => {
  const app = new AgentApp({ replaceChildren() {} });
  const oldElement = {};
  app.elements.oldElement = oldElement;
  app.messages = [{ role: "user", content: "retained conversation" }];
  app.runStatus = "Running…";
  await app.stop();
  assert.equal(app.elements.oldElement, undefined);
  assert.deepEqual(app.messages, []);
  assert.equal(app.runStatus, "");
});
