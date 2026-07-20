/**
 * Cache primitives.
 *
 * The public `Cache` interface is async, opaque-string-valued, and requires
 * `delete`. The engine owns serialization; backends (Redis, KV, SQLite,
 * in-memory) just round-trip strings.
 *
 * `InFlight` is the engine-side dedup table — concurrent calls with the same
 * key share one Promise. Distinct from the `Cache` interface so external
 * backends never see in-flight state.
 */

import { canonicalJSON, normalizeInput, sha256 } from "./hash.js";
import type { Distribution } from "./types.js";

/**
 * Bump manually only when a change would make existing cache entries
 * semantically wrong (cache key composition, stored value shape, provider
 * distribution computation). Library-version bumps alone do not bump this.
 */
export const CACHE_SCHEMA_VERSION = 1;

type CacheKeyInputs = {
  readonly providerId: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly templateHash: string;
  /**
   * Decision space in user-given order. Re-ordering changes the prompt — and
   * therefore the model output — so it must change the cache key.
   */
  readonly decisionSpace: readonly string[];
  /** `null` when deferred to the provider default (distinct from explicit 0). */
  readonly temperature: number | null;
  /**
   * Stable hash of provider options that affect Distribution shape (e.g.
   * `multiSampleN`). Empty string for providers without such options.
   */
  readonly providerConfigHash: string;
  /** Output of `classifier({ format })`, not the raw input. */
  readonly formattedInput: string;
};

/**
 * SHA-256 hex digest over canonical-JSON of all inputs. Stable across
 * processes — safe for persistent backends.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  return sha256(
    canonicalJSON({
      cache_schema_version: CACHE_SCHEMA_VERSION,
      provider_id: inputs.providerId,
      model_id: inputs.modelId,
      tokenizer_id: inputs.tokenizerId,
      template_hash: inputs.templateHash,
      decision_space: inputs.decisionSpace,
      temperature: inputs.temperature,
      provider_config_hash: inputs.providerConfigHash,
      input_hash: sha256(normalizeInput(inputs.formattedInput)),
    }),
  );
}

type CachedValue = {
  readonly schemaVersion: number;
  readonly distribution: Distribution<string>;
  readonly storedAt: number;
};

export function serializeCachedValue<T extends string>(d: Distribution<T>): string {
  const value: CachedValue = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    distribution: d,
    storedAt: Date.now(),
  };
  return JSON.stringify(value);
}

/**
 * Returns `undefined` on a stored-schema-version mismatch; the engine treats
 * that as a miss and re-samples from the provider.
 */
export function deserializeCachedValue<T extends string>(raw: string): Distribution<T> | undefined {
  try {
    const parsed = JSON.parse(raw) as CachedValue;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
    return parsed.distribution as Distribution<T>;
  } catch {
    return undefined;
  }
}

/**
 * @example
 * const redisCache: Cache = {
 *   async get(key) { return await redis.get(key); },
 *   async set(key, value, ttlMs) {
 *     if (ttlMs !== undefined) await redis.set(key, value, "PX", ttlMs);
 *     else await redis.set(key, value);
 *   },
 *   async delete(key) { await redis.del(key); },
 * };
 */
export interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CacheStats = {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
};

/**
 * Optional extension over `Cache`. The built-in `memoryCache` implements it;
 * external backends may opt in.
 */
export interface CacheWithStats extends Cache {
  stats(): CacheStats;
}

type Entry = {
  value: string;
  expiresAt: number | undefined;
};

/**
 * Count-bounded in-memory LRU cache. Used as the per-classifier default when
 * `cache` isn't supplied. Eviction runs after every successful `set`; the
 * cache may briefly hold `maxEntries + concurrent-in-flight` entries during
 * concurrent writes, then drops back to bound.
 *
 * @param options.maxEntries  Default 10_000.
 * @param options.defaultTtlMs  Optional fallback TTL when `set` omits it.
 */
export function memoryCache(options?: {
  maxEntries?: number;
  defaultTtlMs?: number;
}): CacheWithStats {
  const maxEntries = options?.maxEntries ?? 10_000;
  const defaultTtlMs = options?.defaultTtlMs;

  // Map preserves insertion order; re-inserting a key on access bumps it to MRU.
  const store = new Map<string, Entry>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  return {
    async get(key: string): Promise<string | undefined> {
      const entry = store.get(key);
      if (entry === undefined) {
        misses++;
        return undefined;
      }
      if (isExpired(entry)) {
        store.delete(key);
        misses++;
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      hits++;
      return entry.value;
    },

    async set(key: string, value: string, ttlMs?: number): Promise<void> {
      const ttl = ttlMs ?? defaultTtlMs;
      const expiresAt = ttl !== undefined ? Date.now() + ttl : undefined;
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
        evictions++;
      }
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    stats(): CacheStats {
      return {
        size: store.size,
        hits,
        misses,
        evictions,
      };
    },
  };
}

/**
 * Engine-side dedup table. Two callers hitting the same key concurrently
 * share a single Promise; on settle the slot is cleared.
 */
export class InFlight<V> {
  private readonly map = new Map<string, Promise<V>>();

  async run(key: string, factory: () => Promise<V>): Promise<V> {
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    const promise = factory().finally(() => {
      this.map.delete(key);
    });
    this.map.set(key, promise);
    return promise;
  }

  /** Drop the in-flight slot for `key`, allowing the next caller to retry. */
  forget(key: string): void {
    this.map.delete(key);
  }
}
