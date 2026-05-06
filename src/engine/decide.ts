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
 *
 * v0.2 ambient context (via `domovoi.scope`):
 *   - reads `currentScope()` at entry
 *   - merges scope signal into per-call merged signal
 *   - pre-checks scope budget before each provider attempt; returns
 *     `Unknown { budget_exceeded }` (graceful) or throws
 *     `BudgetExceededError` (mode: "throw") on exhaustion
 *   - charges scope budget after each provider call (post-call estimate)
 *   - emits one OTel-shaped span per provider attempt via `scope.tracer`
 */

import type { Provider } from "../providers/provider.js";
import type { ResolvedScope } from "../scope.js";
import { currentScope } from "../scope.js";
import { noopTracer, type Span } from "../tracer.js";
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
import {
  checkChainBudget,
  finalizeChainExhausted,
  makeBudgetExceededVerdict,
  makeCancelledFromMeta,
} from "./finalize.js";
import { fireAndForget } from "./hooks.js";
import { buildMeta, type MetaBuilder, makeMetaBuilder } from "./meta.js";
import { applyThresholds } from "./threshold.js";

export async function decide<T extends string>(
  formattedInput: string,
  config: DecideConfig<T>,
  signal?: AbortSignal,
): Promise<Verdict<T>> {
  const meta = makeMetaBuilder();
  const scope = currentScope();

  const preAbort = firstAbortReason(signal, scope?.signal);
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

    // Scope budget pre-check: short-circuits if a prior charge exhausted the
    // running counter, or if the scope was inherited already-exhausted.
    if (scope?.budgetTracker) {
      const pre = scope.budgetTracker.precheck();
      if (!pre.ok) {
        const verdict = makeBudgetExceededVerdict<T>(
          meta,
          pre.spent,
          pre.limit,
          scope.budgetTracker.mode,
        );
        fireAndForget(config.hooks?.onResult, verdict);
        return verdict;
      }
    }

    const midAbort = firstAbortReason(signal, scope?.signal);
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
      scope,
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

/** Returns the first non-undefined abort reason across the given signals. */
function firstAbortReason(...signals: (AbortSignal | undefined)[]): string | undefined {
  for (const s of signals) {
    const reason = abortReason(s);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Rough token estimator. v0.2 doesn't surface real provider-reported counts
 * yet (planned for v0.3 alongside Anthropic adapter); ~4 chars/token is the
 * standard OpenAI English-text rule of thumb. Budget is a safety rail, not
 * a precision tool — overshooting by ~10% is acceptable.
 */
function estimateInputTokens(formattedInput: string): number {
  return Math.ceil(formattedInput.length / 4);
}

function estimateOutputTokens(): number {
  // Verdict outputs are short — typically a single label token plus JSON
  // envelope. Constant 20 covers structured-output overhead.
  return 20;
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
  scope: ResolvedScope | undefined,
): Promise<AttemptOutcome<T>> {
  const tracer = scope?.tracer ?? noopTracer;
  const span = tracer.startSpan(`chat ${provider.id}`, {
    "gen_ai.provider.name": provider.id,
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": provider.modelId,
    "domovoi.label_space": [...config.space],
  });

  try {
    const cacheKey = computeProviderCacheKey(provider, formattedInput, config);
    const timeoutSignal = AbortSignal.timeout(perCallTimeoutMs);
    const mergedSignal = mergeSignals(userSignal, timeoutSignal, scope?.signal);

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
      span.recordException(err);
      span.setStatus("error");
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

    span.setAttribute("domovoi.cache.hit", meta.cacheHit);

    if (!meta.cacheHit) {
      const inputTokens = estimateInputTokens(formattedInput);
      const outputTokens = estimateOutputTokens();
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
      // Charge before enforce — under "throw" mode, enforce() can throw
      // BudgetExceededError which the outer catch records on the span.
      scope?.budgetTracker?.charge(inputTokens + outputTokens);
      scope?.budgetTracker?.enforce();
    }

    try {
      validateDistribution(distribution, config.space);
    } catch (err) {
      span.recordException(err);
      span.setStatus("error");
      return recordValidationError(err, provider, meta, config, index, cacheKey);
    }

    const calibrated = config.calibrator.apply(distribution);
    const result = applyThresholds(calibrated, config.thresholds, config.space);

    return finalizeOutcome<T>(result, calibrated, provider, meta, isLastProvider, span);
  } catch (err) {
    // Catches BudgetExceededError from enforce(), plus any rethrows from
    // handleDistributionError / recordValidationError under "throw" policy.
    // Inner catches already record their original errors; this records the
    // engine-surfaced wrapper that escapes attemptProvider.
    span.recordException(err);
    span.setStatus("error");
    throw err;
  } finally {
    span.end();
  }
}

function finalizeOutcome<T extends string>(
  result: ReturnType<typeof applyThresholds<T>>,
  calibrated: Distribution<T>,
  provider: Provider,
  meta: MetaBuilder,
  isLastProvider: boolean,
  span: Span,
): AttemptOutcome<T> {
  if (result.kind === "classified") {
    const verdict: Classified<T> = {
      kind: "classified",
      value: result.value,
      probability: result.probability,
      meta: buildMeta(meta, provider),
    };
    span.setAttribute("domovoi.verdict.kind", verdict.kind);
    span.setAttribute("domovoi.verdict.value", verdict.value);
    span.setAttribute("domovoi.verdict.probability", verdict.probability);
    span.setStatus("ok");
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
    span.setAttribute("domovoi.verdict.kind", verdict.kind);
    span.setStatus("ok");
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
    span.setAttribute("domovoi.verdict.kind", verdict.kind);
    span.setAttribute("domovoi.verdict.probability", verdict.probability);
    span.setStatus("ok");
    return { kind: "lastUncertain", verdict, calibrated };
  }
  span.setAttribute("domovoi.verdict.kind", "continue");
  span.setStatus("ok");
  return { kind: "continue", calibrated };
}
