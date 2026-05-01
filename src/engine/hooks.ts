/**
 * Hook invocation helper.
 *
 * Per G8, all observability hooks (`onCall`, `onResult`, `onProviderError`)
 * are fire-and-forget: the engine calls them with the relevant context and
 * does **not** await the returned Promise. Hook errors (sync or async) are
 * swallowed; users own their own catch logic if they need it.
 *
 * Rationale: observability shouldn't block classification. A slow logger
 * shouldn't slow fallback. An unhandled rejection inside a hook shouldn't
 * crash the engine.
 */

export type FireAndForgetFn = ((...args: never[]) => void | Promise<void>) | undefined;

export function fireAndForget(fn: FireAndForgetFn, ...args: unknown[]): void {
  if (fn === undefined) return;
  try {
    const result = (fn as (...a: unknown[]) => void | Promise<void>)(...args);
    if (result instanceof Promise) {
      result.catch(() => {});
    }
  } catch {
    // Sync errors swallowed.
  }
}
