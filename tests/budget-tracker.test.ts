import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget-tracker.js";
import { BudgetExceededError, ConfigError } from "../src/errors.js";

describe("BudgetTracker.from", () => {
  it("returns undefined when budget is undefined", () => {
    expect(BudgetTracker.from(undefined)).toBeUndefined();
  });

  it("returns undefined when budget.tokens is omitted", () => {
    expect(BudgetTracker.from({})).toBeUndefined();
  });

  it("constructs a tracker when tokens is provided", () => {
    const t = BudgetTracker.from({ tokens: 100 });
    expect(t).toBeDefined();
    expect(t?.snapshot()).toEqual({ spent: 0, limit: 100, mode: "graceful" });
  });

  it("respects explicit onExceeded mode", () => {
    const t = BudgetTracker.from({ tokens: 100, onExceeded: "throw" });
    expect(t?.mode).toBe("throw");
  });

  it("defaults onExceeded to graceful", () => {
    const t = BudgetTracker.from({ tokens: 100 });
    expect(t?.mode).toBe("graceful");
  });

  it("throws ConfigError when tokens is zero", () => {
    expect(() => BudgetTracker.from({ tokens: 0 })).toThrow(ConfigError);
  });

  it("throws ConfigError when tokens is negative", () => {
    expect(() => BudgetTracker.from({ tokens: -100 })).toThrow(ConfigError);
  });

  it("throws ConfigError when tokens is NaN", () => {
    expect(() => BudgetTracker.from({ tokens: Number.NaN })).toThrow(ConfigError);
  });

  it("throws ConfigError when tokens is Infinity", () => {
    expect(() => BudgetTracker.from({ tokens: Number.POSITIVE_INFINITY })).toThrow(ConfigError);
  });

  it("ConfigError carries invalid_scope_budget code", () => {
    try {
      BudgetTracker.from({ tokens: -1 });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("invalid_scope_budget");
    }
  });
});

describe("BudgetTracker.precheck", () => {
  it("returns ok before any spend", () => {
    const t = new BudgetTracker(100, "graceful");
    expect(t.precheck()).toEqual({ ok: true });
  });

  it("returns ok while spent < limit", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(50);
    expect(t.precheck()).toEqual({ ok: true });
  });

  it("returns failure when spent >= limit", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(100);
    expect(t.precheck()).toEqual({ ok: false, spent: 100, limit: 100 });
  });

  it("returns failure on overshoot", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(150);
    expect(t.precheck()).toEqual({ ok: false, spent: 150, limit: 100 });
  });
});

describe("BudgetTracker.charge", () => {
  it("accumulates spend across calls", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(30);
    t.charge(20);
    expect(t.snapshot().spent).toBe(50);
  });

  it("does not throw on overshoot under graceful mode", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(200);
    expect(t.snapshot().spent).toBe(200);
  });

  it("clamps non-finite token counts to zero (defensive against bad provider telemetry)", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(Number.NaN);
    t.charge(Number.POSITIVE_INFINITY);
    t.charge(-50);
    t.charge(0);
    expect(t.snapshot().spent).toBe(0);
  });
});

describe("BudgetTracker.enforce", () => {
  it("does nothing under graceful mode even when exhausted", () => {
    const t = new BudgetTracker(100, "graceful");
    t.charge(150);
    expect(() => t.enforce()).not.toThrow();
  });

  it("throws BudgetExceededError under throw mode when exhausted", () => {
    const t = new BudgetTracker(100, "throw");
    t.charge(150);
    expect(() => t.enforce()).toThrow(BudgetExceededError);
  });

  it("does not throw under throw mode when not yet exhausted", () => {
    const t = new BudgetTracker(100, "throw");
    t.charge(50);
    expect(() => t.enforce()).not.toThrow();
  });

  it("error carries spent and limit", () => {
    const t = new BudgetTracker(100, "throw");
    t.charge(150);
    try {
      t.enforce();
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.spent).toBe(150);
      expect(e.limit).toBe(100);
      expect(e.code).toBe("tokens_exceeded");
    }
  });
});

describe("BudgetTracker shared counter (nested-scope semantics)", () => {
  it("two scopes holding the same tracker share the counter", () => {
    // Simulates parent scope's tracker being inherited by child scope.
    // Mutation in either reflects in the snapshot of both.
    const shared = new BudgetTracker(1000, "graceful");
    shared.charge(300);
    // Child scope inherits by reference (mergeScopes behavior in scope.ts).
    const fromParent = shared;
    fromParent.charge(400);
    expect(shared.snapshot().spent).toBe(700);
    expect(fromParent.snapshot().spent).toBe(700);
  });
});
