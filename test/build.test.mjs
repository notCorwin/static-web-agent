import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const dist = join(process.cwd(), "dist");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the production build emits a cache-busted release manifest and module graph", async () => {
  const manifest = JSON.parse(await readFile(join(dist, "version.json"), "utf8"));
  assert.equal(typeof manifest.version, "string");
  assert.notEqual(manifest.version.length, 0);

  const version = escapeRegExp(manifest.version);
  const html = await readFile(join(dist, "index.html"), "utf8");
  assert.match(html, new RegExp(`<meta name="build-version" content="${version}"`));
  assert.match(html, new RegExp(`href="\\./styles\\.css\\?v=${version}"`));
  assert.match(html, new RegExp(`href="\\./vendor/katex/katex\\.min\\.css\\?v=${version}"`));
  assert.match(html, new RegExp(`src="\\./main\\.js\\?v=${version}"`));

  const main = await readFile(join(dist, "main.js"), "utf8");
  assert.match(main, new RegExp(`from "\\./app-entry\\.js\\?v=${version}"`));
  const lightEntry = await readFile(join(dist, "index.js"), "utf8");
  assert.doesNotMatch(lightEntry, /"\.\/app(?:-entry|\/)|"\.\/adapters\/ai-sdk|"\.\/plugins\/remote-model/);
  assert.match(lightEntry, new RegExp(`from "\\./harness\\.js\\?v=${version}"`));
  const harnessTypes = await readFile(join(dist, "harness.d.ts"), "utf8");
  assert.match(harnessTypes, /createBrowserAgentHarness/);
  for (const method of ["install", "uninstall", "selectModel", "clearModel", "run", "process", "mountUi", "snapshot", "subscribe", "dispose"]) {
    assert.match(harnessTypes, new RegExp(`\\b${method}\\(`));
  }
  const license = await readFile(join(dist, "LICENSE"), "utf8");
  assert.match(license, /Copyright \(c\) 2026 notCorwin/);
  await access(join(dist, "vendor/rendering-runtime.js"));
  await access(join(dist, "vendor/katex/katex.min.css"));
  await access(join(dist, "app/attachment-engines.js"));
  await access(join(dist, "app/assets/anydoc-worker.js"));
  await access(join(dist, "app/assets/worker-entry-C9UNuyOJ.js"));
  await access(join(dist, "vendor/anydoc/anydoc_wasm_bg.wasm"));
  await access(join(dist, "vendor/pdfjs/pdf.worker.mjs"));
  await access(join(dist, "vendor/paddleocr/models/PP-OCRv5_mobile_det_onnx_infer.tar"));
  await access(join(dist, "vendor/paddleocr/models/PP-OCRv5_mobile_rec_onnx_infer.tar"));
  await access(join(dist, "vendor/paddleocr/ort/ort-wasm-simd-threaded.jsep.mjs"));
  await access(join(dist, "vendor/paddleocr/ort/ort-wasm-simd-threaded.jsep.wasm"));
  await assert.rejects(access(join(dist, "vendor/paddleocr/ort/ort-wasm-simd-threaded.wasm")));
  await assert.rejects(access(join(dist, "plugins/local-model.js")));
});
