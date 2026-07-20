/**
 * `VerdictMeta` builder — accumulates state across the engine's chain
 * (providers attempted, errors swallowed, latency, cache hits) and produces
 * the final `meta` object on every Verdict variant.
 */

import { computeUsd } from "../providers/pricing.js";
import type { Provider } from "../providers/provider.js";
import type { SerializableError, TokenUsage, VerdictCost, VerdictMeta } from "../types.js";

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
  /** Reported-usage totals across every provider call made for this Verdict. */
  spentInputTokens: number;
  spentOutputTokens: number;
  spentUsd: number;
  /** False once any usage-reporting provider lacked pricing — USD is then omitted. */
  usdComplete: boolean;
  /** True once any provider call reported usage — gates `meta.cost` emission. */
  sawReportedUsage: boolean;
};

export function makeMetaBuilder(): MetaBuilder {
  return {
    providersAttempted: [],
    providerErrors: [],
    startedAtMs: Date.now(),
    cacheHit: false,
    spentInputTokens: 0,
    spentOutputTokens: 0,
    spentUsd: 0,
    usdComplete: true,
    sawReportedUsage: false,
  };
}

/**
 * Accumulate one provider call's reported usage. Returns that call's USD
 * spend when the provider has pricing (for the per-call span attribute).
 */
export function recordSpend(
  builder: MetaBuilder,
  provider: Provider,
  usage: TokenUsage,
): number | undefined {
  builder.sawReportedUsage = true;
  builder.spentInputTokens += usage.inputTokens;
  builder.spentOutputTokens += usage.outputTokens;
  const usd = computeUsd(provider.pricing, usage);
  if (usd === undefined) {
    builder.usdComplete = false;
  } else {
    builder.spentUsd += usd;
  }
  return usd;
}

function buildCost(builder: MetaBuilder): VerdictCost | undefined {
  if (!builder.sawReportedUsage) return undefined;
  return {
    inputTokens: builder.spentInputTokens,
    outputTokens: builder.spentOutputTokens,
    ...(builder.usdComplete ? { usd: builder.spentUsd } : {}),
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
    ...costField(builder),
  };
}

function costField(builder: MetaBuilder): { cost: VerdictCost } | Record<string, never> {
  const cost = buildCost(builder);
  return cost === undefined ? {} : { cost };
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
    ...costField(builder),
  };
}
