/**
 * Construction-time validators throw `ConfigError`; the runtime
 * `validateDistribution` (called by the engine after `Provider.sample` returns)
 * throws `ProviderError`.
 */

import { ConfigError, ProviderError } from "./errors.js";
import type { Distribution, ProviderCapabilities, Thresholds } from "./types.js";

/**
 * Throws if the decision space contains: empty labels (post-NFC + trim),
 * duplicates (post-NFC), whitespace-padded labels, or fewer than 2 entries.
 *
 * The empty-array case is also rejected at the type level via the
 * `readonly [T, ...T[]]` shape on classifier configs.
 */
export function validateSpace(space: readonly string[]): void {
  if (space.length < 2) {
    throw new ConfigError(`Decision space must have at least 2 labels; got ${space.length}.`, {
      code: "invalid_space",
    });
  }
  const seen = new Set<string>();
  for (let i = 0; i < space.length; i++) {
    const label = space[i] as string;
    if (label !== label.trim()) {
      throw new ConfigError(
        `Decision space label at index ${i} has leading/trailing whitespace: ${JSON.stringify(label)}.`,
        { code: "invalid_space" },
      );
    }
    const normalized = label.normalize("NFC");
    if (!normalized) {
      throw new ConfigError(`Decision space label at index ${i} is empty.`, {
        code: "invalid_space",
      });
    }
    if (seen.has(normalized)) {
      throw new ConfigError(`Decision space contains duplicate label: ${JSON.stringify(label)}.`, {
        code: "invalid_space",
      });
    }
    seen.add(normalized);
  }
}

/**
 * Validate threshold values at construction. Inclusive [0, 1] range; binary
 * requires `high > low` strict; `margin >= 0` if present.
 */
export function validateThresholds<S extends readonly string[]>(
  thresholds: Thresholds<S>,
  spaceLength: number,
): void {
  const t = thresholds as {
    high: number;
    low?: number;
    margin?: number;
    coverageMin?: number;
  };

  inRange01("high", t.high);
  if (t.coverageMin !== undefined) inRange01("coverageMin", t.coverageMin);

  if (spaceLength === 2) {
    if (t.low === undefined) {
      throw new ConfigError("Binary classifier requires `thresholds.low`.", {
        code: "invalid_thresholds",
      });
    }
    inRange01("low", t.low);
    if (!(t.high > t.low)) {
      throw new ConfigError(
        `Binary deadband requires high > low strict; got high=${t.high}, low=${t.low}.`,
        { code: "invalid_thresholds" },
      );
    }
  } else {
    if (t.margin !== undefined) {
      if (t.margin < 0 || t.margin > 1 || Number.isNaN(t.margin)) {
        throw new ConfigError(`thresholds.margin must be in [0, 1]; got ${t.margin}.`, {
          code: "invalid_thresholds",
        });
      }
    }
  }
}

function inRange01(name: string, value: number): void {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new ConfigError(`thresholds.${name} must be in [0, 1] inclusive; got ${value}.`, {
      code: "invalid_thresholds",
    });
  }
}

const CLASSIFIER_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export function validateClassifierName(name: string): void {
  if (!CLASSIFIER_NAME_REGEX.test(name)) {
    throw new ConfigError(
      `Classifier name must match /^[a-z][a-z0-9_]*$/; got ${JSON.stringify(name)}.`,
      { code: "invalid_classifier_name" },
    );
  }
}

/**
 * Validates the provider chain. Throws if the array is empty, or if the
 * decision space exceeds the smallest `maxTopLogprobs` across all
 * `distributionSource: "logprobs"` providers in the chain (multi-sample
 * providers have no top-K constraint and are exempt).
 */
export function validateProviderChain(
  providers: ReadonlyArray<{ readonly id: string; readonly capabilities: ProviderCapabilities }>,
  spaceLength: number,
): void {
  if (providers.length === 0) {
    throw new ConfigError("Provider chain is empty; supply at least one provider.", {
      code: "empty_providers",
    });
  }

  const logprobsCaps = providers
    .filter((p) => p.capabilities.distributionSource === "logprobs")
    .map((p) => ({ id: p.id, cap: p.capabilities.maxTopLogprobs }));

  if (logprobsCaps.length === 0) return; // all multi_sample; no top-K cap applies

  const min = logprobsCaps.reduce(
    (acc, p) => (p.cap < acc.cap ? p : acc),
    logprobsCaps[0] as { id: string; cap: number },
  );

  if (spaceLength > min.cap) {
    throw new ConfigError(
      `Decision space size (${spaceLength}) exceeds provider ${min.id}'s top-K cap (${min.cap}). Reduce space size or replace the provider.`,
      { code: "decision_space_too_large" },
    );
  }
}

const SUM_TOLERANCE = 0.001;

/**
 * Engine-side check on every Distribution returned by `Provider.sample`,
 * before calibration. Verifies coverage and per-prob range, fills missing
 * in-space labels with `0` (mutates `probs`), and asserts sum-to-one within
 * a fixed tolerance. Throws `ProviderError` on violation — surfaces buggy
 * custom Provider implementations.
 */
export function validateDistribution<T extends string>(
  d: Distribution<T>,
  space: readonly T[],
): void {
  if (Number.isNaN(d.coverage) || d.coverage < 0 || d.coverage > 1) {
    throw new ProviderError(`Invalid Distribution.coverage: ${d.coverage} (must be in [0, 1]).`, {
      code: "invalid_distribution",
    });
  }

  const probs = d.probs as Record<string, number | undefined>;
  for (const [label, prob] of Object.entries(probs)) {
    if (prob === undefined) continue;
    if (Number.isNaN(prob) || prob < 0 || prob > 1) {
      throw new ProviderError(
        `Invalid probability for label ${JSON.stringify(label)}: ${prob} (must be in [0, 1]).`,
        { code: "invalid_distribution" },
      );
    }
  }

  // Missing in-space labels (first-token outside provider top-K) get 0.
  for (const label of space) {
    if (!(label in probs)) {
      probs[label] = 0;
    }
  }

  let sum = 0;
  for (const label of space) {
    sum += probs[label] ?? 0;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new ProviderError(
      `Distribution probs sum to ${sum.toFixed(6)}; expected 1 ± ${SUM_TOLERANCE}.`,
      { code: "invalid_distribution" },
    );
  }
}
