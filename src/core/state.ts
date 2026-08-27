import { isJsonValue } from "./schema.js";
import type { JsonValue, StateChange, StateStore, StateStoreKind } from "./types.js";

function clone<T extends JsonValue>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new Error("State keys must be non-empty strings.");
}

function validateChanges(changes: readonly StateChange[]): void {
  for (const change of changes) {
    validateKey(change.key);
    if (change.type === "set" && !isJsonValue(change.value)) throw new Error("State values must be valid JSON.");
  }
}

export class MemoryStateStore implements StateStore {
  readonly kind: StateStoreKind = "memory";
  private readonly values = new Map<string, JsonValue>();

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    validateKey(key);
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value) as T;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    await this.apply([{ type: "set", key, value }]);
  }

  async remove(key: string): Promise<void> {
    await this.apply([{ type: "remove", key }]);
  }

  async apply(changes: readonly StateChange[]): Promise<void> {
    validateChanges(changes);
    const prepared = changes.map((change): StateChange => change.type === "set" ? { ...change, value: clone(change.value) } : change);
    for (const change of prepared) {
      if (change.type === "set") this.values.set(change.key, change.value);
      else this.values.delete(change.key);
    }
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

  get kind(): StateStoreKind {
    return this.parent.kind;
  }

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    validateKey(key);
    return this.parent.get<T>(`${this.prefix}${key}`);
  }

  async set(key: string, value: JsonValue): Promise<void> {
    return this.apply([{ type: "set", key, value }]);
  }

  async remove(key: string): Promise<void> {
    return this.apply([{ type: "remove", key }]);
  }

  async apply(changes: readonly StateChange[]): Promise<void> {
    validateChanges(changes);
    return this.parent.apply(changes.map((change) => ({ ...change, key: `${this.prefix}${change.key}` })));
  }

  async keys(): Promise<readonly string[]> {
    const prefix = this.prefix;
    return (await this.parent.keys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  async clear(): Promise<void> {
    await this.parent.apply((await this.keys()).map((key) => ({ type: "remove", key: `${this.prefix}${key}` })));
  }
}

export interface IndexedDbStateStoreOptions {
  readonly databaseName?: string;
  readonly objectStoreName?: string;
  readonly indexedDB?: IDBFactory;
}

export class IndexedDbStateStore implements StateStore {
  readonly kind: StateStoreKind = "indexeddb";
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
    validateKey(key);
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).get(key);
      request.onsuccess = () => resolve(request.result === undefined ? undefined : clone(request.result as T));
      request.onerror = () => reject(request.error ?? new Error("Unable to read state."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to read state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to read state."));
    });
  }

  async set(key: string, value: JsonValue): Promise<void> {
    await this.apply([{ type: "set", key, value }]);
  }

  async remove(key: string): Promise<void> {
    await this.apply([{ type: "remove", key }]);
  }

  async apply(changes: readonly StateChange[]): Promise<void> {
    validateChanges(changes);
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      const objectStore = transaction.objectStore(this.storeName);
      for (const change of changes) {
        if (change.type === "set") objectStore.put(clone(change.value), change.key);
        else objectStore.delete(change.key);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to write state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to write state."));
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
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to list state."));
    });
  }

  async clear(): Promise<void> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to clear state."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Unable to clear state."));
    });
  }
}

/** Keeps a shadow copy so a browser storage failure does not destroy current in-memory state. */
export class ResilientStateStore implements StateStore {
  private readonly primary: StateStore;
  private readonly fallback: MemoryStateStore;
  private degraded = false;
  private failure: string | undefined;

  constructor(primary: StateStore, fallback = new MemoryStateStore()) {
    this.primary = primary;
    this.fallback = fallback;
  }

  get kind(): StateStoreKind {
    return this.degraded ? "memory" : this.primary.kind;
  }

  get failureReason(): string | undefined {
    return this.failure;
  }

  private fail(error: unknown): void {
    this.degraded = true;
    this.failure = error instanceof Error ? error.message : "Persistent browser storage failed.";
  }

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    if (this.degraded) return this.fallback.get<T>(key);
    try {
      const value = await this.primary.get<T>(key);
      if (value === undefined) await this.fallback.remove(key);
      else await this.fallback.set(key, value);
      return value;
    } catch (error) {
      this.fail(error);
      return this.fallback.get<T>(key);
    }
  }

  async set(key: string, value: JsonValue): Promise<void> {
    await this.apply([{ type: "set", key, value }]);
  }

  async remove(key: string): Promise<void> {
    await this.apply([{ type: "remove", key }]);
  }

  async apply(changes: readonly StateChange[]): Promise<void> {
    if (this.degraded) return this.fallback.apply(changes);
    try {
      await this.primary.apply(changes);
      await this.fallback.apply(changes);
    } catch (error) {
      this.fail(error);
      await this.fallback.apply(changes);
    }
  }

  async keys(): Promise<readonly string[]> {
    if (this.degraded) return this.fallback.keys();
    try {
      const keys = await this.primary.keys();
      const changes: StateChange[] = [];
      for (const key of keys) {
        const value = await this.primary.get(key);
        changes.push(value === undefined ? { type: "remove", key } : { type: "set", key, value });
      }
      await this.fallback.clear();
      await this.fallback.apply(changes);
      return keys;
    } catch (error) {
      this.fail(error);
      return this.fallback.keys();
    }
  }

  async clear(): Promise<void> {
    if (this.degraded) return this.fallback.clear();
    try {
      await this.primary.clear();
      await this.fallback.clear();
    } catch (error) {
      this.fail(error);
      await this.fallback.clear();
    }
  }
}

export function createBrowserStateStore(options: IndexedDbStateStoreOptions = {}): StateStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) return new MemoryStateStore();
  return new ResilientStateStore(new IndexedDbStateStore({ ...options, indexedDB: factory }));
}
