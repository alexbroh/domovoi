import { describe, expect, it } from "vitest";
import { ConfigError, ProviderError } from "../src/errors.js";
import type { Distribution, ProviderCapabilities, Thresholds } from "../src/types.js";
import {
  validateClassifierName,
  validateDistribution,
  validateProviderChain,
  validateSpace,
  validateThresholds,
} from "../src/validate.js";

const LOGPROBS_CAP_20: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  maxTopLogprobs: 20,
};

describe("validateSpace (J2)", () => {
  it("rejects singleton", () => {
    expect(() => validateSpace(["a"])).toThrowError(ConfigError);
  });

  it("rejects empty label", () => {
    expect(() => validateSpace(["", "a"])).toThrowError(/empty/);
  });

  it("rejects whitespace-padded labels", () => {
    expect(() => validateSpace(["a", "  b  "])).toThrowError(/whitespace/);
  });

  it("rejects duplicates (NFC-normalized)", () => {
    expect(() => validateSpace(["a", "a", "b"])).toThrowError(/duplicate/);
  });

  it("treats NFC-equivalent labels as duplicates", () => {
    // "é" as single codepoint vs "e" + combining acute accent
    expect(() => validateSpace(["é", "é"])).toThrowError(/duplicate/);
  });

  it("accepts case-only differences (a vs A) as distinct", () => {
    expect(() => validateSpace(["a", "A", "b"])).not.toThrow();
  });

  it("accepts a valid space", () => {
    expect(() => validateSpace(["news", "sports", "music"])).not.toThrow();
  });
});

describe("validateThresholds (H1)", () => {
  it("rejects high outside [0, 1]", () => {
    expect(() =>
      validateThresholds({ high: 1.5 } as Thresholds<readonly string[]>, 3),
    ).toThrowError(ConfigError);
    expect(() =>
      validateThresholds({ high: -0.1 } as Thresholds<readonly string[]>, 3),
    ).toThrowError(ConfigError);
  });

  it("accepts boundary values 0 and 1", () => {
    expect(() =>
      validateThresholds({ high: 0, coverageMin: 1 } as Thresholds<readonly string[]>, 3),
    ).not.toThrow();
  });

  it("requires `low` for binary classifiers", () => {
    expect(() =>
      validateThresholds({ high: 0.7 } as Thresholds<readonly [string, string]>, 2),
    ).toThrowError(/requires .*low/i);
  });

  it("rejects binary high <= low (strict)", () => {
    expect(() =>
      validateThresholds({ high: 0.5, low: 0.5 } as Thresholds<readonly [string, string]>, 2),
    ).toThrowError(/high > low/);
    expect(() =>
      validateThresholds({ high: 0.3, low: 0.5 } as Thresholds<readonly [string, string]>, 2),
    ).toThrowError(/high > low/);
  });

  it("rejects margin outside [0, 1]", () => {
    expect(() =>
      validateThresholds({ high: 0.7, margin: -0.1 } as Thresholds<readonly string[]>, 3),
    ).toThrowError(/margin/);
  });

  it("accepts margin = 0", () => {
    expect(() =>
      validateThresholds({ high: 0.7, margin: 0 } as Thresholds<readonly string[]>, 3),
    ).not.toThrow();
  });
});

describe("validateClassifierName (G10)", () => {
  it("accepts lowercase + digits + underscores", () => {
    expect(() => validateClassifierName("articles")).not.toThrow();
    expect(() => validateClassifierName("video_v2")).not.toThrow();
    expect(() => validateClassifierName("a_b_c_123")).not.toThrow();
  });

  it("rejects uppercase, spaces, hyphens, leading digits", () => {
    expect(() => validateClassifierName("Articles")).toThrowError(ConfigError);
    expect(() => validateClassifierName("articles with spaces")).toThrowError(ConfigError);
    expect(() => validateClassifierName("articles-v2")).toThrowError(ConfigError);
    expect(() => validateClassifierName("1articles")).toThrowError(ConfigError);
    expect(() => validateClassifierName("")).toThrowError(ConfigError);
  });
});

describe("validateProviderChain (M1, lock #1)", () => {
  it("rejects empty chain", () => {
    expect(() => validateProviderChain([], 3)).toThrowError(/empty/);
  });

  it("enforces chain-min top-K cap across logprobs providers", () => {
    expect(() =>
      validateProviderChain(
        [
          { id: "a/x", capabilities: { ...LOGPROBS_CAP_20, maxTopLogprobs: 20 } },
          { id: "b/x", capabilities: { ...LOGPROBS_CAP_20, maxTopLogprobs: 5 } },
        ],
        10,
      ),
    ).toThrowError(/top-K cap \(5\)/);
  });

  it("allows space.length <= chain-min cap", () => {
    expect(() =>
      validateProviderChain(
        [{ id: "a/x", capabilities: { ...LOGPROBS_CAP_20, maxTopLogprobs: 20 } }],
        15,
      ),
    ).not.toThrow();
  });

  it("multi_sample providers are exempt from cap check", () => {
    const ms: ProviderCapabilities = {
      distributionSource: "multi_sample",
      coverageMeasurement: "approximate",
      maxTopLogprobs: 0,
    };
    // 25 labels but only multi_sample providers — no cap applies.
    expect(() => validateProviderChain([{ id: "ms/x", capabilities: ms }], 25)).not.toThrow();
  });
});

describe("validateDistribution (L2)", () => {
  it("rejects coverage outside [0, 1]", () => {
    const d: Distribution<"a" | "b"> = { probs: { a: 0.5, b: 0.5 }, coverage: 1.5 };
    expect(() => validateDistribution(d, ["a", "b"])).toThrowError(ProviderError);
  });

  it("rejects per-prob outside [0, 1]", () => {
    const d: Distribution<"a" | "b"> = {
      probs: { a: 1.2, b: -0.2 } as Distribution<"a" | "b">["probs"],
      coverage: 1,
    };
    expect(() => validateDistribution(d, ["a", "b"])).toThrowError(/Invalid probability/);
  });

  it("rejects sum-not-one beyond tolerance", () => {
    const d: Distribution<"a" | "b"> = { probs: { a: 0.4, b: 0.4 }, coverage: 1 };
    expect(() => validateDistribution(d, ["a", "b"])).toThrowError(/sum/);
  });

  it("accepts sum within tolerance 0.001", () => {
    const d: Distribution<"a" | "b"> = { probs: { a: 0.5005, b: 0.4995 }, coverage: 1 };
    expect(() => validateDistribution(d, ["a", "b"])).not.toThrow();
  });

  it("fills missing in-space labels with 0 (G2)", () => {
    const d: Distribution<"a" | "b" | "c"> = {
      probs: { a: 0.5, b: 0.5 } as Distribution<"a" | "b" | "c">["probs"],
      coverage: 1,
    };
    validateDistribution(d, ["a", "b", "c"]);
    expect((d.probs as Record<string, number>).c).toBe(0);
  });
});
