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
import type { Provider, SampleOutcome } from "../providers/provider.js";
import { DEFAULT_PER_CALL_TIMEOUT_MS, type DecideConfig } from "./config.js";
import type { MetaBuilder } from "./meta.js";

/**
 * Process-wide in-flight dedup. Concurrent calls with the same cache key
 * share a single Promise; the *raw* Distribution is shared, while each caller
 * still applies its own calibrator and thresholds. Reported usage is shared
 * too (the numbers are real for every rider), but only the initiating caller
 * may attribute the spend to its Verdict — the call happened once and must
 * be paid for once. `LoadedSample.sharedFromInFlight` carries that split.
 */
const globalInFlight = new InFlight<SampleOutcome<string>>();

/**
 * A `SampleOutcome` plus how the engine obtained it: `sharedFromInFlight`
 * marks riders on another caller's in-flight request, whose usage informs
 * spans but must not be double-attributed to cost or double-emitted as
 * `cost_usd`.
 */
export type LoadedSample<T extends string> = SampleOutcome<T> & {
  readonly sharedFromInFlight: boolean;
};

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
): Promise<LoadedSample<T>> {
  const cached = await config.cache.get(cacheKey);
  if (cached !== undefined) {
    const parsed = deserializeCachedValue<T>(cached);
    if (parsed !== undefined) {
      meta.cacheHit = true;
      return { distribution: parsed, sharedFromInFlight: false };
    }
    // Schema mismatch → fresh sample.
  }
  const fresh = await fetchFresh(provider, formattedInput, config, signal, cacheKey);
  await config.cache.set(cacheKey, serializeCachedValue(fresh.distribution));
  return fresh;
}

async function fetchFresh<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  signal: AbortSignal,
  cacheKey: string,
): Promise<LoadedSample<T>> {
  let initiatedHere = false;
  const outcome = (await globalInFlight.run(cacheKey, () => {
    initiatedHere = true;
    return provider.sample<T>(formattedInput, config.space, {
      template: config.template,
      temperature: config.temperature,
      timeoutMs: config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS,
      signal,
    });
  })) as SampleOutcome<T>;
  return { ...outcome, sharedFromInFlight: !initiatedHere };
}

/**
 * Drop the in-flight slot for a key after a failed sample so a concurrent
 * caller in another classifier doesn't keep getting served the failed Promise.
 */
export function forgetInFlight(cacheKey: string): void {
  globalInFlight.forget(cacheKey);
}
