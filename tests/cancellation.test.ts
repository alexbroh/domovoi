/**
 * Cancellation and budget tests (G14, G15, K2, R9).
 *
 * Covers:
 *   - Pre-aborted signal → Unknown { cancelled, reason } before any I/O.
 *   - Mid-call user abort → Unknown { cancelled }; in-flight request cancelled.
 *   - AbortSignal.timeout merge (K2) → Unknown { budget_exhausted, scope: "per_call_timeout" }
 *     under default policy; throws BudgetExhaustedError under "throw" policy.
 *   - Chain timeout (R9) → Unknown { budget_exhausted, scope: "chain_timeout" }
 *     when wall-clock across the chain exceeds chainTimeoutMs.
 *   - maxCalls cap → bounded number of provider attempts.
 *   - controller.abort(reason) propagates the reason string into Unknown.cancelled.
 *   - Batch cancellation: partial results — finished items keep Verdicts;
 *     in-flight + not-yet-started become Unknown { cancelled }.
 */

import { describe, expect, it } from "vitest";
import { BudgetExhaustedError } from "../src/errors.js";
import { domovoi, isClassified, isUnknown } from "../src/index.js";
import { mockProvider } from "../src/testing/index.js";
import type { Distribution, SampleOptions } from "../src/types.js";

type ABCLabel = "a" | "b" | "c";
const ABC_SPACE = ["a", "b", "c"] as const satisfies readonly [ABCLabel, ABCLabel, ABCLabel];

const DEFAULT_THRESHOLDS = { high: 0.7, coverageMin: 0.5 } as const;

function makeDistribution<T extends string>(
  probs: Record<T, number>,
  coverage = 1,
): Distribution<T> {
  return { probs: probs as Distribution<T>["probs"], coverage };
}

/**
 * setTimeout wrapped in a Promise that respects AbortSignal. Used to make
 * mock providers simulate slow/hanging API calls that respect engine-supplied
 * cancellation signals.
 */
function delayWithCancellation(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(toError(signal.reason));
    });
  });
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "aborted");
}

describe("pre-aborted signal (G15)", () => {
  it("returns Unknown { cancelled, reason } before any provider call", async () => {
    let providerWasCalled = false;
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      providers: [
        mockProvider({
          behavior: () => {
            providerWasCalled = true;
            return makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const controller = new AbortController();
    controller.abort("user navigated away");
    const verdict = await classifier("input", { signal: controller.signal });
    expect(providerWasCalled).toBe(false);
    expect(isUnknown(verdict)).toBe(true);
    if (isUnknown(verdict) && verdict.reason.type === "cancelled") {
      expect(verdict.reason.reason).toBe("user navigated away");
    } else {
      expect.fail("expected Unknown { cancelled }");
    }
  });

  it("uses 'aborted' as default reason when controller.abort() called without args", async () => {
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      providers: [
        mockProvider({ behavior: () => makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1) }),
      ],
    });
    const controller = new AbortController();
    controller.abort();
    const verdict = await classifier("input", { signal: controller.signal });
    if (isUnknown(verdict) && verdict.reason.type === "cancelled") {
      expect(typeof verdict.reason.reason).toBe("string");
    } else {
      expect.fail("expected Unknown { cancelled }");
    }
  });
});

describe("mid-call user abort (G15)", () => {
  it("returns Unknown { cancelled } when abort fires during provider.sample", async () => {
    const controller = new AbortController();
    let providerSawAbort = false;
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      providers: [
        mockProvider({
          behavior: async (_input, _space, sampleOpts: SampleOptions) => {
            try {
              await delayWithCancellation(500, sampleOpts.signal);
              return makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1);
            } catch (abortErr) {
              providerSawAbort = true;
              throw abortErr;
            }
          },
        }),
      ],
    });

    const verdictPromise = classifier("input", { signal: controller.signal });
    setTimeout(() => controller.abort("user clicked cancel"), 10);
    const verdict = await verdictPromise;

    expect(providerSawAbort).toBe(true);
    if (isUnknown(verdict) && verdict.reason.type === "cancelled") {
      expect(verdict.reason.reason).toBe("user clicked cancel");
    } else {
      expect.fail(`expected Unknown { cancelled }; got ${JSON.stringify(verdict)}`);
    }
  });
});

describe("per-call timeout via AbortSignal.timeout merge (K2)", () => {
  it("returns Unknown { budget_exhausted, scope: 'per_call_timeout' } under default policy", async () => {
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      budget: { perCallTimeoutMs: 50 },
      providers: [
        mockProvider({
          behavior: async (_input, _space, sampleOpts: SampleOptions) => {
            await delayWithCancellation(500, sampleOpts.signal);
            return makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const verdict = await classifier("input");
    if (isUnknown(verdict) && verdict.reason.type === "budget_exhausted") {
      expect(verdict.reason.scope).toBe("per_call_timeout");
    } else {
      expect.fail(
        `expected Unknown { budget_exhausted, per_call_timeout }; got ${JSON.stringify(verdict)}`,
      );
    }
  });

  it("throws BudgetExhaustedError under onErrorPolicy: 'throw'", async () => {
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      budget: { perCallTimeoutMs: 50 },
      onErrorPolicy: "throw",
      providers: [
        mockProvider({
          behavior: async (_input, _space, sampleOpts: SampleOptions) => {
            await delayWithCancellation(500, sampleOpts.signal);
            return makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    try {
      await classifier("input");
      expect.fail("expected BudgetExhaustedError");
    } catch (caughtErr) {
      expect(caughtErr).toBeInstanceOf(BudgetExhaustedError);
      expect((caughtErr as BudgetExhaustedError).scope).toBe("per_call_timeout");
    }
  });

  it("user signal beats timeout signal: cancelled takes precedence over budget_exhausted", async () => {
    const controller = new AbortController();
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      budget: { perCallTimeoutMs: 1000 },
      providers: [
        mockProvider({
          behavior: async (_input, _space, sampleOpts: SampleOptions) => {
            await delayWithCancellation(2000, sampleOpts.signal);
            return makeDistribution<ABCLabel>({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const verdictPromise = classifier("input", { signal: controller.signal });
    setTimeout(() => controller.abort("user cancelled first"), 20);
    const verdict = await verdictPromise;
    if (isUnknown(verdict) && verdict.reason.type === "cancelled") {
      expect(verdict.reason.reason).toBe("user cancelled first");
    } else {
      expect.fail(`expected Unknown { cancelled }; got ${JSON.stringify(verdict)}`);
    }
  });
});

describe("chain timeout (R9)", () => {
  it("refuses to start the next provider iteration after wall-clock exceeds chainTimeoutMs", async () => {
    // Engine checks chain budget at the START of each provider iteration (not
    // mid-call; per-call timeout handles in-flight bounds). To trigger
    // chain_timeout we need an earlier provider to consume the entire budget,
    // then verify the engine refuses to start the next iteration.
    let secondProviderStarted = false;
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      budget: { chainTimeoutMs: 50, perCallTimeoutMs: 10_000 },
      providers: [
        mockProvider({
          behavior: async () => {
            // p1 takes 80ms — past the 50ms chain budget — then returns Uncertain.
            await new Promise((resolve) => setTimeout(resolve, 80));
            return makeDistribution<ABCLabel>({ a: 0.5, b: 0.3, c: 0.2 }, 0.95);
          },
          id: "mock/p1",
        }),
        mockProvider({
          behavior: () => {
            secondProviderStarted = true;
            return makeDistribution<ABCLabel>({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
          },
          id: "mock/p2",
        }),
      ],
    });
    const verdict = await classifier("input");
    expect(secondProviderStarted).toBe(false);
    if (isUnknown(verdict) && verdict.reason.type === "budget_exhausted") {
      expect(verdict.reason.scope).toBe("chain_timeout");
    } else {
      expect.fail(
        `expected Unknown { budget_exhausted, chain_timeout }; got ${JSON.stringify(verdict)}`,
      );
    }
  });
});

describe("maxCalls cap (R9)", () => {
  it("limits the number of provider attempts", async () => {
    const providerInvocations: string[] = [];
    const makeUncertainProvider = (id: string) =>
      mockProvider({
        behavior: () => {
          providerInvocations.push(id);
          return makeDistribution<ABCLabel>({ a: 0.5, b: 0.3, c: 0.2 }, 0.95);
        },
        id,
      });
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      budget: { maxCalls: 2 },
      providers: [
        makeUncertainProvider("mock/p1"),
        makeUncertainProvider("mock/p2"),
        makeUncertainProvider("mock/p3"),
      ],
    });
    await classifier("input");
    expect(providerInvocations).toEqual(["mock/p1", "mock/p2"]);
  });
});

describe(".batch cancellation (G15)", () => {
  it("returns partial results: finished Verdicts + Unknown { cancelled } for unfinished", async () => {
    const fastItemThresholdIndex = 2;
    const controller = new AbortController();
    const classifier = domovoi.classifier({
      space: ABC_SPACE,
      thresholds: DEFAULT_THRESHOLDS,
      providers: [
        mockProvider({
          behavior: async (input: string, _space, sampleOpts: SampleOptions) => {
            const itemIndex = Number(input.split("-")[1] ?? "0");
            if (itemIndex < fastItemThresholdIndex) {
              return makeDistribution<ABCLabel>({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
            }
            await delayWithCancellation(2000, sampleOpts.signal);
            return makeDistribution<ABCLabel>({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
          },
        }),
      ],
    });
    const items = ["item-0", "item-1", "item-2", "item-3", "item-4"];
    const batchPromise = classifier.batch(items, { signal: controller.signal, concurrency: 2 });
    setTimeout(() => controller.abort("batch deadline"), 50);
    const verdicts = await batchPromise;

    expect(verdicts).toHaveLength(items.length);
    expect(isClassified(verdicts[0]!)).toBe(true);
    expect(isClassified(verdicts[1]!)).toBe(true);
    for (let itemIndex = fastItemThresholdIndex; itemIndex < items.length; itemIndex++) {
      const verdict = verdicts[itemIndex];
      if (verdict === undefined) {
        expect.fail(`verdicts[${itemIndex}] missing`);
      }
      expect(isUnknown(verdict!)).toBe(true);
      if (isUnknown(verdict!) && verdict!.reason.type !== "cancelled") {
        expect.fail(
          `verdicts[${itemIndex}] expected Unknown { cancelled }; got ${JSON.stringify(verdict)}`,
        );
      }
    }
  });
});
