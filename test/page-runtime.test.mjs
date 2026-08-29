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

test("page runtime snapshots logs when execution completes", async () => {
  const result = await new BrowserPageRuntime().execute("setTimeout(() => console.log('late'), 0); return 1", null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(result.logs, []);
});

test("page runtime contains object serialization failures", async () => {
  const result = await new BrowserPageRuntime().execute("const unreadable = new Proxy({}, { ownKeys() { throw new Error('blocked') } }); console.log(unreadable); return unreadable", null);
  assert.equal(result.value, "[Unserializable]");
  assert.deepEqual(result.logs, ["[Unserializable]"]);
});

test("page runtime contains hostile Error serialization", async () => {
  const result = await new BrowserPageRuntime().execute("const error = new Error('bad'); Object.defineProperty(error, 'message', { get() { throw new Error('blocked'); } }); console.log(error); return error", null);
  assert.equal(result.value, "[Unserializable]");
  assert.deepEqual(result.logs, ["[Unserializable]"]);
});

test("page runtime contains hostile thrown errors", async () => {
  await assert.rejects(
    new BrowserPageRuntime().execute("const error = new Error('bad'); Object.defineProperty(error, 'message', { get() { throw new Error('blocked'); } }); throw error", null),
    (error) => error instanceof HarnessError && error.code === "PAGE_RUNTIME_EXECUTION_ERROR" && error.message === "Page JavaScript execution failed.",
  );
});

test("page runtime contains hostile error prototypes", async () => {
  await assert.rejects(
    new BrowserPageRuntime().execute("const source = new Error('bad'); const error = new Proxy(source, { getPrototypeOf() { throw new Error('blocked prototype'); } }); throw error", null),
    (error) => error instanceof HarnessError && error.code === "PAGE_RUNTIME_EXECUTION_ERROR" && error.message === "Page JavaScript execution failed.",
  );
});

test("repeated page references are not mistaken for cycles", async () => {
  const result = await new BrowserPageRuntime().execute("const shared = { answer: 42 }; return { first: shared, second: shared };", null);
  assert.deepEqual(result.value, { first: { answer: 42 }, second: { answer: 42 } });
});

test("page runtime preserves prototype-named JSON keys safely", async () => {
  const result = await new BrowserPageRuntime().execute("return JSON.parse('{\"__proto__\":{\"polluted\":true},\"constructor\":2}')", null);
  const expected = JSON.parse('{"__proto__":{"polluted":true},"constructor":2}');
  assert.deepEqual(result.value, expected);
  assert.equal(isJsonValue(result.value), true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(({}).polluted, undefined);
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

test("JSON validation rejects array extras and custom JSON hooks", () => {
  const extra = [1];
  extra.meta = true;
  const hiddenIndex = [];
  Object.defineProperty(hiddenIndex, "0", { value: 1, writable: true, configurable: true });
  const arrayHook = [1];
  Object.defineProperty(arrayHook, "toJSON", { value: () => ({ leaked: true }) });
  const objectHook = { answer: 1 };
  Object.defineProperty(objectHook, "toJSON", { value: () => ({ leaked: true }) });
  const objectGetter = {};
  Object.defineProperty(objectGetter, "answer", { enumerable: true, get: () => 1 });
  const arrayGetter = [];
  Object.defineProperty(arrayGetter, "0", { enumerable: true, get: () => 1 });
  assert.equal(isJsonValue(extra), false);
  assert.equal(isJsonValue(hiddenIndex), false);
  assert.equal(isJsonValue(arrayHook), false);
  assert.equal(isJsonValue(objectHook), false);
  assert.equal(isJsonValue(objectGetter), false);
  assert.equal(isJsonValue(arrayGetter), false);
  assert.equal(validate({ type: "array", items: { type: "number" } }, extra).valid, false);
  assert.equal(validate({ type: "object" }, objectHook).valid, false);
  assert.equal(validate({ type: "object" }, objectGetter).valid, false);
});

test("JSON validation treats prototype-named keys as data", () => {
  const value = JSON.parse('{"__proto__":{"ok":true}}');
  assert.equal(isJsonValue(value), true);
  assert.equal(validate({ type: "object", additionalProperties: false }, value).valid, false);
  assert.equal(validate({ type: "object", properties: JSON.parse('{"__proto__":{"type":"object"}}') }, value).valid, true);
});

test("JSON schema equality distinguishes arrays and handles cycles", () => {
  assert.equal(validate({ enum: [[1]] }, { 0: 1 }).valid, false);
  assert.equal(validate({ enum: [{ 0: 1 }] }, [1]).valid, false);
  assert.equal(validate({ enum: [[1]] }, [1]).valid, true);
  assert.equal(validate({ const: 0 }, -0).valid, true);
  assert.equal(validate({ enum: [-0] }, 0).valid, true);
  const left = {};
  left.self = left;
  const right = {};
  right.self = right;
  assert.equal(validate({ const: left }, right).valid, false);
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

test("page runtime contains hostile abort reasons", async () => {
  const source = new Error("cancel");
  const reason = new Proxy(source, { getPrototypeOf() { throw new Error("blocked prototype"); } });
  const controller = new AbortController();
  const running = new BrowserPageRuntime().execute("await new Promise(() => {}); return 1", null, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(running, (error) => error instanceof Error && error.name === "AbortError");
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
