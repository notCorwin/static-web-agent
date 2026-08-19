import { copyFile, cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const rawBuildVersion = process.env.GITHUB_SHA ?? process.env.BUILD_VERSION ?? "dev";
const buildVersion = rawBuildVersion.replace(/[^a-zA-Z0-9._-]/g, "-");
if (buildVersion.length === 0) throw new Error("A non-empty build version is required.");

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && path.endsWith(".js")) files.push(path);
  }
  return files;
}

for (const file of ["index.html", "styles.css", "README.md"]) await copyFile(file, `dist/${file}`);
await mkdir("dist/vendor/katex", { recursive: true });
await copyFile("node_modules/katex/dist/katex.min.css", "dist/vendor/katex/katex.min.css");
await cp("node_modules/katex/dist/fonts", "dist/vendor/katex/fonts", { recursive: true });
await build({
  entryPoints: ["dist/vendor/rendering-runtime.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/vendor/rendering-runtime.bundle.js",
  platform: "browser",
  sourcemap: false,
});
await rename("dist/vendor/rendering-runtime.bundle.js", "dist/vendor/rendering-runtime.js");
await build({
  entryPoints: ["dist/adapters/ai-sdk.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/adapters/ai-sdk.bundle.js",
  platform: "browser",
  sourcemap: false,
});
await rename("dist/adapters/ai-sdk.bundle.js", "dist/adapters/ai-sdk.js");
await build({
  entryPoints: ["dist/app/attachment-engines.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/app/attachment-engines.bundle.js",
  platform: "browser",
  external: ["fs", "path"],
  sourcemap: false,
});
await rename("dist/app/attachment-engines.bundle.js", "dist/app/attachment-engines.js");
await mkdir("dist/app/assets", { recursive: true });
await build({
  entryPoints: ["dist/app/anydoc-worker.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/app/anydoc-worker.bundle.js",
  platform: "browser",
  sourcemap: false,
});
await rename("dist/app/anydoc-worker.bundle.js", "dist/app/assets/anydoc-worker.js");

await mkdir("dist/vendor/anydoc", { recursive: true });
await copyFile("node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm", "dist/vendor/anydoc/anydoc_wasm_bg.wasm");
await mkdir("dist/vendor/pdfjs", { recursive: true });
await copyFile("node_modules/pdfjs-dist/build/pdf.worker.mjs", "dist/vendor/pdfjs/pdf.worker.mjs");
await copyFile(
  "node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-C9UNuyOJ.js",
  "dist/app/assets/worker-entry-C9UNuyOJ.js",
);
await mkdir("dist/vendor/paddleocr/ort", { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `dist/vendor/paddleocr/ort/${file}`);
}

await mkdir("dist/vendor/paddleocr/models", { recursive: true });
await mkdir("node_modules/.cache/static-web-agent", { recursive: true });
const paddleModels = [
  ["PP-OCRv5_mobile_det_onnx_infer.tar", "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar"],
  ["PP-OCRv5_mobile_rec_onnx_infer.tar", "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar"],
];
for (const [file, url] of paddleModels) {
  const cachePath = `node_modules/.cache/static-web-agent/${file}`;
  let bytes;
  try {
    bytes = await readFile(cachePath);
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download PaddleOCR model ${file}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(cachePath, bytes);
  }
  await writeFile(`dist/vendor/paddleocr/models/${file}`, bytes);
}
const path = "dist/index.html";
const html = await readFile(path, "utf8");
const versionedHtml = html
  .replaceAll("__BUILD_VERSION__", buildVersion)
  .replace("./dist/main.js", "./main.js");
await writeFile(path, versionedHtml);
await writeFile("dist/version.json", `${JSON.stringify({ version: buildVersion })}\n`);

for (const file of await javascriptFiles("dist")) {
  const source = await readFile(file, "utf8");
  const versioned = source.replace(/((?:from\s+|import\s*\(\s*)["'])(\.\.?\/[^"]+?\.js)(["'])/g, `$1$2?v=${buildVersion}$3`);
  if (versioned !== source) await writeFile(file, versioned);
}
