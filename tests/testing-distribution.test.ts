/**
 * Tests for `@hourslabs/domovoi/testing` `distribution()` primitive +
 * Wilson interval helper.
 *
 * Mocked behavior (no real LLM calls) so these run as unit tests despite
 * being in the testing subpath. Real-LLM tests with non-trivial cost
 * belong in `test:e2e`.
 */

import { describe, expect, it } from "vitest";
import type { Verdict, VerdictMeta } from "../src/index.js";
import { distribution, wilsonInterval } from "../src/testing/distribution.js";

const stubMeta: VerdictMeta = {
  providerUsed: "mock/test",
  providersAttempted: ["mock/test"],
  providerErrors: [],
  latencyMs: 0,
  cacheHit: false,
  coverageQuality: "exact",
  distributionSource: "logprobs",
};

function classified<T extends string>(value: T, probability = 0.9): Verdict<T> {
  return { kind: "classified", value, probability, meta: stubMeta };
}

function uncertain<T extends string>(top: T, runnerUp: T): Verdict<T> {
  return {
    kind: "uncertain",
    top,
    probability: 0.55,
    runnerUp,
    distribution: { probs: {} as never, coverage: 1 },
    meta: stubMeta,
  };
}

function unknownVerdict<T extends string>(): Verdict<T> {
  return {
    kind: "unknown",
    reason: {
      type: "out_of_distribution",
      coverage: 0,
      topIfRenormalized: "x" as T,
      probabilityIfRenormalized: 0,
    },
    meta: stubMeta,
  };
}

describe("wilsonInterval", () => {
  it("returns [0, 0] for trials=0", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });

  it("returns symmetric-ish interval at p=0.5", () => {
    const [lo, hi] = wilsonInterval(50, 100);
    expect(lo).toBeGreaterThan(0.4);
    expect(hi).toBeLessThan(0.6);
    expect(hi - lo).toBeGreaterThan(0);
  });

  it("interval narrows as n grows", () => {
    const [lo10, hi10] = wilsonInterval(5, 10);
    const [lo1000, hi1000] = wilsonInterval(500, 1000);
    expect(hi10 - lo10).toBeGreaterThan(hi1000 - lo1000);
  });

  it("returns [0, 1] bounds at extremes", () => {
    const [lo, hi] = wilsonInterval(0, 100);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBe(0);
  });

  it("respects level parameter (99% wider than 90%)", () => {
    const [, hi90] = wilsonInterval(50, 100, 0.9);
    const [, hi99] = wilsonInterval(50, 100, 0.99);
    expect(hi99).toBeGreaterThan(hi90);
  });

  it("rejects unsupported confidence levels", () => {
    expect(() => wilsonInterval(50, 100, 0.5 as 0.95)).toThrow(RangeError);
  });
});

describe("distribution() — input validation", () => {
  it("rejects non-positive n", async () => {
    await expect(distribution(async () => classified("a"), { n: 0 })).rejects.toThrow(RangeError);
    await expect(distribution(async () => classified("a"), { n: -1 })).rejects.toThrow(RangeError);
  });

  it("rejects non-integer n", async () => {
    await expect(distribution(async () => classified("a"), { n: 1.5 })).rejects.toThrow(RangeError);
  });

  it("rejects non-positive concurrency", async () => {
    await expect(
      distribution(async () => classified("a"), { n: 5, concurrency: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("distribution() — coverage", () => {
  it("returns 1.0 when all samples classify as the queried label", async () => {
    const dist = await distribution(async () => classified("greeting"), {
      n: 20,
      concurrency: 1,
    });
    expect(dist.coverage("greeting")).toBe(1);
  });

  it("returns 0 when no samples classify as the queried label", async () => {
    const dist = await distribution(async () => classified("greeting"), {
      n: 20,
      concurrency: 1,
    });
    expect(dist.coverage("request" as never)).toBe(0);
  });

  it("computes mixed coverage correctly", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ % 4 === 0 ? classified("a") : classified("b")),
      { n: 100, concurrency: 1 },
    );
    expect(dist.coverage("a")).toBeCloseTo(0.25, 2);
    expect(dist.coverage("b")).toBeCloseTo(0.75, 2);
  });
});

describe("distribution() — confidenceInterval", () => {
  it("returns a valid interval at default 95% level", async () => {
    const dist = await distribution(async () => classified("a"), {
      n: 100,
      concurrency: 1,
    });
    const [lo, hi] = dist.confidenceInterval("a");
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it("90% interval is narrower than 99%", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ % 3 === 0 ? classified("a") : classified("b")),
      { n: 100, concurrency: 1 },
    );
    const [, hi90] = dist.confidenceInterval("a", 0.9);
    const [, hi99] = dist.confidenceInterval("a", 0.99);
    expect(hi99).toBeGreaterThan(hi90);
  });
});

describe("distribution() — modeKind", () => {
  it("returns 'classified' when most samples are classified", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ < 18 ? classified("a") : uncertain("a", "b")),
      { n: 20, concurrency: 1 },
    );
    expect(dist.modeKind()).toBe("classified");
  });

  it("returns 'uncertain' when most samples are uncertain", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ < 18 ? uncertain("a", "b") : classified("a")),
      { n: 20, concurrency: 1 },
    );
    expect(dist.modeKind()).toBe("uncertain");
  });

  it("returns 'unknown' when most samples are unknown", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ < 18 ? unknownVerdict<string>() : classified("a")),
      { n: 20, concurrency: 1 },
    );
    expect(dist.modeKind()).toBe("unknown");
  });
});

describe("distribution() — expectStable", () => {
  it("passes when all thresholds are met", async () => {
    const dist = await distribution(async () => classified("a"), {
      n: 50,
      concurrency: 1,
    });
    expect(() =>
      dist.expectStable({ minCoverage: 0.9, maxUncertain: 0.1, maxUnknown: 0.05 }),
    ).not.toThrow();
  });

  it("throws when minCoverage (single number) is violated", async () => {
    let i = 0;
    const dist = await distribution(async () => (i++ < 25 ? classified("a") : classified("b")), {
      n: 100,
      concurrency: 1,
    });
    expect(() => dist.expectStable({ minCoverage: 0.9 })).toThrow(/coverage/i);
  });

  it("throws when maxUncertain is violated", async () => {
    const dist = await distribution(async () => uncertain("a", "b"), {
      n: 50,
      concurrency: 1,
    });
    expect(() => dist.expectStable({ maxUncertain: 0.1 })).toThrow(/uncertain/i);
  });

  it("throws when maxUnknown is violated", async () => {
    const dist = await distribution(async () => unknownVerdict<string>(), {
      n: 50,
      concurrency: 1,
    });
    expect(() => dist.expectStable({ maxUnknown: 0.1 })).toThrow(/unknown/i);
  });

  it("supports per-label minCoverage map", async () => {
    let i = 0;
    const dist = await distribution(
      async () => (i++ % 2 === 0 ? classified("a") : classified("b")),
      { n: 100, concurrency: 1 },
    );
    expect(() => dist.expectStable({ minCoverage: { a: 0.4, b: 0.4 } })).not.toThrow();
    expect(() => dist.expectStable({ minCoverage: { a: 0.9 } })).toThrow(/Coverage for "a"/);
  });
});

describe("distribution() — concurrency", () => {
  it("default concurrency is Math.min(n, 5)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dist = await distribution(
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return classified("a");
      },
      { n: 20 }, // omit concurrency → defaults to min(20, 5) = 5
    );
    expect(dist.samples().length).toBe(20);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it("respects explicit concurrency=1 (serial)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await distribution(
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return classified("a");
      },
      { n: 10, concurrency: 1 },
    );
    expect(maxInFlight).toBe(1);
  });

  it("collects results in invocation order", async () => {
    let i = 0;
    const dist = await distribution(
      async () => {
        const idx = i++;
        return classified(`label-${idx}`);
      },
      { n: 5, concurrency: 1 },
    );
    const values = dist.samples().map((v) => (v.kind === "classified" ? v.value : "?"));
    expect(values).toEqual(["label-0", "label-1", "label-2", "label-3", "label-4"]);
  });
});
