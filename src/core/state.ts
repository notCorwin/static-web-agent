import { isJsonValue } from "./schema.js";
import type { JsonValue, StateStore } from "./types.js";

function clone<T extends JsonValue>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, JsonValue>();

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value) as T;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    if (!isJsonValue(value)) throw new Error("State values must be valid JSON.");
    this.values.set(key, clone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.values.keys()].sort();
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

export class PrefixedStateStore implements StateStore {
  private readonly prefix: string;
  private readonly parent: StateStore;

  constructor(parent: StateStore, prefix: string) {
    this.parent = parent;
    this.prefix = prefix.endsWith(":") ? prefix : `${prefix}:`;
  }

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    return this.parent.get<T>(`${this.prefix}${key}`);
  }

  async set(key: string, value: JsonValue): Promise<void> {
    return this.parent.set(`${this.prefix}${key}`, value);
  }

  async remove(key: string): Promise<void> {
    return this.parent.remove(`${this.prefix}${key}`);
  }

  async keys(): Promise<readonly string[]> {
    const prefix = this.prefix;
    return (await this.parent.keys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  async clear(): Promise<void> {
    // ponytail: namespaced stores are intentionally small; batch-delete can replace this if that ceiling changes.
    for (const key of await this.keys()) await this.remove(key);
  }
}

export interface IndexedDbStateStoreOptions {
  readonly databaseName?: string;
  readonly objectStoreName?: string;
  readonly indexedDB?: IDBFactory;
}

export class IndexedDbStateStore implements StateStore {
  private readonly storeName: string;
  private readonly database: Promise<IDBDatabase>;

  constructor(options: IndexedDbStateStoreOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) throw new Error("IndexedDB is not available in this browser.");
    this.storeName = options.objectStoreName ?? "state";
    const databaseName = options.databaseName ?? "static-web-agent";
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab."));
    });
  }

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).get(key);
      request.onsuccess = () => resolve(request.result === undefined ? undefined : request.result as T);
      request.onerror = () => reject(request.error ?? new Error("Unable to read state."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to read state."));
    });
  }

  async set(key: string, value: JsonValue): Promise<void> {
    if (!isJsonValue(value)) throw new Error("State values must be valid JSON.");
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      const request = transaction.objectStore(this.storeName).put(clone(value), key);
      request.onerror = () => reject(request.error ?? new Error("Unable to write state."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to write state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to write state."));
    });
  }

  async remove(key: string): Promise<void> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      const request = transaction.objectStore(this.storeName).delete(key);
      request.onerror = () => reject(request.error ?? new Error("Unable to delete state."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to delete state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to delete state."));
    });
  }

  async keys(): Promise<readonly string[]> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).getAllKeys();
      request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === "string").sort());
      request.onerror = () => reject(request.error ?? new Error("Unable to list state."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to list state."));
    });
  }

  async clear(): Promise<void> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      const request = transaction.objectStore(this.storeName).clear();
      request.onerror = () => reject(request.error ?? new Error("Unable to clear state."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to clear state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to clear state."));
    });
  }
}

export function createBrowserStateStore(options: IndexedDbStateStoreOptions = {}): StateStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  return factory === undefined ? new MemoryStateStore() : new IndexedDbStateStore({ ...options, indexedDB: factory });
}