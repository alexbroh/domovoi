/**
 * Integration tests for `domovoi.scope` + engine cooperation.
 *
 * Covers budget enforcement (graceful + throw), signal propagation,
 * tracer span emission, cache-hit semantics, and bind-across-async.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resetContextStorage } from "../src/context-storage.js";
import { BudgetExceededError, ConfigError } from "../src/errors.js";
import { domovoi } from "../src/index.js";
import { mockProvider } from "../src/testing/index.js";
import type { AttributeValue, Span, Tracer } from "../src/tracer.js";

afterEach(() => {
  resetContextStorage();
});

type RecordedSpan = {
  readonly name: string;
  readonly attrs: Record<string, AttributeValue>;
  readonly status?: "ok" | "error";
  readonly exceptions: unknown[];
  readonly ended: boolean;
};

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name, attrs) {
      const record: RecordedSpan = {
        name,
        attrs: { ...(attrs ?? {}) },
        status: undefined,
        exceptions: [],
        ended: false,
      };
      spans.push(record);
      const mutable = record as { -readonly [K in keyof RecordedSpan]: RecordedSpan[K] };
      const span: Span = {
        setAttribute(key, value) {
          (mutable.attrs as Record<string, AttributeValue>)[key] = value;
        },
        recordException(err) {
          mutable.exceptions.push(err);
        },
        setStatus(status) {
          mutable.status = status;
        },
        end() {
          mutable.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

const space = ["a", "b"] as const;
const thresholds = { high: 0.7, low: 0.3, coverageMin: 0.5 };

describe("scope budget enforcement", () => {
  it("graceful mode returns Unknown { budget_exceeded } when scope is pre-exhausted", async () => {
    await domovoi.scope({ budget: { tokens: 1 } }, async () => {
      const tracker = domovoi.currentScope()?.budgetTracker;
      tracker?.charge(100); // exhaust the budget before the classify call

      const verdict = await domovoi.classify("hello", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
          }),
        ],
        thresholds,
      });

      expect(verdict.kind).toBe("unknown");
      if (verdict.kind === "unknown" && verdict.reason.type === "budget_exceeded") {
        expect(verdict.reason.spent).toBe(100);
        expect(verdict.reason.limit).toBe(1);
      } else {
        expect.fail(`expected budget_exceeded, got ${JSON.stringify(verdict.reason)}`);
      }
    });
  });

  it("throw mode throws BudgetExceededError when scope is pre-exhausted", async () => {
    await domovoi.scope({ budget: { tokens: 1, onExceeded: "throw" } }, async () => {
      const tracker = domovoi.currentScope()?.budgetTracker;
      tracker?.charge(100);

      await expect(
        domovoi.classify("hello", space, {
          providers: [
            mockProvider({
              behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
            }),
          ],
          thresholds,
        }),
      ).rejects.toThrow(BudgetExceededError);
    });
  });

  it("budget charges accumulate across multiple classify calls", async () => {
    await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
      const tracker = domovoi.currentScope()?.budgetTracker;
      const before = tracker?.snapshot().spent ?? 0;

      await domovoi.classify("hello world", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
          }),
        ],
        thresholds,
      });
      const after1 = tracker?.snapshot().spent ?? 0;

      await domovoi.classify("hello world", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
            id: "mock/different", // different id → different cache key → fresh call
          }),
        ],
        thresholds,
      });
      const after2 = tracker?.snapshot().spent ?? 0;

      expect(after1).toBeGreaterThan(before);
      expect(after2).toBeGreaterThan(after1);
    });
  });

  it("cache hit does not charge the budget tracker", async () => {
    await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
      const tracker = domovoi.currentScope()?.budgetTracker;
      const provider = mockProvider({
        behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
      });
      const cache = domovoi.memoryCache();

      // First call: cache miss → charges
      await domovoi.classify("same input", space, {
        providers: [provider],
        thresholds,
        cache,
      });
      const afterFirst = tracker?.snapshot().spent ?? 0;
      expect(afterFirst).toBeGreaterThan(0);

      // Second call with same input + provider + cache: cache hit → no charge
      await domovoi.classify("same input", space, {
        providers: [provider],
        thresholds,
        cache,
      });
      const afterSecond = tracker?.snapshot().spent ?? 0;
      expect(afterSecond).toBe(afterFirst);
    });
  });

  it("rejects invalid budget tokens at construction (synchronous throw)", () => {
    expect(() => domovoi.scope({ budget: { tokens: -1 } }, async () => undefined)).toThrow(
      ConfigError,
    );
  });
});

describe("scope signal propagation", () => {
  it("scope.signal pre-aborts the classify call", async () => {
    const ac = new AbortController();
    ac.abort("scope cancelled");

    await domovoi.scope({ signal: ac.signal }, async () => {
      const verdict = await domovoi.classify("hello", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
          }),
        ],
        thresholds,
      });
      expect(verdict.kind).toBe("unknown");
      if (verdict.kind === "unknown") {
        expect(verdict.reason.type).toBe("cancelled");
      }
    });
  });

  it("scope.signal AND-combines with per-call signal", async () => {
    const scopeAc = new AbortController();
    const callAc = new AbortController();
    callAc.abort("call cancelled");

    await domovoi.scope({ signal: scopeAc.signal }, async () => {
      const verdict = await domovoi.classify("hello", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
          }),
        ],
        thresholds,
        signal: callAc.signal,
      });
      expect(verdict.kind).toBe("unknown");
    });
  });
});

describe("tracer span emission", () => {
  it("emits a span per provider call with gen_ai + domovoi attributes", async () => {
    const { tracer, spans } = recordingTracer();

    await domovoi.scope({ tracer }, async () => {
      await domovoi.classify("hello", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
            id: "mock/test",
            modelId: "test-model",
          }),
        ],
        thresholds,
      });
    });

    expect(spans.length).toBe(1);
    const s = spans[0];
    if (!s) throw new Error("no span recorded");
    expect(s.name).toBe("chat mock/test");
    expect(s.attrs["gen_ai.provider.name"]).toBe("mock/test");
    expect(s.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(s.attrs["gen_ai.request.model"]).toBe("test-model");
    expect(s.attrs["domovoi.label_space"]).toEqual(["a", "b"]);
    expect(s.attrs["gen_ai.usage.input_tokens"]).toBeTypeOf("number");
    expect(s.attrs["gen_ai.usage.output_tokens"]).toBeTypeOf("number");
    expect(s.attrs["domovoi.cache.hit"]).toBe(false);
    expect(s.attrs["domovoi.verdict.kind"]).toBe("classified");
    expect(s.attrs["domovoi.verdict.value"]).toBe("a");
    expect(s.status).toBe("ok");
    expect(s.ended).toBe(true);
  });

  it("marks cache hit with domovoi.cache.hit=true and skips token attrs", async () => {
    const { tracer, spans } = recordingTracer();
    const provider = mockProvider({
      behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
    });
    const cache = domovoi.memoryCache();

    await domovoi.scope({ tracer }, async () => {
      await domovoi.classify("input", space, { providers: [provider], thresholds, cache });
      await domovoi.classify("input", space, { providers: [provider], thresholds, cache });
    });

    expect(spans.length).toBe(2);
    expect(spans[0]?.attrs["domovoi.cache.hit"]).toBe(false);
    expect(spans[1]?.attrs["domovoi.cache.hit"]).toBe(true);
    // Cache hit should NOT have token usage attributes
    expect(spans[1]?.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(spans[1]?.attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
  });

  it("records exception and error status when provider throws", async () => {
    const { tracer, spans } = recordingTracer();
    const failing = mockProvider({
      behavior: () => {
        throw new Error("provider boom");
      },
    });

    await domovoi.scope({ tracer }, async () => {
      await domovoi.classify("input", space, { providers: [failing], thresholds });
    });

    const s = spans[0];
    if (!s) throw new Error("no span recorded");
    expect(s.exceptions.length).toBe(1);
    expect(s.status).toBe("error");
    expect(s.ended).toBe(true);
  });

  it("records exception and error status on enforce()-throw under throw mode", async () => {
    // Charge after this call exhausts the budget; enforce() throws
    // BudgetExceededError, which the outer catch records on the span.
    const { tracer, spans } = recordingTracer();
    const provider = mockProvider({
      behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
    });

    await expect(
      domovoi.scope({ tracer, budget: { tokens: 10, onExceeded: "throw" } }, async () => {
        // Input + output token estimate exceeds limit of 10 → enforce() throws
        await domovoi.classify("this is a long enough input to overrun the tiny budget", space, {
          providers: [provider],
          thresholds,
        });
      }),
    ).rejects.toThrow(BudgetExceededError);

    const s = spans[0];
    if (!s) throw new Error("no span recorded");
    expect(s.exceptions.length).toBeGreaterThan(0);
    expect(s.status).toBe("error");
    expect(s.ended).toBe(true);
  });

  it("does not require a tracer (noop when scope has none)", async () => {
    await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
      const verdict = await domovoi.classify("input", space, {
        providers: [
          mockProvider({
            behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
          }),
        ],
        thresholds,
      });
      expect(verdict.kind).toBe("classified");
    });
  });
});

describe("bind across async boundary", () => {
  it("preserves budget tracker when invoked outside the original scope", async () => {
    let bound: (() => Promise<number>) | undefined;
    const provider = mockProvider({
      behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
    });

    await domovoi.scope({ budget: { tokens: 100_000 } }, () => {
      bound = domovoi.bind(async () => {
        await domovoi.classify("input", space, { providers: [provider], thresholds });
        return domovoi.currentScope()?.budgetTracker?.snapshot().spent ?? 0;
      });
    });

    // Outside the original scope, the bound fn restores it and the budget
    // tracker keeps accumulating across invocations
    const spent1 = await bound?.();
    const spent2 = await bound?.();
    expect(spent1).toBeGreaterThan(0);
    expect(spent2).toBeGreaterThan(spent1 ?? 0);
  });
});

describe("nested scope inheritance with engine", () => {
  it("inner classify charges parent's shared budget tracker", async () => {
    await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
      const outerTracker = domovoi.currentScope()?.budgetTracker;
      const provider = mockProvider({
        behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
      });

      await domovoi.scope({}, async () => {
        await domovoi.classify("inner call", space, {
          providers: [provider],
          thresholds,
        });
      });

      // Charge from inner classify is reflected in the outer tracker
      expect(outerTracker?.snapshot().spent).toBeGreaterThan(0);
    });
  });

  it("inner scope's budget overrides parent (does not share)", async () => {
    await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
      const outerTracker = domovoi.currentScope()?.budgetTracker;
      const beforeOuter = outerTracker?.snapshot().spent ?? 0;
      const provider = mockProvider({
        behavior: () => ({ probs: { a: 0.9, b: 0.1 }, coverage: 0.95 }),
      });

      await domovoi.scope({ budget: { tokens: 100_000 } }, async () => {
        await domovoi.classify("inner call", space, {
          providers: [provider],
          thresholds,
        });
      });

      // Inner scope's fresh tracker absorbed the charge; outer is unchanged
      expect(outerTracker?.snapshot().spent).toBe(beforeOuter);
    });
  });
});
