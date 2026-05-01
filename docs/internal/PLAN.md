# domovoi — Typed-Uncertainty Classification for TypeScript (v0)

## Context

`domovoi` is a **classification infrastructure library** for TypeScript: take heterogeneous unstructured inputs and classify them into a finite enumerated category space using an LLM, with calibrated confidence, typed uncertainty, deadband thresholding, and provider escalation. The motivating use case is **data canonicalization** — unifying items from heterogeneous sources (e.g., videos from YouTube / Dailymotion / Netflix where each platform has a different category taxonomy) under one canonical category set.

Two motivating goals are in tension and the design has to honor both:
- **Real-time judgment** over inputs that resist schema
- **Determinism** of the resulting behavior wherever possible

The library's core insight: these aren't opposites if you frame the LLM's job as a *probabilistic decision over a finite decision space*, not free-form generation. Output a distribution, threshold it, return a typed Verdict that explicitly carries the possibility of failure-to-classify.

The closest conceptual ancestor is Microsoft Research's `Uncertain<T>` (Bornholt et al., ASPLOS 2014). Empty space confirmed (April 2026) — no TS library ships the four-way combination of typed Verdict + calibrated confidence + deadband + escalation. See `RESEARCH.md` for full prior-art survey and SOTA API design notes.

## Conceptual frame — embedded household spirit

A **domovoi** (Slavic household guardian spirit) is a being that lives within a dwelling, performs ongoing protective service, and is inherited with the property when ownership changes. The library's framing is **AI as embedded laborer inside the program** — not a remote tool you call out to, not an autonomous agent doing tasks, but a being bound to your runtime that sees the cases your code brings it and renders typed Verdicts under uncertainty.

The brand carries the framing; the API stays technical (Zod / Drizzle / Pydantic / AI SDK pattern). Two brand-flavored names: the library handle `domovoi` and the output type `Verdict<T>`. Everything else uses descriptive technical vocabulary.

## Key design principle — small core + clear extension points

domovoi commits to the **Zod/React pattern**: ship a small, opinionated core API + publish the interfaces (Provider, Calibrator, Cache) so users can extend without forking the library. Every API addition passes the test: *"is this primitive enough that users can't easily build it themselves, OR is it the ergonomic entry point for the common case?"* If neither, cut it.

## v0 Decisions (locked)

| Decision | Choice |
|---|---|
| Library name | `domovoi` |
| Framing | Embedded household-spirit metaphor; classification infrastructure; canonicalization is canonical use case |
| Language | TypeScript (single-language v0; multi-language ports via stable cache_schema_version + language-neutral OutcomeMeta shape) |
| Shape | Library, not service or spec-first |
| FP intensity | Light FP — immutable types, classifiers as functions, Verdict combinators; no Effect/fp-ts dependency |
| Public verbs | `domovoi.boolean`, `domovoi.classify`, `domovoi.classifier` |
| Verdict variants | Three first-class exported types: `Classified<T>`, `Uncertain<T>`, `Unknown<T>` (`Verdict<T>` is the union) |
| Discriminator | `kind: "classified" \| "uncertain" \| "unknown"` — single literal-string discriminator |
| Failure handling | Default `onErrorPolicy: "fallback"` returns `Unknown { provider_failure }`; engine never throws on operational failure under default policy. `"throw"` policy throws `AggregateError` |
| Numeric field | `probability: number` — post-calibration probability of the chosen class, ∈ [0, 1]. With identity calibrator (default), equals renormalized first-token softmax |
| Provider construction | Imported factory functions: `openai("gpt-4o-mini")`, `ollama("llama-3.1-70b")`, `openaiCompat(model, { baseURL, apiKey })` |
| Classifier shape | Callable: `await c(item)` is primary; `c.batch(items)` ships in v0; `.stream` deferred to v1 |
| Errors | Default mode never throws on operational failure (returns `Unknown` variant); construction errors throw `ConfigError({ code })` |
| Composition | No fluent chain — config-bag only |
| Type inference | `as const` on the decision-space array is the only ergonomic concession; no user-written generics |
| Required capability (v0) | Logprobs at the constrained position (logprobs distributionSource) |
| Provider coverage (v0) | OpenAI Chat Completions + OpenAI-compat (Ollama, vLLM, LM Studio, etc. via `baseURL`); other adapters mechanical to add |
| Capability tiers | `distributionSource: "logprobs" \| "multi_sample"`, `coverageMeasurement: "exact" \| "approximate" \| "none"` |
| Excluded from v0 | Anthropic native, Gemini native (Anthropic v1 via multi-sample + verbalized confidence) |
| Threshold semantics | Binary deadband for N=2 (`high > low` strict); top-confidence for N>2; margin optional; coverage floor; comparisons are inclusive (`>=` / `<=`) |
| Cache | Per-(input, provider) key with `cache_schema_version` (manually bumped); raw distribution stored; in-memory v0; in-flight dedup; per-classifier default; SHA-256 hashing; LRU eviction with `cacheMaxEntries: 10_000`; async opaque-string interface |
| Escalation | Chain of providers; engine handles fallback when previous returns `Uncertain` OR errors; `onErrorPolicy: "fallback" \| "throw"` |
| Calibration | Closed-form factories ship in v0: `identity`, `temperatureScaling(T)` (impl `p^(1/T)/Z`), `plattScaling({a,b})` (binary-only); fit step deferred to v1; multi-sample = identity-only |
| Cancellation | `signal: AbortSignal` first-class; `Provider.sample` accepts signal; engine merges user signal + perCallTimeoutMs via `AbortSignal.any`; pre-aborted handled |
| Budget | Per-call + chain timeouts; max-calls cap; per-item budget in `.batch` |
| Hooks | `hooks.onCall`, `hooks.onResult`, `onProviderError` — fire-and-forget; signature `void \| Promise<void>` |
| Test helpers | `domovoi/testing` subpath with `mockProvider({ behavior, capabilities?, id? })` |

## Public API

```ts
import { domovoi, isClassified, isUncertain, isUnknown, match, type Verdict, type Classifier } from "domovoi";
import { openai, ollama, openaiCompat } from "domovoi/providers";
import { temperatureScaling, identity } from "domovoi/calibration";
import { mockProvider } from "domovoi/testing";

// One-shot binary classification
await domovoi.boolean(input, "Is this toxic?");
//      ─→ Verdict<"yes" | "no">

// One-shot multi-class classification
await domovoi.classify(input, ["news", "sports", "music"] as const);
//      ─→ Verdict<"news"|"sports"|"music">

// Reusable classifier
const c: Classifier<Article, Category> = domovoi.classifier({
  name: "articles",
  space: ["news", "sports", "music"] as const,
  question: "Which category fits?",
  format: (x: Article) => `Title: ${x.title}\n${x.body}`,
  thresholds: { high: 0.7, margin: 0.15, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  calibrator: temperatureScaling(0.85),
});

await c(article);                              // primary: callable
await c.batch(articles, { concurrency: 5 });   // v0 batch
await c(article, { signal: ctrl.signal });     // cancellable

// Local LLM via Ollama
const localProvider = ollama("llama-3.1-70b");

// Generic OpenAI-compat (vLLM, LM Studio, Together, Fireworks, OpenRouter)
const fireworks = openaiCompat("accounts/fireworks/models/llama-3", {
  baseURL: "https://api.fireworks.ai/inference/v1",
  apiKey: process.env.FIREWORKS_API_KEY,
});
```

## Core Types

```ts
// ─── Three first-class variant types ────────────────────────────────

type Classified<T extends string> = {
  readonly kind: "classified";
  readonly value: T;
  readonly probability: number;       // post-calibration P(value), ∈ [0, 1]
  readonly meta: VerdictMeta;
};

type Uncertain<T extends string> = {
  readonly kind: "uncertain";
  readonly top: T;                    // highest-probability class
  readonly probability: number;       // P(top)
  readonly runnerUp: T;               // second-highest class
  readonly distribution: Distribution<T>;
  readonly meta: VerdictMeta;
};

type Unknown<T extends string> = {
  readonly kind: "unknown";
  readonly reason: UnknownReason<T>;
  readonly meta: VerdictMeta;
};

// Convenience union
type Verdict<T extends string> = Classified<T> | Uncertain<T> | Unknown<T>;

// ─── Supporting types ───────────────────────────────────────────────

type Distribution<T extends string> = {
  readonly probs: { readonly [K in T]: number };  // sums to 1, renormalized; missing in-space tokens get 0
  readonly coverage: number;                       // sum of in-space mass BEFORE renormalization, ∈ [0, 1]
};

type UnknownReason<T extends string> =
  | { readonly type: "out_of_distribution";
      readonly coverage: number;
      readonly topIfRenormalized: T;
      readonly probabilityIfRenormalized: number; }
  | { readonly type: "chain_exhausted";
      readonly lastDistribution: Distribution<T>;
      readonly providersAttempted: number; }
  | { readonly type: "predicate_rejected";
      readonly previousKind: "classified" | "uncertain"; }
  | { readonly type: "provider_failure";
      readonly errors: ReadonlyArray<SerializableError>; }
  | { readonly type: "budget_exhausted";
      readonly scope: "per_call_timeout" | "chain_timeout" | "max_calls"; }
  | { readonly type: "cancelled";
      readonly reason?: string; };

type VerdictMeta = {
  readonly providerUsed: string;                   // "openai/gpt-4o-mini"
  readonly providersAttempted: readonly string[];
  readonly providerErrors: ReadonlyArray<{ providerId: string; error: SerializableError }>;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly coverageQuality: "exact" | "approximate" | "none";
  readonly distributionSource: "logprobs" | "multi_sample";
};

type SerializableError = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: SerializableError;              // recursively serializable
  readonly stack?: string;
};

// ─── Type-guard helpers ─────────────────────────────────────────────

declare const isClassified: <T extends string>(v: Verdict<T>) => v is Classified<T>;
declare const isUncertain:  <T extends string>(v: Verdict<T>) => v is Uncertain<T>;
declare const isUnknown:    <T extends string>(v: Verdict<T>) => v is Unknown<T>;

// ─── Exhaustive matcher ─────────────────────────────────────────────

declare const match: <T extends string, R>(
  v: Verdict<T>,
  handlers: {
    classified: (v: Classified<T>) => R;
    uncertain:  (v: Uncertain<T>) => R;
    unknown:    (v: Unknown<T>) => R;
  }
) => R;

// ─── Verdict combinators (small core; users compose more in userspace) ─

namespace Verdict {
  type Filterable<T extends string> = Classified<T> | Uncertain<T>;

  // Predicate filter — pred sees Classified or Uncertain (Unknown passes through unchanged).
  // false → Unknown { predicate_rejected, previousKind }.
  declare function filter<T extends string>(
    pred: (v: Filterable<T>) => boolean
  ): (v: Verdict<T>) => Verdict<T>;
}

// ─── Configuration types ────────────────────────────────────────────

type ClassifierConfig<T extends string, I> = {
  readonly name?: string;                          // /^[a-z][a-z0-9_]*$/; uppercased for env binding
  readonly space: readonly [T, ...T[]];            // T1: non-empty
  readonly question?: string;
  // T4: format optional when I = string (default identity); required otherwise
  readonly format: I extends string ? ((x: I) => string) | undefined : (x: I) => string;
  readonly thresholds: Thresholds<readonly [T, ...T[]]>;   // required; T2 discriminated by space length
  readonly providers?: ReadonlyArray<Provider>;    // env-default if omitted
  readonly calibrator?: Calibrator;                // default: identity
  readonly cache?: Cache;                          // J1: per-classifier default
  readonly budget?: Budget;
  readonly template?: PromptTemplate;
  readonly hooks?: { onCall?: HookFn; onResult?: HookFn };
  readonly onProviderError?: (err: ProviderError, ctx: { providerId: string; attempt: number }) => void | Promise<void>;
  readonly onErrorPolicy?: "fallback" | "throw";   // default "fallback"
};

type HookFn = (...args: any[]) => void | Promise<void>;

// T2: thresholds discriminated by space size
type Thresholds<Space extends readonly string[]> =
  Space["length"] extends 2
    ? { high: number; low: number; coverageMin?: number }
    : { high: number; margin?: number; coverageMin?: number };

type Budget = {
  perCallTimeoutMs?: number;                        // default 10_000
  chainTimeoutMs?: number;                          // default 30_000; wall-clock incl. future retries
  maxCalls?: number;
};

type PromptTemplate = {
  systemPrompt?: string;                            // undefined → no system prompt
  userTemplate: (input: string, space: readonly string[], question?: string) => string;
  templateHash: string;                             // user-supplied for overrides; library default = "domovoi/v0-default"
};

// ─── Public extension interfaces (per C6) ───────────────────────────

interface Provider {
  readonly id: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  sample<T extends string>(
    input: string,
    space: ReadonlyArray<T>,
    opts: {
      template: PromptTemplate;
      temperature: number;
      seed?: number;
      timeoutMs: number;
      signal?: AbortSignal;                         // engine merges user signal + perCallTimeout
    }
  ): Promise<Distribution<T>>;
}

type ProviderCapabilities = {
  distributionSource: "logprobs" | "multi_sample";
  coverageMeasurement: "exact" | "approximate" | "none";
  maxTopLogprobs: number;                           // 0 for multi_sample
};

interface Calibrator {
  apply<T extends string>(d: Distribution<T>): Distribution<T>;
  // serialize() removed from v0; returns with Calibrator.fit() in v1
}

interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

## Consumer Idioms

Three idioms ship; pick whichever fits the call site:

```ts
const v = await domovoi.classify(input, ["news", "sports", "music"] as const);

// Idiom 1 — type-guard helper
if (isClassified(v)) upsert(item, v.value);

// Idiom 2 — canonical TS narrowing
switch (v.kind) {
  case "classified": upsert(item, v.value); break;
  case "uncertain":  queue.review(item, v.top, v.runnerUp, v.distribution); break;
  case "unknown":
    switch (v.reason.type) {
      case "out_of_distribution": newCategoryQueue.add(item, v.reason.topIfRenormalized); break;
      case "chain_exhausted":     humanQueue.add(item, v.reason.lastDistribution); break;
      case "provider_failure":    deadletter.push(item, v.reason.errors); break;
      case "predicate_rejected":  log("filtered:", v.reason.previousKind); break;
      case "budget_exhausted":    timeoutQueue.add(item, v.reason.scope); break;
      case "cancelled":           /* user cancelled; usually no action */ break;
    }
    break;
}

// Idiom 3 — match helper
match(v, {
  classified: ({ value, probability }) => upsert(item, value),
  uncertain:  ({ top, runnerUp })       => queue.review(item, top, runnerUp),
  unknown:    ({ reason })              => routeUnknown(item, reason),
});
```

## Architecture

```
                ┌─────────────────────────┐
   caller ───►  │ Engine (decide)         │
                │  validate construction  │
                │  format → cache key     │
                │  cache.get / in-flight  │
                │  provider.sample        │
                │  validateDistribution   │
                │  calibrator.apply       │
                │  thresholds → variant   │
                │  fallback / escalation  │
                │  wrap with VerdictMeta  │
                └──┬────────┬─────────┬───┘
                   │        │         │
            ┌──────▼──┐  ┌──▼──────┐ ┌▼─────────┐
            │ Cache   │  │Calibrator│ │ Provider │ ◄── adapter (public interface)
            │ raw     │  │  (per-  │ │  chain   │
            │ dists   │  │  caller)│ │          │
            └─────────┘  └──────────┘ └──┬───────┘
                                          │
                              ┌───────────▼──────────┐
                              │ openai / ollama /    │
                              │ openaiCompat (v0)    │
                              └──────────────────────┘
```

Public verbs (`boolean`, `classify`, `classifier`) sit *above* the engine. The engine is provider-blind. Adapters convert the provider's native logprobs response into a normalized `Distribution<T>` plus a coverage measurement. Cache stores raw distributions; calibrator runs per-caller after cache resolution (G18).

## Engine pseudocode

```
decide(input, classifierConfig, signal?):
  if signal?.aborted: return Unknown { cancelled, reason: signal.reason }
  s = format(input)
  key = SHA256(canonicalize({
    cache_schema_version: 1,                       // K1
    provider_id, model_id, tokenizer_id,
    template_hash, decision_space (user-given order; K3),
    temperature: 0,                                // H2
    provider_config_hash (M4: SHA256 of canonical-JSON sorted-key opts),
    input_hash (NFC + trim of formatted s)
  }))
  for each provider in chain:
    if signal?.aborted: return Unknown { cancelled, reason: signal.reason }
    mergedSignal = AbortSignal.any([signal, AbortSignal.timeout(perCallTimeoutMs)])  // K2
    try:
      cached = await cache.get(key)                // H3 async opaque-string interface
      distribution = cached
        ? deserialize(cached)
        : await in_flight_dedup(key, () => provider.sample(s, space, { ..., signal: mergedSignal }))
      validateDistribution(distribution, space)    // L2: coverage ∈ [0,1], probs ∈ [0,1] each, sum 1±0.001, missing→0
      calibrated = calibrator.apply(distribution)  // per-caller; not in cache key
      threshold = applyThresholds(calibrated, thresholds, space.length, ">=" / "<=")  // L1 inclusive
      if threshold.kind === "classified": return classified with full meta
      if threshold.kind === "uncertain": continue chain
      if threshold.kind === "unknown" (out_of_distribution): return unknown with meta
    catch err:
      if err.name === "TimeoutError": return Unknown { budget_exhausted, scope: "per_call_timeout" }
      if signal?.aborted (user-aborted): return Unknown { cancelled, reason: signal.reason }
      if err instanceof BudgetExhaustedError: return Unknown { budget_exhausted, scope: err.scope } (or throw under "throw")
      // ProviderError or any other thrown value (canonicalize via H4 Error.cause):
      const wrapped = err instanceof ProviderError ? err : new ProviderError(err.message, { cause: err });
      meta.providerErrors.push({ providerId, error: serialize(wrapped) })
      onProviderError?.(wrapped, { providerId, attempt: i })  // G8 fire-and-forget
      continue chain
  // chain exhausted
  if all-providers-errored:
    if onErrorPolicy === "throw": throw AggregateError(meta.providerErrors)
    return Unknown { provider_failure, errors: meta.providerErrors }
  if all-uncertain: return Unknown { chain_exhausted, lastDistribution, providersAttempted }
  return wrap with full VerdictMeta
```

## Tokenization & Constrained Output

1. **Validates the decision space at construction time** — for each label, compute `firstTokenId(label)`. If any two labels share a first-token id, throw `ConfigError({ code: "decision_space_collision" })` at construction.
2. **Validates space content** (J2) — reject empty/whitespace-padded/duplicate (NFC-normalized)/singleton spaces.
3. **Constrains output via `logit_bias`** — `+100` for in-space first-tokens; no negative biases (S8). Keeps coverage measurement honest.
4. **Reads logprobs at the first constrained position** — exponentiate logprobs for in-space first-token ids, sum to compute `coverage`, renormalize over the decision space. Missing in-space labels get `prob: 0` (G2).
5. **Coverage threshold** — if `coverage < thresholds.coverageMin` (default 0.5), emit `Unknown { out_of_distribution }`.

## Threshold Semantics

Comparisons inclusive (`>=` / `<=`) per L1.

For a finite decision space of size N:

- **Binary (N = 2)** — classic deadband. `top.prob >= high` → `Classified(top)`; `top.prob <= low` → `Classified(other)`; else `Uncertain`. Required: `high > low` strict.
- **Multi-class (N > 2)** — default rule **top-confidence**: `top.prob >= high` → `Classified(top)`; else `Uncertain`. Optional **margin** rule: requires both `top.prob >= high` *and* `top.prob - second.prob >= margin`. v0 ships top-confidence; margin is configurable.

`low` is binary-only. `coverageMin` applies regardless of N. Threshold values must be in `[0, 1]` inclusive; throw `ConfigError({ code: "invalid_thresholds" })` otherwise (H1).

## Error Model

`Verdict` covers all classification *results*, including failure-to-classify (`Unknown`). Construction errors throw; runtime operational failures convert to `Unknown` variants under default policy.

**Error class taxonomy (4 classes; discriminate via `code`):**

```ts
class DomovoiError extends Error { readonly code: string; }   // base
class ProviderError extends DomovoiError { /* network, rate limit, 5xx, timeout */ }
class ConfigError extends DomovoiError {
  // codes: "decision_space_collision" | "decision_space_too_large" | "missing_provider_config"
  //      | "malformed_provider_config" | "unknown_provider_factory" | "missing_credential"
  //      | "incompatible_calibrator" | "invalid_classifier_name" | "invalid_thresholds"
  //      | "invalid_space" | "empty_providers" | "invalid_distribution"
}
class BudgetExhaustedError extends DomovoiError {
  readonly attemptedProviders: ReadonlyArray<string>;
  readonly elapsedMs: number;
  readonly reason: "perCallTimeout" | "chainTimeout" | "maxCalls";
}
```

All errors use ES2022 `Error.cause` chaining (H4). Engine canonicalizes non-DomovoiError throws from `Provider.sample` into `ProviderError({ cause })`.

**Default behavior (`onErrorPolicy: "fallback"`):**
- `ProviderError` mid-chain → recorded in `meta.providerErrors`; engine tries next provider.
- All providers errored → `Unknown { provider_failure, errors }`.
- Per-item budget exhausted → `Unknown { budget_exhausted, scope }`.
- Cancellation → `Unknown { cancelled, reason }`.

**Throw policy (`onErrorPolicy: "throw"`):**
- Operational errors throw `AggregateError` (or specific error subtype).

## Caching

**Cache key composition** — SHA-256 hash of canonical-JSON record:

```
{
  cache_schema_version: 1,           // K1 — manually bumped on cache-affecting changes
  provider_id, model_id, tokenizer_id,
  prompt_template_hash,              // R14 — user-supplied for overrides
  decision_space,                    // K3 — user-given order
  temperature: 0,                    // H2 — fixed in v0
  provider_config_hash,              // G1 — covers multiSampleN, future opts; SHA256 of canonical-JSON sorted-key
  input_hash                         // SHA256 of NFC+trim of format(input)
}
```

**Public Cache interface** (H3):
```ts
interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Async-first; opaque string values (engine handles serialization); required `delete` for explicit invalidation. Per-classifier default via `domovoi.memoryCache({ maxEntries: 10_000, defaultTtlMs? })` (J1).

**LRU eviction** — count-based via `cacheMaxEntries`; eviction on write-completion (G11).

**In-flight deduplication** — concurrent calls with the same key share a single in-flight Promise. Cache stores raw `Distribution`; calibrator runs per-caller after resolution (G18).

**`cache.stats(): { size, hits, misses, evictions }`** ships in v0 (R7).

**Process-locality caveat** — v0 cache is in-memory per-process; persistent backends (Redis, SQLite, KV) are v1-implementable today via the public Cache interface.

## Provider Source

**Env-driven default** with explicit override (lock #5):

```bash
DOMOVOI_PROVIDERS=openai/gpt-4o-mini,openai/gpt-4o,ollama/llama-3.1-70b
DOMOVOI_PROVIDERS_ARTICLES=openai/gpt-4o-mini       # per-classifier (uppercased name)
OPENAI_API_KEY=sk-...
```

**Format spec:** `factory/model[,factory/model...]`. First `/` separates factory from model; remaining slashes part of model name (e.g., `openrouter/meta-llama/llama-3.1-70b`). Whitespace trimmed; empty entries skipped; empty env value treated as unset (M2).

**Per-provider parametric config** (`multiSampleN`, custom timeouts) requires in-code `providers: [factory(model, opts)]`. No env+code merging.

## Provider Factories

```ts
import { openai, ollama, openaiCompat } from "domovoi/providers";

// 1. OpenAI hosted — typed model union with escape hatch
type OpenAIModel =
  | "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo"
  | "o1" | "o1-mini" | "o1-preview"
  | "gpt-3.5-turbo"
  | (string & {});  // escape hatch — autocomplete on knowns; accept any

const cloud = openai("gpt-4o-mini");

// 2. Ollama — local convenience; defaults to localhost:11434/v1, apiKey "ollama"
const local = ollama("llama-3.1-70b");

// 3. Generic OpenAI-compatible — explicit baseURL required
const fireworks = openaiCompat("accounts/fireworks/models/llama-3", {
  baseURL: "https://api.fireworks.ai/inference/v1",
  apiKey: process.env.FIREWORKS_API_KEY,
});
```

Factory signature locked: `(model, opts?: ProviderOptions) => Provider` (R18).

## Calibration

Closed-form scaling factories ship in v0 (lock #9):

```ts
import { identity, temperatureScaling, plattScaling } from "domovoi/calibration";

const c = domovoi.classifier({
  ...,
  calibrator: temperatureScaling(0.85),     // p^(1/T)/Z; throws on T <= 0
  // calibrator: plattScaling({ a: 1.2, b: -0.3 }),  // binary-only; throws if space.length !== 2
  // calibrator: identity,                  // default
});
```

**Calibrator interface contract:** `Calibrator.apply` must be pure / stateless (S3) — required for `.batch` correctness.

**Multi-sample × calibration:** non-identity calibrators are defined over logprobs only. For `distributionSource: "multi_sample"` providers, engine throws `ConfigError({ code: "incompatible_calibrator" })` at construction. v0 multi-sample = identity-only (S3).

**`Calibrator.fit(eval)` API deferred to v1** alongside `Calibrator.serialize()`.

## Cancellation

First-class via `AbortSignal` (Web API standard; G15):

```ts
// React-style cleanup
useEffect(() => {
  const controller = new AbortController();
  c(item, { signal: controller.signal }).then(setResult);
  return () => controller.abort();
}, [item]);

// Deadline via AbortSignal.timeout (Node 17.3+, browsers 2022+)
await c(item, { signal: AbortSignal.timeout(5000) });

// Combined parent + deadline via AbortSignal.any (Node 20+, Chrome 116+)
await c(item, {
  signal: AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]),
});

// .batch always returns partial results regardless of policy
const results = await c.batch(items, { signal: controller.signal });
```

Field name: `signal: AbortSignal` (matches fetch / OpenAI / Anthropic / TanStack Query convention; AI SDK 6's `abortSignal` is the outlier).

**Engine signal merging** (K2): engine constructs `AbortSignal.any([userSignal, AbortSignal.timeout(perCallTimeoutMs)])` and passes the merged signal to `provider.sample`. Abort-reason discrimination determines Outcome shape (`cancelled` vs `budget_exhausted`).

## `.batch`

LangChain Runnable convention (lock #6):

```ts
await c.batch(items, { concurrency?: 5, signal?: AbortSignal });
// Promise<Verdict<T>[]>
// - Order preserved
// - Per-item Verdicts; per-item provider errors land in meta.providerErrors and don't kill the batch
// - In-flight dedup applies (duplicate items collapse to one provider call)
// - Per-item budget (G14/G17)
// - Cancellation always returns partial results (regardless of onErrorPolicy)
```

`.stream` deferred to v1.

## `.safe` — dropped from v0

Default policy never throws on operational failure; explicit throw mode is opt-in. `.safe` would have minimal value in either mode. Dropped (#7 / S7).

## Hooks (observability)

```ts
domovoi.classifier({
  ...,
  hooks: {
    onCall:   (input, ctx) => { ... },        // before provider.sample
    onResult: (verdict, ctx) => { ... },      // after Verdict produced
  },
  onProviderError: (err, ctx) => {            // when ProviderError swallowed during fallback
    logger.warn("provider error", { err, ctx });
  },
});
```

All hooks **fire-and-forget** (G8): signature accepts `void | Promise<void>`; engine does NOT await; users attach own `.catch` to async work.

## Verdict.filter

```ts
type Filterable<T> = Classified<T> | Uncertain<T>;

Verdict.filter<T>(pred: (v: Filterable<T>) => boolean): (v: Verdict<T>) => Verdict<T>;
```

Predicate sees Classified or Uncertain (Unknown passes through unchanged). Returns true → outcome unchanged; false → `Unknown { predicate_rejected, previousKind }` (G3, R1, G4).

For Unknown-aware logic: direct discrimination (`switch (v.kind)` / `if (isUnknown(v))`), `hooks.onResult`, or `Array.prototype.filter` with type guards.

## Prompt Construction

Default template:

```
system: You are a careful classifier. Output exactly one of: {labels_csv}. No other text.
user:   {question}\n{input}              // {question} omitted if not provided
```

`{labels_csv}` uses **user-given order** of `space` (K3). Single newline between question and input; `{question}` undefined → just `{input}` (no leading newline); no trailing newline (L4). `systemPrompt: undefined` skips system message.

`PromptTemplate` is overridable; user override requires user-supplied `templateHash` (R14). Library default `templateHash = "domovoi/v0-default"`.

Truncation: v0 does not truncate (L4 / R15). Few-shot: out of scope for v0 (R16).

## Sensitive Data in `meta.providerErrors`

Per J3, no library-level redactor. Engine records errors verbatim into `meta.providerErrors[].error` (typed `SerializableError` per H5; `JSON.stringify(verdict)` works naturally).

Redact at the **consumer boundary** (SOTA: Pino, Winston, Sentry beforeSend, OTel processors):

```ts
const logger = pino({
  redact: ['*.meta.providerErrors[*].error.message',
           '*.meta.providerErrors[*].error.stack'],
});
```

## Type-Level Tests (T8–T10)

`tests/types.test-d.ts` asserts:
- **T8** Match exhaustiveness — `match(v, { classified, uncertain })` (missing `unknown`) fails compile.
- **T9** Type-guard narrowing — `isClassified(v)` narrows to a type with `value` but no `runnerUp` / `top` / `reason`.
- **T10** Literal-narrowing — `await domovoi.classify(input, ["a","b","c"] as const)` produces `Verdict<"a"|"b"|"c">` and `result.value` autocompletes the three literals.

## Operational Caveats (README)

1. **v0 ships logprobs adapters only** (OpenAI Chat + OpenAI-compat). Anthropic native is v1 via multi-sample.
2. **Cache is process-local in v0.** Determinism holds within a single warm process. Serverless cold starts begin empty (K6).
3. **Determinism is "deterministic given fixed serving config"** — not bit-exact across providers or model versions (Thinking Machines Lab, Sept 2025).
4. **Calibration is identity by default in v0.** Threshold values must be tuned per (model, prompt). Provide fitted parameters via `temperatureScaling(T)` or `plattScaling({a,b})` for real calibration.
5. **Default budgets**: `perCallTimeoutMs = 10_000`, `chainTimeoutMs = 30_000`, `maxCalls = providers.length`.
6. **`meta.providerErrors` may contain credentials** if your provider's error messages leak them. Redact at the logger/error-tracker boundary, not in domovoi.

## Files to Create

```
package.json                       # tsup + vitest + biome + openai + tiktoken
tsconfig.json                      # strict, NodeNext, ES2022, noUncheckedIndexedAccess
biome.json
vitest.config.ts
README.md                          # pitch + idioms + extension points + cancellation patterns + local LLMs
src/
  index.ts                         # public API: domovoi.{classify,boolean,classifier,memoryCache}, type guards, match, Verdict.filter
  types.ts                         # Classified, Uncertain, Unknown, Verdict, Distribution, UnknownReason, VerdictMeta, SerializableError, Thresholds<Space>
  verdict.ts                       # match, filter, isClassified, isUncertain, isUnknown
  errors.ts                        # DomovoiError (base), ProviderError, ConfigError, BudgetExhaustedError; Error.cause chaining
  engine.ts                        # decide() — chain + cache + threshold + budget + signal merging + abort discrimination
  cache.ts                         # in-memory LRU; key derivation; in-flight dedup; cache.stats()
  calibrator.ts                    # Calibrator interface; identity, temperatureScaling, plattScaling factories
  hash.ts                          # SHA-256 + canonical-JSON
  prompt.ts                        # PromptTemplate, default template
  tokenizer.ts                     # internal; OpenAI cl100k impl
  env.ts                           # DOMOVOI_PROVIDERS parser, validation, env→provider resolution
  validate.ts                      # threshold/space/distribution validation
  serialize.ts                     # Error → SerializableError
  verbs/
    boolean.ts                     # domovoi.boolean
    classify.ts                    # domovoi.classify
    classifier.ts                  # domovoi.classifier (returns Classifier<T, I>)
  providers/
    provider.ts                    # public Provider interface + ProviderCapabilities
    openai-chat.ts                 # logprobs + logit_bias adapter; openai() and openaiCompat() factories
    ollama.ts                      # ollama() factory (defaults to localhost:11434)
testing/
  index.ts                         # mockProvider({ behavior, capabilities?, id? })
calibration/
  index.ts                         # re-exports identity, temperatureScaling, plattScaling
tests/
  verdict.test.ts                  # filter, match, type guards
  engine.test.ts                   # threshold, deadband, escalation, cache, budget, errors, cancellation
  cache.test.ts                    # key composition, dedup, schema versioning, async, delete
  threshold.test.ts                # binary, multi-class top-confidence, margin, validation
  validate.test.ts                 # space validation (empty/duplicate/whitespace/singleton); distribution validation
  calibrator.test.ts               # temperatureScaling math; plattScaling binary-only
  errors.test.ts                   # cause chaining; Serialization
  cancellation.test.ts             # AbortSignal patterns: pre-aborted, mid-call, batch, timeout merging
  env.test.ts                      # DOMOVOI_PROVIDERS parsing
  types.test-d.ts                  # T8/T9/T10
  verbs/{boolean,classify,classifier}.test.ts
  providers/openai-chat.test.ts
examples/
  sentiment.ts                     # 3-class sentiment
  binary-toxic.ts                  # binary classification with deadband
  video-canonicalization.ts        # motivating case: heterogeneous platforms → canonical category
  local-ollama.ts                  # Ollama-backed local classifier
```

## Plan of Work

1. **Scaffold** — `npm init` + typescript + vitest + tsup + biome + openai + tiktoken.
2. **Errors + types** — `errors.ts` (4-class taxonomy with `code`); `types.ts` with Verdict variants, VerdictMeta, SerializableError, Thresholds<Space>.
3. **Validation** — `validate.ts` for space (J2), thresholds (H1), distribution (L2).
4. **Verdict combinators** — `verdict.ts` with `match`, `filter`, type guards.
5. **Hash + canonical JSON** — `hash.ts` with SHA-256 + sorted-key canonicalization.
6. **Tokenizer** (internal) — OpenAI cl100k_base + first-token collision check.
7. **Prompt** — `prompt.ts` with default template + override hook + template hashing.
8. **Calibrator** — interface + `identity`, `temperatureScaling(T)` (`p^(1/T)/Z`), `plattScaling({a,b})` (binary-only with construction check).
9. **Cache** — async opaque-string interface; `domovoi.memoryCache({ maxEntries, defaultTtlMs })` with LRU; in-flight dedup; `cache.stats()`.
10. **Provider contract + adapters** — public `Provider` interface; `openai()`, `ollama()`, `openaiCompat()` factories; logprobs + logit_bias adapter.
11. **Env parsing** — `env.ts` with `DOMOVOI_PROVIDERS` parser, validation, factory resolution.
12. **Engine** — `decide()` with full pseudocode (chain + cache + threshold + budget + signal merging + abort discrimination + provider_failure + chain_exhausted + per-classifier defaults).
13. **Verbs** — `boolean.ts`, `classify.ts`, `classifier.ts`.
14. **Testing helpers** — `domovoi/testing` with `mockProvider`.
15. **Examples** — sentiment, binary-toxic, video-canonicalization, local-ollama.
16. **Tests** — full suite per Verification.

## Verification

1. **Unit tests pass** — engine logic with mocked providers covering: binary deadband (inclusive ops), multi-class top-confidence, margin rule, coverage-based Unknown, chain-exhausted Unknown, escalation chain, budget exhaustion, error propagation.
2. **(T8/T9/T10) Type-level tests** — match exhaustiveness, type-guard narrowing, literal-narrowing one-liner.
3. **(J2) Space validation** — `space: [""]`, `["a","a"]`, `["a","  b "]`, `["a"]` each throw `ConfigError({ code: "invalid_space" })`.
4. **(H1) Threshold validation** — out-of-range or `high <= low` throws `ConfigError({ code: "invalid_thresholds" })`.
5. **(L2) Distribution validation** — invalid coverage / per-prob / sum throw `ProviderError({ code: "invalid_distribution" })`.
6. **(K1) Cache schema versioning** — bumping library version preserves cache; bumping `cache_schema_version` invalidates.
7. **(K2) Engine signal merging** — provider sees a merged signal; abort-reason discrimination distinguishes user-cancel vs timeout into correct Verdict variant.
8. **(K3) Decision-space ordering** — cache key independent of order; prompt preserves user-given order; collision check is set-based.
9. **(G1) provider_config_hash** — same input + same provider + different `multiSampleN` → cache miss.
10. **(G2) Missing in-space tokens** — provider returns top-K missing 3 of 10 in-space tokens → those 3 get `prob: 0` post-renormalization; coverage reflects pre-renormalization in-space mass.
11. **(G3) `Verdict.filter`** — pred over `Filterable<T>` correctly converts rejected Classified/Uncertain to `Unknown { predicate_rejected, previousKind }`; Unknown inputs pass through unchanged.
12. **(G8) Hooks fire-and-forget** — `onProviderError` returning a Promise does not block fallback timing.
13. **(G10) Name validation** — `classifier({ name: "Articles With Spaces" })` throws `ConfigError({ code: "invalid_classifier_name" })`.
14. **(G14) Per-item budget** — `.batch` items hitting budget become `Unknown { budget_exhausted }`; other items unaffected.
15. **(G15) Cancellation** — pre-aborted signal returns `Unknown { cancelled }` immediately; mid-call abort returns same; batch returns partial results; pattern with `AbortSignal.timeout` and `AbortSignal.any` works.
16. **(G18) In-flight dedup × calibrator** — two classifiers with different calibrators on same cache key both get correct per-caller Outcome from one provider call.
17. **(H3) Async cache** — `cache.get/set/delete` are async; cache.stats() reports correctly; memoryCache eviction.
18. **(H4) Error.cause chaining** — non-DomovoiError throws from Provider canonicalize to `ProviderError({ cause })`.
19. **(H5) `JSON.stringify(verdict)` round-trip** — meta.providerErrors[].error is plain serializable object.
20. **(J1) Default cache per-classifier** — two classifiers without explicit cache have separate caches.
21. **(M1) Empty providers** — `classifier({ providers: [] })` throws `ConfigError({ code: "empty_providers" })`.
22. **(M2) Empty env** — `DOMOVOI_PROVIDERS=""` treated as unset → `ConfigError({ code: "missing_provider_config" })`.
23. **(S3) Calibrator math** — `temperatureScaling(0.5).apply({probs: {a: 0.6, b: 0.4}, coverage: 1})` produces `{a: 0.69, b: 0.31}`; `plattScaling` rejects 3-class space at construction.
24. **(S4) Multi-sample default `multiSampleN: 10`** — factory output's capabilities show N=10; explicit override works.
25. **(S10) `mockProvider` smoke test** — constructible from `domovoi/testing`; works as chain element.
26. **Engine integration with real OpenAI** — `examples/sentiment.ts` on a 30-item hand-labeled set; spot-check accuracy ≥ 80%; deadband produces non-zero `Uncertain`; off-topic items produce `Unknown { out_of_distribution }`.
27. **Local LLM integration** — `examples/local-ollama.ts` with Ollama running locally; verify Ollama provider works via `openaiCompat`-style baseURL forwarding.
28. **Video-canonicalization end-to-end** — 10 items each from 3 simulated platforms with different category labels, mapped to a 7-element canonical space; verify a mix of `Classified`, `Uncertain`, and `Unknown` outcomes.

## Out of Scope (deferred to v1+)

- **Anthropic native adapter** — multi-sample with verbalized confidence (Tian et al. EMNLP 2023), v1.
- **Calibrator.fit(eval)** — fitting calibrators from labeled data, v1.
- **Persistent cache backends** — disk/SQLite/Redis (implementable today via public Cache interface), v1.
- **`.stream` on Classifier** — AsyncIterable<Verdict<T>>, v1.
- **Per-call retry policy** — v0 has no retries; budget includes future retry time.
- **Eviction policy choice** (`evictionPolicy: "lru" | "lfu" | "fifo"`) — v0 ships LRU only.
- **`umbra.cascade(...)` API** for derived classifications (replaces `Outcome.map/flatMap`), v1.
- **Multi-language ports** — Python/Rust/Kotlin happen after TS API stabilizes; `cache_schema_version` and language-neutral `VerdictMeta` shape preserve cross-language contracts.
- **Service/sidecar form factor** — explicitly not v0.
- **Continuous decision spaces** — regression-style is a different abstraction.
- **Few-shot prompting / input truncation** — v0 takes input verbatim.
