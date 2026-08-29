import { startApp } from "./app-entry.js";

const root = document.getElementById("app");
if (root === null) throw new Error("Application root is missing.");

startApp(root).catch((error: unknown) => {
  const main = document.createElement("main");
  main.className = "startup-error";
  main.setAttribute("aria-labelledby", "startup-error-title");
  main.append(
    textElement("h1", "The workspace could not start", "startup-error-title"),
    textElement("p", error instanceof Error ? error.message : "The browser could not start the workspace."),
  );
  const retry = document.createElement("button");
  retry.className = "primary-button";
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => window.location.reload());
  main.append(retry);
  root.replaceChildren(main);
});

function textElement(tag: keyof HTMLElementTagNameMap, text: string, id?: string): HTMLElement {
  const element = document.createElement(tag);
  if (id !== undefined) element.id = id;
  element.textContent = text;
  return element;
}
