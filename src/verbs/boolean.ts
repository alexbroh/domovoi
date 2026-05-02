/**
 * domovoi.boolean(input, question, opts?) — binary one-shot.
 *
 * Returns `Verdict<boolean>`. Internally the engine still classifies over the
 * string space `["yes", "no"]` (matches LLM first-token tokenization cleanly);
 * a small transform at the verb boundary maps `"yes" | "no"` → `boolean` so
 * the public surface is idiomatic TS.
 *
 * Defaults a binary deadband: `{ high: 0.7, low: 0.3, coverageMin: 0.3 }` (S2)
 * — illustrative only.
 */

import { type Cache, memoryCache } from "../cache.js";
import { type Calibrator, identity } from "../calibration/index.js";
import { decide, validateClassifierConfig, withDefaults } from "../engine/index.js";
import { resolveDefaultProviders } from "../env.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, Distribution, Thresholds, UnknownVerdictCause, Verdict } from "../types.js";

type YesNo = "yes" | "no";

const ONE_SHOT_BINARY_THRESHOLDS = { high: 0.7, low: 0.3, coverageMin: 0.3 } as const;

const YES_NO_SPACE = ["yes", "no"] as const satisfies readonly [YesNo, YesNo];

export type BooleanOptions = {
  readonly providers?: readonly Provider[];
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
): Promise<Verdict<boolean>> {
  const providers =
    opts?.providers !== undefined && opts.providers.length > 0
      ? opts.providers
      : resolveDefaultProviders();

  const calibrator = opts?.calibrator ?? identity;
  const cache = opts?.cache ?? memoryCache();
  const thresholds: Thresholds<typeof YES_NO_SPACE> =
    opts?.thresholds ?? ONE_SHOT_BINARY_THRESHOLDS;

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

  const verdict = await decide(input, config, opts?.signal);
  return toBooleanVerdict(verdict);
}

/**
 * Map `Verdict<"yes" | "no">` → `Verdict<boolean>`. The engine works on string
 * labels; this transform is the verb-boundary adapter so the public type is a
 * plain `boolean`. Distribution keys go from `{ yes, no }` → `{ true, false }`.
 */
function toBooleanVerdict(v: Verdict<YesNo>): Verdict<boolean> {
  switch (v.kind) {
    case "classified":
      return { ...v, value: v.value === "yes" };
    case "uncertain":
      return {
        ...v,
        top: v.top === "yes",
        runnerUp: v.runnerUp === "yes",
        distribution: rekey(v.distribution),
      };
    case "unknown":
      return { ...v, reason: convertCause(v.reason) };
  }
}

function convertCause(cause: UnknownVerdictCause<YesNo>): UnknownVerdictCause<boolean> {
  switch (cause.type) {
    case "out_of_distribution":
      return { ...cause, topIfRenormalized: cause.topIfRenormalized === "yes" };
    case "chain_exhausted":
      return { ...cause, lastDistribution: rekey(cause.lastDistribution) };
    // Remaining variants don't reference T — payload is structurally identical
    // between UnknownVerdictCause<YesNo> and UnknownVerdictCause<boolean>.
    case "predicate_rejected":
    case "provider_failure":
    case "budget_exhausted":
    case "cancelled":
      return cause;
  }
}

function rekey(d: Distribution<YesNo>): Distribution<boolean> {
  return {
    probs: { true: d.probs.yes, false: d.probs.no },
    coverage: d.coverage,
  };
}
