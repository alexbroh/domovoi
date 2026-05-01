/**
 * `decide()` — the engine orchestrator. Walks the provider chain, dispatching
 * each attempt's outcome (`Verdict` / `lastUncertain` / `continue`) into the
 * right terminal path.
 *
 * Single-responsibility helpers handle the heavy lifting:
 *   - cache + provider call → `engine/distribution.ts`
 *   - error → outcome translation → `engine/error-recording.ts`
 *   - terminal Verdict construction → `engine/finalize.ts`
 *
 * Errors during the chain become `Unknown` Verdicts under the default
 * `onErrorPolicy: "fallback"`; under `"throw"` they propagate as
 * `BudgetExhaustedError` / `AbortError` / `AggregateError`.
 */

import type { Provider } from "../providers/provider.js";
import type { Classified, Distribution, Uncertain, Unknown, Verdict } from "../types.js";
import { validateDistribution } from "../validate.js";
import { abortReason, buildCancelledVerdict } from "./abort.js";
import {
  DEFAULT_CHAIN_TIMEOUT_MS,
  DEFAULT_PER_CALL_TIMEOUT_MS,
  type DecideConfig,
} from "./config.js";
import { computeProviderCacheKey, loadDistribution, mergeSignals } from "./distribution.js";
import {
  type AttemptOutcome,
  handleDistributionError,
  recordValidationError,
} from "./error-recording.js";
import { checkChainBudget, finalizeChainExhausted, makeCancelledFromMeta } from "./finalize.js";
import { fireAndForget } from "./hooks.js";
import { buildMeta, type MetaBuilder, makeMetaBuilder } from "./meta.js";
import { applyThresholds } from "./threshold.js";

export async function decide<T extends string>(
  formattedInput: string,
  config: DecideConfig<T>,
  signal?: AbortSignal,
): Promise<Verdict<T>> {
  const meta = makeMetaBuilder();

  const preAbort = abortReason(signal);
  if (preAbort !== undefined) {
    return makeCancelledFromMeta(meta, preAbort);
  }

  fireAndForget(config.hooks?.onCall, formattedInput, {
    providers: config.providers.map((p) => p.id),
  });

  const limits = computeLimits(config);
  const chainStartMs = Date.now();
  let lastCalibrated: Distribution<T> | undefined;
  let attempts = 0;

  for (let i = 0; i < config.providers.length; i++) {
    const provider = config.providers[i] as Provider;
    if (attempts >= limits.maxCalls) break;
    attempts++;
    meta.providersAttempted.push(provider.id);

    const chainBudgetVerdict = checkChainBudget(meta, chainStartMs, limits.chainTimeoutMs, config);
    if (chainBudgetVerdict !== undefined) {
      fireAndForget(config.hooks?.onResult, chainBudgetVerdict);
      return chainBudgetVerdict;
    }

    const midAbort = abortReason(signal);
    if (midAbort !== undefined) {
      const verdict = buildCancelledVerdict<T>(meta, midAbort, provider);
      fireAndForget(config.hooks?.onResult, verdict);
      return verdict;
    }

    const isLastProvider = i === config.providers.length - 1;
    const outcome = await attemptProvider(
      provider,
      formattedInput,
      config,
      meta,
      signal,
      i,
      chainStartMs,
      limits.perCallTimeoutMs,
      isLastProvider,
    );

    if (outcome.kind === "verdict") {
      fireAndForget(config.hooks?.onResult, outcome.verdict);
      return outcome.verdict;
    }
    if (outcome.kind === "lastUncertain") {
      lastCalibrated = outcome.calibrated;
      fireAndForget(config.hooks?.onResult, outcome.verdict);
      return outcome.verdict;
    }
    if (outcome.calibrated !== undefined) lastCalibrated = outcome.calibrated;
  }

  return finalizeChainExhausted(meta, lastCalibrated, attempts, config);
}

type Limits = {
  perCallTimeoutMs: number;
  chainTimeoutMs: number;
  maxCalls: number;
};

function computeLimits<T extends string>(config: DecideConfig<T>): Limits {
  return {
    perCallTimeoutMs: config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS,
    chainTimeoutMs: config.budget?.chainTimeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS,
    maxCalls: config.budget?.maxCalls ?? config.providers.length,
  };
}

async function attemptProvider<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  meta: MetaBuilder,
  userSignal: AbortSignal | undefined,
  index: number,
  chainStartMs: number,
  perCallTimeoutMs: number,
  isLastProvider: boolean,
): Promise<AttemptOutcome<T>> {
  const cacheKey = computeProviderCacheKey(provider, formattedInput, config);
  const timeoutSignal = AbortSignal.timeout(perCallTimeoutMs);
  const mergedSignal = mergeSignals(userSignal, timeoutSignal);

  let distribution: Distribution<T>;
  try {
    distribution = await loadDistribution(
      provider,
      formattedInput,
      config,
      meta,
      mergedSignal,
      cacheKey,
    );
  } catch (err) {
    return handleDistributionError(
      err,
      provider,
      meta,
      config,
      userSignal,
      timeoutSignal,
      index,
      chainStartMs,
      cacheKey,
    );
  }

  try {
    validateDistribution(distribution, config.space);
  } catch (err) {
    return recordValidationError(err, provider, meta, config, index, cacheKey);
  }

  const calibrated = config.calibrator.apply(distribution);
  const result = applyThresholds(calibrated, config.thresholds, config.space);

  if (result.kind === "classified") {
    const verdict: Classified<T> = {
      kind: "classified",
      value: result.value,
      probability: result.probability,
      meta: buildMeta(meta, provider),
    };
    return { kind: "verdict", verdict };
  }

  if (result.kind === "out_of_distribution") {
    const verdict: Unknown<T> = {
      kind: "unknown",
      reason: {
        type: "out_of_distribution",
        coverage: result.coverage,
        topIfRenormalized: result.topIfRenormalized,
        probabilityIfRenormalized: result.probabilityIfRenormalized,
      },
      meta: buildMeta(meta, provider),
    };
    return { kind: "verdict", verdict };
  }

  // Uncertain: last provider in the chain returns it; otherwise fall through.
  if (isLastProvider) {
    const verdict: Uncertain<T> = {
      kind: "uncertain",
      top: result.top,
      probability: result.probability,
      runnerUp: result.runnerUp,
      distribution: calibrated,
      meta: buildMeta(meta, provider),
    };
    return { kind: "lastUncertain", verdict, calibrated };
  }
  return { kind: "continue", calibrated };
}
