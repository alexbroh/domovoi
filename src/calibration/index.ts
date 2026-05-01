/**
 * Calibrator factories for domovoi v0.
 *
 * - `identity`: pass-through; default.
 * - `temperatureScaling(T)`: p^(1/T) / Σ p_j^(1/T). Pure function on probabilities.
 *   Equivalent to scaling logits before softmax. Throws on T <= 0.
 * - `plattScaling({ a, b })`: binary-only sigmoid scaling. Throws at construction
 *   if invoked on a non-binary space.
 *
 * Calibrator interface (public per C6):
 *   - apply(d): returns a new Distribution; MUST be pure / stateless.
 *   - kind: identifier; engine inspects to detect "identity" for compatibility checks.
 *
 * Calibrator.fit() and Calibrator.serialize() arrive in v1 with fitted calibrators.
 */

import { ConfigError } from "../errors.ts";
import type { Distribution } from "../types.ts";

// ─── Public Calibrator interface ────────────────────────────────────

export interface Calibrator {
  /** Identifier; "identity" is a reserved special-case used by the engine. */
  readonly kind: string;
  /** Pure function on Distribution. Stateless. */
  apply<T extends string>(d: Distribution<T>): Distribution<T>;
}

// ─── identity ───────────────────────────────────────────────────────

export const identity: Calibrator = {
  kind: "identity",
  apply<T extends string>(d: Distribution<T>): Distribution<T> {
    return d;
  },
};

// ─── temperatureScaling ─────────────────────────────────────────────

/**
 * Temperature scaling: p_i_new = p_i^(1/T) / Σ_j p_j^(1/T).
 *
 * - T = 1 → identity.
 * - T > 1 → softens the distribution (less peaked).
 * - T < 1 → sharpens the distribution (more peaked).
 *
 * Mathematically equivalent to scaling logits before softmax. Operates directly
 * on probabilities; coverage is not changed.
 *
 * Throws ConfigError if T <= 0.
 *
 * @example
 *   calibrator: temperatureScaling(0.85)  // user-fitted on held-out eval set
 */
export function temperatureScaling(T: number): Calibrator {
  if (Number.isNaN(T) || T <= 0) {
    throw new ConfigError(
      `temperatureScaling(T): T must be > 0; got ${T}.`,
      { code: "incompatible_calibrator" },
    );
  }
  const inverseT = 1 / T;
  return {
    kind: "temperature",
    apply<U extends string>(d: Distribution<U>): Distribution<U> {
      // p^(1/T) / Σ p_j^(1/T)
      const scaled: Record<string, number> = {};
      let sum = 0;
      for (const [label, prob] of Object.entries(d.probs) as Array<[string, number]>) {
        const v = prob === 0 ? 0 : prob ** inverseT;
        scaled[label] = v;
        sum += v;
      }
      // Defensive: if every prob is 0 (degenerate), pass through unchanged.
      if (sum === 0) return d;
      const normalized: Record<string, number> = {};
      for (const [label, v] of Object.entries(scaled)) {
        normalized[label] = v / sum;
      }
      return {
        probs: normalized as Distribution<U>["probs"],
        coverage: d.coverage,
      };
    },
  };
}

// ─── plattScaling ───────────────────────────────────────────────────

/**
 * Platt scaling: sigmoid(a*z + b) where z is the logit of the positive-class
 * probability.
 *
 * Binary-only by construction. The engine validates compatibility with the
 * decision space at construction; this factory itself doesn't know the space
 * size, so the validation happens in classifier construction (validate.ts).
 *
 * For a binary distribution {p0, p1}, treats `p1` (the second label
 * lexicographically — but engine uses user-given order) as the positive class.
 * Computes new positive-class probability via sigmoid(a*logit(p1) + b);
 * negative class is 1 - that.
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
        // Construction-time validation should have caught this; defensive guard at runtime.
        throw new ConfigError(
          `plattScaling is binary-only; got distribution with ${labels.length} labels.`,
          { code: "incompatible_calibrator" },
        );
      }
      const [neg, pos] = labels as [string, string];
      const probs = d.probs as Record<string, number>;
      const pPos = probs[pos] ?? 0;
      // Clamp to avoid log(0) / log(1) extremes.
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

// ─── Helper for validate.ts ─────────────────────────────────────────

/** Returns true iff the calibrator is the built-in identity (or behaves identically). */
export function isIdentityCalibrator(c: Calibrator): boolean {
  return c.kind === "identity";
}
