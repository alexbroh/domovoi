/**
 * Cache lookup, in-flight dedup, and per-attempt cache-key composition.
 * The provider call itself happens inside `loadDistribution`; the engine
 * orchestrator never invokes `Provider.sample` directly.
 */

import {
  computeCacheKey,
  deserializeCachedValue,
  InFlight,
  serializeCachedValue,
} from "../cache.js";
import type { Provider } from "../providers/provider.js";
import type { Distribution } from "../types.js";
import { DEFAULT_PER_CALL_TIMEOUT_MS, type DecideConfig } from "./config.js";
import type { MetaBuilder } from "./meta.js";

/**
 * Process-wide in-flight dedup. Concurrent calls with the same cache key
 * share a single Promise; the *raw* Distribution is shared, while each caller
 * still applies its own calibrator and thresholds.
 */
const globalInFlight = new InFlight<Distribution<string>>();

export function computeProviderCacheKey<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
): string {
  return computeCacheKey({
    providerId: provider.id,
    modelId: provider.modelId,
    tokenizerId: provider.tokenizerId,
    templateHash: config.template.templateHash,
    decisionSpace: config.space,
    temperature: config.temperature ?? null,
    providerConfigHash: provider.configHash ?? config.providerConfigHash,
    formattedInput,
  });
}

export function mergeSignals(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  scopeSignal?: AbortSignal,
): AbortSignal {
  const signals: AbortSignal[] = [timeoutSignal];
  if (userSignal) signals.push(userSignal);
  if (scopeSignal) signals.push(scopeSignal);
  return AbortSignal.any(signals);
}

export async function loadDistribution<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  meta: MetaBuilder,
  signal: AbortSignal,
  cacheKey: string,
): Promise<Distribution<T>> {
  const cached = await config.cache.get(cacheKey);
  if (cached !== undefined) {
    const parsed = deserializeCachedValue<T>(cached);
    if (parsed !== undefined) {
      meta.cacheHit = true;
      return parsed;
    }
    // Schema mismatch → fresh sample.
  }
  const fresh = await fetchFresh(provider, formattedInput, config, signal, cacheKey);
  await config.cache.set(cacheKey, serializeCachedValue(fresh));
  return fresh;
}

async function fetchFresh<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  signal: AbortSignal,
  cacheKey: string,
): Promise<Distribution<T>> {
  return globalInFlight.run(cacheKey, () =>
    provider.sample<T>(formattedInput, config.space, {
      template: config.template,
      temperature: config.temperature,
      timeoutMs: config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS,
      signal,
    }),
  ) as Promise<Distribution<T>>;
}

/**
 * Drop the in-flight slot for a key after a failed sample so a concurrent
 * caller in another classifier doesn't keep getting served the failed Promise.
 */
export function forgetInFlight(cacheKey: string): void {
  globalInFlight.forget(cacheKey);
}
