import test from "node:test";
import assert from "node:assert/strict";
import { createDomStreamPresentationAdapter, createMemoryStreamPresentationAdapter, createStreamPresentation } from "../dist/app/stream-presentation.js";

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

  presentation.markUserScrollGesture(true);
  presentation.onScroll({ scrollTop: 580, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(presentation.snapshot().followChat, false);

  presentation.scrollToLatest();
  presentation.onScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(presentation.snapshot().scrollToLatest, false);
  presentation.render();
  assert.equal(adapter.snapshots.at(-1).scrollToLatest, false);
  presentation.scrollToLatest();
  presentation.render();
  assert.equal(adapter.snapshots.at(-1).scrollToLatest, true);
  assert.equal(presentation.snapshot().scrollToLatest, false);
});

test("scroll events update only viewport controls without flushing pending content", () => {
  let contentRenders = 0;
  const viewportRenders = [];
  const reads = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  const presentation = createStreamPresentation({
    render: () => { contentRenders += 1; },
    renderViewport: (followChat, viewport) => { viewportRenders.push({ followChat, viewport }); },
  });
  presentation.setBusy(true);
  presentation.handle({ type: "text-delta", delta: "pending" });

  presentation.onScroll({
    get scrollTop() { reads.scrollTop += 1; return 600; },
    get scrollHeight() { reads.scrollHeight += 1; return 1000; },
    get clientHeight() { reads.clientHeight += 1; return 400; },
  });
  presentation.onScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

  assert.equal(contentRenders, 0);
  assert.deepEqual(reads, { scrollTop: 1, scrollHeight: 1, clientHeight: 1 });
  assert.deepEqual(viewportRenders, [
    { followChat: true, viewport: { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 } },
    { followChat: false, viewport: { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 } },
  ]);

  presentation.onScroll({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(viewportRenders.length, 2);
});

test("stream presentation buffers text fragments until a snapshot is requested", () => {
  const presentation = createStreamPresentation(createMemoryStreamPresentationAdapter());
  const fragments = Array.from({ length: 10_000 }, (_, index) => String(index % 10));

  for (const fragment of fragments) presentation.handle({ type: "text-delta", delta: fragment });

  assert.equal(presentation.snapshot().pendingStream[0].text, fragments.join(""));
});

test("stream presentation ignores empty deltas after a segment is established", () => {
  const presentation = createStreamPresentation(createMemoryStreamPresentationAdapter());
  presentation.handle({ type: "text-delta", delta: "answer" });
  const revision = presentation.snapshot().contentRevision;
  assert.equal(presentation.handle({ type: "text-delta", delta: "" }), false);
  assert.equal(presentation.handle({ type: "reasoning-delta", delta: "" }), false);
  assert.equal(presentation.handle({ type: "tool-call-delta", delta: { index: 0 } }), true);
  const toolRevision = presentation.snapshot().contentRevision;
  assert.equal(presentation.handle({ type: "tool-call-delta", delta: { index: 0, arguments: "" } }), false);
  assert.equal(revision + 1, toolRevision);
});

test("stream presentation buffers large tool arguments until a snapshot is requested", () => {
  const presentation = createStreamPresentation(createMemoryStreamPresentationAdapter());
  const fragments = Array.from({ length: 10_000 }, (_, index) => String(index % 10));

  presentation.handle({ type: "tool-call-delta", delta: { index: 0, id: "large", name: "runtime_" } });
  presentation.handle({ type: "tool-call-delta", delta: { index: 0, name: "javascript" } });
  for (const fragment of fragments) presentation.handle({ type: "tool-call-delta", delta: { index: 0, arguments: fragment } });

  const snapshot = presentation.snapshot();
  assert.equal(snapshot.pendingToolCalls[0].name, "runtime_javascript");
  assert.equal(snapshot.pendingToolCalls[0].arguments, fragments.join(""));
  assert.equal(snapshot.liveToolEntries[0].status, "preparing");
  assert.equal(snapshot.liveToolEntries[0].delta.arguments, fragments.join(""));
  assert.equal(snapshot.pendingToolCalls[0], snapshot.liveToolEntries[0].delta);
  assert.equal(Object.isFrozen(snapshot.pendingToolCalls[0]), true);
});

test("stream presentation keeps many interleaved tool fragments isolated", () => {
  const presentation = createStreamPresentation(createMemoryStreamPresentationAdapter());
  const toolCount = 100;
  const fragmentCount = 100;

  for (let index = 0; index < toolCount; index += 1) {
    presentation.handle({ type: "tool-call-delta", delta: { index, id: `call-${index}`, name: `tool_${index}`, arguments: "" } });
  }
  for (let fragment = 0; fragment < fragmentCount; fragment += 1) {
    for (let index = 0; index < toolCount; index += 1) {
      presentation.handle({ type: "tool-call-delta", delta: { index, arguments: String(index % 10) } });
    }
  }

  const snapshot = presentation.snapshot();
  assert.equal(snapshot.pendingToolCalls.length, toolCount);
  assert.equal(snapshot.liveToolEntries.length, toolCount);
  assert.equal(snapshot.pendingStream[0].kind, "tools");
  assert.equal(new Set(snapshot.pendingStream[0].toolKeys).size, toolCount);
  assert.equal(snapshot.pendingToolCalls[42].arguments, "2".repeat(fragmentCount));
});

test("stream presentation removes an empty thinking placeholder when real output starts", () => {
  const text = createStreamPresentation(createMemoryStreamPresentationAdapter());
  text.handle({ type: "model-started", turn: 1 });
  assert.deepEqual(text.snapshot().pendingStream.map((segment) => segment.kind), ["thinking"]);
  text.handle({ type: "text-delta", delta: "answer" });
  assert.deepEqual(text.snapshot().pendingStream.map((segment) => segment.kind), ["text"]);

  const tool = createStreamPresentation(createMemoryStreamPresentationAdapter());
  tool.handle({ type: "model-started", turn: 1 });
  tool.handle({ type: "tool-call-delta", delta: { index: 0, id: "one", name: "search", arguments: "{}" } });
  assert.deepEqual(tool.snapshot().pendingStream.map((segment) => segment.kind), ["tools"]);
});

test("viewport changes reuse the frozen stream content snapshot", () => {
  const presentation = createStreamPresentation(createMemoryStreamPresentationAdapter());
  presentation.handle({ type: "text-delta", delta: "answer" });
  const beforeScroll = presentation.snapshot();

  presentation.onScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  const afterScroll = presentation.snapshot();
  assert.equal(afterScroll.contentRevision, beforeScroll.contentRevision);
  assert.equal(afterScroll.pendingStream, beforeScroll.pendingStream);
  assert.equal(afterScroll.pendingToolCalls, beforeScroll.pendingToolCalls);
  assert.equal(afterScroll.liveToolEntries, beforeScroll.liveToolEntries);

  presentation.handle({ type: "text-delta", delta: " more" });
  const afterDelta = presentation.snapshot();
  assert.ok(afterDelta.contentRevision > afterScroll.contentRevision);
  assert.notEqual(afterDelta.pendingStream, afterScroll.pendingStream);
});

test("the DOM adapter skips redundant followed-scroll writes", async () => {
  const access = { scrollTop: 0, scrollHeight: 0, clientHeight: 0, writes: 0 };
  let scrollTop = 0;
  const chat = {
    get scrollTop() { access.scrollTop += 1; return scrollTop; },
    set scrollTop(value) { access.writes += 1; scrollTop = value; },
    get scrollHeight() { access.scrollHeight += 1; return 1000; },
    get clientHeight() { access.clientHeight += 1; return 400; },
  };
  const adapter = createDomStreamPresentationAdapter({
    conversation: { querySelectorAll: () => [], children: [], append: () => {} },
    chat,
    scrollButton: { hidden: false },
    hasCommittedMessages: () => true,
    onProgrammaticScroll: () => {},
  });

  adapter.render({ pendingToolCalls: [], liveToolEntries: [], pendingStream: [], contentRevision: 0, followChat: true, showScrollButton: false, scrollToLatest: false });
  adapter.render({ pendingToolCalls: [], liveToolEntries: [], pendingStream: [], contentRevision: 0, followChat: true, showScrollButton: false, scrollToLatest: false });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(scrollTop, 600);
  assert.deepEqual(access, { scrollTop: 2, scrollHeight: 2, clientHeight: 2, writes: 1 });
});
