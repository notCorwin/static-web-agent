import * as anydoc from "@firecrawl/anydoc-wasm";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PaddleOCR } from "@paddleocr/paddleocr-js";
import type { RenderedPdfPage } from "./attachments.js";

interface OcrAssets {
  readonly workerUrl: string;
  readonly wasmModuleUrl: string;
  readonly wasmBinaryUrl: string;
  readonly detectionModelUrl: string;
  readonly recognitionModelUrl: string;
}

export interface OcrImageInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

let anydocReady: Promise<void> | undefined;
let paddle: Promise<Awaited<ReturnType<typeof PaddleOCR.create>>> | undefined;

(globalThis as typeof globalThis & { pdfjsWorker?: { readonly WorkerMessageHandler: typeof WorkerMessageHandler } }).pdfjsWorker = { WorkerMessageHandler };

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
  wasmUrl: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  if (anydocReady === undefined) {
    anydocReady = anydoc.default(wasmUrl).then(() => undefined).catch((error) => {
      anydocReady = undefined;
      throw error;
    });
  }
  await anydocReady;
  throwIfAborted(signal);
  const format = anydoc.formatFromExtension(extension(fileName));
  if (format === undefined) return undefined;
  try {
    return anydoc.toMarkdownBytes(bytes, format);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as Error & { readonly code?: unknown }).code) : "";
    if (code === "unsupported" || code === "malformed" || code === "missingPart") return undefined;
    throw error;
  }
}

export async function renderPdfPages(
  bytes: Uint8Array,
  fileName: string,
  signal: AbortSignal,
): Promise<readonly RenderedPdfPage[]> {
  throwIfAborted(signal);
  const worker = pdfjs.PDFWorker.create({});
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const loading = pdfjs.getDocument({ data: copy, worker });
  const pdf = await loading.promise;
  const pages: RenderedPdfPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.25, Math.max(1, 1800 / Math.max(baseViewport.width, baseViewport.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (context === null) throw new Error(`Could not render page ${pageNumber} of “${fileName}”.`);
      await page.render({ canvasContext: context, canvas, viewport, intent: "print" }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value === null ? reject(new Error("Canvas encoding failed.")) : resolve(value), "image/png");
      });
      pages.push({
        name: `${fileName} · page ${pageNumber}`,
        mediaType: "image/png",
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
    await worker.destroy();
  }
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
    paddle = PaddleOCR.create({
      lang: "ch",
      ocrVersion: "PP-OCRv5",
      worker: {
        createWorker: () => new Worker(assets.workerUrl, { type: "module" }),
      },
      ortOptions: {
        backend: "wasm",
        numThreads: 1,
        // PaddleOCR.js currently types wasmPaths as a string, but ONNX
        // Runtime also accepts an explicit { mjs, wasm } mapping. Using the
        // non-JSEP WASM pair avoids downloading the WebGPU/JSEP binary when
        // this pipeline is explicitly configured for the WASM backend.
        wasmPaths: {
          mjs: assets.wasmModuleUrl,
          wasm: assets.wasmBinaryUrl,
        } as unknown as string,
      },
      textDetectionBatchSize: 2,
      textRecognitionBatchSize: 8,
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textDetectionModelAsset: { url: assets.detectionModelUrl },
      textRecognitionModelName: "PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: { url: assets.recognitionModelUrl },
    }).catch((error) => {
      paddle = undefined;
      throw error;
    });
  }
  return paddle;
}

export async function recognizeImages(inputs: readonly OcrImageInput[], assets: OcrAssets, signal: AbortSignal): Promise<readonly string[]> {
  if (inputs.length === 0) return [];
  throwIfAborted(signal);
  const ocr = await getPaddle(assets);
  throwIfAborted(signal);
  const result = await ocr.predict(await Promise.all(inputs.map((input) => blobFromBytes(input.data, input.mediaType))));
  throwIfAborted(signal);
  return result.map((item) => sortOcrItems(item.items).join("\n"));
}

export async function recognizeImage(data: Uint8Array, mediaType: string, assets: OcrAssets, signal: AbortSignal): Promise<string> {
  return (await recognizeImages([{ data, mediaType }], assets, signal))[0] ?? "";
}

export async function disposeAttachmentEngines(): Promise<void> {
  const current = paddle;
  paddle = undefined;
  if (current !== undefined) {
    try {
      await (await current).dispose();
    } catch {
      // Disposal is best effort when the page is already unloading.
    }
  }
  anydocReady = undefined;
}
