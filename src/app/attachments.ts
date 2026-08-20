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

export type PdfPageContent =
  | { readonly kind: "text"; readonly pageNumber: number; readonly text: string }
  | { readonly kind: "image"; readonly pageNumber: number; readonly image: RenderedPdfPage };

export interface OcrImageInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

export interface AttachmentProcessingDependencies {
  readonly documentToMarkdown?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly renderPdfPages?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => Promise<readonly RenderedPdfPage[]>;
  readonly streamPdfPages?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => AsyncIterable<RenderedPdfPage>;
  readonly streamPdfContentPages?: (bytes: Uint8Array, fileName: string, signal: AbortSignal) => AsyncIterable<PdfPageContent>;
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
  const declaredType = file.type.trim();
  if (declaredType.length > 0 && declaredType !== "application/octet-stream") return declaredType;
  const types: Readonly<Record<string, string>> = {
    avif: "image/avif",
    bmp: "image/bmp",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    epub: "application/epub+zip",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    pdf: "application/pdf",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    txt: "text/plain",
    tif: "image/tiff",
    tiff: "image/tiff",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    png: "image/png",
  };
  return types[extension(file.name)] ?? (declaredType.length > 0 ? declaredType : "application/octet-stream");
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

function isTextFile(file: PendingAttachment): boolean {
  return extension(file.name) === "txt" || file.mediaType === "text/plain";
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

function decodeText(bytes: Uint8Array, fileName: string): string {
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    start = 2;
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.slice(start));
  } catch {
    throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `Could not decode “${fileName}” as text.`);
  }
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

async function* defaultStreamPdfContentPages(bytes: Uint8Array, fileName: string, signal: AbortSignal): AsyncGenerator<PdfPageContent> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  yield* engines.streamPdfContentPages(bytes, fileName, signal, { workerUrl: assetUrl("vendor/pdfjs/pdf.worker.mjs") });
}

async function defaultRecognizeImages(inputs: readonly OcrImageInput[], signal: AbortSignal): Promise<readonly string[]> {
  throwIfAborted(signal);
  const engines = await loadEngines();
  return engines.recognizeImages(inputs, {
    workerUrl: assetUrl("app/assets/worker-entry-C9UNuyOJ.js"),
    wasmModuleUrl: assetUrl("vendor/paddleocr/ort/ort-wasm-simd-threaded.jsep.mjs"),
    wasmBinaryUrl: assetUrl("vendor/paddleocr/ort/ort-wasm-simd-threaded.jsep.wasm"),
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
  const legacyRenderPdfPages = dependencies.renderPdfPages;
  const batchRecognizeImage = dependencies.recognizeImage;
  const batchRecognizeImages = dependencies.recognizeImages;
  const legacyStreamPdfPages = dependencies.streamPdfPages ?? (legacyRenderPdfPages === undefined
    ? undefined
    : async function* (bytes: Uint8Array, fileName: string, pageSignal: AbortSignal): AsyncGenerator<RenderedPdfPage> {
      for (const page of await legacyRenderPdfPages(bytes, fileName, pageSignal)) yield page;
    });
  const streamPdfContentPages = dependencies.streamPdfContentPages ?? (async function* (
    bytes: Uint8Array,
    fileName: string,
    pageSignal: AbortSignal,
  ): AsyncGenerator<PdfPageContent> {
    if (legacyStreamPdfPages === undefined) {
      yield* defaultStreamPdfContentPages(bytes, fileName, pageSignal);
      return;
    }
    let pageNumber = 0;
    for await (const page of legacyStreamPdfPages(bytes, fileName, pageSignal)) {
      pageNumber += 1;
      yield { kind: "image", pageNumber, image: page };
    }
  });
  const ocrQueue: Array<{
    readonly input: OcrImageInput;
    readonly contentIndex: number;
    readonly attachment: PendingAttachment;
    readonly heading?: string;
    readonly required: boolean;
  }> = [];
  const readyOcrAttachments = new Set<string>();
  const ocrBatchSize = 2;
  let ocrCompleted = 0;

  const processOcrBatch = async (batch: readonly typeof ocrQueue[number][]): Promise<boolean> => {
    if (batch.length === 0) return false;
    throwIfAborted(signal);
    const batchTexts = batchRecognizeImages !== undefined
      ? await batchRecognizeImages(batch.map((item) => item.input), signal)
      : batchRecognizeImage !== undefined
        ? await Promise.all(batch.map((item) => batchRecognizeImage(item.input.data, item.input.mediaType, signal)))
        : await defaultRecognizeImages(batch.map((item) => item.input), signal);
    let foundText = false;
    for (const [index, item] of batch.entries()) {
      const text = normalizeOcrText(batchTexts[index] ?? "");
      if (!text && item.required) {
        throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `PaddleOCR found no text in “${item.attachment.name}”.`);
      }
      if (text.length > 0) foundText = true;
      content[item.contentIndex] = text === "" ? "" : item.heading === undefined
        ? documentBlock(item.attachment.name, text)
        : `${item.heading}\n\n${text}`;
      readyOcrAttachments.add(item.attachment.id);
    }
    ocrCompleted += batch.length;
    const last = batch.at(-1);
    if (last !== undefined) onProgress?.({ attachment: last.attachment, phase: "ocr", detail: `PaddleOCR · ${ocrCompleted} page${ocrCompleted === 1 ? "" : "s"}` });
    await yieldToBrowser(signal);
    return foundText;
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
      onProgress?.({ attachment, phase: "document", detail: "PDF.js pages" });
      let pageCount = 0;
      let scannedPageCount = 0;
      let pdfHasText = false;
      let ocrPageBatch: Array<typeof ocrQueue[number]> = [];
      for await (const page of streamPdfContentPages(bytes, attachment.name, signal)) {
        pageCount = Math.max(pageCount, page.pageNumber);
        throwIfAborted(signal);
        if (page.kind === "text") {
          pdfHasText = true;
          content.push(`${pageHeading(attachment.name, page.pageNumber)}\n\n${page.text}`);
        } else if (supportsVision) {
          const pageId = `${attachment.id}-page-${page.pageNumber}`;
          attachments.push({ id: pageId, name: page.image.name, mediaType: page.image.mediaType, data: page.image.data });
          attachmentIds.push(pageId);
          content.push(visionLabel(page.image.name));
        } else {
          scannedPageCount += 1;
          onProgress?.({ attachment, phase: "rendering", detail: `PDF.js page ${page.pageNumber}` });
          ocrPageBatch.push({
            input: { data: page.image.data, mediaType: page.image.mediaType },
            contentIndex: content.push("") - 1,
            attachment,
            heading: pageHeading(attachment.name, page.pageNumber),
            required: false,
          });
          if (ocrPageBatch.length >= ocrBatchSize) {
            pdfHasText = (await processOcrBatch(ocrPageBatch)) || pdfHasText;
            ocrPageBatch = [];
          }
        }
      }
      if (pageCount === 0) throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `Could not find pages in “${attachment.name}”.`);
      if (ocrPageBatch.length > 0) pdfHasText = (await processOcrBatch(ocrPageBatch)) || pdfHasText;
      if (!supportsVision && scannedPageCount > 0 && !pdfHasText) {
        throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `PaddleOCR found no text in “${attachment.name}”.`);
      }
      if (supportsVision) onProgress?.({ attachment, phase: "ready" });
      continue;
    }

    if (isTextFile(attachment)) {
      const text = decodeText(bytes, attachment.name);
      if (!isMeaningfulMarkdown(text)) {
        throw new AttachmentProcessingError("ATTACHMENT_PARSE_FAILED", `The text attachment “${attachment.name}” is empty.`);
      }
      content.push(documentBlock(attachment.name, text));
      onProgress?.({ attachment, phase: "ready" });
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
