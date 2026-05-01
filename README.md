# domovoi

Software has been deterministic by convention — every fork in the code is a hand-coded predicate, every route a rule someone wrote down. The interesting decisions often resist enumeration: *is this email a complaint?* *is this PR safe to auto-merge?* *is this user's intent to reorder or cancel?* domovoi treats AI as an **embedded worker** for exactly that class of fork — a primitive you sprinkle through ordinary code at the points where rules don't fit. Each module stays deterministic; the glue between them becomes runtime-decided, typed, and budgeted. *Living software*, in the precise sense — bounded structural non-determinism, not unbounded autonomy.

## Why "domovoi"

In Slavic folklore, a *domovoi* (домово́й — "of the house") is a household guardian spirit. Bound to the dwelling. Inherited with the property. Performing ongoing protective service for whoever lives there next. Not a tool you summon from outside. Not an autonomous agent with its own agenda. A spirit that *lives inside* the home, watches over the cases the household brings it, and renders verdicts.

The metaphor maps cleanly to the technical scope. domovoi is **bound** to your runtime — it's not a remote service, it's a library that lives inside your process. **Embedded** across module boundaries — every module can reach for the same domovoi at any decision point, without ceremony. **Judging with calibrated probability and structured uncertainty** — when the answer is clear, you get a typed `Classified<T>`; when it's not, you get an `Uncertain` or `Unknown` with the reason discriminated, never a thrown exception or a silent miscall.

Other names for this thing were considered and discarded. *Familiar* and *augur* carry biblical condemnation (Lev 19:31, Deut 18:10–11) — wrong values for a tool meant to be trustworthy. *Djinn* and *genie* connote trickster behavior — wrong reliability framing. *Agent* and *worker* are taken by adjacent paradigms (autonomous agents, queue workers) that domovoi explicitly is not. *Domovoi* is pre-Christian Slavic folkloric, accessible in pronunciation ("doh-mo-VOY"), and carries the exact connotation we need: a benign, embedded, judgment-rendering presence that's part of the dwelling itself.

Bind a domovoi to your codebase. Receive Verdicts. Ship.

```ts
import { domovoi, isClassified } from "domovoi";

const v = await domovoi.classify(input, ["news", "sports", "music"] as const);
if (isClassified(v)) {
  v.value;        // ← autocompletes "news" | "sports" | "music"
  v.probability;  // ← number ∈ [0, 1]
}
```

The decision space narrows the output type. No user-written generics. No `import * as`. One line.

> **What ships today (v0.1):** the Verdict primitive — typed-uncertainty classification with calibrated probability and structured failure modes. **v0.2** adds ambient context propagation (`domovoi.scope` for budget / trace / cancellation across embedded calls — the embedded-worker concept fully realized). **v1** is production-ready. See the [Roadmap](#roadmap) below.

---

## Why typed Verdicts

Most LLM-classification approaches force you to choose between:
- **Free-form generation** — flexible but unstructured; you parse and pray.
- **Strict structured output** — argmax string in a fixed enum; no signal when the model is uncertain or the input doesn't fit.

domovoi treats classification as a **probabilistic decision over a finite space**: emit a calibrated Distribution, threshold it, return one of three typed variants:

- **`Classified<T>`** — confident answer with `value: T` and `probability: number`.
- **`Uncertain<T>`** — top class below threshold; carries `top`, `runnerUp`, full `distribution`.
- **`Unknown<T>`** — no answer; reason discriminates `out_of_distribution` / `chain_exhausted` / `provider_failure` / `predicate_rejected` / `budget_exhausted` / `cancelled`.

Failure-to-classify is a *first-class typed result*, not a thrown exception.

## Design principle — small core + clear extension points

domovoi follows the **Zod / Drizzle / Pydantic / AI SDK pattern**: small, opinionated core API; published interfaces (`Provider`, `Calibrator`, `Cache`) so users build their own adapters/calibrators/caches without forking the library. Brand voice carries via the library handle and the `Verdict<T>` type; the rest of the API is descriptive technical vocabulary.

**Core verbs:**
- `domovoi.classify(input, space)` — multi-class one-shot
- `domovoi.boolean(input, question)` — binary one-shot
- `domovoi.classifier({ ... })` — reusable configured classifier (returns `Classifier<T, I>`)

**Type guards + match helper:**
- `isClassified(v)`, `isUncertain(v)`, `isUnknown(v)`
- `match(v, { classified, uncertain, unknown })` — exhaustive; type-checked

**Combinators (small):**
- `Verdict.filter(pred)` — domain-validity rejection over Classified/Uncertain (Unknown passes through)

That's the surface. Everything else is technical: `Provider`, `Calibrator`, `Cache`, `mockProvider`, `temperatureScaling`, `plattScaling`.

## Three idioms

```ts
const v = await c(article);

// 1. Type guard — simple cases
if (isClassified(v)) save(v.value);

// 2. Switch on kind — full routing
switch (v.kind) {
  case "classified": save(v.value); break;
  case "uncertain":  queue.review(v.top, v.runnerUp); break;
  case "unknown":
    switch (v.reason.type) {
      case "out_of_distribution": newCategoryQueue.add(v.reason.topIfRenormalized); break;
      case "provider_failure":    deadletter.push(v.reason.errors); break;
      // ... cancelled, budget_exhausted, chain_exhausted, predicate_rejected
    }
    break;
}

// 3. match — exhaustive expression form
match(v, {
  classified: ({ value }) => save(value),
  uncertain:  ({ top, runnerUp }) => queue.review(top, runnerUp),
  unknown:    ({ reason }) => routeUnknown(reason),
});
```

## Provider chain + escalation

```ts
const c = domovoi.classifier({
  name: "articles",
  space: ["news", "sports", "music"] as const,
  question: "Which category fits?",
  format: (a: Article) => `${a.title}\n${a.body}`,
  thresholds: { high: 0.7, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  calibrator: temperatureScaling(0.85),
});
```

If the first provider returns `Uncertain` or errors, the engine tries the next. Errors are recorded in `verdict.meta.providerErrors`. Default `onErrorPolicy: "fallback"` returns `Unknown { provider_failure }` on full-chain failure (never throws); set `onErrorPolicy: "throw"` for `AggregateError`.

## Env contract

```bash
# Credentials (always in env; factories pick up automatically)
OPENAI_API_KEY=sk-...

# Default provider chain — comma-separated factory/model
DOMOVOI_PROVIDERS=openai/gpt-4o-mini,openai/gpt-4o

# Per-classifier override (when classifier has `name: "articles"`)
DOMOVOI_PROVIDERS_ARTICLES=openai/gpt-4o-mini,ollama/llama-3.1-70b
```

Format: `factory/model[,factory/model...]`. First `/` separates factory from model. Whitespace trimmed; empty entries skipped.

In-code overrides win — `domovoi.classifier({ ..., providers: [...] })` ignores env.

## Local LLMs (free, runs on your machine)

Most local LLM runtimes ship OpenAI-compatible APIs. domovoi works with all of them:

```ts
import { ollama, openaiCompat } from "domovoi/providers";

// Ollama (defaults to localhost:11434)
const local = ollama("llama-3.1-70b");

// LM Studio
const lmstudio = openaiCompat("local-model", {
  baseURL: "http://localhost:1234/v1",
  apiKey: "lmstudio",
});

// vLLM, Together, Fireworks, OpenRouter
const fireworks = openaiCompat("accounts/fireworks/models/llama-3", {
  baseURL: "https://api.fireworks.ai/inference/v1",
  apiKey: process.env.FIREWORKS_API_KEY,
});

// Mixed chain — local primary, cloud fallback
const c = domovoi.classifier({
  ...,
  providers: [local, openai("gpt-4o-mini")],
});
```

## Cancellation (AbortSignal)

Standard Web API. Pass `signal` to any call:

```ts
// React-style cleanup
useEffect(() => {
  const controller = new AbortController();
  c(item, { signal: controller.signal }).then(setResult);
  return () => controller.abort();
}, [item]);

// Deadline via AbortSignal.timeout
await c(item, { signal: AbortSignal.timeout(5000) });

// Combined parent + deadline via AbortSignal.any
await c(item, {
  signal: AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]),
});

// .batch always returns partial results
const results = await c.batch(items, { signal: controller.signal });
// Finished items keep their Verdicts; in-flight + not-yet-started become Unknown { cancelled }
```

`controller.abort(reason)` — the reason propagates into `Unknown { cancelled, reason }`.

## Calibration

domovoi ships closed-form scaling factories. **You** provide the fit parameters from your held-out eval set:

```ts
import { identity, temperatureScaling, plattScaling } from "domovoi/calibration";

// Default: identity (no calibration)
domovoi.classifier({ ..., calibrator: identity });

// Temperature scaling (any space size)
domovoi.classifier({ ..., calibrator: temperatureScaling(0.85) });

// Platt scaling (binary only)
domovoi.classifier({ space: ["yes","no"] as const, ..., calibrator: plattScaling({ a: 1.2, b: -0.3 }) });
```

`Calibrator.fit(eval)` (fit calibrators from labeled data) lands in v1.

## Cache

domovoi caches raw distributions per `(input, provider)` keyed by SHA-256. Default in-memory LRU; size configurable:

```ts
domovoi.classifier({
  ...,
  cache: domovoi.memoryCache({ maxEntries: 50_000 }),  // optional; defaults to 10k per-classifier
});
```

**Cache invariants:**
- The cache hashes the *output* of `format(input)`, not the `format` function itself. Two classifiers with different `format` but identical formatted strings share cache rows.
- Calibrator runs **per-caller** after cache resolution. Two classifiers with different calibrator configs hitting the same cache key get the same raw Distribution but produce different Verdicts.
- Cache is per-classifier by default. For shared cache, pass an explicit instance to multiple classifiers.

**Custom cache backends** (Redis, SQLite, Cloudflare KV) — implement the public `Cache` interface:

```ts
interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Engine handles serialization; backends are dead-simple key-value stores.

## Extension points

Three public interfaces. Implement them for backends domovoi doesn't ship:

- **`Provider`** — adapter for any LLM API (vLLM with custom auth, your-org's internal LLM gateway, etc.)
- **`Calibrator`** — custom calibration (Bayesian smoothing, ensemble averaging)
- **`Cache`** — persistent / distributed backends

Plus `mockProvider` from `domovoi/testing` for unit tests:

```ts
import { mockProvider } from "domovoi/testing";

const c = domovoi.classifier({
  ...,
  providers: [
    mockProvider({
      behavior: (input, space) => ({ probs: { news: 0.8, sports: 0.1, music: 0.1 }, coverage: 0.95 }),
    }),
  ],
});
```

## Sensitive data in error logs

domovoi records provider errors verbatim into `Verdict.meta.providerErrors[].error` (typed plain object — `JSON.stringify` works naturally). Provider error messages may contain credentials.

**Redact at the consumer boundary** (industry pattern — Pino, Winston, Sentry, OpenTelemetry):

```ts
const logger = pino({
  redact: [
    '*.meta.providerErrors[*].error.message',
    '*.meta.providerErrors[*].error.stack',
  ],
});
```

## v0 limitations

1. **Single adapter family** — OpenAI Chat + OpenAI-compatible runtimes (Ollama, vLLM, LM Studio, Together, Fireworks). Anthropic native is v1 (multi-sample with verbalized confidence).
2. **In-memory cache only** — process-local; serverless cold starts begin empty. Persistent backends (Redis, SQLite, KV) implementable today via the public Cache interface.
3. **Identity calibrator default** — provide `temperatureScaling(T)` or `plattScaling({a,b})` parameters fitted on your eval set for real calibration. `Calibrator.fit()` is v1.
4. **No retries on `ProviderError`** — chain fallback covers between-provider failures; per-provider retries are v1.
5. **No streaming** — `.stream` on Classifier is v1 (`.batch` ships in v0).
6. **No few-shot prompting** — input passes verbatim; users wrap with their own example-injection if needed.

## Roadmap

domovoi is a positioning play: AI dispatch as a method-call-shaped primitive that lives inside ordinary code. Order of releases — *what*, not *when*:

**v0.1 (shipped).** The Verdict primitive: discriminated `Classified<T>` / `Uncertain<T>` / `Unknown<T>` with structured failure modes; `classify` / `boolean` / `classifier` verbs; calibration infrastructure; pluggable provider chain; tokenizer-aware OpenAI adapter; `Provider` / `Calibrator` / `Cache` extension points.

**v0.2 (next).** Ambient context propagation. `domovoi.scope({ budget, signal, tracer }, fn)` opts into budget enforcement, tracing, and cancellation across embedded `domovoi.classify(...)` calls deep in your call tree — no prop-drilling. New public extension point: `ContextStorage<T>` (default backed by Node `AsyncLocalStorage`). Distribution-shaped test primitives. Embedded calls outside a scope work exactly as today — zero-disruption upgrade.

**v1 (after v0.2).** Production-ready. Replay (re-run deterministic modules along the AI-decided path that actually happened, no new LLM calls). `Calibrator.fit(eval)` for fitting calibrators from labeled data. Provider matrix complete (Anthropic native multi-sample, Gemini, Cohere, vLLM, Together, Fireworks, OpenRouter convenience factories). First-party persistent caches (Redis, SQLite, Cloudflare KV). Built-in OpenTelemetry integration. `.stream` on Classifier. Determinism declarations (type-checked refusal of AI in regulated paths).

**v2 horizon.** Multi-language ports (Python first; cache schema is language-neutral by design). Multi-modal Verdicts over images and audio. Online calibration from production traces.

**Stability commitments:** the Verdict shape, the three core verbs, and the four error classes are stable across all of v0 / v0.2 / v1. The `Provider` / `Calibrator` / `Cache` extension interfaces are public — breaking them requires a major version bump. `0.x` releases may break their non-extension-point surfaces freely; pin an exact version if you need that stability today.

## Performance targets (aspirational)

- Engine overhead per call: < 1ms (excluding provider call latency).
- Cache hit latency: < 0.1ms.
- Memory per cache entry: < 500 bytes (varies with decision space size).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
