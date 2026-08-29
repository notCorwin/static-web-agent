import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageRuntime, HarnessError } from "../dist/index.js";

test("the page runtime evaluates code and serializes values and logs", async () => {
  const runtime = new BrowserPageRuntime();
  const result = await runtime.execute("console.info('value', input.value); return { answer: input.value * 2 }", { value: 21 });
  assert.deepEqual(result.value, { answer: 42 });
  assert.deepEqual(result.logs, ["value 21"]);
  assert.equal(typeof result.durationMs, "number");
});

test("repeated page references are not mistaken for cycles", async () => {
  const result = await new BrowserPageRuntime().execute("const shared = { answer: 42 }; return { first: shared, second: shared };", null);
  assert.deepEqual(result.value, { first: { answer: 42 }, second: { answer: 42 } });
});

test("empty page code is rejected at the boundary", async () => {
  await assert.rejects(new BrowserPageRuntime().execute("  ", null), (error) => error instanceof HarnessError && error.code === "INVALID_PAGE_RUNTIME_INPUT");
});

test("page runtime preserves an abort reason", async () => {
  const reason = new HarnessError("MODEL_REPLACED", "connection changed");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(new BrowserPageRuntime().execute("return 1", null, { signal: controller.signal }), (error) => error === reason);
});
