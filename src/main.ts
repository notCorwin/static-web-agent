import { startApp } from "./app/app.js";

const root = document.getElementById("app");
if (root === null) throw new Error("Application root is missing.");

void startApp(root).catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : "Unable to start Static Web Agent.";
});
