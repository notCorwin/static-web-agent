import { HarnessError } from "./errors.js";
import type { JsonValue, PageExecutionResult, PageRuntime } from "./types.js";

type PageConsole = Record<string, (...values: readonly unknown[]) => void>;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function safeErrorMessage(value: unknown, fallback: string): string {
  try {
    const message = value instanceof Error ? value.message : undefined;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

function isHarnessError(value: unknown): value is HarnessError {
  try {
    return value instanceof HarnessError;
  } catch {
    return false;
  }
}

function serialize(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Error) return { name: serialize(value.name, seen), message: serialize(value.message, seen) };
    if (typeof Node !== "undefined" && value instanceof Node) {
      return {
        type: value.constructor.name,
        nodeName: value.nodeName,
        ...(value instanceof Element && value.id ? { id: value.id } : {}),
        textContent: value.textContent ?? "",
      };
    }
    if (typeof URL !== "undefined" && value instanceof URL) return value.toString();
    if (typeof Date !== "undefined" && value instanceof Date) return Date.prototype.toJSON.call(value);
    if (typeof RegExp !== "undefined" && value instanceof RegExp) return RegExp.prototype.toString.call(value);
    if (typeof Response !== "undefined" && value instanceof Response) {
      return { type: "Response", url: value.url, status: value.status, ok: value.ok, redirected: value.redirected };
    }
    if (typeof Headers !== "undefined" && value instanceof Headers) return Object.fromEntries(value.entries());
    if (typeof Map !== "undefined" && value instanceof Map) {
      return { type: "Map", entries: [...value.entries()].map(([key, entry]) => [serialize(key, seen), serialize(entry, seen)]) };
    }
    if (typeof Set !== "undefined" && value instanceof Set) return { type: "Set", values: [...value].map((entry) => serialize(entry, seen)) };
    if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => serialize(value[index], seen));

    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      let serialized: JsonValue = "[Unreadable]";
      try {
        serialized = serialize((value as Record<string, unknown>)[key], seen);
      } catch {
      }
      Object.defineProperty(output, key, { value: serialized, enumerable: true, writable: true, configurable: true });
    }
    return output;
  } catch {
    return "[Unserializable]";
  } finally {
    seen.delete(value);
  }
}

function abortError(signal?: AbortSignal): Error {
  try {
    if (signal?.reason instanceof Error) return signal.reason;
  } catch {
  }
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    signal.removeEventListener("abort", listener);
  } catch {
    // Cleanup cannot change the operation result.
  }
}

export class BrowserPageRuntime implements PageRuntime {
  async execute(code: string, input: JsonValue, options: { readonly signal?: AbortSignal } = {}): Promise<PageExecutionResult> {
    const source = code.trim();
    if (!source) throw new HarnessError("INVALID_PAGE_RUNTIME_INPUT", "Page JavaScript code cannot be empty.");
    if (options.signal?.aborted) throw abortError(options.signal);

    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    const logs: string[] = [];
    const pageConsole: PageConsole = {};
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      pageConsole[method] = (...values) => {
        const line = values.map((value) => {
          const serialized = serialize(value);
          return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
        }).join(" ");
        logs.push(line);
      };
    }

    let execute: (value: JsonValue, consoleProxy: PageConsole, signal: AbortSignal) => Promise<unknown>;
    try {
      execute = new Function(
        "input",
        "console",
        "signal",
        `"use strict"; return (async () => {\n${source}\n})()`,
      ) as typeof execute;
    } catch (error) {
      throw new HarnessError("INVALID_PAGE_RUNTIME_INPUT", safeErrorMessage(error, "Page JavaScript could not be compiled."));
    }

    const signal = options.signal ?? NEVER_ABORTED_SIGNAL;
    return new Promise<PageExecutionResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => removeAbortListener(signal, onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void Promise.resolve()
        .then(() => settled ? undefined : execute(input, pageConsole, signal))
        .then((value) => {
          if (settled) return;
          const serialized = serialize(value);
          settled = true;
          cleanup();
          resolve({ value: serialized, logs: [...logs], durationMs: Math.round((typeof performance === "undefined" ? Date.now() : performance.now()) - started) });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(isHarnessError(error) ? error : new HarnessError("PAGE_RUNTIME_EXECUTION_ERROR", safeErrorMessage(error, "Page JavaScript execution failed.")));
        });
    });
  }
}
