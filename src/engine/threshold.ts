/**
 * Threshold application — turn a calibrated Distribution into a per-variant
 * decision. All comparisons are inclusive (`>=`, `<=`).
 *
 * - **Coverage gate first.** If `coverage < coverageMin`, return
 *   `out_of_distribution` (engine wraps this into Unknown).
 * - **Binary (N=2):** classic deadband. `top.prob >= high` → top wins;
 *   `top.prob <= low` → other wins; else Uncertain.
 * - **Multi-class (N>2):** top-confidence rule. `top.prob >= high` → top wins;
 *   else Uncertain. Optional margin rule: requires *both*
 *   `top.prob >= high` AND `top.prob - second.prob >= margin`.
 */

import type { Distribution, Thresholds } from "../types.js";

type ThresholdResult<T extends string> =
  | { kind: "classified"; value: T; probability: number }
  | { kind: "uncertain"; top: T; probability: number; runnerUp: T }
  | {
      kind: "out_of_distribution";
      coverage: number;
      topIfRenormalized: T;
      probabilityIfRenormalized: number;
    };

const DEFAULT_COVERAGE_MIN = 0.5;

type ThresholdValues = {
  high: number;
  low?: number;
  margin?: number;
  coverageMin?: number;
};

export function applyThresholds<T extends string>(
  d: Distribution<T>,
  thresholds: Thresholds<readonly T[]>,
  space: readonly T[],
): ThresholdResult<T> {
  const t = thresholds as ThresholdValues;
  const sorted = sortBySpaceProbability(d, space);
  const top = sorted[0] as { label: T; prob: number };
  const second = sorted[1] as { label: T; prob: number };

  const coverageMin = t.coverageMin ?? DEFAULT_COVERAGE_MIN;
  if (d.coverage < coverageMin) {
    return {
      kind: "out_of_distribution",
      coverage: d.coverage,
      topIfRenormalized: top.label,
      probabilityIfRenormalized: top.prob,
    };
  }

  if (space.length === 2 && t.low !== undefined) {
    return applyBinaryDeadband(top, second, t);
  }

  return applyMultiClassRule(top, second, t);
}

function sortBySpaceProbability<T extends string>(
  d: Distribution<T>,
  space: readonly T[],
): { label: T; prob: number }[] {
  // T extends string here, so Distribution<T>.probs resolves to the keyed-by-T
  // branch of the conditional. The cast tells TS the conditional collapsed.
  const probs = d.probs as { readonly [K in T]: number };
  const items: { label: T; prob: number }[] = space.map((label) => ({
    label,
    prob: probs[label],
  }));
  items.sort((a, b) => b.prob - a.prob);
  return items;
}

function applyBinaryDeadband<T extends string>(
  top: { label: T; prob: number },
  second: { label: T; prob: number },
  t: ThresholdValues,
): ThresholdResult<T> {
  if (top.prob >= t.high) {
    return { kind: "classified", value: top.label, probability: top.prob };
  }
  if (t.low !== undefined && top.prob <= t.low) {
    return { kind: "classified", value: second.label, probability: second.prob };
  }
  return { kind: "uncertain", top: top.label, probability: top.prob, runnerUp: second.label };
}

function applyMultiClassRule<T extends string>(
  top: { label: T; prob: number },
  second: { label: T; prob: number },
  t: ThresholdValues,
): ThresholdResult<T> {
  if (top.prob < t.high) {
    return { kind: "uncertain", top: top.label, probability: top.prob, runnerUp: second.label };
  }
  if (t.margin !== undefined && top.prob - second.prob < t.margin) {
    return { kind: "uncertain", top: top.label, probability: top.prob, runnerUp: second.label };
  }
  return { kind: "classified", value: top.label, probability: top.prob };
}
