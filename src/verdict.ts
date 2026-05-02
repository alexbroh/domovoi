/**
 * Verdict combinators and type guards.
 *
 * Small core: only `match`, `filter`, and the three type guards ship in v0.
 * Userspace can compose richer combinators (tap, getOrElse, etc.) in 1–3 lines.
 */

import type { Classified, Filterable, Uncertain, Unknown, Verdict } from "./types.js";

export function isClassified<T extends string>(v: Verdict<T>): v is Classified<T> {
  return v.kind === "classified";
}

export function isUncertain<T extends string>(v: Verdict<T>): v is Uncertain<T> {
  return v.kind === "uncertain";
}

export function isUnknown<T extends string>(v: Verdict<T>): v is Unknown<T> {
  return v.kind === "unknown";
}

/**
 * Pattern-match against a Verdict. All three branches are required;
 * omitting one causes a type error at compile time (T8).
 *
 * @example
 * const result = match(verdict, {
 *   classified: ({ value }) => save(value),
 *   uncertain:  ({ top, runnerUp }) => queue.review(top, runnerUp),
 *   unknown:    ({ reason }) => routeUnknown(reason),
 * });
 */
export function match<T extends string, R>(
  v: Verdict<T>,
  handlers: {
    classified: (v: Classified<T>) => R;
    uncertain: (v: Uncertain<T>) => R;
    unknown: (v: Unknown<T>) => R;
  },
): R {
  switch (v.kind) {
    case "classified":
      return handlers.classified(v);
    case "uncertain":
      return handlers.uncertain(v);
    case "unknown":
      return handlers.unknown(v);
  }
}

/**
 * Predicate-based domain-validity filter. The predicate sees `Filterable<T>`
 * (Classified or Uncertain only); `Unknown` inputs pass through unchanged.
 *
 *   - pred returns `true`  → outcome unchanged
 *   - pred returns `false` → Unknown { predicate_rejected, previousKind }
 *
 * @example
 * // Reject deprecated label whether confident or uncertain about it
 * const safe = Verdict.filter<MyLabels>((v) => {
 *   const pick = v.kind === "classified" ? v.value : v.top;
 *   return !DEPRECATED.has(pick);
 * })(verdict);
 */
export function filter<T extends string>(pred: (v: Filterable<T>) => boolean) {
  return (v: Verdict<T>): Verdict<T> => {
    if (v.kind === "unknown") return v;
    if (pred(v)) return v;
    return {
      kind: "unknown",
      reason: {
        type: "predicate_rejected",
        previousKind: v.kind,
      },
      meta: v.meta,
    };
  };
}

// Note: `Verdict` is a type (the union from types.ts), not a value namespace.
// Users access `filter` and other combinators via named imports from "@hours/domovoi".
// We deliberately do NOT export `const Verdict = { filter }` to avoid
// shadowing the exported `Verdict<T>` type in the public surface.
