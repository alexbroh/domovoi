/**
 * Engine configuration: `DecideConfig`, defaults, validation, and the
 * `withDefaults` builder used by verbs and one-shots.
 *
 * `DecideConfig` is the engine's internal contract — verbs (boolean,
 * classify, classifier) translate user-facing options into this shape.
 */

import { type Cache, memoryCache } from "../cache.js";
import type { Calibrator } from "../calibration/index.js";
import { identity, isIdentityCalibrator } from "../calibration/index.js";
import type { ProviderError } from "../errors.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, PromptTemplate, Thresholds } from "../types.js";
import {
  validateCalibratorCompatibility,
  validateClassifierName,
  validateProviderChain,
  validateSpace,
  validateThresholds,
} from "../validate.js";

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_PER_CALL_TIMEOUT_MS = 10_000;
export const DEFAULT_CHAIN_TIMEOUT_MS = 30_000;

// ─── DecideConfig — engine's internal contract ──────────────────────

export type OnProviderErrorHook = (
  err: ProviderError,
  ctx: { providerId: string; attempt: number },
) => void | Promise<void>;

export type EngineHooks = {
  onCall?: (...args: unknown[]) => void | Promise<void>;
  onResult?: (...args: unknown[]) => void | Promise<void>;
};

export type DecideConfig<T extends string> = {
  readonly space: readonly T[];
  readonly thresholds: Thresholds<readonly T[]>;
  readonly providers: readonly Provider[];
  readonly calibrator: Calibrator;
  readonly cache: Cache;
  readonly template: PromptTemplate;
  readonly question?: string;
  readonly budget?: Budget;
  readonly onErrorPolicy: "fallback" | "throw";
  readonly onProviderError?: OnProviderErrorHook;
  readonly hooks?: EngineHooks;
  /** Provider-config hash for cache key (G1, M4). Empty `""` for no extra opts. */
  readonly providerConfigHash: string;
  /** Engine sends temperature: 0 in v0 (H2). */
  readonly temperature: number;
};

// ─── withDefaults builder ───────────────────────────────────────────

export type DecideConfigInput<T extends string> = {
  readonly space: readonly T[];
  readonly thresholds: Thresholds<readonly T[]>;
  readonly providers: readonly Provider[];
  readonly calibrator?: Calibrator;
  readonly cache?: Cache;
  readonly template?: PromptTemplate;
  readonly question?: string;
  readonly budget?: Budget;
  readonly onErrorPolicy?: "fallback" | "throw";
  readonly onProviderError?: OnProviderErrorHook;
  readonly hooks?: EngineHooks;
  readonly providerConfigHash?: string;
};

/**
 * Apply engine-level defaults (identity calibrator, fresh in-memory cache,
 * default prompt template, fallback error policy, provider_config_hash = "",
 * temperature: 0) to a partial config. Used by verbs to materialize a
 * DecideConfig from caller-facing options.
 */
export function withDefaults<T extends string>(input: DecideConfigInput<T>): DecideConfig<T> {
  return {
    space: input.space,
    thresholds: input.thresholds,
    providers: input.providers,
    calibrator: input.calibrator ?? identity,
    cache: input.cache ?? memoryCache(),
    template: input.template ?? defaultTemplate,
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    onErrorPolicy: input.onErrorPolicy ?? "fallback",
    ...(input.onProviderError !== undefined ? { onProviderError: input.onProviderError } : {}),
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
    providerConfigHash: input.providerConfigHash ?? "",
    temperature: 0,
  };
}

// ─── Construction-time validation ───────────────────────────────────

export type ValidateClassifierConfigInput<T extends string> = {
  readonly name?: string;
  readonly space: readonly T[];
  readonly thresholds: Thresholds<readonly T[]>;
  readonly providers: readonly Provider[];
  readonly calibrator: Calibrator;
};

/**
 * Validate a classifier configuration at construction. Throws ConfigError
 * with appropriate `code` on any validation failure.
 *
 * Validation order (each step throws ConfigError on failure):
 *   1. `name` (G10): regex-shape check
 *   2. `space` (J2): empty / duplicate / whitespace / singleton
 *   3. `providers` chain (M1, lock #1): non-empty + chain-min top-K cap
 *   4. `thresholds` (H1): range + binary deadband ordering
 *   5. `calibrator` × providers (S3): multi_sample = identity-only
 *   6. Each provider's optional `validate(space)` hook — gives tokenizer-aware
 *      adapters (e.g., OpenAI) the chance to detect first-token collisions
 *      eagerly at classifier construction rather than lazily on first sample.
 *
 * Used by `classifier({...})` and by one-shot verbs (which validate lazily on
 * first call).
 */
export function validateClassifierConfig<T extends string>(
  input: ValidateClassifierConfigInput<T>,
): void {
  if (input.name !== undefined) validateClassifierName(input.name);
  validateSpace(input.space);
  validateProviderChain(input.providers, input.space.length);
  validateThresholds(input.thresholds, input.space.length);
  validateCalibratorCompatibility(isIdentityCalibrator(input.calibrator), input.providers);
  // for-of: side-effect iteration; if any provider's validate throws, the
  // exception propagates immediately (which forEach also supports, but for-of
  // gives cleaner stack traces and matches modern TS conventions).
  for (const provider of input.providers) {
    provider.validate?.(input.space);
  }
}
