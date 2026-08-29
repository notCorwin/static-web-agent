import type { JsonValue, ToolError } from "./types.js";
import { isJsonValue } from "./schema.js";

export class HarnessError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class ModelAdapterError extends HarnessError {
  constructor(message: string, details?: JsonValue, code = "MODEL_ERROR") {
    super(code, message, details);
    this.name = "ModelAdapterError";
  }
}

function safeErrorMessage(value: unknown, fallback = "Operation failed."): string {
  try {
    const message = value instanceof Error ? value.message : undefined;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

export function isAbortError(value: unknown): boolean {
  try {
    return (
      (typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "AbortError") ||
      (value instanceof Error && value.name === "AbortError")
    );
  } catch {
    return false;
  }
}

function safeDetails(value: unknown): JsonValue | undefined {
  if (!isJsonValue(value)) return undefined;
  try {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

export function errorInfo(value: unknown, fallbackCode = "INTERNAL_ERROR"): ToolError {
  const code = typeof fallbackCode === "string" && fallbackCode.length > 0 ? fallbackCode : "INTERNAL_ERROR";
  try {
    if (value instanceof HarnessError) {
      const ownCode = typeof value.code === "string" && value.code.length > 0 ? value.code : code;
      const result: ToolError = { code: ownCode, message: safeErrorMessage(value) };
      const details = safeDetails(value.details);
      return details === undefined ? result : { ...result, details };
    }
    if (isAbortError(value)) return { code: "ABORTED", message: "Operation cancelled." };
    if (value instanceof Error) return { code, message: safeErrorMessage(value) };
  } catch {
    // Error objects are external input; unreadable properties must not escape the run.
  }
  return { code, message: "Operation failed." };
}

export function jsonError(error: ToolError): JsonValue {
  const details = safeDetails(error.details);
  return {
    code: error.code,
    message: error.message,
    ...(details === undefined ? {} : { details }),
  };
}
