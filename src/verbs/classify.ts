/**
 * domovoi.classify(input, space, opts?) — multi-class one-shot.
 *
 * Demo path. Reads providers from `DOMOVOI_PROVIDERS` env unless the caller
 * supplies `{ providers }`. Default thresholds are illustrative only —
 * `{ high: 0.5, coverageMin: 0.3 }` (S2) — production code should construct
 * a `classifier({ thresholds, ... })` instead.
 */

import { type Cache, memoryCache } from "../cache.js";
import { type Calibrator, identity } from "../calibration/index.js";
import { decide, validateClassifierConfig, withDefaults } from "../engine.js";
import { resolveDefaultProviders } from "../env.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, Thresholds, Verdict } from "../types.js";

const ONE_SHOT_DEFAULT_THRESHOLDS = { high: 0.5, coverageMin: 0.3 } as const;

export type ClassifyOptions<T extends string> = {
  readonly question?: string;
  readonly providers?: ReadonlyArray<Provider>;
  readonly calibrator?: Calibrator;
  readonly cache?: Cache;
  readonly budget?: Budget;
  readonly thresholds?: Thresholds<readonly [T, ...T[]]>;
  readonly signal?: AbortSignal;
};

export async function classify<T extends string>(
  input: string,
  space: readonly [T, ...T[]],
  opts?: ClassifyOptions<T>,
): Promise<Verdict<T>> {
  const providers =
    opts?.providers !== undefined && opts.providers.length > 0
      ? opts.providers
      : resolveDefaultProviders();

  const calibrator = opts?.calibrator ?? identity;
  const cache = opts?.cache ?? memoryCache();
  const thresholds = (opts?.thresholds ?? ONE_SHOT_DEFAULT_THRESHOLDS) as Thresholds<
    readonly [T, ...T[]]
  >;

  // Validate at first-call (one-shots validate lazily).
  validateClassifierConfig({
    space,
    thresholds,
    providers,
    calibrator,
  });

  const config = withDefaults<T>({
    space,
    thresholds,
    providers,
    calibrator,
    cache,
    template: defaultTemplate,
    ...(opts?.question !== undefined ? { question: opts.question } : {}),
    ...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
  });

  return decide(input, config, opts?.signal);
}
