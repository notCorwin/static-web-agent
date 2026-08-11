import { startApp } from "./app/app.js";

const root = document.getElementById("app");
if (root === null) throw new Error("Application root is missing.");

void startApp(root).catch((error: unknown) => {
  const main = document.createElement("main");
  main.className = "startup-error";
  main.setAttribute("aria-labelledby", "startup-error-title");
  const icon = document.createElement("div");
  icon.className = "startup-error-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "!";
  const title = document.createElement("h1");
  title.id = "startup-error-title";
  title.textContent = "The workspace could not start";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error ? error.message : "The browser could not load local workspace state.";
  const retry = document.createElement("button");
  retry.className = "primary-button";
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => window.location.reload());
  const help = document.createElement("p");
  help.className = "startup-error-help";
  help.textContent = "If this continues, check that browser storage is available and reload the page.";
  main.append(icon, title, detail, retry, help);
  root.replaceChildren(main);
});
