import type { JsonSchema, JsonValue, ValidationIssue, ValidationResult } from "./types.js";

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  return Object.entries(value).every(([key, item]) => key !== "__proto__" && isJsonValue(item));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    const rightEntries = Object.entries(rightRecord);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(value, rightRecord[key]))
    );
  }
  return false;
}

function typeMatches(value: unknown, type: JsonSchema["type"]): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "null":
        return value === null;
      case "boolean":
        return typeof value === "boolean";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "string":
        return typeof value === "string";
      case "array":
        return Array.isArray(value);
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      default:
        return false;
    }
  });
}

function push(issues: ValidationIssue[], path: string, message: string, keyword?: string): void {
  const issue: ValidationIssue = { path, message };
  if (keyword !== undefined) issue.keyword = keyword;
  issues.push(issue);
}

function validateAt(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  if (!typeMatches(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    push(issues, path, `Expected ${expected ?? "a valid JSON value"}.`, "type");
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => sameJson(candidate, value))) {
    push(issues, path, "Value is not one of the allowed values.", "enum");
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    push(issues, path, "Value does not match the required constant.", "const");
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(issues, path, `Must contain at least ${schema.minLength} characters.`, "minLength");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(issues, path, `Must contain at most ${schema.maxLength} characters.`, "maxLength");
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) push(issues, path, "Value has an invalid format.", "pattern");
      } catch {
        push(issues, path, "Schema contains an invalid pattern.", "pattern");
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push(issues, path, `Must be at least ${schema.minimum}.`, "minimum");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push(issues, path, `Must be at most ${schema.maximum}.`, "maximum");
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(issues, path, `Must contain at least ${schema.minItems} items.`, "minItems");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(issues, path, `Must contain at most ${schema.maxItems} items.`, "maxItems");
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateAt(item, schema.items as JsonSchema, `${path}[${index}]`, issues));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        push(issues, `${path}.${required}`, "Property is required.", "required");
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const childPath = `${path}.${key}`;
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        validateAt(item, propertySchema, childPath, issues);
      } else if (schema.additionalProperties === false) {
        push(issues, childPath, "Additional properties are not allowed.", "additionalProperties");
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        validateAt(item, schema.additionalProperties, childPath, issues);
      }
    }
  }

  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some((candidate) => validate(candidate, value).valid);
    if (!matches) push(issues, path, "Value does not match any allowed schema.", "anyOf");
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => validate(candidate, value).valid).length;
    if (matches !== 1) push(issues, path, "Value must match exactly one allowed schema.", "oneOf");
  }
}

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isJsonValue(value)) {
    push(issues, "$", "Value must be valid JSON (no undefined, functions, symbols, or non-finite numbers).", "json");
    return { valid: false, issues };
  }
  validateAt(value, schema, "$", issues);
  return { valid: issues.length === 0, issues };
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join(" ");
}