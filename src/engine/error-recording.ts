/**
 * Error-handling helpers for `decide()`'s attempt loop. Translates raw
 * exceptions thrown from the provider/cache/validation path into either
 * a terminal `Verdict` (for cancellation, budget exhaustion) or a
 * "continue chain" signal (for swallowable `ProviderError`).
 *
 * Distinguishes between three error sources: per-call timeout, user
 * cancellation, and provider-side failure. Each produces a different
 * `AttemptOutcome` shape that the orchestrator dispatches on.
 */

import {
  BudgetExhaustedError,
  canonicalizeProviderThrow,
  ProviderError,
  serializeError,
} from "../errors.js";
import type { Provider } from "../providers/provider.js";
import type { Distribution, Uncertain, Verdict } from "../types.js";
import {
  abortReason,
  buildBudgetExhaustedVerdict,
  buildCancelledVerdict,
  isTimeoutAbort,
} from "./abort.js";
import type { DecideConfig } from "./config.js";
import { forgetInFlight } from "./distribution.js";
import { fireAndForget } from "./hooks.js";
import type { MetaBuilder } from "./meta.js";

/**
 * Outcome of a single provider attempt within `decide()`. The orchestrator
 * dispatches on this:
 *   - `verdict`: terminal — return immediately.
 *   - `lastUncertain`: terminal-if-last-provider — return Uncertain Verdict.
 *   - `continue`: try the next provider (after recording any error in meta).
 */
export type AttemptOutcome<T extends string> =
  | { kind: "verdict"; verdict: Verdict<T> }
  | { kind: "lastUncertain"; verdict: Uncertain<T>; calibrated: Distribution<T> }
  | { kind: "continue"; calibrated?: Distribution<T> };

export function handleDistributionError<T extends string>(
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

  const userAbort = abortReason(userSignal);
  if (userAbort !== undefined) {
    const verdict = buildCancelledVerdict<T>(meta, userAbort, provider);
    return { kind: "verdict", verdict };
  }

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
  forgetInFlight(cacheKey);
  return { kind: "continue" };
}

export function recordValidationError<T extends string>(
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
  forgetInFlight(cacheKey);
  return { kind: "continue" };
}
