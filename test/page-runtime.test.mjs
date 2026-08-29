import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageRuntime, HarnessError, isJsonValue, validate } from "../dist/index.js";

test("the page runtime evaluates code and serializes values and logs", async () => {
  const runtime = new BrowserPageRuntime();
  const result = await runtime.execute("console.info('value', input.value); return { answer: input.value * 2 }", { value: 21 });
  assert.deepEqual(result.value, { answer: 42 });
  assert.deepEqual(result.logs, ["value 21"]);
  assert.equal(typeof result.durationMs, "number");
});

test("page runtime keeps non-string console values readable", async () => {
  const result = await new BrowserPageRuntime().execute("console.log({ answer: 42 }, [1, 2], null); return 0", null);
  assert.deepEqual(result.logs, ['{"answer":42} [1,2] null']);
});

test("page runtime contains object serialization failures", async () => {
  const result = await new BrowserPageRuntime().execute("const unreadable = new Proxy({}, { ownKeys() { throw new Error('blocked') } }); console.log(unreadable); return unreadable", null);
  assert.equal(result.value, "[Unserializable]");
  assert.deepEqual(result.logs, ["[Unserializable]"]);
});

test("repeated page references are not mistaken for cycles", async () => {
  const result = await new BrowserPageRuntime().execute("const shared = { answer: 42 }; return { first: shared, second: shared };", null);
  assert.deepEqual(result.value, { first: { answer: 42 }, second: { answer: 42 } });
});

test("common built-in values keep a readable serialized form", async () => {
  const result = await new BrowserPageRuntime().execute("return { date: new Date(0), pattern: /agent/gi };", null);
  assert.deepEqual(result.value, { date: "1970-01-01T00:00:00.000Z", pattern: "/agent/gi" });
});

test("sparse arrays stay within the JSON boundary", async () => {
  const sparse = [];
  sparse.length = 1;
  assert.equal(isJsonValue(sparse), false);
  assert.equal(validate({ type: "array" }, sparse).valid, false);
  const result = await new BrowserPageRuntime().execute("return input", sparse);
  assert.deepEqual(result.value, [null]);
  assert.equal(Object.hasOwn(result.value, 0), true);
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

test("page runtime catches an abort between the initial check and listener registration", async () => {
  const reason = new HarnessError("MODEL_CLEARED", "connection cleared");
  let aborted = false;
  const input = { executed: false };
  const signal = {
    reason,
    get aborted() { return aborted; },
    addEventListener() { aborted = true; },
    removeEventListener() {},
  };
  await assert.rejects(new BrowserPageRuntime().execute("input.executed = true; return 1", input, { signal }), (error) => error === reason);
  assert.equal(input.executed, false);
});
