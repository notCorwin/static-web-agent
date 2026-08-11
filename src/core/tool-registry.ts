import { CapabilityManager } from "./capabilities.js";
import { errorInfo } from "./errors.js";
import { formatIssues, isJsonValue, validate } from "./schema.js";
import type {
  JsonSchema,
  JsonValue,
  ToolDefinition,
  ToolDescriptor,
  ToolError,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "./types.js";

const CORE_PLUGIN_ID = "core";
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function issuesAsJson(issues: readonly { readonly path: string; readonly message: string }[]): JsonValue {
  return issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function failure(code: string, message: string, details?: JsonValue): ToolExecutionResult {
  const error: ToolError = details === undefined ? { code, message } : { code, message, details };
  return { ok: false, error };
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  if (typeof structuredClone === "function") return structuredClone(schema);
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition & { readonly pluginId: string; readonly requiredCapabilities: readonly string[] }>();
  private readonly capabilities: CapabilityManager;

  constructor(capabilities: CapabilityManager) {
    this.capabilities = capabilities;
  }

  register(tool: ToolDefinition, owner = tool.pluginId ?? CORE_PLUGIN_ID): () => void {
    const name = tool.name.trim();
    if (!TOOL_NAME.test(name)) {
      throw new Error(`Invalid tool name “${tool.name}”. Use lowercase letters, numbers, dots, hyphens, or underscores.`);
    }
    if (!tool.description.trim()) throw new Error(`Tool “${name}” must have a description.`);
    if (this.tools.has(name)) throw new Error(`Tool “${name}” is already registered.`);

    const requiredCapabilities = [...new Set((tool.requiredCapabilities ?? []).map((capability) => capability.trim()))];
    if (requiredCapabilities.some((capability) => capability.length === 0)) {
      throw new Error(`Tool “${name}” declares an empty capability name.`);
    }
    const registered = {
      ...tool,
      name,
      inputSchema: cloneSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneSchema(tool.outputSchema) }),
      pluginId: owner,
      requiredCapabilities: Object.freeze(requiredCapabilities),
    };
    this.tools.set(name, registered);
    return () => {
      if (this.tools.get(name) === registered) this.tools.delete(name);
    };
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterByPlugin(pluginId: string): void {
    for (const [name, tool] of this.tools) if (tool.pluginId === pluginId) this.tools.delete(name);
  }

  get(name: string): ToolDescriptor | undefined {
    const tool = this.tools.get(name);
    return tool === undefined ? undefined : this.descriptor(tool);
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name)).map((tool) => this.descriptor(tool));
  }

  async execute(name: string, input: unknown, request: ToolExecutionRequest = {}): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) return failure("TOOL_NOT_FOUND", `Tool “${name}” is not registered.`);

    const inputValidation = validate(tool.inputSchema, input);
    if (!inputValidation.valid) {
      return failure("INVALID_TOOL_INPUT", formatIssues(inputValidation.issues), issuesAsJson(inputValidation.issues));
    }

    const signal = request.signal ?? new AbortController().signal;
    try {
      if (signal.aborted) return failure("ABORTED", "Tool execution was cancelled.");
      const result = await tool.execute(input as JsonValue, {
        signal,
        pluginId: tool.pluginId,
        getCapability: async <T>(capability: string) => {
          if (!tool.requiredCapabilities.includes(capability)) {
            throw new Error(`Tool “${name}” did not declare the “${capability}” capability.`);
          }
          return this.capabilities.get<T>(tool.pluginId, capability, signal);
        },
      });
      if (!isJsonValue(result)) return failure("INVALID_TOOL_OUTPUT", "Tool output must be valid JSON.");
      if (tool.outputSchema !== undefined) {
        const outputValidation = validate(tool.outputSchema, result);
        if (!outputValidation.valid) {
          return failure("INVALID_TOOL_OUTPUT", formatIssues(outputValidation.issues), issuesAsJson(outputValidation.issues));
        }
      }
      return { ok: true, value: result };
    } catch (error) {
      const info = errorInfo(error, "TOOL_ERROR");
      return { ok: false, error: info };
    }
  }

  private descriptor(tool: ToolDefinition & { readonly pluginId: string; readonly requiredCapabilities: readonly string[] }): ToolDescriptor {
    const descriptor: ToolDescriptor = {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneSchema(tool.inputSchema),
      requiredCapabilities: [...tool.requiredCapabilities],
      ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneSchema(tool.outputSchema) }),
    };
    return descriptor;
  }
}