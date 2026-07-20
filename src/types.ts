/**
 * Core types for domovoi: typed-uncertainty classification.
 */

/**
 * Capabilities a Provider declares about its sampling behavior. The engine
 * uses these to decide how to interpret the returned `Distribution` and
 * which providers in a chain produce comparable Verdict metadata.
 */
export type ProviderCapabilities = {
  readonly distributionSource: "logprobs" | "multi_sample";
  readonly coverageMeasurement: "exact" | "approximate" | "none";
  /** Max top-K logprobs returned by the provider; 0 for `multi_sample`. */
  readonly maxTopLogprobs: number;
};

/**
 * The label-type domain a Verdict can range over: string for multi-class
 * spaces, boolean for the binary `domovoi.boolean()` verb.
 */
export type Label = string | boolean;

/**
 * Probability distribution over the labels of a decision space, plus a
 * coverage signal that measures how much probability mass the model put
 * on labels outside the space.
 */
export type Distribution<T extends Label> = {
  /**
   * Probability per label, renormalized to sum to 1 over the space. Labels
   * the model didn't express any opinion on are present with value 0.
   */
  readonly probs: [T] extends [string]
    ? { readonly [K in T]: number }
    : { readonly [K in `${T & boolean}`]: number };
  /**
   * Pre-renormalization mass on in-space labels, ∈ [0, 1]. Low coverage
   * means the model wanted to answer with something outside the space.
   */
  readonly coverage: number;
};

/**
 * Plain-object error shape. `Verdict.meta.providerErrors[i].error` carries
 * this so `JSON.stringify(verdict)` round-trips cleanly. Live `Error`
 * instances are still passed to the `onProviderError` hook for callers
 * that need `instanceof` semantics.
 */
export type SerializableError = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: SerializableError;
  readonly stack?: string;
};

/** Backend-reported token counts for one provider call. */
export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * What this Verdict cost, summed across every provider call the engine made
 * for it — including calls whose provider was later escalated past or
 * errored after responding. Only backend-*reported* usage accumulates here;
 * calls against backends that report no usage are excluded (spans carry
 * estimates for those, flagged `domovoi.usage.estimated`). Absent entirely
 * when the Verdict was served without any provider call (pure cache hit).
 */
export type VerdictCost = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * USD spend, present only when every usage-reporting provider attempted
   * for this Verdict declared pricing — a partial sum would silently
   * under-report, so it is omitted instead.
   */
  readonly usd?: number;
};

/**
 * Per-Verdict metadata recorded by the engine. Present on every variant —
 * gives observability into which provider answered, how long it took, and
 * what failed along the way without separate instrumentation.
 */
export type VerdictMeta = {
  /** Provider that produced this Verdict, in `factory/model` form. */
  readonly providerUsed: string;
  /** Every provider attempted, in chain order. */
  readonly providersAttempted: readonly string[];
  /** Errors swallowed during fallback. Empty when no errors occurred. */
  readonly providerErrors: ReadonlyArray<{
    readonly providerId: string;
    readonly error: SerializableError;
  }>;
  /** Wall-clock latency from engine entry to this Verdict. */
  readonly latencyMs: number;
  /** True when this Verdict was served from cache. */
  readonly cacheHit: boolean;
  /** OOD-signal quality from the answering provider. */
  readonly coverageQuality: "exact" | "approximate" | "none";
  /** How the answering provider constructed its Distribution. */
  readonly distributionSource: "logprobs" | "multi_sample";
  /** See `VerdictCost`. Absent on pure cache hits. */
  readonly cost?: VerdictCost;
};

/**
 * Why a Verdict came back as `Unknown`. Each variant carries the data
 * relevant to its mode — surface it for routing, alerting, or retry logic.
 */
export type UnknownVerdictCause<T extends Label> =
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
      readonly type: "budget_exceeded";
      readonly spent: number;
      readonly limit: number;
    }
  | {
      readonly type: "cancelled";
      readonly reason?: string;
    };

/**
 * Confident result. `value` cleared the `high` threshold (and the margin
 * requirement, if any) over the decision space.
 */
export type Classified<T extends Label> = {
  readonly kind: "classified";
  readonly value: T;
  /** Calibrated probability of `value`, ∈ [0, 1]. */
  readonly probability: number;
  readonly meta: VerdictMeta;
};

/**
 * Top candidate found, but below the `high` threshold (or the margin
 * requirement was not met). Carries `runnerUp` so callers can fall back,
 * confirm with the user, or escalate to a stronger model with both
 * candidates in scope.
 */
export type Uncertain<T extends Label> = {
  readonly kind: "uncertain";
  readonly top: T;
  /** Calibrated probability of `top`, ∈ [0, 1]. */
  readonly probability: number;
  readonly runnerUp: T;
  readonly distribution: Distribution<T>;
  readonly meta: VerdictMeta;
};

/** No usable classification. `reason.type` discriminates the cause. */
export type Unknown<T extends Label> = {
  readonly kind: "unknown";
  readonly reason: UnknownVerdictCause<T>;
  readonly meta: VerdictMeta;
};

/**
 * The discriminated union returned by every classifier call. Narrow with
 * `kind`, the type guards (`isClassified` / `isUncertain` / `isUnknown`),
 * or `match` for exhaustive handling.
 */
export type Verdict<T extends Label> = Classified<T> | Uncertain<T> | Unknown<T>;

/** Verdict variants that carry a top-class candidate. */
export type Filterable<T extends Label> = Classified<T> | Uncertain<T>;

/**
 * Threshold rules, discriminated by space length. Binary spaces use a
 * deadband (`high` / `low`); multi-class spaces use a top-confidence rule
 * with optional margin. Values must lie in `[0, 1]` and binary `high` must
 * exceed `low` strictly.
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

/** Caps on time and provider calls. Defaults applied if a field is omitted. */
export type Budget = {
  /** Per-provider-call wall-clock timeout. Default 10_000ms. */
  readonly perCallTimeoutMs?: number;
  /** Across-the-chain wall-clock budget. Default 30_000ms. */
  readonly chainTimeoutMs?: number;
  /** Hard cap on provider calls per classification. Default = chain length. */
  readonly maxCalls?: number;
};

/**
 * Prompt template applied to every classification call. Override only when
 * the default doesn't fit; supply your own `templateHash` so cache keys
 * stay correct.
 */
export type PromptTemplate = {
  readonly systemPrompt?: string;
  /** Renders the user message. `{labels_csv}` is filled in user-given order. */
  readonly userTemplate: (input: string, space: readonly string[], question?: string) => string;
  /** Stable hash for cache-key composition. */
  readonly templateHash: string;
};
