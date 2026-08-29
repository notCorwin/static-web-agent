import { copyFile, readFile, rename, readdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const rawBuildVersion = process.env.GITHUB_SHA ?? process.env.BUILD_VERSION ?? "dev";
const buildVersion = rawBuildVersion.replace(/[^a-zA-Z0-9._-]/g, "-") || "dev";

for (const file of ["index.html", "styles.css", "README.md", "LICENSE"]) await copyFile(file, `dist/${file}`);
await build({
  entryPoints: ["dist/main.js"],
  bundle: true,
  format: "esm",
  minify: true,
  platform: "browser",
  outfile: "dist/main.bundle.js",
  sourcemap: false,
});
await rename("dist/main.bundle.js", "dist/main.js");

const html = await readFile("dist/index.html", "utf8");
await writeFile("dist/index.html", html.replaceAll("__BUILD_VERSION__", buildVersion).replace("./dist/main.js", "./main.js"));
await writeFile("dist/version.json", `${JSON.stringify({ version: buildVersion })}\n`);

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

for (const file of await javascriptFiles("dist")) {
  const source = await readFile(file, "utf8");
  const versioned = source.replace(/((?:from\s+|import\s*\(\s*|import\s*)["'])(\.\.?\/[^"']+?\.js)(["'])/g, `$1$2?v=${buildVersion}$3`);
  if (versioned !== source) await writeFile(file, versioned);
}
