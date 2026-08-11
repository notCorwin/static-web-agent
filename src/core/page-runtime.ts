import { KernelError } from "./errors.js";
import type { JsonValue, JavaScriptRuntimeResult, PageRuntime } from "./types.js";

const MAX_PAGE_CODE_CHARS = 100_000;
const MAX_PAGE_OUTPUT_CHARS = 64_000;

type PageConsole = Record<string, (...values: readonly unknown[]) => void>;

function serialize(value: unknown, seen = new WeakSet<object>(), depth = 0): JsonValue {
  if (depth > 12) return "[Max depth]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (typeof Node !== "undefined" && value instanceof Node) {
    return {
      type: value.constructor.name,
      nodeName: value.nodeName,
      ...(value instanceof Element && value.id ? { id: value.id } : {}),
      textContent: value.textContent ?? "",
    };
  }
  if (typeof URL !== "undefined" && value instanceof URL) return value.toString();
  if (typeof Response !== "undefined" && value instanceof Response) {
    return { type: "Response", url: value.url, status: value.status, ok: value.ok, redirected: value.redirected };
  }
  if (typeof Headers !== "undefined" && value instanceof Headers) return Object.fromEntries(value.entries());
  if (typeof Map !== "undefined" && value instanceof Map) {
    return { type: "Map", entries: [...value.entries()].map(([key, entry]) => [serialize(key, seen, depth + 1), serialize(entry, seen, depth + 1)]) };
  }
  if (typeof Set !== "undefined" && value instanceof Set) return { type: "Set", values: [...value].map((entry) => serialize(entry, seen, depth + 1)) };
  if (Array.isArray(value)) return value.map((entry) => serialize(entry, seen, depth + 1));

  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    try {
      output[key] = serialize((value as Record<string, unknown>)[key], seen, depth + 1);
    } catch {
      output[key] = "[Unreadable]";
    }
  }
  return output;
}

function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function serializedSize(value: JsonValue): number {
  return (JSON.stringify(value) ?? "").length;
}

export class BrowserPageRuntime implements PageRuntime {
  async execute(code: string, input: JsonValue, options: { readonly signal?: AbortSignal } = {}): Promise<JavaScriptRuntimeResult> {
    const source = code.trim();
    if (!source) throw new KernelError("INVALID_PAGE_RUNTIME_INPUT", "Page JavaScript code cannot be empty.");
    if (source.length > MAX_PAGE_CODE_CHARS) throw new KernelError("INVALID_PAGE_RUNTIME_INPUT", "Page JavaScript is limited to 100,000 characters.");
    if (options.signal?.aborted) throw abortError();

    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    const logs: string[] = [];
    let logChars = 0;
    const pageConsole: PageConsole = {};
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      pageConsole[method] = (...values) => {
        if (logs.length >= 100 || logChars >= 16_000) return;
        const line = values.map((value) => serialize(value)).join(" ").slice(0, 2_000);
        logs.push(line);
        logChars += line.length;
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
      throw new KernelError("INVALID_PAGE_RUNTIME_INPUT", error instanceof Error ? error.message : "Page JavaScript could not be compiled.");
    }

    const signal = options.signal ?? new AbortController().signal;
    return new Promise<JavaScriptRuntimeResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then(() => execute(input, pageConsole, signal))
        .then((value) => {
          if (settled) return;
          const serialized = serialize(value);
          if (serializedSize(serialized) > MAX_PAGE_OUTPUT_CHARS) throw new KernelError("PAGE_RUNTIME_OUTPUT_TOO_LARGE", "Page runtime output exceeds the 64,000-character limit.");
          settled = true;
          cleanup();
          resolve({ value: serialized, logs, durationMs: Math.round((typeof performance === "undefined" ? Date.now() : performance.now()) - started) });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof KernelError ? error : new KernelError("PAGE_RUNTIME_EXECUTION_ERROR", error instanceof Error ? error.message : "Page JavaScript execution failed."));
        });
    });
  }
}
