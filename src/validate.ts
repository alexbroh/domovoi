/**
 * Construction-time and runtime validation.
 *
 * Construction-time (throws ConfigError):
 *   - validateSpace: empty / duplicate / whitespace-padded / singleton (J2)
 *   - validateThresholds: range and ordering (H1)
 *   - validateCalibratorCompatibility: Platt binary-only; multi-sample = identity-only
 *   - validateProviders: non-empty array (M1); chain-min top-K cap (lock #1)
 *   - validateClassifierName: regex /^[a-z][a-z0-9_]*$/ (G10)
 *
 * Runtime (throws ProviderError):
 *   - validateDistribution: coverage range, per-prob range, sum-to-1, missing-keys → 0 (L2)
 */

import { ConfigError, ProviderError } from "./errors.js";
import type { Distribution, ProviderCapabilities, Thresholds } from "./types.js";

// ─── Decision-space validation (J2) ─────────────────────────────────

/**
 * Validate the decision space at construction. Throws ConfigError if any rule fails:
 * - No empty (post-NFC + trim) labels.
 * - No whitespace-padded labels (catches copy-paste errors).
 * - No duplicate labels (post-NFC normalize).
 * - No singleton spaces (length 1).
 *
 * Note: T1 (`readonly [T, ...T[]]`) handles the empty-array case at the type level.
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
    if (normalized.length === 0) {
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

// ─── Threshold validation (H1) ──────────────────────────────────────

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

// ─── Classifier name validation (G10) ───────────────────────────────

const CLASSIFIER_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export function validateClassifierName(name: string): void {
  if (!CLASSIFIER_NAME_REGEX.test(name)) {
    throw new ConfigError(
      `Classifier name must match /^[a-z][a-z0-9_]*$/; got ${JSON.stringify(name)}.`,
      { code: "invalid_classifier_name" },
    );
  }
}

// ─── Provider chain validation (M1, lock #1) ────────────────────────

/**
 * Validate the provider chain at construction.
 * - Non-empty array (M1).
 * - Chain-min top-K cap across `distributionSource: "logprobs"` providers (lock #1):
 *   space.length must not exceed the smallest maxTopLogprobs in the chain.
 *   `multi_sample` providers are exempt.
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

// ─── Calibrator compatibility (S3) ──────────────────────────────────

/**
 * Validate calibrator vs provider chain capabilities at construction.
 * Multi-sample providers cannot use non-identity calibrators in v0.
 */
export function validateCalibratorCompatibility(
  calibratorIsIdentity: boolean,
  providers: ReadonlyArray<{ readonly id: string; readonly capabilities: ProviderCapabilities }>,
): void {
  if (calibratorIsIdentity) return;
  const multiSample = providers.find((p) => p.capabilities.distributionSource === "multi_sample");
  if (multiSample) {
    throw new ConfigError(
      `Provider ${multiSample.id} uses distributionSource: "multi_sample"; non-identity calibrators are not supported on multi-sample providers in v0. Use 'identity' calibrator or remove the multi-sample provider from the chain.`,
      { code: "incompatible_calibrator" },
    );
  }
}

// ─── Runtime distribution validation (L2) ───────────────────────────

const SUM_TOLERANCE = 0.001;

/**
 * Validate Distribution at engine boundary post-`provider.sample`.
 *
 * - coverage ∈ [0, 1]
 * - each prob ∈ [0, 1]
 * - missing in-space labels → assigned 0 (per G2; mutates `probs`)
 * - sum of probs ≈ 1 within tolerance 0.001
 *
 * Catches buggy custom Provider implementations early. Throws ProviderError.
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

  // Per-prob range check (allow 0; engine fills missing keys)
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

  // Fill missing in-space labels with 0 (G2). Mutate the probs map.
  for (const label of space) {
    if (!(label in probs)) {
      probs[label] = 0;
    }
  }

  // Sum-to-1 within tolerance.
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
