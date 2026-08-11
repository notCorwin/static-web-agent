import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";

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
