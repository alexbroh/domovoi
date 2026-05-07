<div align="center">
  <img alt="domovoi — a small lit cabin in a forest of binary digits, where a craftsman gnome works at his bench" src=".github/assets/cover.png" width="100%" />
</div>

# domovoi

[![npm version](https://img.shields.io/npm/v/@hourslabs/domovoi)](https://www.npmjs.com/package/@hourslabs/domovoi)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/typescript-%3E%3D5-blue)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-Apache%202.0-lightgrey)](LICENSE)

**domovoi is an embedded intelligence in the runtime — a primitive that lives inside your software.** Ask at the forks where rules break down, get a typed Verdict, and direct it with bounded cost and full observability.

---

- [What is domovoi](#what-is-domovoi)
- [Install](#install)
- [Typed Verdicts](#typed-verdicts)
- [When to Use It](#when-to-use-it)
- [API](#api)
- [Chaining](#chaining)
- [Provider Chain and Escalation](#provider-chain-and-escalation)
- [Local LLMs](#local-llms)
- [Configuration](#configuration)
- [Cancellation](#cancellation)
- [Calibration](#calibration)
- [Cache](#cache)
- [Current Limitations](#current-limitations)
- [Roadmap](#roadmap)
- [Origin](#origin)

---

## What is domovoi

Some decisions in software resist code. Is "SQ *COFFEE 0421" a restaurant or a grocery store? Is this message a refund request or a complaint? Is this form submission an abandoned checkout or a contact inquiry? A human decides in seconds. Code never will.

Rules and trained classifiers have tackled this for decades. Rules break on edge cases, then multiply until they collapse under their own weight. Classifiers return a confidence score and leave the handling to you. They don't know what they don't know.

domovoi is a single function call at the decision point. Unlike agent frameworks or workflow engines, it doesn't restructure how you build — it drops into existing code like any other dependency. Ask it, get a typed `Verdict`, and dispatch.

The `Verdict` is the core idea. Rather than a string or a confidence score, domovoi returns one of three typed states: `Classified` when confident, `Uncertain` when the top answer falls below threshold, `Unknown` when no answer is possible. Uncertainty becomes a first-class value your type system understands, not a silent wrong answer. Everything around the `Verdict` stays deterministic.

```tsx
import { domovoi, match } from "@hourslabs/domovoi";

async function processTransaction(transaction: Transaction): Promise<void> {
  if (await fraud.isSuspicious(transaction)) return holds.queue(transaction);

  const account = await accounts.get(transaction.accountId);
  const verdict = await domovoi.classify(
    transaction.merchant,      // e.g. "NETFLIX.COM"
    account.budget.categories, // e.g. ["shopping", "groceries", ...]
  );

  await match(verdict, {
    classified: ({ value })         => budget.attribute(account, transaction, value),
    uncertain:  ({ top, runnerUp }) => budget.attributePending(account, transaction, top, runnerUp),
    unknown:    ({ reason })        => transactions.markUncategorized(transaction, reason),
  });

  await receipts.archive(transaction);
  events.emit("transaction.processed", transaction.id);
}
```

---

## Install

```bash
npm install @hourslabs/domovoi

# set your provider credentials
OPENAI_API_KEY=sk-...
```

---

## Typed Verdicts

domovoi treats classification as a probabilistic decision over a finite space and returns one of three typed variants:

- **`Classified<T>`** — confident answer with `value: T` and calibrated `probability`.
- **`Uncertain<T>`** — top class below threshold; carries `top`, `runnerUp`, and the full `distribution`.
- **`Unknown<T>`** — no answer; `reason` discriminates `out_of_distribution`, `chain_exhausted`, `provider_failure`, `predicate_rejected`, `budget_exhausted`, or `cancelled`.

Failure-to-classify is a typed result, not an exception. Dispatch is exhaustive at the type level.

```
"NETFLIX.COM"                   →  subscriptions   (p=1.00)
"WHOLE FOODS MARKET #10293"     →  groceries       (p=0.99)
"UBER EATS"                     →  dining          (p=0.99)
"SHELL OIL 12345"               →  transportation  (p=0.93)
"AMZN MKTP US*A12B3C4D5"        →  uncertain       (shopping vs groceries, p=0.55)
```

The `AMZN MKTP` row shows why the third state exists: it could be shopping or groceries depending on the cart. A forced `argmax` would silently pick the wrong one. domovoi surfaces the ambiguity as a first-class result instead.

---

## Where Heuristics Break Down

Use domovoi for decisions that are obvious to a human, hard to encode in rules, and safe to get wrong within bounds.

- **Intent routing** — refund, complaint, or question. Rule sets and regex won't cover the full input space.
- **Content classification** — tag an article, ticket, or submission against your taxonomy. Replace brittle keyword rules with a classifier that handles edge cases.
- **Tiered dispatch** — chain models (e.g., cheap → expensive). The cheaper model handles easy cases; the stronger model runs only on `Uncertain`. Costs drop meaningfully when ~70–80% resolve at the lower tier.
- **Free-form validation + privacy filters** — does this description match the product? Does this bio violate guidelines? Does this input contain PII or a prompt-injection attempt?

This same shape shows up across mainstream libraries: [Mozilla Readability](https://github.com/mozilla/readability) and [Mercury Parser](https://github.com/postlight/parser) for DOM-based article extraction, [GitHub Linguist](https://github.com/github-linguist/linguist) for language detection, and [email-reply-parser](https://github.com/crisp-oss/email-reply-parser/blob/master/lib/regex.ts) and [Talon](https://github.com/mailgun/talon) for email fragment parsing. Under the hood, they rely on dense stacks of regex and heuristics that grow in complexity without ever fully solving the problem.

Here's a paraphrased example from email-reply-parser:

<table>
<tr><th>Before</th><th>With domovoi</th></tr>
<tr>
<td valign="top">

```ts
const QUOTE_HEADERS = [
  /^-*\s*(On\s.+\swrote:{0,1})\s*-*$/m,    // EN
  /^-*\s*(Le\s.+\sécrit\s?:{0,1})\s*-*$/m, // FR
  /^\s*(Am\s.+schrieb.+):$/m,              // DE
  /^(在[\s\S]+写道：)$/m,                    // ZH
  /^(20[0-9]{2}\..+\s작성:)$/m,             // KO
  // ...25 more locale variants
];

const SIGNATURE_SEPS = [
  /^\s*-{2,4}$/, /^\s*_{2,4}$/, /^-- $/,
  // ...18 patterns total
];

function classify(line: string) {
  if (QUOTE_HEADERS.some(r => r.test(line)))
    return "quote";
  if (SIGNATURE_SEPS.some(r => r.test(line)))
    return "signature";
  return "body";
}

// "-- pricing tier --" → signature.
// Body silently dropped.
```

</td>
<td valign="top">

```ts
const fragment = await domovoi.classify(
  line,
  ["quote", "signature", "body"],
);

await match(fragment, {
  classified: ({ value }) =>
    record(line, value),
  uncertain:  ({ top, runnerUp }) =>
    record(line, top, { lowConfidence: runnerUp }),
  unknown: () =>
    record(line, "body"),
});
```

</td>
</tr>
</table>

---

## API

Three core verbs:

```tsx
domovoi.classify(input, space, opts?)    // multi-class one-shot
domovoi.boolean(input, question, opts?)  // binary one-shot
domovoi.classifier({ ... })             // reusable, configured → Classifier<T, I>
```

Three ways to consume a Verdict:

```tsx
// Type guard — single-variant cases
if (isClassified(verdict)) save(verdict.value);

// switch — when each Unknown reason needs its own handler
switch (verdict.kind) { ... }

// match — exhaustive expression form, type-checked
match(verdict, {
  classified: ({ value })         => save(value),
  uncertain:  ({ top, runnerUp }) => saveTentative(top, runnerUp),
  unknown:    ({ reason })        => handleUnknown(reason),
});
```

`Verdict.filter(pred)` rejects domain-invalid `Classified` or `Uncertain` to `Unknown { predicate_rejected }`; `Unknown` passes through untouched.

Three extension interfaces let you write your own without forking: **`Provider`** for any LLM API, **`Calibrator`** for custom calibration math, **`Cache`** for persistent or distributed backends. `mockProvider` from `@hourslabs/domovoi/testing` covers unit tests with controllable Distributions.

---

## Chaining

Verdicts compose. A Verdict can gate the next call, so each classifier works over a small, coherent space rather than one flat list of labels:

```tsx
import { domovoi, isClassified } from "@hourslabs/domovoi";

const kind = await domovoi.classify(issue.body, [
  "bug", "feature", "question", "docs",
]);

// only bugs need surface-area triage — the first Verdict gates the second call
const surface =
  isClassified(kind) && kind.value === "bug"
    ? await domovoi.classify(issue.body, [
        "frontend", "backend", "infra", "data",
      ])
    : null;

await issues.label(issue, {
  kind:    isClassified(kind)    ? kind.value    : "triage",
  surface: surface && isClassified(surface) ? surface.value : null,
});
```

---

## Provider Chain and Escalation

Configure a named classifier with a provider chain, thresholds, and a calibrator using `domovoi.classifier`:

```tsx
const articleClassifier = domovoi.classifier({
  name: "articles",
  space: ["news", "sports", "music"],
  question: "Which category fits this article?",
  format: (article: Article) => `${article.title}\n\n${article.body}`,
  thresholds: { high: 0.7, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  calibrator: temperatureScaling(0.85),
});
```

If the first provider returns `Uncertain` or errors, the engine tries the next. Errors land in `verdict.meta.providerErrors`. The default `onErrorPolicy: "fallback"` returns `Unknown { provider_failure }` on full-chain failure — it never throws. Set `onErrorPolicy: "throw"` for `AggregateError`.

Every Verdict includes rich metadata — provider, attempted chain, latency, cache hits, distribution source, and swallowed fallback errors — without extra instrumentation.

---

## Local LLMs

Local runtimes ship OpenAI-compatible APIs, so you can mix them freely with hosted models in a single chain:

```tsx
// local primary, hosted fallback
providers: [ollama("llama-3.1-70b"), openai("gpt-4o")]
```

`ollama(model)` defaults to `localhost:11434`. `openaiCompat(model, { baseURL, apiKey })` covers LM Studio, vLLM, Together, Fireworks, and OpenRouter.

---

## Configuration

```bash
# Credentials — provider factories pick these up automatically
OPENAI_API_KEY=sk-...

# Default provider chain — comma-separated factory/model
DOMOVOI_PROVIDERS=openai/gpt-4o-mini,openai/gpt-4o

# Per-classifier override — when the classifier has `name: "articles"`
DOMOVOI_PROVIDERS_ARTICLES=openai/gpt-4o-mini,ollama/llama-3.1-70b
```

Format: `factory/model[,factory/model...]`. Whitespace is trimmed; empty entries are skipped. In-code overrides win — pass `providers` to `domovoi.classifier({ ... })` and the env is ignored.

---

## Cancellation

Pass `signal` to any call. Standard Web API throughout:

```tsx
// per-call timeout
const verdict = await domovoi.classify(input, space, {
  signal: AbortSignal.timeout(2000),
});

// composing signals
const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]);

// abort with reason
controller.abort("budget_exceeded");
// → Unknown { kind: "cancelled", reason: "budget_exceeded" }
```

`.batch` always returns partial results. Finished items keep their Verdicts; in-flight and queued items become `Unknown { cancelled }`. The Promise resolves; it does not reject.

---

## Scopes

A `domovoi.classify` call deep in a request handler needs three things from its environment: a cost ceiling, a cancellation signal, and observability. Threading them through every layer of your stack as arguments is tedious. Scopes make them ambient.

```ts
import { domovoi } from "@hourslabs/domovoi";

await domovoi.scope(
  { budget: { tokens: 50_000 }, signal: req.signal, tracer },
  async () => {
    // Every classify inside this scope inherits the budget, the signal,
    // and the tracer.
    await processBatch(items);
  },
);
```

If `processBatch` calls helpers that classify, they share the same running budget. When the budget hits zero, the next classify returns `Unknown { reason: { type: "budget_exceeded", spent, limit } }` rather than spend more.

### Predictable cost

The failure mode that makes finance teams nervous about LLM-backed code is the runaway loop — an infinite call quietly burning through a month of budget in an afternoon. Scope budgets are the circuit breaker:

```ts
await domovoi.scope({ budget: { tokens: 10_000 } }, async () => {
  for (const item of items) {
    const v = await domovoi.classify(item.text, ["a", "b"]);
    if (v.kind === "unknown" && v.reason.type === "budget_exceeded") break;
    // ...
  }
});
```

Default mode is graceful: classify returns `Unknown` when the limit is hit. For hard-fail behavior, set `onExceeded: "throw"` — classify throws `BudgetExceededError` instead.

### Scope-level cancellation

Scope signals combine with per-call signals via `AbortSignal.any`. Either firing aborts the in-flight provider call.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort("user navigated away"), 5_000);

await domovoi.scope({ signal: ac.signal }, async () => {
  await domovoi.classify(input, space);
});
```

### Observability

Pass a `Tracer` and domovoi emits one span per provider call, following the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for `gen_ai.*` fields and reserving `domovoi.*` for verdict-shaped concepts:

| Attribute | Carries |
|---|---|
| `gen_ai.provider.name` | `"openai"`, `"anthropic"`, etc. |
| `gen_ai.request.model` | requested model id |
| `gen_ai.usage.input_tokens` / `output_tokens` | per-call token counts |
| `domovoi.verdict.kind` | `"classified"` / `"uncertain"` / `"unknown"` |
| `domovoi.verdict.value` | selected label when classified |
| `domovoi.cache.hit` | whether the call was served from cache |

A short adapter wires your existing OpenTelemetry tracer in:

```ts
import { trace } from "@opentelemetry/api";
import type { Tracer } from "@hourslabs/domovoi";

const otel = trace.getTracer("my-app");
const tracer: Tracer = {
  startSpan: (name, attrs) => otel.startSpan(name, { attributes: attrs }),
};
```

Datadog, Honeycomb, Grafana Cloud, and Dynatrace populate their AI Observability views from `gen_ai.*` attributes automatically.

### Resolution order

Each `domovoi.classify` call resolves its budget, signal, and tracer in this order:

1. Per-call option, e.g. `domovoi.classify(..., { signal })`
2. Nearest enclosing `domovoi.scope`
3. No enforcement, no tracing, no budget

`AbortSignal` is the one exception — per-call and scope signals combine, rather than the per-call value overriding the scope.

Nested scopes inherit unspecified fields from the parent. A child `budget` overrides the parent and starts a fresh counter. A child `tracer` overrides. A child `signal` combines.

### Bind: scope across async boundaries

Queue workers, cron jobs, and `setTimeout` callbacks run *outside* the original async context. `domovoi.bind` captures the current scope and re-applies it on later invocation:

```ts
await domovoi.scope({ budget: { tokens: 50_000 }, tracer }, async () => {
  const job = domovoi.bind(async (item: Item) => {
    return domovoi.classify(item.text, ["a", "b"]);
  });

  // Queue runs `job` later, in a different async context. The captured
  // scope is re-applied: budget and tracer still flow through.
  await queue.push(job, items);
});
```

Mirrors Node's `AsyncLocalStorage.bind` and OpenTelemetry's `context.bind`. Outside any scope, `domovoi.bind(fn)` returns `fn` unchanged.

### Backward compatibility

Calls outside any scope are unchanged: no enforcement, no tracing, no budget. Existing code keeps working without changes.

---

## Testing

Two primitives in `@hourslabs/domovoi/testing` cover the testing surface:

- `mockProvider({ behavior })` — a `Provider` stub for unit-testing engine logic without hitting a real LLM.
- `distribution(fn, { n })` — runs `n` real samples and returns Wilson-CI-backed assertions about behavior stability.

### mockProvider — unit tests without an LLM

Most engine and threshold logic doesn't need a real model. `mockProvider` lets you supply a deterministic Distribution per call:

```ts
import { mockProvider } from "@hourslabs/domovoi/testing";

const stub = mockProvider({
  behavior: () => ({ probs: { yes: 0.92, no: 0.08 }, coverage: 0.95 }),
});

const c = domovoi.classifier({
  space: ["yes", "no"] as const,
  thresholds: { high: 0.7, low: 0.3 },
  providers: [stub],
});

const v = await c("input that the mock ignores");
// v.kind === "classified", v.value === "yes" — deterministic, no network
```

Useful for threshold logic, provider-chain fallback, calibrator math, error-handling paths — anything that's about *engine* behavior rather than *model* behavior. Zero LLM calls; runs anywhere.

### distribution — assert against AI behavior

Single-sample assertions on AI behavior are meaningless: the model varies between runs. `distribution()` runs `n` real samples and turns "the classifier should reliably tag greetings" into a one-liner backed by a Wilson confidence interval:

```ts
import { distribution } from "@hourslabs/domovoi/testing";

const dist = await distribution(
  () => domovoi.classify("hello there", ["greeting", "request"] as const),
  { n: 100 },
);

dist.coverage("greeting");           // 0.94
dist.confidenceInterval("greeting"); // [0.88, 0.98] — 95% Wilson CI
dist.modeKind();                      // "classified" | "uncertain" | "unknown"

dist.expectStable({
  minCoverage: 0.9,        // OR per-label: { greeting: 0.9, request: 0.5 }
  maxUncertain: 0.05,
  maxUnknown: 0.02,
});
```

Default concurrency is `Math.min(n, 5)` — `n=100` finishes in ~6 seconds against a 300ms p50 provider, well under typical rate limits. Pass `concurrency: 1` to serialize when running multiple `distribution()` tests in parallel.

`distribution()` makes `n` real LLM calls. At gpt-4o-mini and `n=100`, that's ~$0.005 per test — belongs in `test:e2e`, not the per-commit unit tier.

---

## Cost

A `domovoi.classify` call on gpt-4o-mini costs about $0.00004 — roughly 1/25 of a cent. ~180 input tokens (system prompt + label space + your input) at $0.15/M, plus ~15 output tokens at $0.60/M.

| Calls / month | Cost    |
|---------------|---------|
| 100k          | $4      |
| 10M           | $400    |
| 1B            | $40,000 |

The default `memoryCache` deduplicates byte-exact-match inputs within a process — significant savings on workloads with repeated inputs (log severity tags, predefined enums, boilerplate replies), little impact on free-form user content where every input is unique. The `Cache` extension point lets you back domovoi with any store for cross-process or persistent caching.

Reach for deterministic tools instead when: syntactic problems with stable rules (URL parsing, format validation, tokenizers), very high volume with thin margins (100B+ ad impressions / day), or hard-real-time loops where a cache miss (~300ms p50) blows the SLA.

---

## Calibration

Three closed-form scaling factories from `@hourslabs/domovoi/calibration`:

| Factory | When to use |
|---|---|
| `identity` | Default. No calibration applied. |
| `temperatureScaling(T)` | Works on any space size. |
| `plattScaling({ a, b })` | Binary classifiers only. |

Fit the parameters on your held-out eval set. `Calibrator.fit(eval)` is on the roadmap; until then, fitting is manual. Calibrators run per-caller after cache resolution, so different configs on the same cache key produce different Verdicts from the same raw Distribution.

---

## Cache

Raw distributions are cached per `(input, provider)` keyed by SHA-256. The default is an in-memory LRU at 10k entries per classifier:

```tsx
// override the default
domovoi.classifier({
  cache: domovoi.memoryCache({ maxEntries: 50_000 }),
  // ...
});
```

The cache hashes the *output* of `format(input)`, not the function itself. Two classifiers with different `format` implementations but identical output share cache rows.

Custom backends implement the public `Cache` interface. Redis, SQLite, and Cloudflare KV are planned as first-party packages; they're implementable today via the interface.

---

## Current Limitations

1. **Single adapter family.** OpenAI Chat plus OpenAI-compatible runtimes (Ollama, vLLM, LM Studio, Together, Fireworks). Anthropic native and Gemini are on the roadmap.
2. **In-memory cache only.** Process-local; serverless cold starts begin empty. Persistent backends are implementable today via the public `Cache` interface; first-party Redis, SQLite, and KV packages are planned.
3. **Identity calibrator default.** Provide `temperatureScaling(T)` or `plattScaling({ a, b })` with parameters you fit on your eval set for real calibration. Automated fitting (`Calibrator.fit(eval)`) is planned.
4. **No per-provider retries.** Chain fallback covers between-provider failures; per-provider retries are planned.
5. **No streaming.** `.stream` on `Classifier` is planned; `.batch` ships today.
6. **No few-shot prompting.** Input passes verbatim; wrap with your own example-injection if needed.

---

## Roadmap

Milestones are ordered; dates are not. For exact versions, see the npm package page and GitHub Releases.

**Today.** The Verdict primitive — `Classified<T>`, `Uncertain<T>`, and `Unknown<T>` with structured failure modes. The `classify`, `boolean`, and `classifier` verbs. Calibration infrastructure, pluggable provider chain, tokenizer-aware OpenAI adapter, and the `Provider` / `Calibrator` / `Cache` extension points.

**Next.** Ambient context propagation via `domovoi.scope({ budget, signal, tracer }, fn)` — opt into budget enforcement, tracing, and cancellation across all `domovoi.classify(...)` calls deep in your call tree. New public extension point: `ContextStorage<T>`, backed by Node `AsyncLocalStorage`. Calls outside a scope continue to work exactly as today.

**Stability.** The Verdict shape, the three core verbs, and the four error classes are stable across releases. The `Provider` / `Calibrator` / `Cache` extension interfaces are public — breaking changes require a major version bump. Pre-1.0 releases may break anything outside these interfaces; pin an exact version if stability is required today.

---

## Origin

In Slavic folklore, a _domovoi_ (домово́й — "of the house") is a household spirit, not summoned from outside but bound to the home itself. It belongs to whoever lives there, watches over the household, and tends to what needs tending. domovoi is that spirit for your software: present at every decision, bound to you.

---

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
