import type { ModelAttachment } from "../core/types.js";

export interface PendingAttachment {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface AttachmentProgress {
  readonly attachment: PendingAttachment;
  readonly phase: "reading" | "document" | "rendering" | "ocr" | "ready";
  readonly detail?: string;
}

export interface PreparedAttachments {
  readonly content: string;
  readonly attachments: readonly ModelAttachment[];
  readonly attachmentIds: readonly string[];
  readonly labels: readonly string[];
  readonly usedVision: boolean;
}

export interface RenderedPdfPage {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface OcrImageInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

export interface AttachmentProcessingDependencies {
  readonly documentToMarkdown?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly renderPdfPages?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => Promise<readonly RenderedPdfPage[]>;
  readonly streamPdfPages?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => AsyncIterable<RenderedPdfPage>;
  readonly recognizeImage?: (data: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<string>;
  readonly recognizeImages?: (inputs: readonly OcrImageInput[], signal: AbortSignal) => Promise<readonly string[]>;
}

export class AttachmentProcessingError extends Error {
  readonly code: "ATTACHMENT_UNSUPPORTED" | "ATTACHMENT_PARSE_FAILED" | "ATTACHMENT_CANCELLED";

  constructor(code: AttachmentProcessingError["code"], message: string) {
    super(message);
    this.name = "AttachmentProcessingError";
    this.code = code;
  }
}

let nextAttachmentId = 0;

function assetUrl(path: string): string {
  const url = new URL(path.replace(/^\//, ""), document.baseURI);
  const version = document.querySelector<HTMLMetaElement>('meta[name="build-version"]')?.content;
  if (version !== undefined && version.length > 0) url.searchParams.set("v", version);
  return url.toString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new AttachmentProcessingError("ATTACHMENT_CANCELLED", "Attachment processing was cancelled.");
}

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function mediaTypeFor(file: File): string {
  if (file.type.trim().length > 0) return file.type;
  const types: Readonly<Record<string, string>> = {
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    epub: "application/epub+zip",
    pdf: "application/pdf",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    txt: "text/plain",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[extension(file.name)] ?? "application/octet-stream";
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `attachment-${crypto.randomUUID()}`;
  nextAttachmentId += 1;
  return `attachment-${Date.now()}-${nextAttachmentId}`;
}

export function createPendingAttachment(file: File): PendingAttachment {
  return {
    id: createId(),
    file,
    name: file.name || "attachment",
    mediaType: mediaTypeFor(file),
    size: file.size,
  };
}

function isPdf(file: PendingAttachment): boolean {
  return file.mediaType === "application/pdf" || extension(file.name) === "pdf";
}

function isImage(file: PendingAttachment): boolean {
  return file.mediaType.startsWith("image/");
}

function isMeaningfulMarkdown(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function pageHeading(name: string, page: number): string {
  return `### ${name} · page ${page}`;
}

function documentBlock(name: string, markdown: string): string {
  return `### ${name}\n\n${markdown.trim()}`;
}

function visionLabel(name: string): string {
  return `[Image attachment: ${name}]`;
}

function normalizeOcrText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

async function readFileBytes(file: File, signal: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  if (bytes.byteLength === 0) throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `The attachment “${file.name}” is empty.`);
  return bytes;
}

async function defaultDocumentToMarkdown(bytes: Uint8Array, fileName: string, signal: AbortSignal): Promise<string | undefined> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  return engines.documentToMarkdown(
    bytes,
    fileName,
    assetUrl("app/assets/anydoc-worker.js"),
    assetUrl("vendor/anydoc/anydoc_wasm_bg.wasm"),
    signal,
  );
}

async function defaultRenderPdfPages(bytes: Uint8Array, fileName: string, signal: AbortSignal): Promise<readonly RenderedPdfPage[]> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  return engines.renderPdfPages(bytes, fileName, signal, { workerUrl: assetUrl("vendor/pdfjs/pdf.worker.mjs") });
}

async function* defaultStreamPdfPages(bytes: Uint8Array, fileName: string, signal: AbortSignal): AsyncGenerator<RenderedPdfPage> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  yield* engines.streamPdfPages(bytes, fileName, signal, { workerUrl: assetUrl("vendor/pdfjs/pdf.worker.mjs") });
}

async function defaultRecognizeImage(data: Uint8Array, mediaType: string, signal: AbortSignal): Promise<string> {
  const results = await defaultRecognizeImages([{ data, mediaType }], signal);
  return results[0] ?? "";
}

async function defaultRecognizeImages(inputs: readonly OcrImageInput[], signal: AbortSignal): Promise<readonly string[]> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  return engines.recognizeImages(inputs, {
    workerUrl: assetUrl("app/assets/worker-entry-C9UNuyOJ.js"),
    wasmModuleUrl: assetUrl("vendor/paddleocr/ort/ort-wasm-simd-threaded.mjs"),
    wasmBinaryUrl: assetUrl("vendor/paddleocr/ort/ort-wasm-simd-threaded.wasm"),
    detectionModelUrl: assetUrl("vendor/paddleocr/models/PP-OCRv5_mobile_det_onnx_infer.tar"),
    recognitionModelUrl: assetUrl("vendor/paddleocr/models/PP-OCRv5_mobile_rec_onnx_infer.tar"),
  }, signal);
}

let enginesPromise: Promise<typeof import("./attachment-engines.js")> | undefined;

async function loadEngines(): Promise<typeof import("./attachment-engines.js")> {
  if (enginesPromise === undefined) enginesPromise = import("./attachment-engines.js");
  return enginesPromise;
}

async function yieldToBrowser(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  throwIfAborted(signal);
}

export async function disposeAttachmentEngines(): Promise<void> {
  if (enginesPromise === undefined) return;
  try {
    await (await enginesPromise).disposeAttachmentEngines();
  } catch {
    // A failed or already-terminated worker must not prevent the app from stopping.
  }
}

export async function processAttachmentFiles(
  files: readonly PendingAttachment[],
  supportsVision: boolean,
  signal: AbortSignal,
  dependencies: AttachmentProcessingDependencies = {},
  onProgress?: (progress: AttachmentProgress) => void,
): Promise<PreparedAttachments> {
  const attachments: ModelAttachment[] = [];
  const attachmentIds: string[] = [];
  const labels: string[] = [];
  const content: string[] = [];
  const documentToMarkdown = dependencies.documentToMarkdown ?? defaultDocumentToMarkdown;
  const renderPdfPages = dependencies.renderPdfPages ?? defaultRenderPdfPages;
  const recognizeImage = dependencies.recognizeImage ?? defaultRecognizeImage;
  const recognizeImages = dependencies.recognizeImages ?? defaultRecognizeImages;
  const streamPdfPages = dependencies.streamPdfPages ?? (dependencies.renderPdfPages === undefined
    ? defaultStreamPdfPages
    : async function* (bytes: Uint8Array, fileName: string, pageSignal: AbortSignal): AsyncGenerator<RenderedPdfPage> {
      for (const page of await renderPdfPages(bytes, fileName, pageSignal)) yield page;
    });
  const ocrQueue: Array<{
    readonly input: OcrImageInput;
    readonly contentIndex: number;
    readonly attachment: PendingAttachment;
    readonly heading?: string;
    readonly required: boolean;
  }> = [];
  const readyOcrAttachments = new Set<string>();
  const ocrBatchSize = 8;
  let ocrCompleted = 0;

  const processOcrBatch = async (batch: readonly typeof ocrQueue[number][]): Promise<void> => {
    if (batch.length === 0) return;
    throwIfAborted(signal);
    const batchTexts = dependencies.recognizeImages === undefined
      ? await Promise.all(batch.map((item) => recognizeImage(item.input.data, item.input.mediaType, signal)))
      : await recognizeImages(batch.map((item) => item.input), signal);
    for (const [index, item] of batch.entries()) {
      const text = normalizeOcrText(batchTexts[index] ?? "");
      if (!text && item.required) {
        throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `PaddleOCR found no text in “${item.attachment.name}”.`);
      }
      content[item.contentIndex] = text === "" ? "" : item.heading === undefined
        ? documentBlock(item.attachment.name, text)
        : `${item.heading}\n\n${text}`;
      readyOcrAttachments.add(item.attachment.id);
    }
    ocrCompleted += batch.length;
    const last = batch.at(-1);
    if (last !== undefined) onProgress?.({ attachment: last.attachment, phase: "ocr", detail: `PaddleOCR · ${ocrCompleted} page${ocrCompleted === 1 ? "" : "s"}` });
    await yieldToBrowser(signal);
  };

  const flushOcrQueue = async (): Promise<void> => {
    while (ocrQueue.length > 0) {
      const batch = ocrQueue.splice(0, ocrBatchSize);
      await processOcrBatch(batch);
    }
  };

  for (const attachment of files) {
    throwIfAborted(signal);
    labels.push(attachment.name);
    onProgress?.({ attachment, phase: "reading" });
    const bytes = await readFileBytes(attachment.file, signal);
    if (isImage(attachment)) {
      if (supportsVision) {
        attachments.push({ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, data: bytes });
        attachmentIds.push(attachment.id);
        content.push(visionLabel(attachment.name));
      } else {
        onProgress?.({ attachment, phase: "ocr", detail: "PaddleOCR" });
        ocrQueue.push({
          input: { data: bytes, mediaType: attachment.mediaType },
          contentIndex: content.push("") - 1,
          attachment,
          required: true,
        });
        if (ocrQueue.length >= ocrBatchSize) await flushOcrQueue();
      }
      if (supportsVision) onProgress?.({ attachment, phase: "ready" });
      continue;
    }

    if (isPdf(attachment)) {
      await flushOcrQueue();
      onProgress?.({ attachment, phase: "document", detail: "anydoc" });
      const markdown = await documentToMarkdown(bytes, attachment.name, signal);
      if (isMeaningfulMarkdown(markdown)) {
        content.push(documentBlock(attachment.name, markdown));
        onProgress?.({ attachment, phase: "ready" });
        continue;
      }
      onProgress?.({ attachment, phase: "rendering", detail: "PDF pages" });
      let pageCount = 0;
      let ocrPageBatch: Array<typeof ocrQueue[number]> = [];
      for await (const page of streamPdfPages(bytes, attachment.name, signal)) {
        pageCount += 1;
        throwIfAborted(signal);
        const pageId = `${attachment.id}-page-${pageCount}`;
        if (supportsVision) {
          attachments.push({ id: pageId, name: page.name, mediaType: page.mediaType, data: page.data });
          attachmentIds.push(pageId);
          content.push(visionLabel(page.name));
        } else {
          onProgress?.({ attachment, phase: "ocr", detail: `PaddleOCR page ${pageCount}` });
          ocrPageBatch.push({
            input: { data: page.data, mediaType: page.mediaType },
            contentIndex: content.push("") - 1,
            attachment,
            heading: pageHeading(attachment.name, pageCount),
            required: false,
          });
          if (ocrPageBatch.length >= ocrBatchSize) {
            await processOcrBatch(ocrPageBatch);
            ocrPageBatch = [];
          }
        }
      }
      if (pageCount === 0) throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `Could not find pages in “${attachment.name}”.`);
      if (ocrPageBatch.length > 0) await processOcrBatch(ocrPageBatch);
      if (supportsVision) onProgress?.({ attachment, phase: "ready" });
      continue;
    }

    onProgress?.({ attachment, phase: "document", detail: "anydoc" });
    const markdown = await documentToMarkdown(bytes, attachment.name, signal);
    if (!isMeaningfulMarkdown(markdown)) {
      throw new AttachmentProcessingError("ATTACHMENT_UNSUPPORTED", `This browser cannot parse “${attachment.name}”.`);
    }
    content.push(documentBlock(attachment.name, markdown));
    onProgress?.({ attachment, phase: "ready" });
  }

  await flushOcrQueue();
  for (const attachment of files) {
    if (readyOcrAttachments.has(attachment.id)) onProgress?.({ attachment, phase: "ready" });
  }

  return {
    content: content.join("\n\n"),
    attachments,
    attachmentIds,
    labels,
    usedVision: supportsVision && attachmentIds.length > 0,
  };
}
