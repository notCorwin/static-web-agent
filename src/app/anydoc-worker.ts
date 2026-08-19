import init, { formatFromExtension, toMarkdownBytes } from "@firecrawl/anydoc-wasm";

interface AnydocRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
  readonly extension: string;
  readonly wasmUrl: string;
}

interface AnydocResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly markdown?: string;
  readonly code?: string;
  readonly message?: string;
}

const scope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<AnydocRequest>) => void) | null;
  postMessage: (message: AnydocResponse) => void;
};

let ready: Promise<unknown> | undefined;

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as Error & { readonly code?: unknown }).code ?? "")
    : "";
}

scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      ready ??= init(request.wasmUrl);
      await ready;
      const format = formatFromExtension(request.extension);
      if (format === undefined) {
        scope.postMessage({ id: request.id, ok: false, code: "unsupported" });
        return;
      }
      const markdown = toMarkdownBytes(new Uint8Array(request.bytes), format);
      scope.postMessage({ id: request.id, ok: true, markdown });
    } catch (error) {
      const code = errorCode(error);
      scope.postMessage({
        id: request.id,
        ok: false,
        code,
        message: error instanceof Error ? error.message : "Document conversion failed.",
      });
    }
  })();
};
