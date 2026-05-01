/**
 * Engine — the `decide()` core that ties Provider + Calibrator + Cache + Threshold
 * together with chain semantics, signal merging, abort-reason discrimination,
 * budget enforcement, in-flight dedup, and Verdict construction.
 *
 * High-level pseudocode (per docs/internal/PLAN.md G21):
 *
 *   if signal?.aborted: return Unknown { cancelled }
 *   formatted = format(input)
 *   for each provider in chain:
 *     mergedSignal = AbortSignal.any([userSignal, AbortSignal.timeout(perCallTimeoutMs)])
 *     try:
 *       cached = await cache.get(key)
 *       distribution = cached ?? in_flight_dedup(key, () => provider.sample(...))
 *       validateDistribution(distribution, space)
 *       cache.set(key, ...)  if not from cache
 *       calibrated = calibrator.apply(distribution)        // per-caller (G18)
 *       threshold = applyThresholds(calibrated, ...)
 *       return matched-variant Verdict
 *     catch err:
 *       if AbortError: → Unknown { cancelled } | Unknown { budget_exhausted, scope }
 *       if BudgetExhaustedError: → Unknown { budget_exhausted } (or throw under "throw" policy)
 *       else: ProviderError → record in meta, continue chain
 *   chain exhausted → Unknown { provider_failure } | Unknown { chain_exhausted }
 */

import {
  type Cache,
  InFlight,
  computeCacheKey,
  deserializeCachedValue,
  memoryCache,
  serializeCachedValue,
} from "./cache.js";
import { isIdentityCalibrator } from "./calibration/index.js";
import type { Calibrator } from "./calibration/index.js";
import { identity } from "./calibration/index.js";
import {
  BudgetExhaustedError,
  DomovoiError,
  ProviderError,
  canonicalizeProviderThrow,
  serializeError,
} from "./errors.js";
import { defaultTemplate } from "./prompt.js";
import type { Provider } from "./providers/provider.js";
import type {
  Budget,
  Classified,
  Distribution,
  PromptTemplate,
  SerializableError,
  Thresholds,
  Uncertain,
  Unknown,
  Verdict,
  VerdictMeta,
} from "./types.js";
import {
  validateCalibratorCompatibility,
  validateClassifierName,
  validateDistribution,
  validateProviderChain,
  validateSpace,
  validateThresholds,
} from "./validate.js";

// ─── Configuration types (engine-internal; verbs map to this) ───────

export type DecideConfig<T extends string> = {
  readonly space: ReadonlyArray<T>;
  readonly thresholds: Thresholds<ReadonlyArray<T>>;
  readonly providers: ReadonlyArray<Provider>;
  readonly calibrator: Calibrator;
  readonly cache: Cache;
  readonly template: PromptTemplate;
  readonly question?: string;
  readonly budget?: Budget;
  readonly onErrorPolicy: "fallback" | "throw";
  readonly onProviderError?: (
    err: ProviderError,
    ctx: { providerId: string; attempt: number },
  ) => void | Promise<void>;
  readonly hooks?: {
    onCall?: (...args: unknown[]) => void | Promise<void>;
    onResult?: (...args: unknown[]) => void | Promise<void>;
  };
  /** Provider-config hash for cache key (G1, M4). Empty `""` for no extra opts. */
  readonly providerConfigHash: string;
  /** Engine sends temperature: 0 in v0 (H2). */
  readonly temperature: number;
};

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_PER_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_CHAIN_TIMEOUT_MS = 30_000;

// ─── In-flight dedup (engine-scoped, shared across classifiers) ─────

const globalInFlight = new InFlight<Distribution<string>>();

// ─── Pre-flight aborted check ───────────────────────────────────────

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (signal === undefined || !signal.aborted) return undefined;
  const reason = signal.reason;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined) return String(reason);
  return "aborted";
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return true;
  return false;
}

// ─── Threshold application ──────────────────────────────────────────

type ThresholdResult<T extends string> =
  | { kind: "classified"; value: T; probability: number }
  | { kind: "uncertain"; top: T; probability: number; runnerUp: T }
  | {
      kind: "out_of_distribution";
      coverage: number;
      topIfRenormalized: T;
      probabilityIfRenormalized: number;
    };

/**
 * Apply thresholds to a calibrated Distribution.
 *
 * Coverage gate first (out_of_distribution). Then:
 *   - Binary (N=2): high >= top → Classified(top); low <= top → Classified(other);
 *     else Uncertain.
 *   - Multi-class: high <= top → Classified(top); else Uncertain.
 *     Margin (optional): top - second >= margin required for Classified.
 *
 * All comparisons inclusive (L1: >=, <=).
 */
function applyThresholds<T extends string>(
  d: Distribution<T>,
  thresholds: Thresholds<ReadonlyArray<T>>,
  space: ReadonlyArray<T>,
): ThresholdResult<T> {
  const t = thresholds as {
    high: number;
    low?: number;
    margin?: number;
    coverageMin?: number;
  };

  // Find top + runner-up over the in-space probabilities (already
  // post-renormalization; coverage carries the pre-renormalization mass).
  const sorted: Array<{ label: T; prob: number }> = space.map((label) => ({
    label,
    prob: d.probs[label] as number,
  }));
  sorted.sort((a, b) => b.prob - a.prob);
  const top = sorted[0] as { label: T; prob: number };
  const second = sorted[1] as { label: T; prob: number };

  // Coverage gate.
  const coverageMin = t.coverageMin ?? 0.5;
  if (d.coverage < coverageMin) {
    return {
      kind: "out_of_distribution",
      coverage: d.coverage,
      topIfRenormalized: top.label,
      probabilityIfRenormalized: top.prob,
    };
  }

  // Binary (N = 2).
  if (space.length === 2 && t.low !== undefined) {
    if (top.prob >= t.high) {
      return { kind: "classified", value: top.label, probability: top.prob };
    }
    // The "other" label in binary: the one not at the top.
    if (top.prob <= t.low) {
      return { kind: "classified", value: second.label, probability: second.prob };
    }
    return {
      kind: "uncertain",
      top: top.label,
      probability: top.prob,
      runnerUp: second.label,
    };
  }

  // Multi-class.
  if (top.prob >= t.high) {
    if (t.margin !== undefined) {
      if (top.prob - second.prob >= t.margin) {
        return { kind: "classified", value: top.label, probability: top.prob };
      }
      return {
        kind: "uncertain",
        top: top.label,
        probability: top.prob,
        runnerUp: second.label,
      };
    }
    return { kind: "classified", value: top.label, probability: top.prob };
  }
  return {
    kind: "uncertain",
    top: top.label,
    probability: top.prob,
    runnerUp: second.label,
  };
}

// ─── Meta builder ───────────────────────────────────────────────────

type MetaBuilder = {
  readonly providersAttempted: string[];
  readonly providerErrors: Array<{ providerId: string; error: SerializableError }>;
  readonly startedAtMs: number;
  cacheHit: boolean;
};

function makeMetaBuilder(): MetaBuilder {
  return {
    providersAttempted: [],
    providerErrors: [],
    startedAtMs: Date.now(),
    cacheHit: false,
  };
}

function buildMeta(builder: MetaBuilder, provider: Provider): VerdictMeta {
  return {
    providerUsed: provider.id,
    providersAttempted: [...builder.providersAttempted],
    providerErrors: [...builder.providerErrors],
    latencyMs: Date.now() - builder.startedAtMs,
    cacheHit: builder.cacheHit,
    coverageQuality: provider.capabilities.coverageMeasurement,
    distributionSource: provider.capabilities.distributionSource,
  };
}

function buildMetaForFailure(builder: MetaBuilder, fallbackProvider?: Provider): VerdictMeta {
  // For all-failure cases (provider_failure / cancelled / budget_exhausted),
  // there's no successful provider to attribute. Use the last-attempted
  // provider's id if available; otherwise empty.
  const providerUsed = fallbackProvider?.id ?? builder.providersAttempted.at(-1) ?? "";
  return {
    providerUsed,
    providersAttempted: [...builder.providersAttempted],
    providerErrors: [...builder.providerErrors],
    latencyMs: Date.now() - builder.startedAtMs,
    cacheHit: builder.cacheHit,
    coverageQuality: fallbackProvider?.capabilities.coverageMeasurement ?? "none",
    distributionSource: fallbackProvider?.capabilities.distributionSource ?? "logprobs",
  };
}

// ─── Hook helpers (fire-and-forget per G8) ──────────────────────────

function fireAndForget(
  fn: ((...args: never[]) => void | Promise<void>) | undefined,
  ...args: unknown[]
): void {
  if (fn === undefined) return;
  try {
    const r = (fn as (...a: unknown[]) => void | Promise<void>)(...args);
    if (r instanceof Promise) {
      // Swallow async errors; users own their hook's catch.
      r.catch(() => {});
    }
  } catch {
    // Sync errors swallowed.
  }
}

// ─── decide() — the engine ──────────────────────────────────────────

export async function decide<T extends string>(
  formattedInput: string,
  config: DecideConfig<T>,
  signal?: AbortSignal,
): Promise<Verdict<T>> {
  const meta = makeMetaBuilder();

  // Pre-aborted check (G15).
  const preAbort = abortReason(signal);
  if (preAbort !== undefined) {
    return {
      kind: "unknown",
      reason: { type: "cancelled", reason: preAbort },
      meta: buildMetaForFailure(meta),
    };
  }

  fireAndForget(config.hooks?.onCall, formattedInput, {
    providers: config.providers.map((p) => p.id),
  });

  const perCallTimeout = config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  const chainTimeoutMs = config.budget?.chainTimeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS;
  const maxCalls = config.budget?.maxCalls ?? config.providers.length;
  const chainStartMs = Date.now();

  let lastDistribution: Distribution<T> | undefined;
  let attempts = 0;

  for (let i = 0; i < config.providers.length; i++) {
    const provider = config.providers[i] as Provider;
    if (attempts >= maxCalls) break;
    attempts++;
    meta.providersAttempted.push(provider.id);

    // Chain-timeout check (R9: wall-clock incl. retries; v0 has no retries).
    const elapsedChain = Date.now() - chainStartMs;
    if (elapsedChain >= chainTimeoutMs) {
      const verdict = budgetExhaustedVerdict<T>(meta, "chain_timeout", config.onErrorPolicy);
      if (verdict !== undefined) {
        fireAndForget(config.hooks?.onResult, verdict);
        return verdict;
      }
      throw new BudgetExhaustedError("chain_timeout exceeded", {
        scope: "chain_timeout",
        attemptedProviders: meta.providersAttempted,
        elapsedMs: elapsedChain,
      });
    }

    // Engine-side abort check between providers.
    const midAbort = abortReason(signal);
    if (midAbort !== undefined) {
      const verdict = cancelledVerdict<T>(meta, midAbort, provider);
      fireAndForget(config.hooks?.onResult, verdict);
      return verdict;
    }

    // Compute cache key for this provider.
    const cacheKey = computeCacheKey({
      providerId: provider.id,
      modelId: provider.modelId,
      tokenizerId: provider.tokenizerId,
      templateHash: config.template.templateHash,
      decisionSpace: config.space,
      temperature: config.temperature,
      providerConfigHash: config.providerConfigHash,
      formattedInput,
    });

    // Engine signal merging (K2): user signal + per-call timeout.
    const timeoutSignal = AbortSignal.timeout(perCallTimeout);
    const signals: AbortSignal[] = [timeoutSignal];
    if (signal !== undefined) signals.push(signal);
    const mergedSignal = AbortSignal.any(signals);

    let distribution: Distribution<T>;
    try {
      // Cache lookup.
      const cached = await config.cache.get(cacheKey);
      if (cached !== undefined) {
        const parsed = deserializeCachedValue<T>(cached);
        if (parsed !== undefined) {
          distribution = parsed;
          meta.cacheHit = true;
        } else {
          // Schema mismatch; fall through to fresh sample.
          distribution = await fetchFresh(provider, formattedInput, config, mergedSignal, cacheKey);
          await config.cache.set(cacheKey, serializeCachedValue(distribution));
        }
      } else {
        distribution = await fetchFresh(provider, formattedInput, config, mergedSignal, cacheKey);
        await config.cache.set(cacheKey, serializeCachedValue(distribution));
      }
    } catch (err) {
      // Discriminate on error type and abort reason.
      // Timeout merged signal will surface as DOMException("TimeoutError") via
      // OpenAI SDK wrapping; check signal.reason if available.
      if (timeoutSignal.aborted && isTimeoutAbort(timeoutSignal)) {
        // Per-call budget hit. Convert to Unknown { budget_exhausted } under "fallback";
        // throw under "throw".
        const v = budgetExhaustedVerdict<T>(
          meta,
          "per_call_timeout",
          config.onErrorPolicy,
          provider,
        );
        if (v !== undefined) {
          fireAndForget(config.hooks?.onResult, v);
          return v;
        }
        throw new BudgetExhaustedError("per_call_timeout exceeded", {
          scope: "per_call_timeout",
          attemptedProviders: meta.providersAttempted,
          elapsedMs: Date.now() - chainStartMs,
          cause: err,
        });
      }

      // User-initiated cancellation.
      const userAbort = abortReason(signal);
      if (userAbort !== undefined) {
        const v = cancelledVerdict<T>(meta, userAbort, provider);
        fireAndForget(config.hooks?.onResult, v);
        return v;
      }

      // Otherwise: ProviderError. Canonicalize, record in meta, continue chain.
      const wrapped = canonicalizeProviderThrow(err);
      if (wrapped instanceof ProviderError) {
        meta.providerErrors.push({
          providerId: provider.id,
          error: serializeError(wrapped),
        });
        fireAndForget(config.onProviderError, wrapped, {
          providerId: provider.id,
          attempt: i + 1,
        });
        // In-flight slot is cleaned by Promise.finally; but if the same key
        // is in-flight in another classifier the dedup may have served the
        // failed Promise — explicit forget defends against that.
        globalInFlight.forget(cacheKey);
        continue;
      }
      // Non-Provider DomovoiError or unknown — propagate.
      throw wrapped;
    }

    lastDistribution = distribution;

    // Validate distribution (L2). May throw ProviderError; treat as a recorded
    // chain error and continue.
    try {
      validateDistribution(distribution, config.space);
    } catch (err) {
      const wrapped = canonicalizeProviderThrow(err);
      if (wrapped instanceof ProviderError) {
        meta.providerErrors.push({
          providerId: provider.id,
          error: serializeError(wrapped),
        });
        fireAndForget(config.onProviderError, wrapped, {
          providerId: provider.id,
          attempt: i + 1,
        });
        continue;
      }
      throw wrapped;
    }

    // Calibrator runs per-caller after cache resolution (G18).
    const calibrated = config.calibrator.apply(distribution);

    // Apply thresholds.
    const result = applyThresholds(calibrated, config.thresholds, config.space);

    if (result.kind === "classified") {
      const verdict: Classified<T> = {
        kind: "classified",
        value: result.value,
        probability: result.probability,
        meta: buildMeta(meta, provider),
      };
      fireAndForget(config.hooks?.onResult, verdict);
      return verdict;
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
      fireAndForget(config.hooks?.onResult, verdict);
      return verdict;
    }

    // Uncertain: continue chain.
    if (i === config.providers.length - 1) {
      // Last provider produced Uncertain; return it.
      const verdict: Uncertain<T> = {
        kind: "uncertain",
        top: result.top,
        probability: result.probability,
        runnerUp: result.runnerUp,
        distribution: calibrated,
        meta: buildMeta(meta, provider),
      };
      fireAndForget(config.hooks?.onResult, verdict);
      return verdict;
    }
    // Otherwise loop to next provider.
  }

  // Chain exhausted. Distinguish:
  //   - All providers errored → Unknown { provider_failure } (or AggregateError under throw)
  //   - Some succeeded and last was Uncertain → handled above (returned within loop).
  //   - All Uncertain (no error path) → Unknown { chain_exhausted }
  if (
    lastDistribution === undefined &&
    meta.providerErrors.length > 0 &&
    meta.providerErrors.length === meta.providersAttempted.length
  ) {
    // All-providers-failed.
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

  // Defensive: last-distribution path. The Uncertain return-from-last-iteration
  // above should have already caught this; this branch is for safety.
  if (lastDistribution !== undefined) {
    const verdict: Unknown<T> = {
      kind: "unknown",
      reason: {
        type: "chain_exhausted",
        lastDistribution,
        providersAttempted: attempts,
      },
      meta: buildMetaForFailure(meta),
    };
    fireAndForget(config.hooks?.onResult, verdict);
    return verdict;
  }

  // No distribution and no errors — degenerate (e.g., maxCalls = 0). Treat as chain_exhausted.
  const verdict: Unknown<T> = {
    kind: "unknown",
    reason: {
      type: "chain_exhausted",
      lastDistribution: { probs: {} as Distribution<T>["probs"], coverage: 0 },
      providersAttempted: attempts,
    },
    meta: buildMetaForFailure(meta),
  };
  fireAndForget(config.hooks?.onResult, verdict);
  return verdict;
}

// ─── Helper: fresh fetch with in-flight dedup ───────────────────────

async function fetchFresh<T extends string>(
  provider: Provider,
  formattedInput: string,
  config: DecideConfig<T>,
  signal: AbortSignal,
  cacheKey: string,
): Promise<Distribution<T>> {
  // In-flight dedup keyed by cacheKey. The same Promise serves all concurrent
  // callers; the cache.set happens once at the call site after the Promise
  // resolves (callers each write the same value, last-write wins — same key).
  return globalInFlight.run(cacheKey, () =>
    provider.sample<T>(formattedInput, config.space, {
      template: config.template,
      temperature: config.temperature,
      timeoutMs: config.budget?.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS,
      signal,
    }),
  );
}

// ─── Helper: cancelled / budget-exhausted Verdict construction ──────

function cancelledVerdict<T extends string>(
  meta: MetaBuilder,
  reason: string,
  provider: Provider,
): Unknown<T> {
  return {
    kind: "unknown",
    reason: { type: "cancelled", reason },
    meta: buildMetaForFailure(meta, provider),
  };
}

function budgetExhaustedVerdict<T extends string>(
  meta: MetaBuilder,
  scope: "per_call_timeout" | "chain_timeout" | "max_calls",
  policy: "fallback" | "throw",
  provider?: Provider,
): Unknown<T> | undefined {
  if (policy === "throw") return undefined;
  return {
    kind: "unknown",
    reason: { type: "budget_exhausted", scope },
    meta: buildMetaForFailure(meta, provider),
  };
}

// ─── Helper: rehydrate SerializableError into Error for AggregateError ──

function deserializeForAggregate(serialized: SerializableError): Error {
  const err = new Error(serialized.message);
  err.name = serialized.name;
  if (serialized.stack !== undefined) err.stack = serialized.stack;
  if (serialized.cause !== undefined) {
    Object.defineProperty(err, "cause", {
      value: deserializeForAggregate(serialized.cause),
      enumerable: false,
      writable: true,
    });
  }
  return err;
}

// ─── Construction-time validation entry point ───────────────────────

/**
 * Validate a classifier configuration at construction. Throws ConfigError
 * with appropriate `code` on any validation failure.
 *
 * Used by the `classifier({...})` factory and by one-shot verbs (which validate
 * lazily on first call).
 */
export function validateClassifierConfig<T extends string>(input: {
  readonly name?: string;
  readonly space: ReadonlyArray<T>;
  readonly thresholds: Thresholds<ReadonlyArray<T>>;
  readonly providers: ReadonlyArray<Provider>;
  readonly calibrator: Calibrator;
}): void {
  if (input.name !== undefined) validateClassifierName(input.name);
  validateSpace(input.space);
  validateProviderChain(input.providers, input.space.length);
  validateThresholds(input.thresholds, input.space.length);
  validateCalibratorCompatibility(isIdentityCalibrator(input.calibrator), input.providers);
}

// ─── Utility: provide reasonable defaults for engine config ─────────

export function withDefaults<T extends string>(input: {
  readonly space: ReadonlyArray<T>;
  readonly thresholds: Thresholds<ReadonlyArray<T>>;
  readonly providers: ReadonlyArray<Provider>;
  readonly calibrator?: Calibrator;
  readonly cache?: Cache;
  readonly template?: PromptTemplate;
  readonly question?: string;
  readonly budget?: Budget;
  readonly onErrorPolicy?: "fallback" | "throw";
  readonly onProviderError?: DecideConfig<T>["onProviderError"];
  readonly hooks?: DecideConfig<T>["hooks"];
  readonly providerConfigHash?: string;
}): DecideConfig<T> {
  return {
    space: input.space,
    thresholds: input.thresholds,
    providers: input.providers,
    calibrator: input.calibrator ?? identity,
    cache: input.cache ?? memoryCache(),
    template: input.template ?? defaultTemplate,
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    onErrorPolicy: input.onErrorPolicy ?? "fallback",
    ...(input.onProviderError !== undefined ? { onProviderError: input.onProviderError } : {}),
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
    providerConfigHash: input.providerConfigHash ?? "",
    temperature: 0,
  };
}

// Re-export for engine-level type consumers
export type { Calibrator };
export { DomovoiError };
