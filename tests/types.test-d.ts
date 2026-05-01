/**
 * Type-level tests (T8/T9/T10).
 *
 * Run via `vitest --typecheck` or `npm run test:types`.
 */

import { assertType, describe, expectTypeOf, test } from "vitest";
import {
  type Classified,
  type Uncertain,
  type Unknown,
  type Verdict,
  isClassified,
  isUncertain,
  isUnknown,
  match,
} from "../src/index.js";

declare const v: Verdict<"a" | "b" | "c">;

describe("T8 — match exhaustiveness", () => {
  test("match returns the handler's return type", () => {
    const result = match(v, {
      classified: (c) => c.value,
      uncertain: () => "U" as const,
      unknown: () => "K" as const,
    });
    expectTypeOf(result).toEqualTypeOf<"a" | "b" | "c" | "U" | "K">();
  });

  test("missing 'unknown' branch fails to compile", () => {
    // @ts-expect-error - missing 'unknown' handler
    match(v, {
      classified: () => 1,
      uncertain: () => 2,
    });
  });

  test("missing 'uncertain' branch fails to compile", () => {
    // @ts-expect-error - missing 'uncertain' handler
    match(v, {
      classified: () => 1,
      unknown: () => 3,
    });
  });
});

describe("T9 — type-guard narrowing", () => {
  test("isClassified narrows to Classified<T>", () => {
    if (isClassified(v)) {
      expectTypeOf(v).toEqualTypeOf<Classified<"a" | "b" | "c">>();
      expectTypeOf(v.value).toEqualTypeOf<"a" | "b" | "c">();
      expectTypeOf(v.probability).toEqualTypeOf<number>();
      // @ts-expect-error - Classified has no `runnerUp`
      v.runnerUp;
      // @ts-expect-error - Classified has no `top`
      v.top;
      // @ts-expect-error - Classified has no `reason`
      v.reason;
    }
  });

  test("isUncertain narrows to Uncertain<T>", () => {
    if (isUncertain(v)) {
      expectTypeOf(v).toEqualTypeOf<Uncertain<"a" | "b" | "c">>();
      expectTypeOf(v.top).toEqualTypeOf<"a" | "b" | "c">();
      expectTypeOf(v.runnerUp).toEqualTypeOf<"a" | "b" | "c">();
      // @ts-expect-error - Uncertain has no `value`
      v.value;
      // @ts-expect-error - Uncertain has no `reason`
      v.reason;
    }
  });

  test("isUnknown narrows to Unknown<T>", () => {
    if (isUnknown(v)) {
      expectTypeOf(v).toEqualTypeOf<Unknown<"a" | "b" | "c">>();
      // @ts-expect-error - Unknown has no `value`
      v.value;
      // @ts-expect-error - Unknown has no `top`
      v.top;
    }
  });
});

describe("T10 — literal narrowing one-liner (RESEARCH.md Pass 2 SOTA bar)", () => {
  test("space `as const` narrows Verdict to literal union", () => {
    type Result = Verdict<"news" | "sports" | "music">;
    const r: Result = {} as Result;
    if (isClassified(r)) {
      // The whole point: r.value must be the literal union, not bare string.
      assertType<"news" | "sports" | "music">(r.value);
    }
  });
});
