import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStreamPresentationAdapter, createStreamPresentation } from "../dist/app/stream-presentation.js";

test("stream presentation preserves interleaved text, thinking, and continuous tool groups", () => {
  const adapter = createMemoryStreamPresentationAdapter();
  const presentation = createStreamPresentation(adapter);

  const initial = presentation.snapshot();
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.pendingStream), true);

  presentation.handle({ type: "model-started", turn: 1 });
  presentation.handle({ type: "reasoning-delta", delta: "first thought" });
  presentation.handle({ type: "text-delta", delta: "answer" });
  const textBeforeTool = presentation.snapshot();
  assert.deepEqual(textBeforeTool.pendingStream.map((segment) => segment.kind), ["thinking", "text"]);
  presentation.handle({ type: "text-delta", delta: " more" });
  assert.equal(textBeforeTool.pendingStream[1].text, "answer");
  assert.equal(presentation.snapshot().pendingStream[1].text, "answer more");

  presentation.handle({ type: "tool-call-delta", delta: { index: 0, id: "one", name: "search", arguments: "{" } });
  presentation.handle({ type: "tool-call-delta", delta: { index: 1, id: "two", name: "open", arguments: "{}" } });
  const secondTool = presentation.snapshot();
  assert.deepEqual(secondTool.pendingStream.map((segment) => segment.kind), ["thinking", "text", "tools"]);
  assert.equal(secondTool.pendingStream.at(-1).toolKeys.length, 2);
  assert.deepEqual(secondTool.pendingToolCalls.map((delta) => delta.name), ["search", "open"]);

  const beforeMoreText = presentation.snapshot();
  presentation.handle({ type: "tool-started", call: { id: "one", name: "search", arguments: {} } });
  presentation.handle({ type: "tool-finished", call: { id: "one", name: "search", arguments: {} }, result: { ok: true, value: { hits: 1 } } });
  presentation.handle({ type: "text-delta", delta: "after tools" });
  assert.equal(beforeMoreText.pendingStream.at(-1).kind, "tools");
  assert.equal(beforeMoreText.pendingStream.at(-1).toolKeys.length, 2);
  assert.deepEqual(presentation.snapshot().pendingStream.map((segment) => segment.kind), ["thinking", "text", "tools", "text"]);
  assert.equal(presentation.snapshot().liveToolEntries[0].status, "finished");

  presentation.handle({ type: "run-finished", result: { runId: "run", status: "completed", messages: [], turns: 1 } });
  assert.deepEqual(presentation.snapshot().pendingToolCalls, []);
  presentation.resetPending();
  assert.deepEqual(presentation.snapshot().pendingStream, []);
  assert.deepEqual(presentation.snapshot().liveToolEntries, []);
});

test("stream presentation detaches from and recovers the latest scroll position", () => {
  const adapter = createMemoryStreamPresentationAdapter();
  const presentation = createStreamPresentation(adapter);
  presentation.setBusy(true);

  presentation.onScroll({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  presentation.onScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  presentation.render();
  assert.equal(presentation.snapshot().followChat, false);
  assert.equal(presentation.snapshot().showScrollButton, true);

  presentation.onScroll({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  presentation.render();
  assert.equal(presentation.snapshot().followChat, true);
  assert.equal(presentation.snapshot().showScrollButton, false);

  presentation.scrollToLatest();
  presentation.render();
  assert.equal(adapter.snapshots.at(-1).scrollToLatest, true);
  assert.equal(presentation.snapshot().scrollToLatest, false);
});
