/** Values crossing the model/page boundary must be JSON values. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonSchemaType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

/** The small JSON Schema subset needed for the single Meta Tool contract. */
export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
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

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export type ToolExecutionResult =
  | { readonly ok: true; readonly value: JsonValue; readonly durationMs: number }
  | { readonly ok: false; readonly error: ToolError; readonly durationMs: number };

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
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

export interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
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
  readonly durationMs?: number;
}

export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescriptor[];
  readonly signal: AbortSignal;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call-delta"; readonly delta: ToolCallDelta }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "completed"; readonly message: AssistantMessage; readonly usage?: ModelUsage };

/** Provider adapters normalize their transport into this one stream contract. */
export interface ModelAdapter {
  readonly id: string;
  readonly stream: (request: ModelRequest) => AsyncIterable<ModelEvent>;
}

export interface PageExecutionResult {
  readonly value: JsonValue;
  readonly logs: readonly string[];
  readonly durationMs: number;
}

/** Runs code in the current page realm. It is intentionally not a sandbox. */
export interface PageRuntime {
  readonly execute: (
    code: string,
    input: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PageExecutionResult>;
}

export interface AgentRunRequest {
  readonly messages: readonly ModelMessage[];
  readonly signal?: AbortSignal;
  /** Optional host quota. The core and reference UI set no default. */
  readonly maxTurns?: number;
  readonly modelTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { readonly type: "run-started"; readonly runId: string }
  | { readonly type: "model-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call-delta"; readonly delta: ToolCallDelta }
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
  /** Output received before cooperative cancellation or transport failure. */
  readonly partial?: AssistantMessage;
  readonly turns: number;
  readonly usage?: ModelUsage;
  readonly error?: ToolError;
}
