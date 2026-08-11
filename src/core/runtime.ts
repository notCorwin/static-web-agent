import { KernelError } from "./errors.js";
import { isJsonValue } from "./schema.js";
import type { JavaScriptRuntime, JavaScriptRuntimeResult, JsonValue } from "./types.js";

const WORKER_SOURCE = `
  const serialize = (value, seen = new WeakSet(), depth = 0) => {
    if (depth > 8) return "[Max depth]";
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "undefined") return null;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (Array.isArray(value)) return value.map((item) => serialize(item, seen, depth + 1));
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = serialize(item, seen, depth + 1);
      return output;
    }
    return String(value);
  };

  // A worker receives no capability objects. These common ambient APIs are also masked
  // where the browser permits it; this is a resource boundary, not a security boundary.
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "caches", "importScripts"]) {
    try { globalThis[name] = undefined; } catch (_) { /* read-only in some engines */ }
  }

  self.onmessage = async ({ data }) => {
    const logs = [];
    const consoleProxy = {};
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      consoleProxy[method] = (...values) => logs.push(values.map((value) => serialize(value)).join(" "));
    }
    try {
      const execute = new Function("input", "console", "\\\"use strict\\\"; return (async () => {\\n" + data.code + "\\n})()");
      const value = await execute(data.input, consoleProxy);
      self.postMessage({ ok: true, value: serialize(value), logs });
    } catch (error) {
      self.postMessage({ ok: false, error: serialize(error), logs });
    }
  };
`;

function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class BrowserWorkerRuntime implements JavaScriptRuntime {
  async execute(
    code: string,
    input: JsonValue,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<JavaScriptRuntimeResult> {
    const source = code.trim();
    if (!source) throw new KernelError("INVALID_RUNTIME_INPUT", "JavaScript code cannot be empty.");
    if (source.length > 100_000) throw new KernelError("INVALID_RUNTIME_INPUT", "JavaScript code is limited to 100,000 characters.");
    if (options.signal?.aborted) throw abortError();
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new KernelError("INVALID_RUNTIME_INPUT", "Runtime timeout must be positive.");

    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      throw new KernelError("RUNTIME_UNAVAILABLE", "This browser does not support worker-based JavaScript execution.");
    }

    const started = now();
    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw new KernelError("RUNTIME_UNAVAILABLE", error instanceof Error ? error.message : "Unable to create a runtime worker.");
    }
    const signal = options.signal;

    return new Promise<JavaScriptRuntimeResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (typeof data !== "object" || data === null) {
          cleanup();
          reject(new KernelError("RUNTIME_ERROR", "Runtime returned an invalid response."));
          return;
        }
        const record = data as Record<string, unknown>;
        const logs = Array.isArray(record.logs) ? record.logs.filter((value): value is string => typeof value === "string") : [];
        if (record.ok === true && isJsonValue(record.value)) {
          cleanup();
          resolve({ value: record.value, logs, durationMs: Math.round(now() - started) });
        } else {
          const errorRecord = typeof record.error === "object" && record.error !== null ? record.error as Record<string, unknown> : undefined;
          const message = typeof errorRecord?.message === "string" ? errorRecord.message : "Runtime execution failed.";
          cleanup();
          reject(new KernelError("RUNTIME_EXECUTION_ERROR", message));
        }
      };
      worker.onerror = () => {
        cleanup();
        reject(new KernelError("RUNTIME_WORKER_ERROR", "The runtime worker failed."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new KernelError("RUNTIME_TIMEOUT", `Runtime execution exceeded ${timeoutMs} ms.`));
      }, timeoutMs);
      try {
        worker.postMessage({ code: source, input });
      } catch (error) {
        cleanup();
        reject(new KernelError("RUNTIME_ERROR", error instanceof Error ? error.message : "Unable to start runtime execution."));
      }
    });
  }
}

export function createRuntimeCapability(runtime: JavaScriptRuntime): JavaScriptRuntime {
  return { execute: (code, input, options) => runtime.execute(code, input, options) };
}