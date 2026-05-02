# @hourslabs/domovoi

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
