/**
 * Built-in calibrator factories.
 *
 *   - `identity` — pass-through; the default.
 *   - `temperatureScaling(T)` — `p^(1/T) / Σ p_j^(1/T)`; equivalent to
 *     scaling logits before softmax.
 *   - `plattScaling({ a, b })` — sigmoid scaling; binary spaces only.
 *
 * `Calibrator.apply` must be pure and stateless. The engine runs it
 * per-caller after the Distribution is loaded from the cache, so impurity
 * would leak across callers sharing a cache row.
 */

import { ConfigError } from "../errors.js";
import type { Distribution } from "../types.js";

export interface Calibrator {
  /** Identifier; `"identity"` is reserved and recognized by the engine. */
  readonly kind: string;
  apply<T extends string>(d: Distribution<T>): Distribution<T>;
}

export const identity: Calibrator = {
  kind: "identity",
  apply<T extends string>(d: Distribution<T>): Distribution<T> {
    return d;
  },
};

/**
 *   - `T = 1` → identity.
 *   - `T > 1` → softens (less peaked).
 *   - `T < 1` → sharpens (more peaked).
 *
 * Operates on probabilities (not logits) and leaves `coverage` unchanged.
 * Throws `ConfigError` on `T <= 0`.
 *
 * @example
 *   calibrator: temperatureScaling(0.85)  // user-fit on held-out eval set
 */
export function temperatureScaling(T: number): Calibrator {
  if (Number.isNaN(T) || T <= 0) {
    throw new ConfigError(`temperatureScaling(T): T must be > 0; got ${T}.`, {
      code: "incompatible_calibrator",
    });
  }
  const inverseT = 1 / T;
  return {
    kind: "temperature",
    apply<U extends string>(d: Distribution<U>): Distribution<U> {
      const scaledEntries = (Object.entries(d.probs) as [string, number][]).map(
        ([label, prob]) => [label, prob === 0 ? 0 : prob ** inverseT] as const,
      );
      const partitionFn = scaledEntries.reduce(
        (running, [, scaledProb]) => running + scaledProb,
        0,
      );
      // Degenerate input (every prob is 0) — return as-is rather than divide by 0.
      if (partitionFn === 0) return d;
      const normalizedProbs = Object.fromEntries(
        scaledEntries.map(([label, scaledProb]) => [label, scaledProb / partitionFn] as const),
      );
      return {
        probs: normalizedProbs as Distribution<U>["probs"],
        coverage: d.coverage,
      };
    },
  };
}

/**
 * Platt scaling: `sigmoid(a*z + b)` where `z = logit(p_pos)`.
 *
 * Binary-only — the second label in the distribution (in user-given order)
 * is treated as the positive class. Construction-time space-size validation
 * happens in the classifier; `apply()` re-checks at runtime as a defensive
 * guard against direct misuse.
 */
export function plattScaling(params: { a: number; b: number }): Calibrator {
  if (
    Number.isNaN(params.a) ||
    Number.isNaN(params.b) ||
    !Number.isFinite(params.a) ||
    !Number.isFinite(params.b)
  ) {
    throw new ConfigError(
      `plattScaling({ a, b }): a and b must be finite numbers; got a=${params.a}, b=${params.b}.`,
      { code: "incompatible_calibrator" },
    );
  }
  return {
    kind: "platt",
    apply<U extends string>(d: Distribution<U>): Distribution<U> {
      const labels = Object.keys(d.probs);
      if (labels.length !== 2) {
        throw new ConfigError(
          `plattScaling is binary-only; got distribution with ${labels.length} labels.`,
          { code: "incompatible_calibrator" },
        );
      }
      const [neg, pos] = labels as [string, string];
      const probs = d.probs as Record<string, number>;
      const pPos = probs[pos] ?? 0;
      // Clamp away from {0, 1} so `Math.log(p / (1 - p))` is finite.
      const eps = 1e-9;
      const clamped = Math.min(1 - eps, Math.max(eps, pPos));
      const logit = Math.log(clamped / (1 - clamped));
      const calibratedPos = sigmoid(params.a * logit + params.b);
      return {
        probs: {
          [neg]: 1 - calibratedPos,
          [pos]: calibratedPos,
        } as Distribution<U>["probs"],
        coverage: d.coverage,
      };
    },
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function isIdentityCalibrator(c: Calibrator): boolean {
  return c.kind === "identity";
}
