/**
 * `VerdictMeta` builder — accumulates state across the engine's chain
 * (providers attempted, errors swallowed, latency, cache hits) and produces
 * the final `meta` object on every Verdict variant.
 */

import type { Provider } from "../providers/provider.js";
import type { SerializableError, VerdictMeta } from "../types.js";

type ProviderErrorRecord = {
  readonly providerId: string;
  readonly error: SerializableError;
};

/**
 * Mutable accumulator used by `decide()`. Only the helpers in this file should
 * mutate it; callers append to `providersAttempted` / `providerErrors` and
 * flip `cacheHit` directly.
 */
export type MetaBuilder = {
  readonly providersAttempted: string[];
  readonly providerErrors: ProviderErrorRecord[];
  readonly startedAtMs: number;
  cacheHit: boolean;
};

export function makeMetaBuilder(): MetaBuilder {
  return {
    providersAttempted: [],
    providerErrors: [],
    startedAtMs: Date.now(),
    cacheHit: false,
  };
}

/**
 * Build the final `VerdictMeta` for a Classified or Uncertain Verdict produced
 * by a specific (successful) provider.
 */
export function buildMeta(builder: MetaBuilder, provider: Provider): VerdictMeta {
  return {
    providerUsed: provider.id,
    providersAttempted: [...builder.providersAttempted],
    providerErrors: [...builder.providerErrors],
    latencyMs: Date.now() - builder.startedAtMs,
    cacheHit: builder.cacheHit,
    coverageQuality: provider.capabilities.coverageMeasurement,
    distributionSource: provider.capabilities.distributionSource,
  };
}

/**
 * Build `VerdictMeta` for failure-mode Verdicts (provider_failure,
 * chain_exhausted, cancelled, budget_exhausted) where there's no clear
 * "successful provider" to attribute. Falls back to the last-attempted
 * provider for `providerUsed`, or the empty string when none was attempted.
 */
export function buildMetaForFailure(
  builder: MetaBuilder,
  fallbackProvider?: Provider,
): VerdictMeta {
  const providerUsed = fallbackProvider?.id ?? builder.providersAttempted.at(-1) ?? "";
  return {
    providerUsed,
    providersAttempted: [...builder.providersAttempted],
    providerErrors: [...builder.providerErrors],
    latencyMs: Date.now() - builder.startedAtMs,
    cacheHit: builder.cacheHit,
    coverageQuality: fallbackProvider?.capabilities.coverageMeasurement ?? "none",
    distributionSource: fallbackProvider?.capabilities.distributionSource ?? "logprobs",
  };
}
