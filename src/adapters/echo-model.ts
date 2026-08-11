import type { ModelAdapter, ModelEvent, ModelRequest, UserMessage } from "../core/types.js";

export class EchoModelAdapter implements ModelAdapter {
  readonly id = "echo";

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal.aborted) {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      throw error;
    }
    const lastUser = [...request.messages].reverse().find((message): message is UserMessage => message.role === "user");
    const content = lastUser === undefined
      ? "This is the local demo model. Add a message to begin."
      : `Local demo response\n\n${lastUser.content}`;
    for (let index = 0; index < content.length; index += 32) {
      if (request.signal.aborted) {
        const error = new Error("Operation cancelled.");
        error.name = "AbortError";
        throw error;
      }
      const delta = content.slice(index, index + 32);
      yield { type: "text-delta", delta };
      await Promise.resolve();
    }
    yield { type: "completed", message: { role: "assistant", content } };
  }
}