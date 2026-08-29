import type { JsonSchema, JsonValue, ValidationIssue, ValidationResult } from "./types.js";

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, new WeakSet<object>());
}

function isJsonValueAt(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  try {
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValueAt(value[index], ancestors)) return false;
      }
      return true;
    }
    return Object.entries(value).every(([, item]) => isJsonValueAt(item, ancestors));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
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
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(value, candidate));
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return false;
  }
}

type PathSegment = string | number;

function push(issues: ValidationIssue[], path: readonly PathSegment[], message: string, keyword?: string): void {
  const issue: ValidationIssue = { path: `$${path.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("")}`, message };
  if (keyword !== undefined) issue.keyword = keyword;
  issues.push(issue);
}

function validateAt(value: unknown, schema: JsonSchema, path: PathSegment[], issues: ValidationIssue[]): boolean {
  const kind = typeof value;
  if (kind === "number" && !Number.isFinite(value)) return false;
  if (value !== null && kind !== "string" && kind !== "boolean" && kind !== "number" && kind !== "object") return false;
  if (kind === "object" && value !== null && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  if (!typeMatches(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    push(issues, path, `Expected ${expected ?? "a valid JSON value"}.`, "type");
    return isJsonValue(value);
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

  let json = true;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(issues, path, `Must contain at least ${schema.minItems} items.`, "minItems");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(issues, path, `Must contain at most ${schema.maxItems} items.`, "maxItems");
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        path.push(index);
        if (!validateAt(value[index], schema.items, path, issues)) json = false;
        path.pop();
      }
    } else if (!isJsonValue(value)) {
      json = false;
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        path.push(required);
        push(issues, path, "Property is required.", "required");
        path.pop();
      }
    }
    for (const [key, item] of Object.entries(record)) {
      path.push(key);
      const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (propertySchema !== undefined) {
        if (!validateAt(item, propertySchema, path, issues)) json = false;
      } else if (schema.additionalProperties === false) {
        push(issues, path, "Additional properties are not allowed.", "additionalProperties");
        if (!isJsonValue(item)) json = false;
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        if (!validateAt(item, schema.additionalProperties, path, issues)) json = false;
      } else if (!isJsonValue(item)) json = false;
      path.pop();
    }
  }

  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some((candidate) => validate(candidate, value).valid);
    if (!matches) push(issues, path, "Value does not match any allowed schema.", "anyOf");
  }
  if (schema.oneOf !== undefined) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      if (validate(candidate, value).valid && ++matches > 1) break;
    }
    if (matches !== 1) push(issues, path, "Value must match exactly one allowed schema.", "oneOf");
  }
  return json;
}

function invalidJsonResult(): ValidationResult {
  const issues: ValidationIssue[] = [];
  push(issues, [], "Value must be valid JSON (no undefined, functions, symbols, or non-finite numbers).", "json");
  return { valid: false, issues };
}

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  try {
    if (!validateAt(value, schema, [], issues)) return invalidJsonResult();
  } catch {
    return invalidJsonResult();
  }
  return { valid: issues.length === 0, issues };
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join(" ");
}
