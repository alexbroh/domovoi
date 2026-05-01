---
"domovoi": minor
---

Initial v0 engine + verbs + tests + tooling pipeline:

- Engine refactored into `src/engine/{config,threshold,meta,abort,hooks,decide,index}.ts`
  for single-responsibility modules. Public API unchanged.
- 102 tests across 6 suites covering Verdict combinators, validation rules,
  calibrators (math + boundaries), cache (LRU + TTL + stats + in-flight dedup),
  env-driven provider resolution, and engine semantics (thresholds, fallback
  chains, cancellation, AggregateError, JSON serialization, batch).
- Type-level tests (T8/T9/T10) for match exhaustiveness, type-guard narrowing,
  literal-narrowing one-liner.
- Tightened Biome rule set (noExplicitAny, useNamingConvention with snake_case
  exception for external contracts, useConsistentArrayType shorthand).
- Tooling: Changesets initialized; `attw` + `publint` + `knip` integrated into
  CI; ESM-only build verified via attw `esm-only` profile; CodeQL workflow;
  Dependabot config (npm + github-actions).
- License footer corrected: README MIT → Apache 2.0.
