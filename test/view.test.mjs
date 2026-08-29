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
