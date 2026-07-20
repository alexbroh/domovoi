/**
 * Construction-time validation for factory `pricing` options and the USD
 * computation the engine applies to backend-reported usage.
 */

import { ConfigError } from "../errors.js";
import type { TokenUsage } from "../types.js";
import type { ProviderPricing } from "./provider.js";

/**
 * Throws `ConfigError` unless both rates are finite and non-negative.
 * Returns the pricing unchanged so factories can validate-and-spread in one
 * expression.
 */
export function validatedPricing(pricing: ProviderPricing): ProviderPricing {
  for (const [rateName, rate] of Object.entries(pricing)) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new ConfigError(
        `pricing.${rateName} must be a finite number >= 0 (USD per million tokens); got ${rate}.`,
        { code: "malformed_provider_config" },
      );
    }
  }
  return pricing;
}

/** USD spend for one call. `undefined` when the provider has no pricing. */
export function computeUsd(
  pricing: ProviderPricing | undefined,
  usage: TokenUsage,
): number | undefined {
  if (pricing === undefined) return undefined;
  return (
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1e6
  );
}
