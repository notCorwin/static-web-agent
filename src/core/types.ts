/** JSON values are the only values allowed across the model/tool boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonSchemaType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

/** A deliberately small, dependency-free JSON Schema subset for tool contracts. */
export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  keyword?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export type CapabilityName = string;

export interface CapabilityRequest {
  readonly name: CapabilityName;
  readonly reason: string;
  readonly optional?: boolean;
}

export interface CapabilityContext {
  readonly pluginId: string;
  readonly signal: AbortSignal;
}

export interface CapabilityProvider<T = unknown> {
  readonly provide: (context: CapabilityContext) => T | Promise<T>;
}

export interface CapabilityScope {
  readonly has: (name: CapabilityName) => boolean;
  readonly get: <T>(name: CapabilityName) => Promise<T>;
}

export interface PermissionPolicy {
  readonly decide: (request: CapabilityRequest & { readonly pluginId: string }) => boolean | Promise<boolean>;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly requiredCapabilities: readonly CapabilityName[];
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly getCapability: <T>(name: CapabilityName) => Promise<T>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly requiredCapabilities?: readonly CapabilityName[];
  readonly pluginId?: string;
  readonly execute: (input: JsonValue, context: ToolExecutionContext) => JsonValue | Promise<JsonValue>;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export type ToolExecutionResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: ToolError };

export interface ToolExecutionRequest {
  readonly signal?: AbortSignal;
}

export interface PluginManifest {
  readonly apiVersion: "1";
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions: readonly CapabilityRequest[];
}

export interface Logger {
  readonly debug: (...values: readonly unknown[]) => void;
  readonly info: (...values: readonly unknown[]) => void;
  readonly warn: (...values: readonly unknown[]) => void;
  readonly error: (...values: readonly unknown[]) => void;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: "tool";
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescriptor[];
  readonly signal: AbortSignal;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "completed"; readonly message: AssistantMessage; readonly usage?: ModelUsage };

export interface ModelAdapter {
  readonly id: string;
  readonly stream: (request: ModelRequest) => AsyncIterable<ModelEvent>;
}

export interface AgentLimits {
  readonly maxMessages: number;
  readonly maxMessageChars: number;
  readonly maxRequestChars: number;
  readonly maxToolOutputChars: number;
  readonly maxToolCallsPerTurn: number;
}

export interface AgentRunRequest {
  readonly messages: readonly ModelMessage[];
  readonly signal?: AbortSignal;
  readonly maxTurns?: number;
  readonly modelTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly limits?: Readonly<Partial<AgentLimits>>;
  readonly onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { readonly type: "run-started"; readonly runId: string }
  | { readonly type: "model-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "assistant-message"; readonly message: AssistantMessage }
  | { readonly type: "tool-started"; readonly call: ToolCall }
  | { readonly type: "tool-finished"; readonly call: ToolCall; readonly result: ToolExecutionResult }
  | { readonly type: "run-error"; readonly error: ToolError }
  | { readonly type: "run-finished"; readonly result: AgentRunResult };

export type AgentRunStatus = "completed" | "cancelled" | "max-turns" | "failed";

export interface AgentRunResult {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly messages: readonly ModelMessage[];
  readonly response?: AssistantMessage;
  readonly turns: number;
  readonly usage?: ModelUsage;
  readonly error?: ToolError;
}

export interface CapabilityContribution {
  readonly name: CapabilityName;
  readonly provider: CapabilityProvider;
}

export interface DataProcessor {
  readonly id: string;
  readonly description: string;
  readonly process: (value: JsonValue, signal: AbortSignal) => JsonValue | Promise<JsonValue>;
}

export interface UiContribution {
  readonly id: string;
  readonly mount: (container: HTMLElement) => void | (() => void);
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly capabilities: CapabilityScope;
  readonly registerTool: (tool: ToolDefinition) => () => void;
  readonly registerCapability: (contribution: CapabilityContribution) => () => void;
  readonly registerModelAdapter: (adapter: ModelAdapter) => () => void;
  readonly registerProcessor: (processor: DataProcessor) => () => void;
  readonly registerUi: (contribution: UiContribution) => () => void;
}

/** Plugins are trusted same-realm modules; permissions constrain kernel contributions, not their ambient JavaScript access. */
export interface Plugin {
  readonly manifest: PluginManifest;
  readonly setup: (context: PluginContext) => void | Promise<void>;
  readonly teardown?: (context: PluginContext) => void | Promise<void>;
}

export interface PluginHandle {
  readonly manifest: PluginManifest;
  readonly uninstall: () => Promise<void>;
}

export interface JavaScriptRuntimeResult {
  readonly value: JsonValue;
  readonly logs: readonly string[];
  readonly durationMs: number;
}

export interface JavaScriptRuntime {
  readonly execute: (
    code: string,
    input: JsonValue,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) => Promise<JavaScriptRuntimeResult>;
}

export interface StorageCapability {
  readonly get: (key: string) => Promise<JsonValue | undefined>;
  readonly set: (key: string, value: JsonValue) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly keys: () => Promise<readonly string[]>;
}

export type StateStoreKind = "memory" | "indexeddb";

export type StateChange =
  | { readonly type: "set"; readonly key: string; readonly value: JsonValue }
  | { readonly type: "remove"; readonly key: string };

export interface StateStore {
  readonly kind: StateStoreKind;
  readonly failureReason?: string | undefined;
  readonly get: <T extends JsonValue = JsonValue>(key: string) => Promise<T | undefined>;
  readonly set: (key: string, value: JsonValue) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly apply: (changes: readonly StateChange[]) => Promise<void>;
  readonly keys: () => Promise<readonly string[]>;
  readonly clear: () => Promise<void>;
}