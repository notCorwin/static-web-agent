import type { JsonValue, ToolError } from "./types.js";

export class KernelError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class PermissionDeniedError extends KernelError {
  constructor(pluginId: string, capability: string, reason?: string) {
    super(
      "CAPABILITY_DENIED",
      `Plugin “${pluginId}” is not authorized to use the “${capability}” capability${reason ? `: ${reason}` : "."}`,
      { pluginId, capability },
    );
    this.name = "PermissionDeniedError";
  }
}

export class PluginError extends KernelError {
  constructor(code: string, message: string, details?: JsonValue) {
    super(code, message, details);
    this.name = "PluginError";
  }
}

export class ModelAdapterError extends KernelError {
  constructor(message: string, details?: JsonValue) {
    super("MODEL_ERROR", message, details);
    this.name = "ModelAdapterError";
  }
}

export function isAbortError(value: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}

export function errorInfo(value: unknown, fallbackCode = "INTERNAL_ERROR"): ToolError {
  if (value instanceof KernelError) {
    const result: ToolError = { code: value.code, message: value.message };
    return value.details === undefined ? result : { ...result, details: value.details };
  }

  if (isAbortError(value)) return { code: "ABORTED", message: "Operation cancelled." };
  if (value instanceof Error) return { code: fallbackCode, message: value.message || "Operation failed." };
  return { code: fallbackCode, message: "Operation failed." };
}

export function toError(value: unknown, fallbackMessage = "Operation failed."): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(fallbackMessage);
}

export function jsonError(error: ToolError): JsonValue {
  const result: Record<string, JsonValue> = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) result.details = error.details;
  return result;
}