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

test("empty page code is rejected at the boundary", async () => {
  await assert.rejects(new BrowserPageRuntime().execute("  ", null), (error) => error instanceof HarnessError && error.code === "INVALID_PAGE_RUNTIME_INPUT");
});
