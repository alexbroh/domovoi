---
"@hours/domovoi": minor
---

Initial v0 engine: Verdict combinators, calibrator math, in-memory LRU cache (with TTL, in-flight dedup, stats), env-driven provider resolution (`DOMOVOI_PROVIDERS`), and engine semantics — thresholds, chain fallback, cancellation via `AbortSignal`, AggregateError under `onErrorPolicy: "throw"`, JSON-serializable Verdicts, `.batch`.

Type-level tests verify `match()` exhaustiveness, type-guard narrowing, and literal-narrowing on `domovoi.classify(input, [...] as const)`.

Tooling: Changesets, `attw`, `publint`, `knip`, CodeQL, Dependabot. License: Apache 2.0.
