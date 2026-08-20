import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PaddleOCR } from "@paddleocr/paddleocr-js";
import type { PdfPageContent, RenderedPdfPage } from "./attachments.js";

interface OcrAssets {
  readonly workerUrl: string;
  readonly wasmModuleUrl: string;
  readonly wasmBinaryUrl: string;
  readonly detectionModelUrl: string;
  readonly recognitionModelUrl: string;
}

interface PdfAssets {
  readonly workerUrl: string;
}

export interface OcrImageInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

let paddle: Promise<Awaited<ReturnType<typeof PaddleOCR.create>>> | undefined;
let paddleWorker: Worker | undefined;
let paddleGeneration = 0;

let pdfWorkerUrl: string | undefined;
let anydocWorker: Worker | undefined;
let anydocRequestSequence = 0;
const anydocRequests = new Map<number, {
  readonly resolve: (value: string | undefined) => void;
  readonly reject: (reason?: unknown) => void;
}>();

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Attachment processing was cancelled.");
  error.name = "AbortError";
  throw error;
}

export async function documentToMarkdown(
  bytes: Uint8Array,
  fileName: string,
  workerUrl: string,
  wasmUrl: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  const worker = getAnydocWorker(workerUrl);
  const id = ++anydocRequestSequence;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  let promiseReject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<string | undefined>((resolve, reject) => {
    promiseReject = reject;
    anydocRequests.set(id, { resolve, reject });
  });
  const abort = (): void => {
    anydocRequests.delete(id);
    worker.terminate();
    if (anydocWorker === worker) anydocWorker = undefined;
    const error = new Error("Attachment processing was cancelled.");
    error.name = "AbortError";
    promiseReject(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    worker.postMessage({ id, bytes: copy.buffer, extension: extension(fileName), wasmUrl }, [copy.buffer]);
    const result = await promise;
    throwIfAborted(signal);
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    anydocRequests.delete(id);
  }
}

function getAnydocWorker(workerUrl: string): Worker {
  if (anydocWorker !== undefined) return anydocWorker;
  const worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = (event: MessageEvent<{ readonly id?: number; readonly ok?: boolean; readonly markdown?: string; readonly code?: string; readonly message?: string }>) => {
    const response = event.data;
    if (typeof response.id !== "number") return;
    const request = anydocRequests.get(response.id);
    if (request === undefined) return;
    if (response.ok === true) request.resolve(response.markdown);
    else if (response.code === "unsupported" || response.code === "malformed" || response.code === "missingPart") request.resolve(undefined);
    else request.reject(new Error(response.message ?? "Document conversion failed."));
  };
  worker.onerror = (event) => {
    const error = event.error instanceof Error ? event.error : new Error(event.message || "Document conversion worker failed.");
    for (const request of anydocRequests.values()) request.reject(error);
    anydocRequests.clear();
    if (anydocWorker === worker) anydocWorker = undefined;
  };
  anydocWorker = worker;
  return worker;
}

function configurePdfWorker(assets: PdfAssets): void {
  if (pdfWorkerUrl === assets.workerUrl) return;
  pdfjs.GlobalWorkerOptions.workerSrc = assets.workerUrl;
  pdfWorkerUrl = assets.workerUrl;
}

async function yieldToBrowser(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function extractPdfText(items: readonly unknown[]): string {
  let value = "";
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    if (value.length > 0 && !value.endsWith("\n") && item.str.length > 0) value += " ";
    value += item.str;
    if ("hasEOL" in item && item.hasEOL === true) value += "\n";
  }
  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function renderPdfPage(page: pdfjs.PDFPageProxy, fileName: string, pageNumber: number, signal: AbortSignal): Promise<RenderedPdfPage> {
  throwIfAborted(signal);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.8, Math.max(1, 1440 / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  try {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error(`Could not render page ${pageNumber} of “${fileName}”.`);
    const renderTask = page.render({ canvasContext: context, canvas, viewport, intent: "print" });
    const abortRender = (): void => renderTask.cancel();
    signal.addEventListener("abort", abortRender, { once: true });
    try {
      await renderTask.promise;
    } finally {
      signal.removeEventListener("abort", abortRender);
    }
    throwIfAborted(signal);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value === null ? reject(new Error("Canvas encoding failed.")) : resolve(value), "image/png");
    });
    return {
      name: `${fileName} · page ${pageNumber}`,
      mediaType: "image/png",
      data: new Uint8Array(await blob.arrayBuffer()),
    };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function* streamPdf<T>(
  bytes: Uint8Array,
  fileName: string,
  signal: AbortSignal,
  assets: PdfAssets,
  transform: (page: pdfjs.PDFPageProxy, pageNumber: number) => Promise<T>,
): AsyncGenerator<T> {
  throwIfAborted(signal);
  configurePdfWorker(assets);
  const worker = pdfjs.PDFWorker.create({});
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const loading = pdfjs.getDocument({ data: copy, worker });
  const abortLoading = (): void => { void loading.destroy(); };
  signal.addEventListener("abort", abortLoading, { once: true });
  let pdf: Awaited<typeof loading.promise> | undefined;
  try {
    pdf = await loading.promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      try {
        yield await transform(page, pageNumber);
      } finally {
        page.cleanup();
      }
      await yieldToBrowser(signal);
    }
  } finally {
    signal.removeEventListener("abort", abortLoading);
    await loading.destroy().catch(() => undefined);
    await pdf?.destroy().catch(() => undefined);
    try {
      worker.destroy();
    } catch {
      // A cancelled loading task may already have destroyed the worker.
    }
  }
}

export async function* streamPdfPages(
  bytes: Uint8Array,
  fileName: string,
  signal: AbortSignal,
  assets: PdfAssets,
): AsyncGenerator<RenderedPdfPage> {
  yield* streamPdf(bytes, fileName, signal, assets, (page, pageNumber) => renderPdfPage(page, fileName, pageNumber, signal));
}

export async function* streamPdfContentPages(
  bytes: Uint8Array,
  fileName: string,
  signal: AbortSignal,
  assets: PdfAssets,
): AsyncGenerator<PdfPageContent> {
  yield* streamPdf(bytes, fileName, signal, assets, async (page, pageNumber): Promise<PdfPageContent> => {
    const text = extractPdfText((await page.getTextContent()).items);
    if (text.length > 0) return { kind: "text", pageNumber, text };
    return { kind: "image", pageNumber, image: await renderPdfPage(page, fileName, pageNumber, signal) };
  });
}

export async function renderPdfPages(
  bytes: Uint8Array,
  fileName: string,
  signal: AbortSignal,
  assets: PdfAssets,
): Promise<readonly RenderedPdfPage[]> {
  const pages: RenderedPdfPage[] = [];
  for await (const page of streamPdfPages(bytes, fileName, signal, assets)) pages.push(page);
  return pages;
}

function sortOcrItems(items: readonly { readonly text: string; readonly poly: readonly (readonly [number, number])[] }[]): readonly string[] {
  return [...items]
    .filter((item) => item.text.trim().length > 0)
    .sort((left, right) => {
      const leftPoint = left.poly[0] ?? [0, 0];
      const rightPoint = right.poly[0] ?? [0, 0];
      const y = leftPoint[1] - rightPoint[1];
      return Math.abs(y) > 12 ? y : leftPoint[0] - rightPoint[0];
    })
    .map((item) => item.text.trim());
}

async function blobFromBytes(data: Uint8Array, mediaType: string): Promise<Blob> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer], { type: mediaType });
}

async function getPaddle(assets: OcrAssets): Promise<Awaited<ReturnType<typeof PaddleOCR.create>>> {
  if (paddle === undefined) {
    const generation = ++paddleGeneration;
    paddle = PaddleOCR.create({
      lang: "ch",
      ocrVersion: "PP-OCRv5",
      worker: {
        createWorker: () => {
          const worker = new Worker(assets.workerUrl, { type: "module" });
          if (generation !== paddleGeneration) {
            worker.terminate();
            throw new Error("OCR worker generation was cancelled.");
          }
          paddleWorker = worker;
          return worker;
        },
      },
      ortOptions: {
        backend: "auto",
        numThreads: 1,
        wasmPaths: {
          mjs: assets.wasmModuleUrl,
          wasm: assets.wasmBinaryUrl,
        } as unknown as string,
      },
      batch_size: 2,
      textDetectionBatchSize: 2,
      textRecognitionBatchSize: 8,
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textDetectionModelAsset: { url: assets.detectionModelUrl },
      textRecognitionModelName: "PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: { url: assets.recognitionModelUrl },
    }).catch((error) => {
      if (generation === paddleGeneration) paddle = undefined;
      throw error;
    });
  }
  return paddle;
}

function cancelPaddle(): void {
  paddleGeneration += 1;
  paddle = undefined;
  paddleWorker?.terminate();
  paddleWorker = undefined;
}

export async function recognizeImages(inputs: readonly OcrImageInput[], assets: OcrAssets, signal: AbortSignal): Promise<readonly string[]> {
  if (inputs.length === 0) return [];
  throwIfAborted(signal);
  const operation = (async (): Promise<readonly string[]> => {
    const ocr = await getPaddle(assets);
    throwIfAborted(signal);
    const result = await ocr.predict(await Promise.all(inputs.map((input) => blobFromBytes(input.data, input.mediaType))));
    throwIfAborted(signal);
    return result.map((item) => sortOcrItems(item.items).join("\n"));
  })();
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const abortPromise = new Promise<readonly string[]>((_resolve, reject) => { rejectAbort = reject; });
  let aborted = false;
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    cancelPaddle();
    const error = new Error("Attachment processing was cancelled.");
    error.name = "AbortError";
    rejectAbort(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([operation, abortPromise]);
  } finally {
    signal.removeEventListener("abort", abort);
    void operation.catch(() => undefined);
  }
}

export async function recognizeImage(data: Uint8Array, mediaType: string, assets: OcrAssets, signal: AbortSignal): Promise<string> {
  return (await recognizeImages([{ data, mediaType }], assets, signal))[0] ?? "";
}

export async function disposeAttachmentEngines(): Promise<void> {
  cancelPaddle();
  const currentAnydoc = anydocWorker;
  anydocWorker = undefined;
  for (const request of anydocRequests.values()) request.reject(new Error("Document conversion was stopped."));
  anydocRequests.clear();
  currentAnydoc?.terminate();
}
