/**
 * Terminal-Verdict construction for `decide()`'s exit paths:
 * chain-budget exhaustion, pre/mid-loop cancellation, and chain-exhausted
 * (every-provider-errored vs last-provider-uncertain).
 */

import { BudgetExhaustedError } from "../errors.js";
import type { Distribution, Unknown, Verdict } from "../types.js";
import { buildBudgetExhaustedVerdict, deserializeForAggregate } from "./abort.js";
import type { DecideConfig } from "./config.js";
import { fireAndForget } from "./hooks.js";
import { buildMetaForFailure, type MetaBuilder } from "./meta.js";

export function checkChainBudget<T extends string>(
  meta: MetaBuilder,
  chainStartMs: number,
  chainTimeoutMs: number,
  config: DecideConfig<T>,
): Unknown<T> | undefined {
  const elapsed = Date.now() - chainStartMs;
  if (elapsed < chainTimeoutMs) return undefined;
  const verdict = buildBudgetExhaustedVerdict<T>(meta, "chain_timeout", config.onErrorPolicy);
  if (verdict !== undefined) return verdict;
  throw new BudgetExhaustedError("chain_timeout exceeded", {
    scope: "chain_timeout",
    attemptedProviders: meta.providersAttempted,
    elapsedMs: elapsed,
  });
}

export function makeCancelledFromMeta<T extends string>(
  meta: MetaBuilder,
  reason: string,
): Unknown<T> {
  return {
    kind: "unknown",
    reason: { type: "cancelled", reason },
    meta: buildMetaForFailure(meta),
  };
}

export function finalizeChainExhausted<T extends string>(
  meta: MetaBuilder,
  lastCalibrated: Distribution<T> | undefined,
  attempts: number,
  config: DecideConfig<T>,
): Verdict<T> {
  // Every provider erroring is distinct from "chain exhausted with Uncertain".
  const allErrored =
    lastCalibrated === undefined &&
    meta.providerErrors.length > 0 &&
    meta.providerErrors.length === meta.providersAttempted.length;

  if (allErrored) {
    if (config.onErrorPolicy === "throw") {
      const errors = meta.providerErrors.map((e) => deserializeForAggregate(e.error));
      throw new AggregateError(errors, "All providers failed.");
    }
    const verdict: Unknown<T> = {
      kind: "unknown",
      reason: {
        type: "provider_failure",
        errors: meta.providerErrors.map((e) => e.error),
      },
      meta: buildMetaForFailure(meta),
    };
    fireAndForget(config.hooks?.onResult, verdict);
    return verdict;
  }

  // Reachable only in degenerate cases (e.g. `maxCalls: 0`); the in-loop
  // `lastUncertain` path otherwise returns first.
  const verdict: Unknown<T> = {
    kind: "unknown",
    reason: {
      type: "chain_exhausted",
      lastDistribution: lastCalibrated ?? { probs: {} as Distribution<T>["probs"], coverage: 0 },
      providersAttempted: attempts,
    },
    meta: buildMetaForFailure(meta),
  };
  fireAndForget(config.hooks?.onResult, verdict);
  return verdict;
}
