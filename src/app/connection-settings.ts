export const CONNECTION_SETTINGS_KEY = "static-web-agent.connection";

export interface ConnectionSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface ConnectionDraft {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface ConnectionFieldErrors {
  readonly endpoint?: string;
  readonly model?: string;
}

export interface ConnectionValidation {
  readonly settings?: ConnectionSettings;
  readonly errors: ConnectionFieldErrors;
}

interface StorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function localStorageOrUndefined(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectionSettings(value: unknown): value is ConnectionSettings {
  return isRecord(value)
    && typeof value.endpoint === "string"
    && typeof value.model === "string"
    && typeof value.apiKey === "string";
}

export function loadConnectionSettings(storage: StorageLike | undefined = localStorageOrUndefined()): ConnectionSettings | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(CONNECTION_SETTINGS_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return isConnectionSettings(value) ? validateConnectionDraft(value).settings : undefined;
  } catch {
    return undefined;
  }
}

export function saveConnectionSettings(settings: ConnectionSettings, storage: StorageLike | undefined = localStorageOrUndefined()): void {
  if (storage === undefined) return;
  try {
    const valid = validateConnectionDraft(settings).settings;
    if (valid === undefined) return;
    storage.setItem(CONNECTION_SETTINGS_KEY, JSON.stringify(valid));
  } catch {
    // Chat remains usable when browser storage is unavailable or full.
  }
}

export function validateConnectionDraft(draft: ConnectionDraft): ConnectionValidation {
  const endpoint = draft.endpoint.trim();
  const model = draft.model.trim();
  const errors: { endpoint?: string; model?: string } = {};
  if (!endpoint) errors.endpoint = "Enter the model endpoint.";
  else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      errors.endpoint = "Use an http:// or https:// endpoint.";
    }
  }
  if (!model) errors.model = "Enter a model name.";
  if (errors.endpoint !== undefined || errors.model !== undefined) return { errors };
  return { errors: {}, settings: { endpoint, model, apiKey: draft.apiKey } };
}
