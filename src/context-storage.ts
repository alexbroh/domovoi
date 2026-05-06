/**
 * `ContextStorage<T>` — pluggable extension point for `domovoi.scope`'s
 * ambient state. Default implementation wraps Node's
 * `node:async_hooks.AsyncLocalStorage`, which works on Node 16+,
 * Cloudflare Workers (with the `nodejs_compat` flag, since 2024), and
 * Deno (native).
 *
 * Browser users or exotic runtimes call `configureContextStorage(custom)`
 * at boot to swap the default. The interface mirrors `AsyncLocalStorage`
 * minus methods domovoi doesn't need (`enterWith`, `disable`, etc.).
 *
 * `getContextStorage()` returns the *currently configured* storage —
 * tests mutate it via `configureContextStorage` and reset between cases.
 *
 * Resolution semantics: `run` shadows nested scopes fully. There is no
 * implicit merge — the engine's `mergeScopes()` (in `scope.ts`) builds the
 * `ResolvedScope` value that `run` stores, so nested inheritance behavior
 * lives in scope-merge logic, not in the context storage layer.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedScope } from "./scope.js";

export interface ContextStorage<T> {
  /** Run `fn` with `value` as the active store. Restored on return/throw. */
  run<R>(value: T, fn: () => R | Promise<R>): R | Promise<R>;
  /** Read the active store, or `undefined` if no enclosing `run()`. */
  getStore(): T | undefined;
}

let storage: ContextStorage<ResolvedScope> = new AsyncLocalStorage<ResolvedScope>();

export function getContextStorage(): ContextStorage<ResolvedScope> {
  return storage;
}

/**
 * Replace the default `AsyncLocalStorage`-backed storage with a custom
 * implementation. Call once at boot, before any `domovoi.scope(...)` runs.
 *
 * Use cases:
 *   - browser runtimes without `node:async_hooks`
 *   - test harnesses that need deterministic single-tenant state
 *   - custom propagation layers (cross-process, queue handlers with their
 *     own context system)
 */
export function configureContextStorage(custom: ContextStorage<ResolvedScope>): void {
  storage = custom;
}

/**
 * Reset to the default `AsyncLocalStorage`-backed storage. Test-only
 * affordance — production code should not need this.
 */
export function resetContextStorage(): void {
  storage = new AsyncLocalStorage<ResolvedScope>();
}
