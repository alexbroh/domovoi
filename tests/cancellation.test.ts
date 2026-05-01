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

const ABC = ["a", "b", "c"] as const;

function dist<T extends string>(probs: Record<T, number>, coverage = 1): Distribution<T> {
  return { probs: probs as Distribution<T>["probs"], coverage };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const reason = signal.reason;
      if (reason instanceof Error) reject(reason);
      else reject(new Error(typeof reason === "string" ? reason : "aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal !== undefined) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        const reason = signal.reason;
        if (reason instanceof Error) reject(reason);
        else reject(new Error(typeof reason === "string" ? reason : "aborted"));
      });
    }
  });
}

describe("pre-aborted signal (G15)", () => {
  it("returns Unknown { cancelled, reason } before any provider call", async () => {
    let providerCalled = false;
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: () => {
            providerCalled = true;
            return dist({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const ctrl = new AbortController();
    ctrl.abort("user navigated away");
    const v = await c("input", { signal: ctrl.signal });
    expect(providerCalled).toBe(false);
    expect(isUnknown(v)).toBe(true);
    if (isUnknown(v) && v.reason.type === "cancelled") {
      expect(v.reason.reason).toBe("user navigated away");
    } else {
      expect.fail("expected Unknown { cancelled }");
    }
  });

  it("uses 'aborted' as default reason when controller.abort() called without args", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [mockProvider({ behavior: () => dist({ a: 1, b: 0, c: 0 }, 1) })],
    });
    const ctrl = new AbortController();
    ctrl.abort(); // no reason
    const v = await c("input", { signal: ctrl.signal });
    if (isUnknown(v) && v.reason.type === "cancelled") {
      // Reason may be "aborted" (string) or a DOMException message.
      expect(typeof v.reason.reason).toBe("string");
    } else {
      expect.fail("expected Unknown { cancelled }");
    }
  });
});

describe("mid-call user abort (G15)", () => {
  it("returns Unknown { cancelled } when abort fires during provider.sample", async () => {
    const ctrl = new AbortController();
    let providerWasAborted = false;
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: async (_input, _space, opts: SampleOptions) => {
            try {
              await delay(500, opts.signal);
              return dist({ a: 1, b: 0, c: 0 }, 1);
            } catch (err) {
              providerWasAborted = true;
              throw err;
            }
          },
        }),
      ],
    });

    const promise = c("input", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort("user clicked cancel"), 10);
    const v = await promise;

    expect(providerWasAborted).toBe(true);
    if (isUnknown(v) && v.reason.type === "cancelled") {
      expect(v.reason.reason).toBe("user clicked cancel");
    } else {
      expect.fail(`expected Unknown { cancelled }; got ${JSON.stringify(v)}`);
    }
  });
});

describe("per-call timeout via AbortSignal.timeout merge (K2)", () => {
  it("returns Unknown { budget_exhausted, scope: 'per_call_timeout' } under default policy", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      budget: { perCallTimeoutMs: 50 },
      providers: [
        mockProvider({
          behavior: async (_input, _space, opts: SampleOptions) => {
            // Provider hangs longer than per-call timeout.
            await delay(500, opts.signal);
            return dist({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const v = await c("input");
    if (isUnknown(v) && v.reason.type === "budget_exhausted") {
      expect(v.reason.scope).toBe("per_call_timeout");
    } else {
      expect.fail(
        `expected Unknown { budget_exhausted, per_call_timeout }; got ${JSON.stringify(v)}`,
      );
    }
  });

  it("throws BudgetExhaustedError under onErrorPolicy: 'throw'", async () => {
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      budget: { perCallTimeoutMs: 50 },
      onErrorPolicy: "throw",
      providers: [
        mockProvider({
          behavior: async (_input, _space, opts: SampleOptions) => {
            await delay(500, opts.signal);
            return dist({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    try {
      await c("input");
      expect.fail("expected BudgetExhaustedError");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhaustedError);
      expect((err as BudgetExhaustedError).scope).toBe("per_call_timeout");
    }
  });

  it("user signal beats timeout signal: cancelled takes precedence over budget_exhausted", async () => {
    const ctrl = new AbortController();
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      budget: { perCallTimeoutMs: 1000 }, // long timeout
      providers: [
        mockProvider({
          behavior: async (_input, _space, opts: SampleOptions) => {
            await delay(2000, opts.signal);
            return dist({ a: 1, b: 0, c: 0 }, 1);
          },
        }),
      ],
    });
    const promise = c("input", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort("user cancelled first"), 20);
    const v = await promise;
    if (isUnknown(v) && v.reason.type === "cancelled") {
      expect(v.reason.reason).toBe("user cancelled first");
    } else {
      expect.fail(`expected Unknown { cancelled }; got ${JSON.stringify(v)}`);
    }
  });
});

describe("chain timeout (R9)", () => {
  it("returns Unknown { budget_exhausted, scope: 'chain_timeout' } when wall-clock exceeds chainTimeoutMs at iteration boundary", async () => {
    // Engine checks chain budget at the START of each provider iteration (not
    // mid-call; per-call timeout handles in-flight bounds). To trigger
    // chain_timeout we need an earlier provider to consume the entire budget,
    // then verify the engine refuses to start the next iteration.
    let p2Started = false;
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      budget: { chainTimeoutMs: 50, perCallTimeoutMs: 10_000 },
      providers: [
        mockProvider({
          behavior: async () => {
            // p1 takes 80ms — past the 50ms chain budget — then returns Uncertain.
            await new Promise((r) => setTimeout(r, 80));
            return dist({ a: 0.5, b: 0.3, c: 0.2 }, 0.95);
          },
          id: "mock/p1",
        }),
        mockProvider({
          behavior: () => {
            p2Started = true;
            return dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
          },
          id: "mock/p2",
        }),
      ],
    });
    const v = await c("input");
    expect(p2Started).toBe(false);
    if (isUnknown(v) && v.reason.type === "budget_exhausted") {
      expect(v.reason.scope).toBe("chain_timeout");
    } else {
      expect.fail(`expected Unknown { budget_exhausted, chain_timeout }; got ${JSON.stringify(v)}`);
    }
  });
});

describe("maxCalls cap (R9)", () => {
  it("limits the number of provider attempts", async () => {
    const calls: string[] = [];
    const makeMock = (id: string) =>
      mockProvider({
        behavior: () => {
          calls.push(id);
          return dist({ a: 0.5, b: 0.3, c: 0.2 }, 0.95); // always Uncertain
        },
        id,
      });
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      budget: { maxCalls: 2 },
      providers: [makeMock("mock/p1"), makeMock("mock/p2"), makeMock("mock/p3")],
    });
    await c("input");
    // Engine should stop after 2 attempts, not 3.
    expect(calls).toEqual(["mock/p1", "mock/p2"]);
  });
});

describe(".batch cancellation (G15)", () => {
  it("returns partial results: finished Verdicts + Unknown { cancelled } for unfinished", async () => {
    const ctrl = new AbortController();
    const c = domovoi.classifier({
      space: ABC,
      thresholds: { high: 0.7, coverageMin: 0.5 },
      providers: [
        mockProvider({
          behavior: async (input: string, _space, opts: SampleOptions) => {
            // First two complete fast; rest hang waiting on signal.
            const idx = Number(input.split("-")[1] ?? "0");
            if (idx < 2) {
              return dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
            }
            await delay(2000, opts.signal);
            return dist({ a: 0.9, b: 0.05, c: 0.05 }, 0.95);
          },
        }),
      ],
    });
    const items = ["item-0", "item-1", "item-2", "item-3", "item-4"];
    const promise = c.batch(items, { signal: ctrl.signal, concurrency: 2 });
    setTimeout(() => ctrl.abort("batch deadline"), 50);
    const results = await promise;
    expect(results).toHaveLength(items.length);
    // First two finished (Classified).
    expect(isClassified(results[0]!)).toBe(true);
    expect(isClassified(results[1]!)).toBe(true);
    // Remaining became Unknown { cancelled } as the abort propagated.
    for (let i = 2; i < items.length; i++) {
      const r = results[i];
      if (r === undefined) {
        expect.fail(`results[${i}] missing`);
      }
      expect(isUnknown(r!)).toBe(true);
      if (isUnknown(r!) && r!.reason.type === "cancelled") {
        // Reason propagated.
      } else {
        expect.fail(`results[${i}] expected Unknown { cancelled }; got ${JSON.stringify(r)}`);
      }
    }
  });
});
