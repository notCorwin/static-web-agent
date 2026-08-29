import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("the build contains the small static surface", async () => {
  await access("dist/index.html");
  await access("dist/main.js");
  await access("dist/index.d.ts");
  const html = await readFile("dist/index.html", "utf8");
  const main = await readFile("dist/main.js", "utf8");
  const types = await readFile("dist/index.d.ts", "utf8");
  assert.match(html, /\.\/main\.js\?v=/);
  assert.doesNotMatch(main, /paddleocr|anydoc|pdfjs|mermaid|katex|runtime\.javascript|storage\.local/);
  assert.doesNotMatch(types, /AgentKernel|PluginManifest|StateStore|JavaScriptRuntime/);
});
