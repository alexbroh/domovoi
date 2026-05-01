/**
 * Hook invocation helper.
 *
 * All observability hooks (`onCall`, `onResult`, `onProviderError`) are
 * fire-and-forget: the engine never awaits them, and sync or async errors
 * inside the hook are swallowed. A slow logger doesn't slow fallback; an
 * unhandled rejection inside a hook can't crash the engine.
 */

type FireAndForgetFn = ((...args: never[]) => void | Promise<void>) | undefined;

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
