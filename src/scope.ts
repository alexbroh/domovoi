/**
 * `domovoi.scope` — ambient context for embedded decisions.
 *
 *   await domovoi.scope(
 *     { budget: { tokens: 10_000 }, signal, tracer },
 *     async () => {
 *       // every domovoi.classify(...) inside picks up budget/signal/tracer
 *       // ambiently, no prop-drilling
 *       await processBatch(items);
 *     },
 *   );
 *
 * Three primitives:
 *   - `scope(opts, fn)` — runs `fn` with merged ambient state
 *   - `currentScope()` — reads the active `ResolvedScope`, or `undefined`
 *   - `bind(fn)` — captures the current scope for later invocation in
 *     a different async context (queue workers, cron jobs)
 *
 * Resolution semantics (per-field, applied at each `domovoi.classify` call):
 *   1. Per-call option — e.g. `domovoi.classify(..., { signal })`
 *   2. Nearest enclosing scope
 *   3. Default — no enforcement, no tracing, no budget
 *
 * `AbortSignal` is the exception: per-call and scope signals combine via
 * `AbortSignal.any([scopeSignal, callSignal])`. Budget and tracer override.
 *
 * Backward compatibility: zero disruption. Calls outside any scope behave
 * identically to v0.1 — `currentScope()` returns `undefined`, the engine
 * falls through to per-call opts, no enforcement applied.
 */

import { BudgetTracker, type ScopeBudget } from "./budget-tracker.js";
import { getContextStorage } from "./context-storage.js";
import type { Tracer } from "./tracer.js";

export type ScopeOptions = {
  readonly budget?: ScopeBudget;
  readonly signal?: AbortSignal;
  readonly tracer?: Tracer;
};

/**
 * Internal post-merge representation held in `ContextStorage`. Public type
 * is `ScopeOptions` (declarative); `ResolvedScope` carries the mutable
 * `BudgetTracker` so nested inheritance shares the running counter.
 */
export type ResolvedScope = {
  readonly signal?: AbortSignal;
  readonly tracer?: Tracer;
  readonly budgetTracker?: BudgetTracker;
};

/**
 * Run `fn` inside a domovoi scope. Returns whatever `fn` returns.
 *
 * Nested scopes inherit unspecified fields from the parent. Specified
 * fields override (except signals, which AND-combine).
 */
export function scope<R>(opts: ScopeOptions, fn: () => R | Promise<R>): R | Promise<R> {
  const parent = currentScope();
  const merged = mergeScopes(parent, opts);
  return getContextStorage().run(merged, fn);
}

/** Read the active scope, or `undefined` if not inside one. */
export function currentScope(): ResolvedScope | undefined {
  return getContextStorage().getStore();
}

/**
 * Capture the current scope and re-apply on later invocation. Use for
 * queue workers, cron jobs, deferred callbacks — work that detaches from
 * the calling stack but should keep the same budget / signal / tracer.
 *
 *   domovoi.scope({ budget: { tokens: 10_000 }, tracer }, async () => {
 *     const job = domovoi.bind(async (item) => {
 *       return domovoi.classify(item.text, ["a", "b"]);
 *     });
 *     await queue.push(job, items);  // budget still enforced inside worker
 *   });
 *
 * Mirrors Node's `AsyncLocalStorage.bind` and OpenTelemetry's
 * `context.bind` semantics, scoped to domovoi's ambient state.
 *
 * Edge cases:
 *   - No enclosing scope at bind time: returns `fn` unchanged (no-op
 *     pass-through; avoids `contextStorage.run` overhead).
 *   - Captured signal aborted before invocation: classify returns
 *     `Unknown { reason: { type: "cancelled" } }` immediately via the
 *     existing abort-detection path in the engine.
 *   - Captured budget already exhausted: classify returns
 *     `Unknown { reason: { type: "budget_exceeded" } }` on first call.
 *   - `bind` inside a `bind`: inner captures the resolved scope at its
 *     call site, which already includes the outer captured scope —
 *     naturally transitive, no special code.
 */
export function bind<F extends (...args: never[]) => unknown>(fn: F): F {
  const captured = currentScope();
  if (!captured) return fn;
  const storage = getContextStorage();
  return ((...args: never[]) => storage.run(captured, () => fn(...args))) as F;
}

/**
 * Merge a parent `ResolvedScope` (possibly undefined) with child
 * `ScopeOptions` to produce a new `ResolvedScope`.
 *
 * Semantics per-field:
 *   - signal: AND-combine via `AbortSignal.any([parent, child])`
 *   - tracer: child overrides parent if specified
 *   - budget: if child specifies budget, fresh tracker is created
 *     (override semantics — clears parent budget for this and nested
 *     scopes). If child omits budget, inherit parent's tracker by
 *     reference so the running counter stays shared.
 */
export function mergeScopes(parent: ResolvedScope | undefined, child: ScopeOptions): ResolvedScope {
  const signal = mergeSignals(parent?.signal, child.signal);
  const tracer = child.tracer ?? parent?.tracer;
  const budgetTracker = child.budget ? BudgetTracker.from(child.budget) : parent?.budgetTracker;

  return {
    ...(signal ? { signal } : {}),
    ...(tracer ? { tracer } : {}),
    ...(budgetTracker ? { budgetTracker } : {}),
  };
}

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  // AbortSignal.any fires when ANY of the signals abort — correct for
  // "abort if scope OR call cancels."
  return AbortSignal.any([a, b]);
}
