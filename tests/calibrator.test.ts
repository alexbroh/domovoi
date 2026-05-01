import { describe, expect, it } from "vitest";
import { identity, plattScaling, temperatureScaling } from "../src/calibration/index.js";
import { ConfigError } from "../src/errors.js";
import type { Distribution } from "../src/types.js";

describe("identity", () => {
  it("returns the input unchanged", () => {
    const d: Distribution<"a" | "b"> = { probs: { a: 0.6, b: 0.4 }, coverage: 0.95 };
    expect(identity.apply(d)).toBe(d);
  });

  it("has kind = 'identity'", () => {
    expect(identity.kind).toBe("identity");
  });
});

describe("temperatureScaling (S3)", () => {
  it("rejects T <= 0", () => {
    expect(() => temperatureScaling(0)).toThrowError(ConfigError);
    expect(() => temperatureScaling(-1)).toThrowError(ConfigError);
    expect(() => temperatureScaling(Number.NaN)).toThrowError(ConfigError);
  });

  it("preserves probability sum (within FP tolerance)", () => {
    const cal = temperatureScaling(0.5);
    const result = cal.apply<"a" | "b" | "c">({
      probs: { a: 0.6, b: 0.3, c: 0.1 },
      coverage: 0.95,
    });
    const sum = Object.values(result.probs).reduce((a, b) => a + (b as number), 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("T = 1 is approximately identity (modulo FP)", () => {
    const cal = temperatureScaling(1);
    const input: Distribution<"a" | "b"> = { probs: { a: 0.7, b: 0.3 }, coverage: 1 };
    const output = cal.apply(input);
    expect(output.probs.a).toBeCloseTo(input.probs.a, 9);
    expect(output.probs.b).toBeCloseTo(input.probs.b, 9);
  });

  it("T < 1 sharpens (top probability increases)", () => {
    const cal = temperatureScaling(0.5);
    const input: Distribution<"a" | "b"> = { probs: { a: 0.6, b: 0.4 }, coverage: 1 };
    const output = cal.apply(input);
    expect(output.probs.a).toBeGreaterThan(input.probs.a);
    expect(output.probs.b).toBeLessThan(input.probs.b);
  });

  it("T > 1 softens (top probability decreases)", () => {
    const cal = temperatureScaling(2);
    const input: Distribution<"a" | "b"> = { probs: { a: 0.7, b: 0.3 }, coverage: 1 };
    const output = cal.apply(input);
    expect(output.probs.a).toBeLessThan(input.probs.a);
    expect(output.probs.b).toBeGreaterThan(input.probs.b);
  });

  it("preserves coverage", () => {
    const cal = temperatureScaling(0.85);
    const input: Distribution<"a" | "b"> = { probs: { a: 0.5, b: 0.5 }, coverage: 0.73 };
    expect(cal.apply(input).coverage).toBe(0.73);
  });

  it("computes the canonical p^(1/T) / Σ p_j^(1/T) form", () => {
    const T = 0.5;
    const cal = temperatureScaling(T);
    const input: Distribution<"a" | "b" | "c"> = {
      probs: { a: 0.6, b: 0.3, c: 0.1 },
      coverage: 1,
    };
    const output = cal.apply(input);
    // Manually compute expected values: p_i^(1/T) / Σ
    const inv = 1 / T;
    const numA = 0.6 ** inv;
    const numB = 0.3 ** inv;
    const numC = 0.1 ** inv;
    const Z = numA + numB + numC;
    expect(output.probs.a).toBeCloseTo(numA / Z, 9);
    expect(output.probs.b).toBeCloseTo(numB / Z, 9);
    expect(output.probs.c).toBeCloseTo(numC / Z, 9);
  });
});

describe("plattScaling", () => {
  it("rejects non-finite a or b", () => {
    expect(() => plattScaling({ a: Number.POSITIVE_INFINITY, b: 0 })).toThrowError(ConfigError);
    expect(() => plattScaling({ a: 0, b: Number.NaN })).toThrowError(ConfigError);
  });

  it("rejects non-binary distributions at apply time", () => {
    const cal = plattScaling({ a: 1, b: 0 });
    const ternary: Distribution<"a" | "b" | "c"> = {
      probs: { a: 0.4, b: 0.3, c: 0.3 },
      coverage: 1,
    };
    expect(() => cal.apply(ternary)).toThrowError(/binary-only/);
  });

  it("preserves probability sum on binary distributions", () => {
    const cal = plattScaling({ a: 1.2, b: -0.3 });
    const result = cal.apply<"yes" | "no">({ probs: { yes: 0.7, no: 0.3 }, coverage: 1 });
    const sum = (result.probs.yes as number) + (result.probs.no as number);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("a=1, b=0 (identity Platt) leaves a probability roughly unchanged", () => {
    // sigmoid(logit(p)) === p; so a=1,b=0 should approximately preserve.
    const cal = plattScaling({ a: 1, b: 0 });
    const result = cal.apply<"yes" | "no">({ probs: { yes: 0.7, no: 0.3 }, coverage: 1 });
    expect(result.probs.yes).toBeCloseTo(0.7, 6);
  });
});
