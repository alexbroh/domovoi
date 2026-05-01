/**
 * Abort and budget utilities.
 *
 * Engine signal merging (K2): user signal + per-call timeout merge into a
 * single `AbortSignal.any` that gets passed to the provider. When the merged
 * signal aborts, we discriminate on the abort reason to decide whether the
 * resulting Verdict is `Unknown { cancelled }` (user-initiated) or
 * `Unknown { budget_exhausted, scope: "per_call_timeout" }` (timeout-initiated).
 *
 * AggregateError construction: under `onErrorPolicy: "throw"` and full-chain
 * provider failure, we throw `AggregateError` containing rehydrated `Error`
 * instances. `deserializeForAggregate` walks the SerializableError shape back
 * into Error instances with `cause` chaining preserved.
 */

import type { Provider } from "../providers/provider.js";
import type { SerializableError, Unknown } from "../types.js";
import type { MetaBuilder } from "./meta.js";
import { buildMetaForFailure } from "./meta.js";

/**
 * Returns a human-readable string describing why a signal aborted, or
 * `undefined` if the signal isn't aborted (or wasn't supplied).
 */
export function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (signal === undefined || !signal.aborted) return undefined;
  const reason = signal.reason;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined) return String(reason);
  return "aborted";
}

/**
 * Detects whether a merged signal's abort came from `AbortSignal.timeout(...)`.
 * The timeout path produces a DOMException with `name === "TimeoutError"`.
 */
export function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError";
}

export function buildCancelledVerdict<T extends string>(
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

export type BudgetScope = "per_call_timeout" | "chain_timeout" | "max_calls";

/**
 * Build `Unknown { budget_exhausted, scope }` for `onErrorPolicy: "fallback"`.
 * Returns `undefined` under `"throw"` policy — the engine throws
 * `BudgetExhaustedError` instead.
 */
export function buildBudgetExhaustedVerdict<T extends string>(
  meta: MetaBuilder,
  scope: BudgetScope,
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

/**
 * Rehydrate a `SerializableError` (the JSON-safe shape stored in
 * `meta.providerErrors`) back into an `Error` instance suitable for
 * `AggregateError`. Cause chains are reconstructed recursively.
 */
export function deserializeForAggregate(serialized: SerializableError): Error {
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
