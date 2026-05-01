/**
 * domovoi.boolean(input, question, opts?) — binary one-shot.
 *
 * Returns `Verdict<"yes" | "no">` (R4). Defaults a binary deadband:
 * `{ high: 0.7, low: 0.3, coverageMin: 0.3 }` (S2) — illustrative only.
 *
 * Returns the labels in user-given conventional order for prompts:
 * ["yes", "no"]. Engine uses user-given order for cache key + prompt rendering
 * per K3.
 */

import { type Cache, memoryCache } from "../cache.js";
import { type Calibrator, identity } from "../calibration/index.js";
import { decide, validateClassifierConfig, withDefaults } from "../engine.js";
import { resolveDefaultProviders } from "../env.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, Thresholds, Verdict } from "../types.js";

type YesNo = "yes" | "no";

const ONE_SHOT_BINARY_THRESHOLDS = { high: 0.7, low: 0.3, coverageMin: 0.3 } as const;

const YES_NO_SPACE = ["yes", "no"] as const satisfies readonly [YesNo, YesNo];

export type BooleanOptions = {
  readonly providers?: ReadonlyArray<Provider>;
  readonly calibrator?: Calibrator;
  readonly cache?: Cache;
  readonly budget?: Budget;
  readonly thresholds?: Thresholds<typeof YES_NO_SPACE>;
  readonly signal?: AbortSignal;
};

export async function boolean(
  input: string,
  question: string,
  opts?: BooleanOptions,
): Promise<Verdict<YesNo>> {
  const providers =
    opts?.providers !== undefined && opts.providers.length > 0
      ? opts.providers
      : resolveDefaultProviders();

  const calibrator = opts?.calibrator ?? identity;
  const cache = opts?.cache ?? memoryCache();
  const thresholds = (opts?.thresholds ?? ONE_SHOT_BINARY_THRESHOLDS) as Thresholds<
    typeof YES_NO_SPACE
  >;

  validateClassifierConfig({
    space: YES_NO_SPACE,
    thresholds,
    providers,
    calibrator,
  });

  const config = withDefaults<YesNo>({
    space: YES_NO_SPACE,
    thresholds,
    providers,
    calibrator,
    cache,
    template: defaultTemplate,
    question,
    ...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
  });

  return decide(input, config, opts?.signal);
}
