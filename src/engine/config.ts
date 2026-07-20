/**
 * Engine configuration: `DecideConfig`, defaults, validation, and the
 * `withDefaults` builder used by verbs and one-shots.
 *
 * `DecideConfig` is the engine's internal contract — verbs (boolean,
 * classify, classifier) translate user-facing options into this shape.
 */

import { type Cache, memoryCache } from "../cache.js";
import type { Calibrator } from "../calibration/index.js";
import { identity } from "../calibration/index.js";
import type { ProviderError } from "../errors.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, PromptTemplate, Thresholds } from "../types.js";
import {
  validateClassifierName,
  validateProviderChain,
  validateSpace,
  validateThresholds,
} from "../validate.js";

export const DEFAULT_PER_CALL_TIMEOUT_MS = 10_000;
export const DEFAULT_CHAIN_TIMEOUT_MS = 30_000;

type OnProviderErrorHook = (
  err: ProviderError,
  ctx: { providerId: string; attempt: number },
) => void | Promise<void>;

type EngineHooks = {
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
  /**
   * Stable hash of provider-specific options that affect Distribution shape
   * (e.g. `multiSampleN`). Mixed into the cache key so changing those opts is
   * a cache miss. Empty string when the provider has no such options.
   */
  readonly providerConfigHash: string;
  /**
   * `undefined` defers to the provider-appropriate default (logprobs: 0,
   * multi-sample: 1) — see `SampleOptions.temperature`.
   */
  readonly temperature: number | undefined;
};

type DecideConfigInput<T extends string> = {
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
 * Materialize a fully-defaulted `DecideConfig` from a partial input. Used by
 * verbs to translate caller-facing options into the engine's internal shape.
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
    // Deferred to the provider default; no verb exposes temperature today.
    temperature: undefined,
  };
}

type ValidateClassifierConfigInput<T extends string> = {
  readonly name?: string;
  readonly space: readonly T[];
  readonly thresholds: Thresholds<readonly T[]>;
  readonly providers: readonly Provider[];
  readonly calibrator: Calibrator;
};

/**
 * Validate a classifier configuration at construction. Throws `ConfigError`
 * with the relevant `code` on first failure; never partially configures.
 *
 * Each registered provider's optional `validate(space)` hook fires last —
 * giving tokenizer-aware adapters (e.g. OpenAI) a chance to surface
 * first-token collisions eagerly, before any network I/O.
 */
export function validateClassifierConfig<T extends string>(
  input: ValidateClassifierConfigInput<T>,
): void {
  if (input.name !== undefined) validateClassifierName(input.name);
  validateSpace(input.space);
  validateProviderChain(input.providers, input.space.length);
  validateThresholds(input.thresholds, input.space.length);
  for (const provider of input.providers) {
    provider.validate?.(input.space);
  }
}
