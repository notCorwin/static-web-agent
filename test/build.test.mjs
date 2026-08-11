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
  assert.match(html, new RegExp(`src="\\./main\\.js\\?v=${version}"`));

  const main = await readFile(join(dist, "main.js"), "utf8");
  assert.match(main, new RegExp(`from "\\./app/app\\.js\\?v=${version}"`));
  await assert.rejects(access(join(dist, "plugins/local-model.js")));
});
