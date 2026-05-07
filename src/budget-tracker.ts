/**
 * Running token-budget counter held inside a `ResolvedScope`. Shared across
 * nested `domovoi.scope({...})` calls that inherit the parent's budget,
 * which is why this is a class rather than a closure: the "shared mutable
 * counter" model needs to be explicit.
 *
 * Two-phase enforcement:
 *   - `precheck()` before each provider call — short-circuits if already
 *     exhausted, so a runaway loop stops on its next iteration.
 *   - `charge(tokens)` after each provider call — accumulates real spend.
 *
 * Default mode is `"graceful"`: when exhausted, the engine returns
 * `Unknown { reason: { type: "budget_exceeded", spent, limit } }` instead
 * of throwing. Users who want hard-fail semantics opt into `"throw"` mode.
 *
 * Honest contract: `precheck` measures "have we already exceeded?", not
 * "would this call exceed?" — a single in-flight call can overshoot the
 * limit by one call's worth of tokens. Tighter pre-charge enforcement
 * (estimate via tokenizer before call) is possible but defer; document
 * the overshoot in the README so users know.
 */

import { BudgetExceededError, ConfigError } from "./errors.js";

export type BudgetMode = "graceful" | "throw";

export type ScopeBudget = {
  readonly tokens?: number;
  readonly onExceeded?: BudgetMode;
};

export type BudgetSnapshot = {
  readonly spent: number;
  readonly limit: number;
  readonly mode: BudgetMode;
};

type PrecheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly spent: number; readonly limit: number };

export class BudgetTracker {
  private spent = 0;

  constructor(
    private readonly limit: number,
    public readonly mode: BudgetMode,
  ) {}

  /**
   * Build a tracker from a public `ScopeBudget`, or return `undefined` if
   * the budget is absent / has no `tokens` field. Used during scope merge.
   *
   * Throws `ConfigError` if `tokens` is non-finite or non-positive — these
   * are construction-time validation failures, not runtime budget exhaustion.
   */
  static from(budget: ScopeBudget | undefined): BudgetTracker | undefined {
    if (budget?.tokens === undefined) return undefined;
    if (!Number.isFinite(budget.tokens) || budget.tokens <= 0) {
      throw new ConfigError(
        `Scope budget tokens must be a finite positive number, got ${budget.tokens}`,
        { code: "invalid_scope_budget" },
      );
    }
    return new BudgetTracker(budget.tokens, budget.onExceeded ?? "graceful");
  }

  /** Check whether the budget is already exhausted. Called pre-call. */
  precheck(): PrecheckResult {
    if (this.isExhausted()) {
      return { ok: false, spent: this.spent, limit: this.limit };
    }
    return { ok: true };
  }

  /**
   * Accumulate spend. Called post-call with the actual token cost.
   * Negative or non-finite values are silently clamped to 0 — provider
   * adapters occasionally return malformed token counts, and a budget
   * tracker shouldn't panic on bad telemetry from upstream.
   */
  charge(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.spent += tokens;
  }

  /**
   * Throw `BudgetExceededError` if mode is `"throw"` and budget is exhausted.
   * Caller invokes after `charge()` to enforce hard-fail semantics; under
   * `"graceful"` mode this is a no-op and the next `precheck()` returns
   * `{ ok: false, ... }` for graceful Unknown construction.
   */
  enforce(): void {
    if (this.isExhausted() && this.mode === "throw") {
      throw new BudgetExceededError({ spent: this.spent, limit: this.limit });
    }
  }

  snapshot(): BudgetSnapshot {
    return { spent: this.spent, limit: this.limit, mode: this.mode };
  }

  private isExhausted(): boolean {
    return this.spent >= this.limit;
  }
}
