/**
 * Core types for domovoi: typed-uncertainty classification.
 *
 * Verdict<T> is a discriminated union with three variants:
 *   - Classified<T>: confident result; probability ≥ high threshold.
 *   - Uncertain<T>: top class below threshold; carries top, runnerUp, distribution.
 *   - Unknown<T>:  no result; reason discriminates the failure mode.
 */

// ─── Provider capability tiers ──────────────────────────────────────

export type ProviderCapabilities = {
  readonly distributionSource: "logprobs" | "multi_sample";
  readonly coverageMeasurement: "exact" | "approximate" | "none";
  /** Max top-K logprobs returned by provider; 0 for multi_sample. */
  readonly maxTopLogprobs: number;
};

// ─── Distribution ───────────────────────────────────────────────────

export type Distribution<T extends string> = {
  /**
   * Renormalized probability per label. Missing labels (those whose first-token
   * fell outside provider's top-K) are assigned 0 by the engine.
   */
  readonly probs: { readonly [K in T]: number };
  /**
   * Sum of in-space mass before renormalization, ∈ [0, 1].
   * Lower coverage indicates the model wanted to emit out-of-space tokens.
   */
  readonly coverage: number;
};

// ─── SerializableError (for meta.providerErrors) ────────────────────

/**
 * Plain-object error shape; JSON-safe. Engine converts thrown Error instances
 * to this shape when recording into Verdict.meta.providerErrors so that
 * `JSON.stringify(verdict)` produces useful output.
 *
 * Live Error instances are still passed to the `onProviderError` hook with
 * full Error semantics (instanceof checks work there).
 */
export type SerializableError = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: SerializableError;
  readonly stack?: string;
};

// ─── VerdictMeta (on every variant) ─────────────────────────────────

export type VerdictMeta = {
  /** "openai/gpt-4o-mini" — same format as DOMOVOI_PROVIDERS env entries. */
  readonly providerUsed: string;
  /** Every provider attempted, in chain order. */
  readonly providersAttempted: readonly string[];
  /** Errors swallowed during fallback. Empty if no errors. */
  readonly providerErrors: ReadonlyArray<{
    readonly providerId: string;
    readonly error: SerializableError;
  }>;
  /** Wall-clock latency from engine entry to this Verdict. */
  readonly latencyMs: number;
  /** True if the engine resolved this Verdict from cache (no provider call). */
  readonly cacheHit: boolean;
  /** Quality of OOD detection from the answering provider's capabilities. */
  readonly coverageQuality: "exact" | "approximate" | "none";
  /** How the Distribution was constructed by the answering provider. */
  readonly distributionSource: "logprobs" | "multi_sample";
};

// ─── UnknownReason ──────────────────────────────────────────────────

export type UnknownReason<T extends string> =
  | {
      readonly type: "out_of_distribution";
      readonly coverage: number;
      readonly topIfRenormalized: T;
      readonly probabilityIfRenormalized: number;
    }
  | {
      readonly type: "chain_exhausted";
      readonly lastDistribution: Distribution<T>;
      readonly providersAttempted: number;
    }
  | {
      readonly type: "predicate_rejected";
      readonly previousKind: "classified" | "uncertain";
    }
  | {
      readonly type: "provider_failure";
      readonly errors: readonly SerializableError[];
    }
  | {
      readonly type: "budget_exhausted";
      readonly scope: "per_call_timeout" | "chain_timeout" | "max_calls";
    }
  | {
      readonly type: "cancelled";
      readonly reason?: string;
    };

// ─── Verdict variants ───────────────────────────────────────────────

/**
 * The classifier produced a confident result: `value` is one of the labels
 * in the decision space, with calibrated probability ≥ the `high` threshold.
 */
export type Classified<T extends string> = {
  readonly kind: "classified";
  readonly value: T;
  /** Post-calibration probability of `value`, ∈ [0, 1]. */
  readonly probability: number;
  readonly meta: VerdictMeta;
};

/**
 * The classifier identified a top candidate but its probability was below
 * the `high` threshold (or the margin requirement was not met).
 */
export type Uncertain<T extends string> = {
  readonly kind: "uncertain";
  readonly top: T;
  /** Post-calibration probability of `top`, ∈ [0, 1]. */
  readonly probability: number;
  readonly runnerUp: T;
  readonly distribution: Distribution<T>;
  readonly meta: VerdictMeta;
};

/**
 * No usable classification was produced. Inspect `reason.type` to discriminate
 * out_of_distribution / chain_exhausted / predicate_rejected / provider_failure
 * / budget_exhausted / cancelled.
 */
export type Unknown<T extends string> = {
  readonly kind: "unknown";
  readonly reason: UnknownReason<T>;
  readonly meta: VerdictMeta;
};

/**
 * Convenience union over the three variants. Pattern-match on `kind` to
 * narrow, or use the type guards (`isClassified`, `isUncertain`, `isUnknown`),
 * or use the `match` helper for exhaustive handling.
 */
export type Verdict<T extends string> = Classified<T> | Uncertain<T> | Unknown<T>;

// ─── Filterable subset (used by Verdict.filter) ─────────────────────

/** Verdict variants that carry a top-class candidate (Classified or Uncertain). */
export type Filterable<T extends string> = Classified<T> | Uncertain<T>;

// ─── Thresholds (discriminated by space size) ───────────────────────

/**
 * Thresholds discriminated by space length:
 *   - Binary (length 2): requires `high` and `low` (deadband).
 *   - Multi-class: requires `high`, optional `margin`.
 *
 * Value rules enforced at construction:
 *   - All thresholds in [0, 1] inclusive.
 *   - Binary: `high > low` strict.
 *   - `margin >= 0`.
 */
export type Thresholds<Space extends readonly string[]> = Space["length"] extends 2
  ? {
      readonly high: number;
      readonly low: number;
      readonly coverageMin?: number;
    }
  : {
      readonly high: number;
      readonly margin?: number;
      readonly coverageMin?: number;
    };

// ─── Budget ─────────────────────────────────────────────────────────

export type Budget = {
  /** Wall-clock per-provider-call timeout. Default 10_000ms. */
  readonly perCallTimeoutMs?: number;
  /** Wall-clock across all providers in the chain (incl. future retries). Default 30_000ms. */
  readonly chainTimeoutMs?: number;
  /** Hard cap on number of provider calls per classification. Default = chain length. */
  readonly maxCalls?: number;
};

// ─── PromptTemplate ─────────────────────────────────────────────────

export type PromptTemplate = {
  /** Optional system prompt; undefined skips the system message. */
  readonly systemPrompt?: string;
  /**
   * Renders the user message. {labels_csv} is filled by the engine in
   * user-given order. Single newline between question and input;
   * question undefined → just input (no leading newline).
   */
  readonly userTemplate: (input: string, space: readonly string[], question?: string) => string;
  /**
   * Stable hash for cache-key composition. Library default is
   * "domovoi/v0-default"; user overrides must supply their own.
   */
  readonly templateHash: string;
};
