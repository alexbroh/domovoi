---
"@hourslabs/domovoi": minor
---

Add `domovoi.scope` for ambient budget, signal, and tracer; `domovoi.bind` for scope across async boundaries; `distribution()` testing primitive.

**`domovoi.scope({ budget?, signal?, tracer? }, fn)`** — runs `fn` with ambient context inherited by every classify call inside it. Token budget enforced as a circuit breaker: when exhausted, classify returns `Unknown { reason: { type: "budget_exceeded", spent, limit } }` rather than continue spending. Opt into `onExceeded: "throw"` for hard-fail semantics. Scope signals combine with per-call signals via `AbortSignal.any`.

**`domovoi.bind(fn)`** — captures the current scope and re-applies on later invocation. Mirrors Node's `AsyncLocalStorage.bind` for queue workers, cron jobs, and `setTimeout` callbacks that detach from the calling stack.

**Tracing** — engine emits one OTel-shaped span per provider call when `scope.tracer` is present, following the GenAI semantic conventions: `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, plus domovoi-specific `domovoi.label_space`, `domovoi.cache.hit`, `domovoi.verdict.{kind,value,probability}`.

**`@hourslabs/domovoi/testing` adds `distribution()`** — single-sample assertions on AI behavior are meaningless; `distribution()` runs `n` real samples and returns Wilson-CI-backed assertions about behavior stability:

```ts
const dist = await distribution(
  () => domovoi.classify("hello there", ["greeting", "request"]),
  { n: 100 },
);
dist.coverage("greeting");                 // 0.94
dist.confidenceInterval("greeting");       // [0.88, 0.98]
dist.expectStable({ minCoverage: 0.9, maxUncertain: 0.05 });
```

**Backward compatibility:** zero disruption. Calls outside any scope are unchanged — no enforcement, no tracing, no budget.

New errors: `BudgetExceededError` (with `code: "tokens_exceeded"`).
New types: `ScopeOptions`, `ScopeBudget`, `ResolvedScope`, `BudgetMode`, `BudgetSnapshot`, `Tracer`, `Span`, `AttributeValue`, `ContextStorage<T>`, `Samples<T>`, `DistributionOptions`, `StabilityAssertion`, `ConfidenceLevel`.
