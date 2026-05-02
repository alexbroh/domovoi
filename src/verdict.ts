/**
 * Verdict combinators and type guards. The library ships only `match`,
 * `filter`, and the three type guards; richer combinators (tap, getOrElse,
 * etc.) compose cleanly in userspace.
 */

import type { Classified, Filterable, Label, Uncertain, Unknown, Verdict } from "./types.js";

export function isClassified<T extends Label>(v: Verdict<T>): v is Classified<T> {
  return v.kind === "classified";
}

export function isUncertain<T extends Label>(v: Verdict<T>): v is Uncertain<T> {
  return v.kind === "uncertain";
}

export function isUnknown<T extends Label>(v: Verdict<T>): v is Unknown<T> {
  return v.kind === "unknown";
}

/**
 * Pattern-match against a Verdict. All three branches are required;
 * omitting one is a compile-time error.
 *
 * @example
 * const result = match(verdict, {
 *   classified: ({ value }) => save(value),
 *   uncertain:  ({ top, runnerUp }) => queue.review(top, runnerUp),
 *   unknown:    ({ reason }) => routeUnknown(reason),
 * });
 */
export function match<T extends Label, R>(
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
 * Domain-validity filter. The predicate sees `Filterable<T>` — Classified or
 * Uncertain only. When it returns `false`, the Verdict becomes
 * `Unknown { predicate_rejected }`. Unknown inputs pass through unchanged.
 *
 * @example
 * const safe = filter<MyLabels>((v) => {
 *   const pick = v.kind === "classified" ? v.value : v.top;
 *   return !DEPRECATED.has(pick);
 * })(verdict);
 */
export function filter<T extends Label>(pred: (v: Filterable<T>) => boolean) {
  return (v: Verdict<T>): Verdict<T> => {
    if (v.kind === "unknown") return v;
    if (pred(v)) return v;
    return {
      kind: "unknown",
      reason: { type: "predicate_rejected", previousKind: v.kind },
      meta: v.meta,
    };
  };
}
