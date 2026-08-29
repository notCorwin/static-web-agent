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

export function isAbortError(value: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}

function safeDetails(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}

export function errorInfo(value: unknown, fallbackCode = "INTERNAL_ERROR"): ToolError {
  if (value instanceof HarnessError) {
    const result: ToolError = { code: value.code, message: value.message };
    const details = safeDetails(value.details);
    return details === undefined ? result : { ...result, details };
  }
  if (isAbortError(value)) return { code: "ABORTED", message: "Operation cancelled." };
  if (value instanceof Error) return { code: fallbackCode, message: value.message || "Operation failed." };
  return { code: fallbackCode, message: "Operation failed." };
}

export function jsonError(error: ToolError): JsonValue {
  const details = safeDetails(error.details);
  return {
    code: error.code,
    message: error.message,
    ...(details === undefined ? {} : { details }),
  };
}
