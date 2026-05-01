import { describe, expect, it, vi } from "vitest";
import { temperatureScaling } from "../src/calibration/index.js";
import { domovoi, isClassified, isUncertain, isUnknown } from "../src/index.js";
import { mockProvider } from "../src/testing/index.js";
import type { Distribution } from "../src/types.js";

const ABC = ["a", "b", "c"] as const;

function dist<T extends string>(probs: Record<T, number>, coverage = 1): Distribution<T> {
  return { probs: probs as Distribution<T>["probs"], coverage };
}

describe("threshold semantics — multi-class top-confidence", () => {
  it("returns Classified when top.prob >= high (inclusive, L1)", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.7, b: 0.2, c: 0.1 }, 0.95) })],
    });
    const v = await c("input");
    expect(isClassified(v)).toBe(true);
    if (isClassified(v)) {
      expect(v.value).toBe("a");
      expect(v.probability).toBeCloseTo(0.7);
    }
  });

  it("returns Uncertain when top.prob < high", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.5, b: 0.3, c: 0.2 }, 0.95) })],
    });
    const v = await c("input");
    expect(isUncertain(v)).toBe(true);
    if (isUncertain(v)) {
      expect(v.top).toBe("a");
      expect(v.runnerUp).toBe("b");
    }
  });

  it("margin rule: requires both high AND margin", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.5, margin: 0.3, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.6, b: 0.35, c: 0.05 }, 0.95) })],
    });
    // top=0.6 >= 0.5, but margin = 0.6 - 0.35 = 0.25 < 0.3 → Uncertain
    const v = await c("input");
    expect(isUncertain(v)).toBe(true);
  });
});

describe("threshold semantics — binary deadband", () => {
  it("Classified(top) when top.prob >= high", async () => {
    const c = domovoi.classifier({
      space: ["yes", "no"] as const,
      thresholds: { high: 0.7, low: 0.3, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ yes: 0.85, no: 0.15 }, 0.95) })],
    });
    const v = await c("input");
    if (isClassified(v)) {
      expect(v.value).toBe("yes");
    } else {
      expect.fail("expected Classified");
    }
  });

  it("Classified(other) when top.prob <= low (deadband flip)", async () => {
    const c = domovoi.classifier({
      space: ["yes", "no"] as const,
      thresholds: { high: 0.7, low: 0.3, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ yes: 0.25, no: 0.75 }, 0.95) })],
    });
    const v = await c("input");
    if (isClassified(v)) {
      expect(v.value).toBe("no");
    } else {
      expect.fail("expected Classified");
    }
  });

  it("Uncertain in the deadband (low, high) strict", async () => {
    const c = domovoi.classifier({
      space: ["yes", "no"] as const,
      thresholds: { high: 0.7, low: 0.3, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ yes: 0.55, no: 0.45 }, 0.95) })],
    });
    const v = await c("input");
    expect(isUncertain(v)).toBe(true);
  });
});

describe("coverage gate (out_of_distribution)", () => {
  it("returns Unknown { out_of_distribution } when coverage < coverageMin", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.3) })],
    });
    const v = await c("input");
    if (isUnknown(v) && v.reason.type === "out_of_distribution") {
      expect(v.reason.topIfRenormalized).toBe("a");
      expect(v.reason.coverage).toBe(0.3);
    } else {
      expect.fail("expected Unknown { out_of_distribution }");
    }
  });
});

describe("chain fallback on Uncertain", () => {
  it("escalates to next provider when first returns Uncertain", async () => {
    const p1 = mockProvider({
      behavior: () => dist({ a: 0.5, b: 0.3, c: 0.2 }, 0.95),
      id: "mock/p1",
    });
    const p2 = mockProvider({
      behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95),
      id: "mock/p2",
    });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [p1, p2],
    });
    const v = await c("input");
    expect(isClassified(v)).toBe(true);
    if (isClassified(v)) {
      expect(v.meta.providerUsed).toBe("mock/p2");
      expect(v.meta.providersAttempted).toEqual(["mock/p1", "mock/p2"]);
    }
  });

  it("returns Uncertain from last provider if all fail to classify", async () => {
    const p1 = mockProvider({
      behavior: () => dist({ a: 0.5, b: 0.3, c: 0.2 }, 0.95),
      id: "mock/p1",
    });
    const p2 = mockProvider({
      behavior: () => dist({ a: 0.55, b: 0.25, c: 0.2 }, 0.95),
      id: "mock/p2",
    });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [p1, p2],
    });
    const v = await c("input");
    expect(isUncertain(v)).toBe(true);
    if (isUncertain(v)) {
      expect(v.meta.providerUsed).toBe("mock/p2");
    }
  });
});

describe("chain fallback on ProviderError (#3, S1)", () => {
  it("records error in meta.providerErrors and tries next provider", async () => {
    const p1 = mockProvider({
      behavior: () => {
        throw new Error("transient 502");
      },
      id: "mock/p1",
    });
    const p2 = mockProvider({
      behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95),
      id: "mock/p2",
    });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [p1, p2],
    });
    const v = await c("input");
    expect(isClassified(v)).toBe(true);
    if (isClassified(v)) {
      expect(v.meta.providerUsed).toBe("mock/p2");
      expect(v.meta.providerErrors).toHaveLength(1);
      expect(v.meta.providerErrors[0]?.providerId).toBe("mock/p1");
      expect(v.meta.providerErrors[0]?.error.message).toBe("transient 502");
    }
  });

  it("returns Unknown { provider_failure } when all providers error (default policy)", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: () => {
            throw new Error("p1 down");
          },
          id: "mock/p1",
        }),
        mockProvider({
          behavior: () => {
            throw new Error("p2 down");
          },
          id: "mock/p2",
        }),
      ],
    });
    const v = await c("input");
    if (isUnknown(v) && v.reason.type === "provider_failure") {
      expect(v.reason.errors).toHaveLength(2);
      expect(v.reason.errors[0]?.message).toBe("p1 down");
      expect(v.reason.errors[1]?.message).toBe("p2 down");
    } else {
      expect.fail("expected Unknown { provider_failure }");
    }
  });

  it("throws AggregateError when all providers error under onErrorPolicy: 'throw'", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      onErrorPolicy: "throw",
      providers: [
        mockProvider({
          behavior: () => {
            throw new Error("p1 down");
          },
          id: "mock/p1",
        }),
        mockProvider({
          behavior: () => {
            throw new Error("p2 down");
          },
          id: "mock/p2",
        }),
      ],
    });
    await expect(c("input")).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("cancellation (G15)", () => {
  it("returns Unknown { cancelled } when signal is pre-aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort("user navigated away");
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 1, b: 0, c: 0 }, 1) })],
    });
    const v = await c("input", { signal: ctrl.signal });
    if (isUnknown(v) && v.reason.type === "cancelled") {
      expect(v.reason.reason).toBe("user navigated away");
    } else {
      expect.fail("expected Unknown { cancelled }");
    }
  });
});

describe("VerdictMeta", () => {
  it("populates providerUsed + providersAttempted + coverageQuality + distributionSource", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95),
          id: "mock/test",
        }),
      ],
    });
    const v = await c("input");
    expect(v.meta.providerUsed).toBe("mock/test");
    expect(v.meta.providersAttempted).toEqual(["mock/test"]);
    expect(v.meta.coverageQuality).toBe("exact");
    expect(v.meta.distributionSource).toBe("logprobs");
    expect(v.meta.cacheHit).toBe(false);
    expect(typeof v.meta.latencyMs).toBe("number");
  });

  it("cacheHit becomes true on second call (G18)", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95) })],
    });
    const first = await c("input");
    const second = await c("input");
    expect(first.meta.cacheHit).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
  });
});

describe("calibrator runs per-caller after cache resolution (G18)", () => {
  it("two classifiers with same providers but different calibrators produce different Outcomes from one provider call", async () => {
    let providerCalls = 0;
    const provider = mockProvider({
      behavior: () => {
        providerCalls++;
        return dist({ a: 0.6, b: 0.4 }, 0.95);
      },
    });
    // Use shared cache across both classifiers.
    const sharedCache = domovoi.memoryCache();

    const cIdentity = domovoi.classifier({
      space: ["a", "b"] as const,
      thresholds: { high: 0.55, low: 0.45, coverageMin: 0.5 },
      providers: [provider],
      cache: sharedCache,
    });
    const cTemperature = domovoi.classifier({
      space: ["a", "b"] as const,
      thresholds: { high: 0.55, low: 0.45, coverageMin: 0.5 },
      providers: [provider],
      cache: sharedCache,
      calibrator: temperatureScaling(0.5), // sharpens
    });

    const v1 = await cIdentity("hello");
    const v2 = await cTemperature("hello");

    // Single provider call shared via cache.
    expect(providerCalls).toBe(1);
    // Calibrator produced different probabilities.
    if (isClassified(v1) && isClassified(v2)) {
      expect(v2.probability).toBeGreaterThan(v1.probability);
    } else {
      expect.fail("expected both Classified");
    }
  });
});

describe("Verdict JSON-serializable (H5)", () => {
  it("JSON.stringify(verdict) produces useful output even for provider_failure", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const v = await c("input");
    const json = JSON.stringify(v);
    expect(json).toContain('"provider_failure"');
    expect(json).toContain('"boom"');
    // Round-trips cleanly.
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe("unknown");
    expect(parsed.reason.type).toBe("provider_failure");
    expect(parsed.reason.errors[0].message).toBe("boom");
  });
});

describe(".batch (lock #6)", () => {
  it("preserves input order and returns per-item Verdicts", async () => {
    const provider = mockProvider({
      behavior: (input) => {
        const which = input.startsWith("yes") ? "a" : "b";
        return which === "a"
          ? dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95)
          : dist({ a: 0.05, b: 0.9, c: 0.05 }, 0.95);
      },
    });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [provider],
    });
    const results = await c.batch(["yes-1", "no-1", "yes-2"]);
    expect(results).toHaveLength(3);
    expect(isClassified(results[0]!) && (results[0] as { value: string }).value).toBe("a");
    expect(isClassified(results[1]!) && (results[1] as { value: string }).value).toBe("b");
    expect(isClassified(results[2]!) && (results[2] as { value: string }).value).toBe("a");
  });

  it("per-item provider failures don't kill the batch", async () => {
    const provider = mockProvider({
      behavior: (input) => {
        if (input === "boom") throw new Error("fail");
        return dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
      },
    });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [provider],
    });
    const results = await c.batch(["good-1", "boom", "good-2"]);
    expect(isClassified(results[0]!)).toBe(true);
    expect(isUnknown(results[1]!)).toBe(true);
    expect(isClassified(results[2]!)).toBe(true);
  });
});

describe("hooks fire-and-forget (G8)", () => {
  it("onProviderError is invoked without blocking fallback", async () => {
    const onProviderError = vi.fn(() => {});
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: () => {
            throw new Error("transient");
          },
          id: "mock/p1",
        }),
        mockProvider({
          behavior: () => dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95),
          id: "mock/p2",
        }),
      ],
      onProviderError,
    });
    const v = await c("input");
    expect(isClassified(v)).toBe(true);
    expect(onProviderError).toHaveBeenCalledOnce();
    const [err, ctx] = onProviderError.mock.calls[0]!;
    expect((err as Error).message).toBe("transient");
    expect((ctx as { providerId: string }).providerId).toBe("mock/p1");
  });
});

describe("default thresholds are inclusive (L1)", () => {
  it("top.prob exactly equal to high → Classified", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 0.7, b: 0.2, c: 0.1 }, 0.95) })],
    });
    const v = await c("input");
    expect(isClassified(v)).toBe(true);
  });
});
