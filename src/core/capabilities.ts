import { KernelError, PermissionDeniedError } from "./errors.js";
import type {
  CapabilityName,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityScope,
  PermissionPolicy,
} from "./types.js";

export class CapabilityUnavailableError extends KernelError {
  constructor(capability: CapabilityName) {
    super("CAPABILITY_UNAVAILABLE", `No implementation is registered for the “${capability}” capability.`, {
      capability,
    });
    this.name = "CapabilityUnavailableError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("Operation cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

export class CapabilityManager {
  private readonly providers = new Map<CapabilityName, CapabilityProvider>();
  private readonly grants = new Map<string, Set<CapabilityName>>();
  private readonly policy: PermissionPolicy;

  constructor(policy?: PermissionPolicy) {
    this.policy = policy ?? { decide: () => false };
  }

  register<T>(name: CapabilityName, provider: CapabilityProvider<T>): () => void {
    const normalized = name.trim();
    if (!normalized) throw new KernelError("INVALID_CAPABILITY", "Capability names cannot be empty.");
    if (this.providers.has(normalized)) {
      throw new KernelError("DUPLICATE_CAPABILITY", `Capability “${normalized}” is already registered.`);
    }
    this.providers.set(normalized, provider);
    return () => {
      if (this.providers.get(normalized) === provider) this.providers.delete(normalized);
    };
  }

  hasProvider(name: CapabilityName): boolean {
    return this.providers.has(name);
  }

  async request(pluginId: string, requests: readonly CapabilityRequest[], signal = new AbortController().signal): Promise<readonly CapabilityName[]> {
    const unique = [...new Map(requests.map((request) => [request.name, request])).values()];
    const pending: CapabilityRequest[] = [];
    const alreadyGranted = this.grants.get(pluginId) ?? new Set<CapabilityName>();

    for (const request of unique) {
      throwIfAborted(signal);
      if (request.name.trim() !== request.name || request.name.length === 0) {
        throw new KernelError("INVALID_CAPABILITY", "Capability names must be non-empty and trimmed.");
      }
      if (alreadyGranted.has(request.name)) continue;
      if (!this.providers.has(request.name)) {
        if (request.optional === true) continue;
        throw new CapabilityUnavailableError(request.name);
      }
      pending.push(request);
    }

    const approved: CapabilityName[] = [];
    for (const request of pending) {
      throwIfAborted(signal);
      const allowed = await this.policy.decide({ ...request, pluginId });
      if (!allowed) {
        if (request.optional === true) continue;
        throw new PermissionDeniedError(pluginId, request.name, request.reason);
      }
      approved.push(request.name);
    }

    if (approved.length > 0) {
      const grant = this.grants.get(pluginId) ?? new Set<CapabilityName>();
      for (const name of approved) grant.add(name);
      this.grants.set(pluginId, grant);
    }
    return [...new Set([...alreadyGranted, ...approved])];
  }

  isGranted(pluginId: string, name: CapabilityName): boolean {
    return this.grants.get(pluginId)?.has(name) ?? false;
  }

  async get<T>(pluginId: string, name: CapabilityName, signal = new AbortController().signal): Promise<T> {
    throwIfAborted(signal);
    if (!this.isGranted(pluginId, name)) throw new PermissionDeniedError(pluginId, name);
    const provider = this.providers.get(name);
    if (provider === undefined) throw new CapabilityUnavailableError(name);
    return provider.provide({ pluginId, signal }) as T | Promise<T>;
  }

  scope(pluginId: string, allowedNames: readonly CapabilityName[], signal = new AbortController().signal): CapabilityScope {
    const allowed = new Set(allowedNames);
    return {
      has: (name) => allowed.has(name) && this.isGranted(pluginId, name),
      get: async <T>(name: CapabilityName) => {
        if (!allowed.has(name)) throw new PermissionDeniedError(pluginId, name, "The plugin did not request this capability.");
        return this.get<T>(pluginId, name, signal);
      },
    };
  }

  revoke(pluginId: string, names?: readonly CapabilityName[]): void {
    if (names === undefined) {
      this.grants.delete(pluginId);
      return;
    }
    const grant = this.grants.get(pluginId);
    if (grant === undefined) return;
    for (const name of names) grant.delete(name);
    if (grant.size === 0) this.grants.delete(pluginId);
  }

  grantedFor(pluginId: string): readonly CapabilityName[] {
    return [...(this.grants.get(pluginId) ?? [])].sort();
  }
}