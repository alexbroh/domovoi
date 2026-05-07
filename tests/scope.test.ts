import { afterEach, describe, expect, it } from "vitest";
import { resetContextStorage } from "../src/context-storage.js";
import { bind, currentScope, mergeScopes, scope } from "../src/scope.js";
import type { Tracer } from "../src/tracer.js";

afterEach(() => {
  resetContextStorage();
});

describe("scope() basic propagation", () => {
  it("currentScope returns undefined outside any scope", () => {
    expect(currentScope()).toBeUndefined();
  });

  it("currentScope returns the active scope inside scope()", async () => {
    const ac = new AbortController();
    await scope({ signal: ac.signal }, () => {
      const s = currentScope();
      expect(s).toBeDefined();
      expect(s?.signal).toBeDefined();
    });
  });

  it("currentScope returns undefined after scope() completes", async () => {
    await scope({ signal: new AbortController().signal }, () => undefined);
    expect(currentScope()).toBeUndefined();
  });

  it("propagates scope across awaited continuations", async () => {
    const ac = new AbortController();
    await scope({ signal: ac.signal }, async () => {
      await new Promise((r) => setTimeout(r, 0));
      const s = currentScope();
      expect(s?.signal).toBeDefined();
    });
  });
});

describe("scope() — budget tracker construction", () => {
  it("constructs a budget tracker when budget.tokens is set", async () => {
    await scope({ budget: { tokens: 100 } }, () => {
      const s = currentScope();
      expect(s?.budgetTracker).toBeDefined();
      expect(s?.budgetTracker?.snapshot()).toEqual({
        spent: 0,
        limit: 100,
        mode: "graceful",
      });
    });
  });

  it("respects throw mode", async () => {
    await scope({ budget: { tokens: 100, onExceeded: "throw" } }, () => {
      expect(currentScope()?.budgetTracker?.mode).toBe("throw");
    });
  });

  it("does not construct a tracker when budget is omitted", async () => {
    await scope({}, () => {
      expect(currentScope()?.budgetTracker).toBeUndefined();
    });
  });

  it("does not construct a tracker when budget has no tokens field", async () => {
    await scope({ budget: {} }, () => {
      expect(currentScope()?.budgetTracker).toBeUndefined();
    });
  });
});

describe("scope() — nested inheritance", () => {
  it("inner scope inherits parent's signal when child omits it", async () => {
    const ac = new AbortController();
    await scope({ signal: ac.signal }, async () => {
      await scope({}, () => {
        expect(currentScope()?.signal).toBeDefined();
      });
    });
  });

  it("inner scope inherits parent's tracer when child omits it", async () => {
    const tracer: Tracer = { startSpan: () => ({}) as never };
    await scope({ tracer }, async () => {
      await scope({}, () => {
        expect(currentScope()?.tracer).toBe(tracer);
      });
    });
  });

  it("inner scope inherits parent's budget tracker by reference (shared counter)", async () => {
    await scope({ budget: { tokens: 1000 } }, async () => {
      const outerTracker = currentScope()?.budgetTracker;
      outerTracker?.charge(300);

      await scope({}, () => {
        const innerTracker = currentScope()?.budgetTracker;
        expect(innerTracker).toBe(outerTracker);
        innerTracker?.charge(200);
      });

      // Child's charges roll up to parent's tracker
      expect(outerTracker?.snapshot().spent).toBe(500);
    });
  });

  it("inner scope's tracer overrides parent's tracer", async () => {
    const outerTracer: Tracer = { startSpan: () => ({}) as never };
    const innerTracer: Tracer = { startSpan: () => ({}) as never };

    await scope({ tracer: outerTracer }, async () => {
      await scope({ tracer: innerTracer }, () => {
        expect(currentScope()?.tracer).toBe(innerTracer);
      });
      // Outer scope's tracer is restored after inner scope completes
      expect(currentScope()?.tracer).toBe(outerTracer);
    });
  });

  it("inner scope's budget creates a fresh tracker (override)", async () => {
    await scope({ budget: { tokens: 1000 } }, async () => {
      const outerTracker = currentScope()?.budgetTracker;
      outerTracker?.charge(500);

      await scope({ budget: { tokens: 100 } }, () => {
        const innerTracker = currentScope()?.budgetTracker;
        expect(innerTracker).not.toBe(outerTracker);
        expect(innerTracker?.snapshot().spent).toBe(0);
        expect(innerTracker?.snapshot().limit).toBe(100);
      });

      expect(outerTracker?.snapshot().spent).toBe(500);
    });
  });

  it("inner scope's signal AND-combines with parent's signal", async () => {
    const outerAc = new AbortController();
    const innerAc = new AbortController();

    await scope({ signal: outerAc.signal }, async () => {
      await scope({ signal: innerAc.signal }, () => {
        const merged = currentScope()?.signal;
        expect(merged).toBeDefined();
        expect(merged).not.toBe(outerAc.signal);
        expect(merged).not.toBe(innerAc.signal);
        // Aborting either one fires the merged signal
        expect(merged?.aborted).toBe(false);
        innerAc.abort("inner aborted");
        expect(merged?.aborted).toBe(true);
      });
    });
  });
});

describe("mergeScopes", () => {
  it("returns empty object for empty parent + empty child", () => {
    const merged = mergeScopes(undefined, {});
    expect(merged).toEqual({});
  });

  it("preserves child fields when parent is undefined", () => {
    const ac = new AbortController();
    const merged = mergeScopes(undefined, { signal: ac.signal });
    expect(merged.signal).toBe(ac.signal);
  });

  it("AbortSignal.any combines two signals", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeScopes({ signal: a.signal }, { signal: b.signal });
    expect(merged.signal).toBeDefined();
    expect(merged.signal).not.toBe(a.signal);
    expect(merged.signal).not.toBe(b.signal);
  });
});

describe("bind()", () => {
  it("returns the original fn when no enclosing scope", () => {
    const fn = (x: number) => x * 2;
    const bound = bind(fn);
    expect(bound).toBe(fn);
    expect(bound(5)).toBe(10);
  });

  it("re-applies the captured scope on later invocation", async () => {
    let captured: ((x: number) => number) | undefined;
    const ac = new AbortController();

    await scope({ signal: ac.signal, budget: { tokens: 1000 } }, () => {
      captured = bind((x: number) => {
        // Inside the bound fn, we should see the captured scope
        const s = currentScope();
        expect(s?.signal).toBe(ac.signal);
        expect(s?.budgetTracker?.snapshot().limit).toBe(1000);
        return x * 2;
      });
    });

    // Outside the original scope: currentScope is undefined
    expect(currentScope()).toBeUndefined();
    // But the bound fn restores it
    expect(captured?.(5)).toBe(10);
    expect(currentScope()).toBeUndefined(); // restored after bound returns
  });

  it("preserves shared budget counter across bound invocations", async () => {
    let bound: (() => number | undefined) | undefined;

    await scope({ budget: { tokens: 1000 } }, () => {
      bound = bind(() => {
        const tracker = currentScope()?.budgetTracker;
        tracker?.charge(100);
        return tracker?.snapshot().spent;
      });
    });

    // Each bound invocation runs against the same captured tracker;
    // the running counter accumulates across invocations.
    expect(bound?.()).toBe(100);
    expect(bound?.()).toBe(200);
    expect(bound?.()).toBe(300);
  });

  it("works with async functions", async () => {
    let bound: ((x: number) => Promise<number>) | undefined;
    const tracer: Tracer = { startSpan: () => ({}) as never };

    await scope({ tracer }, () => {
      bound = bind(async (x: number) => {
        await new Promise((r) => setTimeout(r, 0));
        expect(currentScope()?.tracer).toBe(tracer);
        return x + 1;
      });
    });

    const result = await bound?.(5);
    expect(result).toBe(6);
  });

  it("nested bind: inner captures the outer-bound scope transitively", async () => {
    const ac = new AbortController();
    let outerBound: (() => unknown) | undefined;

    await scope({ signal: ac.signal }, () => {
      outerBound = bind(() => {
        // Inside outer-bound, scope is restored. Now bind again:
        const innerBound = bind(() => {
          return currentScope()?.signal;
        });
        return innerBound();
      });
    });

    // Outside any scope, invoking the outer-bound runs the captured inner bind:
    const seenSignal = outerBound?.();
    expect(seenSignal).toBe(ac.signal);
  });
});
