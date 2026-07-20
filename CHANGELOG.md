# @hourslabs/domovoi

## 0.3.0

### Minor Changes

- 8519c1c: Add the Anthropic provider: `anthropic(model?, opts?)` with multi-sample verbalized-confidence distributions (default Haiku 4.5, 3 samples per call), disagreement-aware aggregation, and `samples` option. Multi-sample providers can now use non-identity calibrators (the v0 restriction is lifted), providers can contribute a `configHash` to the cache key, and sampling temperature defers to a provider-appropriate default when unset.
- 4db3ff0: Cost as observability: providers accept `pricing: { inputPerMTok, outputPerMTok }` and every Verdict carries `meta.cost` — backend-reported token usage summed across all provider calls (fallbacks included), with `usd` when every usage-reporting provider has pricing; absent on pure cache hits. Spans upgrade to real usage (`gen_ai.usage.*`, estimates flagged `domovoi.usage.estimated`) and emit `gen_ai.usage.cost_usd` per priced call; the scope budget now charges real tokens when reported. Breaking for custom Provider implementations: `sample()` returns `{ distribution, usage? }` instead of a bare `Distribution`; `mockProvider` accepts both shapes.

## 0.2.0

### Minor Changes

- d859942: Add `domovoi.scope` for ambient budget, signal, and tracer; `domovoi.bind` for scope across async boundaries; `distribution()` testing primitive.

  **`domovoi.scope({ budget?, signal?, tracer? }, fn)`** — runs `fn` with ambient context inherited by every classify call inside it. Token budget enforced as a circuit breaker: when exhausted, classify returns `Unknown { reason: { type: "budget_exceeded", spent, limit } }` rather than continue spending. Opt into `onExceeded: "throw"` for hard-fail semantics. Scope signals combine with per-call signals via `AbortSignal.any`.

  **`domovoi.bind(fn)`** — captures the current scope and re-applies on later invocation. Mirrors Node's `AsyncLocalStorage.bind` for queue workers, cron jobs, and `setTimeout` callbacks that detach from the calling stack.

  **Tracing** — engine emits one OTel-shaped span per provider call when `scope.tracer` is present, following the GenAI semantic conventions: `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, plus domovoi-specific `domovoi.label_space`, `domovoi.cache.hit`, `domovoi.verdict.{kind,value,probability}`.

  **`@hourslabs/domovoi/testing` adds `distribution()`** — single-sample assertions on AI behavior are meaningless; `distribution()` runs `n` real samples and returns Wilson-CI-backed assertions about behavior stability:

  ```ts
  const dist = await distribution(
    () => domovoi.classify("hello there", ["greeting", "request"]),
    { n: 100 }
  );
  dist.coverage("greeting"); // 0.94
  dist.confidenceInterval("greeting"); // [0.88, 0.98]
  dist.expectStable({ minCoverage: 0.9, maxUncertain: 0.05 });
  ```

  **Backward compatibility:** zero disruption. Calls outside any scope are unchanged — no enforcement, no tracing, no budget.

  New errors: `BudgetExceededError` (with `code: "tokens_exceeded"`).
  New types: `ScopeOptions`, `ScopeBudget`, `ResolvedScope`, `BudgetMode`, `BudgetSnapshot`, `Tracer`, `Span`, `AttributeValue`, `ContextStorage<T>`, `Samples<T>`, `DistributionOptions`, `StabilityAssertion`, `ConfidenceLevel`.

## 0.1.0

### Minor Changes

- 1691349: `domovoi.boolean(input, question)` returns `Verdict<boolean>` (idiomatic TS) instead of `Verdict<"yes" | "no">`. The engine internally still classifies over the `["yes", "no"]` string space (matches LLM first-token tokenization); a small transform at the verb boundary maps `value` / `top` / `runnerUp` to `boolean` and rekeys `distribution.probs` from `{ yes, no }` to `{ true, false }`.

  `Verdict<T>`, `Classified<T>`, `Uncertain<T>`, `Unknown<T>`, `UnknownReason<T>`, `Filterable<T>`, and `Distribution<T>` widen from `T extends string` to `T extends Label` (where `Label = string | boolean` — exported from the public surface). `domovoi.classify` and `domovoi.classifier` continue to constrain `T extends string` since multi-class spaces are string-only.

  User-visible change: `if (isClassified(v) && v.value)` now reads cleanly for binary classifiers, instead of `v.value === "yes"`.

- 04953d8: Eager `Provider.validate(space)` hook — surfaces `decision_space_collision` errors at `domovoi.classifier({...})` construction time instead of lazily on first sample call. Optional on the public `Provider` interface; the hosted `openai()` adapter implements it via `cl100k_base` first-token comparison. Existing custom `Provider` implementations continue to work unchanged.
- 8946595: Initial v0 engine: Verdict combinators, calibrator math, in-memory LRU cache (with TTL, in-flight dedup, stats), env-driven provider resolution (`DOMOVOI_PROVIDERS`), and engine semantics — thresholds, chain fallback, cancellation via `AbortSignal`, AggregateError under `onErrorPolicy: "throw"`, JSON-serializable Verdicts, `.batch`.

  Type-level tests verify `match()` exhaustiveness, type-guard narrowing, and literal-narrowing on `domovoi.classify(input, [...] as const)`.

  Tooling: Changesets, `attw`, `publint`, `knip`, CodeQL, Dependabot. License: Apache 2.0.

- 238fd59: Tokenizer-aware OpenAI adapter: `cl100k_base` via `tiktoken` for first-token collision detection at `domovoi.classifier({...})` construction time, plus `+100` `logit_bias` for in-space label steering on every sample. Ollama keeps a string-prefix fallback (per-model tokenizer variance). `openaiCompat` exposes `useCl100kTokenizer: boolean` for backends with OpenAI-compatible tokenization (vLLM, Together, Fireworks).

  Four runnable examples: `news-topics` (5-class news-desk routing with cross-domain Uncertain), `binary-toxic` (deadband), `video-canonicalization` (typed input + format callback + chain fallback), `local-ollama` (local-first hybrid).
