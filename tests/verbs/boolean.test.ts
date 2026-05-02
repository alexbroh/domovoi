/**
 * Runtime tests for the `domovoi.boolean` verb's yes/no → boolean transform.
 *
 * The engine internally classifies over the string space `["yes", "no"]`;
 * the verb maps to `Verdict<boolean>` at the boundary. These tests pin every
 * variant of that mapping (Classified, Uncertain, Unknown × reasons that
 * carry T) so the transform doesn't drift.
 */

import { describe, expect, test } from "vitest";
import { boolean as booleanVerb } from "../../src/verbs/boolean.js";
import { mockProvider } from "../../src/testing/index.js";
import { isClassified, isUncertain, isUnknown } from "../../src/verdict.js";

describe("domovoi.boolean — yes/no → boolean transform", () => {
  test("Classified: 'yes' → value === true", async () => {
    const provider = mockProvider<"yes" | "no">({
      behavior: () => ({ probs: { yes: 0.95, no: 0.05 }, coverage: 1.0 }),
    });
    const v = await booleanVerb("input", "ok?", { providers: [provider] });
    expect(isClassified(v)).toBe(true);
    if (isClassified(v)) {
      expect(v.value).toBe(true);
      expect(typeof v.value).toBe("boolean");
      expect(v.probability).toBeCloseTo(0.95);
    }
  });

  test("Classified: 'no' → value === false", async () => {
    const provider = mockProvider<"yes" | "no">({
      behavior: () => ({ probs: { yes: 0.05, no: 0.95 }, coverage: 1.0 }),
    });
    const v = await booleanVerb("input", "ok?", { providers: [provider] });
    expect(isClassified(v)).toBe(true);
    if (isClassified(v)) {
      expect(v.value).toBe(false);
      expect(typeof v.value).toBe("boolean");
    }
  });

  test("Uncertain: top/runnerUp are booleans; distribution rekeyed to true/false", async () => {
    const provider = mockProvider<"yes" | "no">({
      behavior: () => ({ probs: { yes: 0.55, no: 0.45 }, coverage: 1.0 }),
    });
    const v = await booleanVerb("input", "ok?", { providers: [provider] });
    expect(isUncertain(v)).toBe(true);
    if (isUncertain(v)) {
      expect(v.top).toBe(true);
      expect(v.runnerUp).toBe(false);
      expect(typeof v.top).toBe("boolean");
      expect(typeof v.runnerUp).toBe("boolean");
      expect(v.distribution.probs).toEqual({ true: 0.55, false: 0.45 });
    }
  });

  test("Unknown { out_of_distribution }: topIfRenormalized maps to boolean", async () => {
    // Provider emits low coverage to trigger out_of_distribution.
    const provider = mockProvider<"yes" | "no">({
      behavior: () => ({ probs: { yes: 0.6, no: 0.4 }, coverage: 0.1 }),
    });
    const v = await booleanVerb("input", "ok?", {
      providers: [provider],
      thresholds: { high: 0.7, low: 0.3, coverageMin: 0.5 },
    });
    expect(isUnknown(v)).toBe(true);
    if (isUnknown(v) && v.reason.type === "out_of_distribution") {
      expect(v.reason.topIfRenormalized).toBe(true);
      expect(typeof v.reason.topIfRenormalized).toBe("boolean");
    }
  });
});
