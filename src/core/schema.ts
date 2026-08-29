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
    if (hasJsonBoundaryProblem(value)) return false;
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

function hasJsonBoundaryProblem(value: object): boolean {
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || (!(Array.isArray(value) && key === "length") && descriptor.enumerable !== true)) return true;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return true;
    return typeof (value as { readonly toJSON?: unknown }).toJSON === "function"
      || (Array.isArray(value) && Object.keys(value).length !== value.length);
  } catch {
    return true;
  }
}

function sameJson(left: unknown, right: unknown, pairs = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right) || (typeof left === "number" && typeof right === "number" && left === right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left === "object" && typeof right === "object") {
    const matched = pairs.get(left);
    if (matched?.has(right)) return true;
    if (matched === undefined) pairs.set(left, new WeakSet([right]));
    else matched.add(right);
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index) || !sameJson(left[index], right[index], pairs)) return false;
      }
      return true;
    }
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    const rightEntries = Object.entries(rightRecord);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(value, rightRecord[key], pairs))
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

function schemaField<K extends keyof JsonSchema>(schema: JsonSchema, key: K): JsonSchema[K] | undefined {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
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
  const type = schemaField(schema, "type");
  if (!typeMatches(value, type)) {
    const expected = Array.isArray(type) ? type.join(" or ") : type;
    push(issues, path, `Expected ${expected ?? "a valid JSON value"}.`, "type");
    return isJsonValue(value);
  }

  const enumValues = schemaField(schema, "enum");
  if (enumValues !== undefined && !enumValues.some((candidate) => sameJson(candidate, value))) {
    push(issues, path, "Value is not one of the allowed values.", "enum");
  }
  const constant = schemaField(schema, "const");
  if (constant !== undefined && !sameJson(constant, value)) {
    push(issues, path, "Value does not match the required constant.", "const");
  }

  if (typeof value === "string") {
    const length = [...value].length;
    const minLength = schemaField(schema, "minLength");
    if (minLength !== undefined && length < minLength) {
      push(issues, path, `Must contain at least ${minLength} characters.`, "minLength");
    }
    const maxLength = schemaField(schema, "maxLength");
    if (maxLength !== undefined && length > maxLength) {
      push(issues, path, `Must contain at most ${maxLength} characters.`, "maxLength");
    }
    const pattern = schemaField(schema, "pattern");
    if (pattern !== undefined) {
      try {
        if (!new RegExp(pattern).test(value)) push(issues, path, "Value has an invalid format.", "pattern");
      } catch {
        push(issues, path, "Schema contains an invalid pattern.", "pattern");
      }
    }
  }

  if (typeof value === "number") {
    const minimum = schemaField(schema, "minimum");
    if (minimum !== undefined && value < minimum) {
      push(issues, path, `Must be at least ${minimum}.`, "minimum");
    }
    const maximum = schemaField(schema, "maximum");
    if (maximum !== undefined && value > maximum) {
      push(issues, path, `Must be at most ${maximum}.`, "maximum");
    }
  }

  let json = !(value !== null && typeof value === "object" && hasJsonBoundaryProblem(value));
  if (Array.isArray(value)) {
    const minItems = schemaField(schema, "minItems");
    if (minItems !== undefined && value.length < minItems) {
      push(issues, path, `Must contain at least ${minItems} items.`, "minItems");
    }
    const maxItems = schemaField(schema, "maxItems");
    if (maxItems !== undefined && value.length > maxItems) {
      push(issues, path, `Must contain at most ${maxItems} items.`, "maxItems");
    }
    const items = schemaField(schema, "items");
    if (items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        path.push(index);
        if (!validateAt(value[index], items, path, issues)) json = false;
        path.pop();
      }
    } else if (!isJsonValue(value)) {
      json = false;
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schemaField(schema, "properties") ?? {};
    const additionalProperties = schemaField(schema, "additionalProperties");
    for (const required of schemaField(schema, "required") ?? []) {
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
      } else if (additionalProperties === false) {
        push(issues, path, "Additional properties are not allowed.", "additionalProperties");
        if (!isJsonValue(item)) json = false;
      } else if (additionalProperties !== undefined && additionalProperties !== true) {
        if (!validateAt(item, additionalProperties, path, issues)) json = false;
      } else if (!isJsonValue(item)) json = false;
      path.pop();
    }
  }

  const anyOf = schemaField(schema, "anyOf");
  if (anyOf !== undefined) {
    const matches = anyOf.some((candidate) => validate(candidate, value).valid);
    if (!matches) push(issues, path, "Value does not match any allowed schema.", "anyOf");
  }
  const oneOf = schemaField(schema, "oneOf");
  if (oneOf !== undefined) {
    let matches = 0;
    for (const candidate of oneOf) {
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
