/**
 * `decide()` — the engine orchestrator. Walks the provider chain with cache
 * lookup, in-flight dedup, signal merging, distribution validation,
 * per-caller calibration, threshold application, and fallback semantics.
 *
 * High-level flow (per docs/internal/PLAN.md G21):
 *
 *     if signal pre-aborted: return Unknown { cancelled }
 *     for each provider in chain:
 *       check chain timeout → Unknown { budget_exhausted } | throw
 *       check signal aborted → Unknown { cancelled }
 *       compute cacheKey
 *       merge signal := AbortSignal.any([userSignal, AbortSignal.timeout(perCallTimeoutMs)])
 *       try:
 *         distribution := cache.get(key) ?? in_flight_dedup(key, () => provider.sample(...))
 *         validateDistribution(distribution, space)
 *         calibrated := calibrator.apply(distribution)   // per-caller (G18)
 *         result := applyThresholds(calibrated, ...)
 *         match result {
 *           classified → return Verdict
 *           out_of_distribution → return Unknown
 *           uncertain → continue chain (return on last provider)
 *         }
 *       catch:
 *         if timeout signal aborted → Unknown { budget_exhausted } | throw
 *         if user signal aborted → Unknown { cancelled }
 *         else: ProviderError → record in meta, continue chain
 *     chain exhausted:
 *       if all errored → Unknown { provider_failure } | AggregateError
 *       else (last was Uncertain) → handled in loop
 */

import {
  InFlight,
  computeCacheKey,
  deserializeCachedValue,
  serializeCachedValue,
} from "../cache.js";
import {
  BudgetExhaustedError,
  ProviderError,
  canonicalizeProviderThrow,
  serializeError,
} from "../errors.js";
import type { Provider } from "../providers/provider.js";
import type { Classified, Distribution, Uncertain, Unknown, Verdict } from "../types.js";
import { validateDistribution } from "../validate.js";
import {
  abortReason,
  buildBudgetExhaustedVerdict,
  buildCancelledVerdict,
  deserializeForAggregate,
  isTimeoutAbort,
} from "./abort.js";
import {
  DEFAULT_CHAIN_TIMEOUT_MS,
  DEFAULT_PER_CALL_TIMEOUT_MS,
  type DecideConfig,
} from "./config.js";
import { fireAndForget } from "./hooks.js";
import { type MetaBuilder, buildMeta, buildMetaForFailure, makeMetaBuilder } from "./meta.js";
import { applyThresholds } from "./threshold.js";

// ─── Engine-scoped in-flight dedup (shared across classifiers) ──────

/**
 * Concurrent calls with the same cache key share a single in-flight Promise.
 * Different classifiers with different calibrators on the same key both get
 * the raw Distribution and apply their own calibrator per-caller (G18).
 */
const globalInFlight = new InFlight<Distribution<string>>();

// ─── Per-attempt result discriminated union ─────────────────────────

/**
 * Outcome of a single provider attempt within `decide()`. The orchestrator
 * dispatches on this:
 *   - `verdict`: terminal — return immediately.
 *   - `lastUncertain`: terminal-if-last-provider — return Uncertain Verdict.
 *   - `continue`: try the next provider (after recording any error in meta).
 */
type AttemptOutcome<T extends string> =
  | { kind: "verdict"; verdict: Verdict<T> }
  | { kind: "lastUncertain"; verdict: Uncertain<T>; calibrated: Distribution<T> }
  | { kind: "continue"; calibrated?: Distribution<T> };

// ─── Public entry point ─────────────────────────────────────────────

export async function decide<T extends string>(
  formattedInput: string,
  config: DecideConfig<T>,
  signal?: AbortSignal,
): Promise<Verdict<T>> {
  const meta = makeMetaBuilder();

  // Pre-aborted check (G15).
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

// ─── Private orchestration helpers ──────────────────────────────────

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

function checkChainBudget<T extends string>(
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

function makeCancelledFromMeta<T extends string>(meta: MetaBuilder, reason: string): Unknown<T> {
  return {
    kind: "unknown",
    reason: { type: "cancelled", reason },
    meta: buildMetaForFailure(meta),
  };
}

// ─── Per-provider attempt ───────────────────────────────────────────

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

  // Validate; treat L2 violations as a recordable provider error.
  try {
    validateDistribution(distribution, config.space);
  } catch (err) {
    return recordValidationError(err, provider, meta, config, index, cacheKey);
  }

  // Calibrate per-caller (G18) and apply thresholds.
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

  // Uncertain. Last provider in chain → return as final Verdict; else continue.
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

function computeProviderCacheKey<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
): string {
  return computeCacheKey({
    providerId: provider.id,
    modelId: provider.modelId,
    tokenizerId: provider.tokenizerId,
    templateHash: config.template.templateHash,
    decisionSpace: config.space,
    temperature: config.temperature,
    providerConfigHash: config.providerConfigHash,
    formattedInput,
  });
}

function mergeSignals(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  const signals: AbortSignal[] = [timeoutSignal];
  if (userSignal !== undefined) signals.push(userSignal);
  return AbortSignal.any(signals);
}

async function loadDistribution<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  meta: MetaBuilder,
  signal: AbortSignal,
  cacheKey: string,
): Promise<Distribution<T>> {
  const cached = await config.cache.get(cacheKey);
  if (cached !== undefined) {
    const parsed = deserializeCachedValue<T>(cached);
    if (parsed !== undefined) {
      meta.cacheHit = true;
      return parsed;
    }
    // Schema mismatch → fresh sample.
  }
  const fresh = await fetchFresh(provider, formattedInput, config, signal, cacheKey);
  await config.cache.set(cacheKey, serializeCachedValue(fresh));
  return fresh;
}

async function fetchFresh<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  signal: AbortSignal,
  cacheKey: string,
): Promise<Distribution<T>> {
  return globalInFlight.run(cacheKey, () =>
    provider.sample<T>(formattedInput, config.space, {
      template: config.template,
      temperature: config.temperature,
      timeoutMs: config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS,
      signal,
    }),
  ) as Promise<Distribution<T>>;
}

// ─── Error handling helpers ─────────────────────────────────────────

function handleDistributionError<T extends string>(
  err: unknown,
  provider: Provider,
  meta: MetaBuilder,
  config: DecideConfig<T>,
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  index: number,
  chainStartMs: number,
  cacheKey: string,
): AttemptOutcome<T> {
  // Per-call timeout hit (merged via AbortSignal.timeout).
  if (timeoutSignal.aborted && isTimeoutAbort(timeoutSignal)) {
    const verdict = buildBudgetExhaustedVerdict<T>(
      meta,
      "per_call_timeout",
      config.onErrorPolicy,
      provider,
    );
    if (verdict !== undefined) return { kind: "verdict", verdict };
    throw new BudgetExhaustedError("per_call_timeout exceeded", {
      scope: "per_call_timeout",
      attemptedProviders: meta.providersAttempted,
      elapsedMs: Date.now() - chainStartMs,
      cause: err,
    });
  }

  // User-initiated cancel.
  const userAbort = abortReason(userSignal);
  if (userAbort !== undefined) {
    const verdict = buildCancelledVerdict<T>(meta, userAbort, provider);
    return { kind: "verdict", verdict };
  }

  // Otherwise: ProviderError → record + continue chain.
  return recordProviderError(err, provider, meta, config, index, cacheKey);
}

function recordProviderError<T extends string>(
  err: unknown,
  provider: Provider,
  meta: MetaBuilder,
  config: DecideConfig<T>,
  index: number,
  cacheKey: string,
): AttemptOutcome<T> {
  const wrapped = canonicalizeProviderThrow(err);
  if (!(wrapped instanceof ProviderError)) {
    // Non-Provider DomovoiError or unknown — propagate.
    throw wrapped;
  }
  meta.providerErrors.push({ providerId: provider.id, error: serializeError(wrapped) });
  fireAndForget(config.onProviderError, wrapped, {
    providerId: provider.id,
    attempt: index + 1,
  });
  // Defensive: if the same key is in-flight in another classifier the dedup
  // may have served the failed Promise — explicit forget allows retry.
  globalInFlight.forget(cacheKey);
  return { kind: "continue" };
}

function recordValidationError<T extends string>(
  err: unknown,
  provider: Provider,
  meta: MetaBuilder,
  config: DecideConfig<T>,
  index: number,
  cacheKey: string,
): AttemptOutcome<T> {
  const wrapped = canonicalizeProviderThrow(err);
  if (!(wrapped instanceof ProviderError)) throw wrapped;
  meta.providerErrors.push({ providerId: provider.id, error: serializeError(wrapped) });
  fireAndForget(config.onProviderError, wrapped, {
    providerId: provider.id,
    attempt: index + 1,
  });
  globalInFlight.forget(cacheKey);
  return { kind: "continue" };
}

// ─── Chain-exhausted finalizer ──────────────────────────────────────

function finalizeChainExhausted<T extends string>(
  meta: MetaBuilder,
  lastCalibrated: Distribution<T> | undefined,
  attempts: number,
  config: DecideConfig<T>,
): Verdict<T> {
  // All providers errored — distinguish from chain_exhausted.
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

  // Defensive — `lastUncertain` path inside the loop should already have
  // returned. This only triggers in degenerate cases (e.g., maxCalls = 0).
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
