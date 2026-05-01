/**
 * Cache primitives.
 *
 * Public Cache interface (per C6) is async + opaque-string in/out + required
 * delete. Engine handles serialization/deserialization; backends (Redis, KV,
 * SQLite, in-memory) just roundtrip strings.
 *
 * Built-in: `memoryCache({ maxEntries, defaultTtlMs })` — count-based LRU,
 * eviction on write-completion (G11). Per-classifier default (J1) — when
 * a classifier doesn't pass `cache`, a fresh memoryCache is constructed.
 *
 * In-flight dedup (lock for cache.ts via PLAN.md L327): concurrent calls with
 * the same key share one in-flight Promise. Lives at the engine layer, not in
 * the Cache interface — the cache only sees completed Distributions to store.
 */

import { canonicalJSON, normalizeInput, sha256 } from "./hash.js";
import type { Distribution } from "./types.js";

// ─── Cache schema constants ─────────────────────────────────────────

/**
 * Bumped manually only when changes to cache key composition, cached value
 * shape, or provider distribution computation would invalidate prior entries.
 * Library version bumps alone do NOT bump this (K1).
 */
export const CACHE_SCHEMA_VERSION = 1;

// ─── Cache key composition ──────────────────────────────────────────

export type CacheKeyInputs = {
  readonly providerId: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  /** Stable hash from PromptTemplate.templateHash (R14). */
  readonly templateHash: string;
  /** Decision space in USER-GIVEN order (K3). */
  readonly decisionSpace: readonly string[];
  /** Engine sends temperature: 0 in v0 (H2). */
  readonly temperature: number;
  /**
   * SHA-256 of canonical-JSON of provider-specific opts that affect
   * Distribution shape (multiSampleN, future verbalizedConfidence, etc.).
   * Empty `{}` → "" hash for v0 logprobs adapters with no extra opts (M4).
   */
  readonly providerConfigHash: string;
  /** Formatted input string (post `format(input)`). */
  readonly formattedInput: string;
};

/**
 * Compute the cache key from its inputs. SHA-256 over canonical-JSON of all
 * inputs; produces a stable hex digest used as the public cache key.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  return sha256(
    canonicalJSON({
      cache_schema_version: CACHE_SCHEMA_VERSION,
      provider_id: inputs.providerId,
      model_id: inputs.modelId,
      tokenizer_id: inputs.tokenizerId,
      template_hash: inputs.templateHash,
      decision_space: inputs.decisionSpace, // user-given order; not sorted (K3)
      temperature: inputs.temperature,
      provider_config_hash: inputs.providerConfigHash,
      input_hash: sha256(normalizeInput(inputs.formattedInput)),
    }),
  );
}

// ─── Cached value shape (engine-internal) ───────────────────────────

/**
 * Engine-controlled wrapper around a cached Distribution. Serialized to JSON
 * (an opaque string from the Cache interface's POV). Schema evolution is
 * fully internal to the engine — Cache impls don't know this shape.
 */
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
 * Deserialize a cached string into a Distribution. Returns `undefined` if the
 * stored schema version doesn't match (engine treats as a miss; falls through
 * to provider).
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

// ─── Public Cache interface (H3) ────────────────────────────────────

/**
 * Async, opaque-string Cache interface.
 *
 * Implementations (Redis, KV, SQLite, in-memory) only need to roundtrip strings
 * and respect optional TTL. Schema evolution is engine-internal.
 *
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

// ─── Cache stats (R7) ───────────────────────────────────────────────

export type CacheStats = {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
};

/**
 * In-memory caches built by `memoryCache(...)` expose stats via a non-standard
 * `stats()` method. External Cache implementations may opt into this if useful;
 * the public Cache interface does not require it.
 */
export interface CacheWithStats extends Cache {
  stats(): CacheStats;
}

// ─── memoryCache factory (default for J1) ───────────────────────────

type Entry = {
  value: string;
  expiresAt: number | undefined;
};

/**
 * In-memory LRU cache. Default for classifiers that don't supply their own
 * `cache` (J1: per-classifier default). Count-based eviction (S9). Eviction
 * fires on write-completion (G11).
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

  // JS Map preserves insertion order; we move entries to the back on access
  // to implement LRU.
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
      // Move to MRU position.
      store.delete(key);
      store.set(key, entry);
      hits++;
      return entry.value;
    },

    async set(key: string, value: string, ttlMs?: number): Promise<void> {
      const ttl = ttlMs ?? defaultTtlMs;
      const expiresAt = ttl !== undefined ? Date.now() + ttl : undefined;
      // If existing key, remove first to refresh insertion order.
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt });
      // Evict LRU until under cap (G11: on write-completion).
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

// ─── In-flight deduplication helper ─────────────────────────────────

/**
 * In-flight dedup table: concurrent calls with the same key share one Promise.
 * Used by the engine to wrap `provider.sample` calls. Operates at the engine
 * layer, not the Cache interface — different classifiers with different
 * calibrators on the same cache key share the raw Distribution but apply
 * their own calibrator per-caller (G18).
 */
export class InFlight<V> {
  private readonly map = new Map<string, Promise<V>>();

  /**
   * Get-or-fetch: returns the in-flight Promise if one exists for `key`,
   * otherwise invokes `factory()` to start a new fetch. Cleans up on settle.
   */
  async run(key: string, factory: () => Promise<V>): Promise<V> {
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    const promise = factory().finally(() => {
      this.map.delete(key);
    });
    this.map.set(key, promise);
    return promise;
  }

  /** Remove a key from the in-flight table (e.g., on AbortError to allow retry). */
  forget(key: string): void {
    this.map.delete(key);
  }
}
