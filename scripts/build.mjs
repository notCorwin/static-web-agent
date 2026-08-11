import { copyFile, readFile, writeFile } from "node:fs/promises";

for (const file of ["index.html", "styles.css", "README.md"]) await copyFile(file, `dist/${file}`);
const path = "dist/index.html";
const html = await readFile(path, "utf8");
await writeFile(path, html.replace("./dist/main.js", "./main.js"));
