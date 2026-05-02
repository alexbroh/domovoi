<div align="center">
  <img alt="domovoi — a small lit cabin in a forest of binary digits, where a craftsman gnome works at his bench" src=".github/assets/cover.png" width="100%" />
</div>

# domovoi

**domovoi is an embedded intelligence-in-the-runtime. Not a service, but a primitive that lives inside your software.** Ask questions at the forks where rules don't fit; receive typed Verdicts; ship to production with bounded cost and full observability.

```ts
import { domovoi, isClassified } from "domovoi";

const query = "best running shoes for marathons";
const verdict = await domovoi.classify(query, ["commercial", "informational", "navigational"] as const);

if (isClassified(verdict)) {
  verdict.value;        // → "commercial"
  verdict.probability;  // → 0.94
}
```

**That's it.** The space you pass narrows the output type. No generics to write, no namespace import to remember.

Run the same classifier across a range of search queries:

```
"best running shoes for marathons"     →  commercial     (p=0.94)
"what time is it in tokyo"             →  informational  (p=0.97)
"facebook login"                       →  navigational   (p=0.99)
"how to clean white sneakers"          →  informational  (p=0.91)
"running"                              →  uncertain      (commercial vs informational, p=0.55)
```

The last row is the interesting one. A bare "running" could be any of three intents — buying gear, learning technique, or opening the Running app. The model can't tell which, so you get an `Uncertain` Verdict with both top candidates named. Your search router decides what to do with it.

> Today's release ships the Verdict primitive: typed classification with calibrated probability, plus structured failure modes for the cases the model can't handle. The next release adds `domovoi.scope` — ambient budget enforcement and cancellation across embedded calls. The [Roadmap](#roadmap) has the rest.

---

The existing tools don't quite fit. Free-form generation makes you parse and pray. Strict structured output picks an argmax and gives you no signal when the model is unsure. Agent frameworks like LangGraph treat AI as an autonomous orchestrator and ask you to adopt a framework. Workflow engines like Temporal treat AI as a remote service to call, not a primitive to embed. domovoi fills the gap: a library you import and call inline, with calibrated probability built in and the model's uncertainty surfaced as a typed result.

|                              | domovoi                              | LangGraph             | Temporal / Inngest      | Vanilla LLM SDK    |
| ---------------------------- | ------------------------------------ | --------------------- | ----------------------- | ------------------ |
| **Shape**                    | Library you sprinkle                 | Framework you adopt   | Workflow engine         | Service client     |
| **AI in routing decisions**  | Yes (typed)                          | Yes (untyped state)   | No                      | N/A                |
| **Typed uncertainty**        | `Classified \| Uncertain \| Unknown` | Free-form state       | Hand-coded              | Argmax string only |
| **Calibrated probability**   | First-class                          | No                    | No                      | No                 |
| **Cancellation**             | `AbortSignal` native                 | Manual                | Native                  | Provider-specific  |
| **Per-call cost / latency**  | ~50–500ms, one LLM call              | Per-step, agent-loop  | Workflow-orchestrated   | Per-call           |

## Features

- **Typed Verdicts** — `Classified<T> | Uncertain<T> | Unknown<T>` discriminated union; failure-to-classify is a first-class typed result, not a thrown exception.
- **Calibrated probabilities** — temperature scaling, Platt scaling, identity. You supply fit parameters today; fitting from labeled data is on the roadmap.
- **Provider chain with fallback** — escalate on uncertainty or error; structured per-attempt error metadata.
- **AbortSignal cancellation** — native, throughout. `AbortSignal.timeout`, `AbortSignal.any` compose naturally.
- **Tokenizer-aware** — `cl100k_base` for first-token collision detection and logit_bias steering on hosted OpenAI; string-prefix fallback for backends with unknown tokenizers.
- **Pluggable extension points** — `Provider`, `Calibrator`, `Cache` as public interfaces. Build your own without forking.
- **Local LLMs** — Ollama, vLLM, LM Studio, Together, Fireworks, OpenRouter via `openaiCompat`.

## Why "domovoi"

In Slavic folklore, a *domovoi* (домово́й — "of the house") is a household guardian spirit. It belongs to the house, gets inherited with the property, and looks after whoever lives there. You don't summon it from outside, and it doesn't go off and do its own thing. It stays in the home, sees what comes through the door, and gives its verdict. **Bind a domovoi to your codebase. Receive Verdicts. Ship.**

## Where this fits

A domovoi belongs at the forks where you'd otherwise write a brittle regex pile, defer to a human, or skip the decision entirely:

- **Intent routing** — *"is this ticket a refund, complaint, or question?"* `Classified` flows to a handler; `Uncertain` flows to a human review queue; `Unknown { provider_failure }` flows to dead-letter.
- **Smart triage** — *"which team owns this incident? which engineer for this code review?"* Replace the inbox-routing regex pile with a domovoi over your team taxonomy.
- **Tiered dispatch** — chain `[gpt-4o-mini, gpt-5]` resolves cheaply when the model is confident and escalates to the expensive call only on `Uncertain`. Real money saved when ≥70–80% of inputs resolve at the cheap tier — pre-RAG gates, pre-action filters, editor-feature dispatch — but break-even is on you.
- **Ingestion-time batch classification** — *"categorize 100K menu items / auto-label every issue / triage the email backlog overnight."* `c.batch(items, { concurrency })` with provider chain + per-item Verdicts; failures stay isolated, the rest of the batch finishes.
- **Moderation with human-in-the-loop** — *"is this content NSFW, spam, or fine?"* `Uncertain` is the entire moderation queue. Stop picking a fixed threshold and praying.
- **Fuzzy validation beyond regex** — *"does this product description actually describe this product?"* The check that's trivial for a human and impossible for a regex.
- **PR / code-review gating** — *"is this PR safe to auto-merge?"* `Classified { value: "yes", probability: 0.91 }` auto-merges; `Uncertain` requests human review with the runner-up carried in the Verdict.

The same shape repeats: a decision that's easy for a human but hard to write rules for, with a bounded downside if you get it wrong. You want a typed verdict you can dispatch on, not a string you have to parse.

## Before / after

Routing a support ticket without a domovoi: a regex pile that grows every time someone reports a misroute, and that silently misclassifies whenever an input phrasing isn't anticipated.

```ts
function routeTicket(ticket: Ticket) {
  if (/\b(refund|return|money[- ]?back|charge[- ]?back)\b/i.test(ticket.body)) {
    return handleRefund(ticket);
  }
  if (/\b(broken|doesn'?t work|not working|defective|stopped working)\b/i.test(ticket.body)) {
    return handleComplaint(ticket);
  }
  if (/\?\s*$/.test(ticket.body) || /\b(how|why|when|where)\b/i.test(ticket.body)) {
    return handleQuestion(ticket);
  }
  // What about "I want my money back, this is broken"? Falls to triage.
  // Triage drowns. Bug reports follow. Add a regex. Repeat.
  return triage(ticket);
}
```

Routing the same ticket *with* a domovoi at the fork:

```ts
import { domovoi, match } from "domovoi";

async function routeTicket(ticket: Ticket) {
  const intent = await domovoi.classify(
    ticket.body,
    ["refund", "complaint", "question"] as const,
    { question: "What is this customer asking for?" },
  );
  return match(intent, {
    classified: ({ value })           => handlers[value](ticket),
    uncertain:  ({ top, runnerUp })   => humanReview.queue(ticket, top, runnerUp),
    unknown:    ()                    => triage(ticket),
  });
}
```

The regex pile collapses into a three-class typed space. The "I want my money back, this is broken" case lands as `Uncertain` with `top: "complaint"` and `runnerUp: "refund"`, so the review queue already knows both candidates before a human looks at the ticket. And triage stops being the bucket for "anything we couldn't match" and becomes the bucket for "the model failed, we genuinely don't know."

---

## Why typed Verdicts

Most LLM-classification approaches force you to choose between:
- **Free-form generation** — flexible but unstructured; you parse and pray.
- **Strict structured output** — argmax string in a fixed enum; no signal when the model is uncertain or the input doesn't fit.

domovoi treats classification as a **probabilistic decision over a finite space**: emit a calibrated Distribution, threshold it, return one of three typed variants:

- **`Classified<T>`** — confident answer with `value: T` and `probability: number`.
- **`Uncertain<T>`** — top class below threshold; carries `top`, `runnerUp`, full `distribution`.
- **`Unknown<T>`** — no answer; reason discriminates `out_of_distribution` / `chain_exhausted` / `provider_failure` / `predicate_rejected` / `budget_exhausted` / `cancelled`.

Failure-to-classify is a typed result, not an exception you have to catch.

## Design principle — small core + clear extension points

domovoi keeps the public API deliberately small. The three extension interfaces — `Provider`, `Calibrator`, `Cache` — are public so you can write your own adapters, calibrators, and caches in your own code, without forking the library.

**Core verbs:**
- `domovoi.classify(input, space)` — multi-class one-shot
- `domovoi.boolean(input, question)` — binary one-shot
- `domovoi.classifier({ ... })` — reusable configured classifier (returns `Classifier<T, I>`)

**Type guards + match helper:**
- `isClassified(v)`, `isUncertain(v)`, `isUnknown(v)`
- `match(v, { classified, uncertain, unknown })` — exhaustive; type-checked

**Combinators:**
- `Verdict.filter(pred)` — domain-validity rejection over Classified/Uncertain. Unknown passes through.

That's the surface. Everything else is technical: `Provider`, `Calibrator`, `Cache`, `mockProvider`, `temperatureScaling`, `plattScaling`.

## Three idioms

```ts
const verdict = await articleClassifier(article);

// 1. Type guard — simple cases
if (isClassified(verdict)) save(verdict.value);

// 2. Switch on kind — full routing
switch (verdict.kind) {
  case "classified": save(verdict.value); break;
  case "uncertain":  reviewQueue.add(verdict.top, verdict.runnerUp); break;
  case "unknown":
    switch (verdict.reason.type) {
      case "out_of_distribution": newCategoryQueue.add(verdict.reason.topIfRenormalized); break;
      case "provider_failure":    deadLetterQueue.push(verdict.reason.errors); break;
      // ... cancelled, budget_exhausted, chain_exhausted, predicate_rejected
    }
    break;
}

// 3. match — exhaustive expression form
match(verdict, {
  classified: ({ value })          => save(value),
  uncertain:  ({ top, runnerUp })  => reviewQueue.add(top, runnerUp),
  unknown:    ({ reason })         => handleUnknown(reason),
});
```

## Provider chain + escalation

```ts
const articleClassifier = domovoi.classifier({
  name: "articles",
  space: ["news", "sports", "music"] as const,
  question: "Which category fits this article?",
  format: (article: Article) => `${article.title}\n\n${article.body}`,
  thresholds: { high: 0.7, coverageMin: 0.5 },
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  calibrator: temperatureScaling(0.85),
});
```

If the first provider returns `Uncertain` or errors, the engine tries the next. Errors are recorded in `verdict.meta.providerErrors`. Default `onErrorPolicy: "fallback"` returns `Unknown { provider_failure }` on full-chain failure — it never throws. Set `onErrorPolicy: "throw"` for `AggregateError`.

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

## Local LLMs

Local LLM runtimes ship OpenAI-compatible APIs. `ollama("llama-3.1-70b")` for Ollama (defaults to `localhost:11434`); `openaiCompat(model, { baseURL, apiKey })` for LM Studio, vLLM, Together, Fireworks, OpenRouter. Mix freely with hosted models in a single provider chain — `[ollama(...), openai(...)]` runs local primary, hosted fallback.

## Cancellation

Pass `signal` to any call. Standard Web API throughout: `AbortSignal.timeout(ms)`, `AbortSignal.any([parent, deadline])`, `controller.abort(reason)` — the reason propagates into `Unknown { cancelled, reason }`. `.batch` always returns partial results; finished items keep their Verdicts, in-flight and queued items become `Unknown { cancelled }`. The Promise resolves; it does not reject.

## Calibration

Three closed-form scaling factories from `domovoi/calibration`: `identity` (default — no calibration), `temperatureScaling(T)` (any space size), `plattScaling({ a, b })` (binary only). Fit parameters come from *your* held-out eval set; a `Calibrator.fit(eval)` API for fitting from labeled data is on the roadmap. Multi-sample providers are identity-only for now.

## Cache

Raw distributions cached per `(input, provider)` keyed by SHA-256. Default: in-memory LRU, 10k entries per-classifier; pass `cache: domovoi.memoryCache({ maxEntries })` to override.

Two invariants worth knowing. The cache hashes the *output* of `format(input)`, not the function itself — two classifiers with different `format` but identical output share rows. The calibrator runs **per-caller** after cache resolution, so different calibrator configs on the same cache key produce different Verdicts from the same raw Distribution.

Custom backends — Redis, SQLite, Cloudflare KV — implement the public `Cache` interface (`get`, `set`, `delete` over opaque strings); engine handles serialization.

## Extension points

Three public interfaces for backends domovoi doesn't ship: `Provider` (any LLM API), `Calibrator` (custom calibration math), `Cache` (persistent/distributed). Plus `mockProvider` from `domovoi/testing` for unit tests with controllable Distribution outputs.

## Current limitations

1. **Single adapter family** — OpenAI Chat + OpenAI-compatible runtimes (Ollama, vLLM, LM Studio, Together, Fireworks). Anthropic native (multi-sample with verbalized confidence) is on the roadmap.
2. **In-memory cache only** — process-local; serverless cold starts begin empty. Persistent backends (Redis, SQLite, KV) are implementable today via the public `Cache` interface.
3. **Identity calibrator default** — provide `temperatureScaling(T)` or `plattScaling({a,b})` parameters fitted on your eval set for real calibration. A `Calibrator.fit()` API for fitting from labeled data is planned.
4. **No retries on `ProviderError`** — chain fallback covers between-provider failures; per-provider retries are planned.
5. **No streaming** — `.stream` on `Classifier` is planned (`.batch` ships today).
6. **No few-shot prompting** — input passes verbatim; users wrap with their own example-injection if needed.

## Roadmap

Ordered milestones below. The order is committed, the calendar isn't, and specific version numbers live on the npm package page and in GitHub Releases.

**Today.** The Verdict primitive: discriminated `Classified<T>` / `Uncertain<T>` / `Unknown<T>` with structured failure modes; `classify` / `boolean` / `classifier` verbs; calibration infrastructure; pluggable provider chain; tokenizer-aware OpenAI adapter; `Provider` / `Calibrator` / `Cache` extension points.

**Next.** Ambient context propagation. `domovoi.scope({ budget, signal, tracer }, fn)` opts into budget enforcement, tracing, and cancellation across embedded `domovoi.classify(...)` calls deep in your call tree — no prop-drilling. New public extension point: `ContextStorage<T>` (default backed by Node `AsyncLocalStorage`). Distribution-shaped test primitives. Embedded calls outside a scope work exactly as today — zero-disruption upgrade.

**After that.** Production-ready embedded AI dispatch. Replay (re-run deterministic modules along the AI-decided path that actually happened, no new LLM calls). `Calibrator.fit(eval)` for fitting calibrators from labeled data. Provider matrix complete (Anthropic native multi-sample, Gemini, Cohere, vLLM, Together, Fireworks, OpenRouter convenience factories). First-party persistent caches (Redis, SQLite, Cloudflare KV). Built-in OpenTelemetry integration. `.stream` on `Classifier`. Determinism declarations (type-checked refusal of AI in regulated paths).

**Horizon.** Multi-language ports (Python first; cache schema is language-neutral by design). Multi-modal Verdicts over images and audio. Online calibration from production traces.

**Stability commitments.** The Verdict shape, the three core verbs, and the four error classes are stable across releases. The `Provider` / `Calibrator` / `Cache` extension interfaces are public — breaking them requires a major version bump. Pre-1.0 releases may break anything outside the extension interfaces. Pin an exact version if you need that stability today.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
