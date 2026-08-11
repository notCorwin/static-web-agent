import type { ModelAdapter, ModelEvent, ModelRequest } from "../core/types.js";

function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function calculate(source: string): number {
  const tokens = source.replace(/\s+/g, "").match(/(?:\d+(?:\.\d+)?|[()+\-*/])/g);
  if (tokens === null || tokens.join("") !== source.replace(/\s+/g, "") || tokens.length === 0) throw new Error("Use numbers, parentheses, and + - * / operators.");
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = (): number => {
    const token = take();
    if (token === "(") {
      const value = expression();
      if (take() !== ")") throw new Error("Missing closing parenthesis.");
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("Expected a number.");
    return value;
  };
  const unary = (): number => {
    if (peek() === "+") {
      take();
      return unary();
    }
    if (peek() === "-") {
      take();
      return -unary();
    }
    return primary();
  };
  const term = (): number => {
    let value = unary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = unary();
      if (operator === "/" && right === 0) throw new Error("Cannot divide by zero.");
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  function expression(): number {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = term();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  const value = expression();
  if (index !== tokens.length || !Number.isFinite(value)) throw new Error("Invalid expression.");
  return value;
}

function localResponse(prompt: string, request: ModelRequest): string {
  const text = prompt.trim();
  if (/^(?:\/?help|what can you do)\??$/i.test(text)) {
    return [
      "This is the offline assistant. It can work without sending your text anywhere.",
      "",
      "• /calc 2 * (3 + 4) — calculate an expression",
      "• /time — show the current local time",
      "• /tools — list enabled tools",
      "• Connect a model above for open-ended answers and tool planning.",
    ].join("\n");
  }
  if (/^\/?time$/i.test(text)) return `Your local time is ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date())}.`;
  if (/^\/?tools$/i.test(text)) {
    const names = request.tools.map((tool) => tool.name);
    return names.length === 0 ? "No tools are enabled. Enable a plugin in the Runtime surface." : `Enabled tools:\n${names.map((name) => `• ${name}`).join("\n")}`;
  }
  const expression = text.match(/^\/?(?:calc|calculate)\s+(.+)$/i)?.[1] ?? (/^[\d\s()+\-*/.]+$/.test(text) ? text : undefined);
  if (expression !== undefined) {
    try {
      return `Result: ${calculate(expression)}`;
    } catch (error) {
      return `I could not calculate that: ${error instanceof Error ? error.message : "invalid expression"}`;
    }
  }
  return [
    "The offline assistant is ready for local commands, but it is not a general language model.",
    "",
    "Try /help, /calc, /time, or /tools. Connect an OpenAI-compatible model when you need open-ended reasoning.",
  ].join("\n");
}

export class LocalModelAdapter implements ModelAdapter {
  readonly id = "local";

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal.aborted) throw abortError();
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const content = localResponse(lastUser?.content ?? "", request);
    for (let index = 0; index < content.length; index += 48) {
      if (request.signal.aborted) throw abortError();
      yield { type: "text-delta", delta: content.slice(index, index + 48) };
      await Promise.resolve();
    }
    yield { type: "completed", message: { role: "assistant", content } };
  }
}
