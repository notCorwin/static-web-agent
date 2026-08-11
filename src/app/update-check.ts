const BUILD_VERSION_META = "meta[name=\"build-version\"]";
const VERSION_FILE = "version.json";
const VERSION_QUERY = "check";

function currentBuildVersion(): string | undefined {
  const version = document.querySelector(BUILD_VERSION_META)?.getAttribute("content")?.trim();
  if (version === undefined || version.length === 0 || version.includes("__BUILD_VERSION__")) return undefined;
  return version;
}

function cleanVersionQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("v")) return;
  url.searchParams.delete("v");
  window.history.replaceState({}, "", url);
}

export async function reloadIfOutdated(): Promise<boolean> {
  const localVersion = currentBuildVersion();
  if (localVersion === undefined) return false;

  try {
    const url = new URL(VERSION_FILE, window.location.href);
    url.searchParams.set(VERSION_QUERY, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    const remoteVersion = payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).version
      : undefined;
    if (typeof remoteVersion !== "string" || remoteVersion.length === 0 || remoteVersion === localVersion) {
      cleanVersionQuery();
      return false;
    }

    const reloadUrl = new URL(window.location.href);
    reloadUrl.searchParams.set("v", remoteVersion);
    window.location.replace(reloadUrl.href);
    return true;
  } catch {
    return false;
  }
}
