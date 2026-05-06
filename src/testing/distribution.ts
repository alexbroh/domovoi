/**
 * `distribution()` — distribution-shaped assertions for AI behavior.
 *
 *   import { distribution } from "@hourslabs/domovoi/testing";
 *
 *   const dist = await distribution(
 *     () => domovoi.classify("hello there", ["greeting", "request"]),
 *     { n: 100 },
 *   );
 *   dist.coverage("greeting");           // 0.94
 *   dist.confidenceInterval("greeting"); // [0.88, 0.98] — 95% Wilson CI
 *   dist.modeKind();                      // "classified"
 *   dist.expectStable({ minCoverage: 0.9, maxUncertain: 0.05 });
 *
 * Single-sample assertions on AI behavior are meaningless (the model
 * varies between runs). This primitive turns "the classifier should
 * reliably tag greetings" into a one-liner backed by a Wilson confidence
 * interval and explicit stability thresholds.
 *
 * Cost note: `n=100` against gpt-4o-mini is ~$0.005 per test. Belongs in
 * `test:e2e`, not unit. Document the cost in the test file's comment.
 *
 * Default concurrency: `Math.min(n, 5)` — six seconds for `n=100` against
 * a 300ms p50 provider, well under OpenAI tier 1 RPM limits at the
 * per-test level. Pass `concurrency: 1` to serialize if you run multiple
 * `distribution()` tests in parallel and hit 429s.
 */

import type { Label, Verdict } from "../types.js";

export type DistributionOptions = {
  readonly n: number;
  readonly concurrency?: number;
};

export type StabilityAssertion = {
  readonly minCoverage?: Readonly<Record<string, number>> | number;
  readonly maxUncertain?: number;
  readonly maxUnknown?: number;
};

/**
 * Result of `distribution()`. The user-facing name avoids collision with
 * the internal `Distribution<T>` (probability distribution over labels).
 */
export interface Samples<T extends Label> {
  /** Fraction of samples that returned `Classified` with the given value. */
  coverage(label: T): number;
  /** Wilson confidence interval for `coverage(label)` at the given level. */
  confidenceInterval(label: T, level?: ConfidenceLevel): readonly [number, number];
  /** Most-frequent verdict kind across samples. */
  modeKind(): "classified" | "uncertain" | "unknown";
  /** Raw samples, in the order they were collected. */
  samples(): readonly Verdict<T>[];
  /**
   * Throw `AssertionError` if any threshold is violated. `minCoverage`
   * accepts a single number (applies to the mode label) or a per-label map.
   */
  expectStable(opts: StabilityAssertion): void;
}

export type ConfidenceLevel = 0.9 | 0.95 | 0.99;

function zForLevel(level: ConfidenceLevel): number {
  switch (level) {
    case 0.9:
      return 1.6449;
    case 0.95:
      return 1.96;
    case 0.99:
      return 2.5758;
  }
}

export async function distribution<T extends Label>(
  fn: () => Promise<Verdict<T>>,
  opts: DistributionOptions,
): Promise<Samples<T>> {
  if (!Number.isFinite(opts.n) || opts.n <= 0 || !Number.isInteger(opts.n)) {
    throw new RangeError(`distribution(): n must be a positive integer, got ${opts.n}`);
  }
  const concurrency = opts.concurrency ?? Math.min(opts.n, 5);
  if (!Number.isFinite(concurrency) || concurrency <= 0 || !Number.isInteger(concurrency)) {
    throw new RangeError(
      `distribution(): concurrency must be a positive integer, got ${concurrency}`,
    );
  }

  const results = await runWithConcurrency(opts.n, concurrency, fn);
  return makeSamples(results);
}

function makeSamples<T extends Label>(results: readonly Verdict<T>[]): Samples<T> {
  return {
    samples: () => results,

    coverage(label) {
      const matches = results.reduce(
        (acc, v) => (v.kind === "classified" && v.value === label ? acc + 1 : acc),
        0,
      );
      return matches / results.length;
    },

    confidenceInterval(label, level = 0.95) {
      const matches = results.reduce(
        (acc, v) => (v.kind === "classified" && v.value === label ? acc + 1 : acc),
        0,
      );
      return wilsonInterval(matches, results.length, level);
    },

    modeKind() {
      const counts = { classified: 0, uncertain: 0, unknown: 0 };
      for (const v of results) counts[v.kind] += 1;
      let bestKind: "classified" | "uncertain" | "unknown" = "classified";
      let bestCount = counts.classified;
      if (counts.uncertain > bestCount) {
        bestKind = "uncertain";
        bestCount = counts.uncertain;
      }
      if (counts.unknown > bestCount) bestKind = "unknown";
      return bestKind;
    },

    expectStable(spec) {
      const total = results.length;
      const fractionByKind = {
        classified: results.filter((v) => v.kind === "classified").length / total,
        uncertain: results.filter((v) => v.kind === "uncertain").length / total,
        unknown: results.filter((v) => v.kind === "unknown").length / total,
      };

      if (spec.maxUncertain !== undefined && fractionByKind.uncertain > spec.maxUncertain) {
        throw new Error(
          `Uncertain rate ${fractionByKind.uncertain.toFixed(3)} exceeds maxUncertain ${spec.maxUncertain}`,
        );
      }
      if (spec.maxUnknown !== undefined && fractionByKind.unknown > spec.maxUnknown) {
        throw new Error(
          `Unknown rate ${fractionByKind.unknown.toFixed(3)} exceeds maxUnknown ${spec.maxUnknown}`,
        );
      }

      if (spec.minCoverage !== undefined) {
        const coverages = computePerLabelCoverage(results);
        if (typeof spec.minCoverage === "number") {
          // Single threshold: applies to the most-covered label
          const best = Math.max(...Object.values(coverages), 0);
          if (best < spec.minCoverage) {
            throw new Error(
              `Best label coverage ${best.toFixed(3)} below minCoverage ${spec.minCoverage}`,
            );
          }
        } else {
          for (const [label, threshold] of Object.entries(spec.minCoverage)) {
            const actual = coverages[label] ?? 0;
            if (actual < threshold) {
              throw new Error(
                `Coverage for "${label}" is ${actual.toFixed(3)}, below minCoverage ${threshold}`,
              );
            }
          }
        }
      }
    },
  };
}

function computePerLabelCoverage<T extends Label>(
  results: readonly Verdict<T>[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of results) {
    if (v.kind === "classified") {
      const key = String(v.value);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const total = results.length;
  const coverage: Record<string, number> = {};
  for (const [k, c] of Object.entries(counts)) coverage[k] = c / total;
  return coverage;
}

/**
 * Wilson score interval for a binomial proportion. More robust than the
 * normal approximation at small n or extreme p.
 *
 * @see https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  level: ConfidenceLevel = 0.95,
): readonly [number, number] {
  if (trials <= 0) return [0, 0];
  if (level !== 0.9 && level !== 0.95 && level !== 0.99) {
    throw new RangeError(`wilsonInterval: unsupported level ${level} (use 0.9, 0.95, or 0.99)`);
  }
  const z = zForLevel(level);
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  const lo = Math.max(0, center - margin);
  const hi = Math.min(1, center + margin);
  return [lo, hi];
}

/**
 * Worker-pool concurrency limiter. Each worker pulls from a shared counter,
 * runs `fn`, repeats until exhausted. Optimal scheduling — no batch
 * barriers; a slow call doesn't hold up the whole batch.
 */
async function runWithConcurrency<R>(
  n: number,
  concurrency: number,
  fn: () => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(n);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= n) return;
      results[idx] = await fn();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, () => worker()));
  return results;
}
