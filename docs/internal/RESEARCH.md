# domovoi — API Design Research

last reviewed: 2026-04

Two research passes informed the API design. Captured here for future reference.

---

## Pass 1 — Prior art for typed-uncertainty classification

Question: does a TypeScript library already exist for "LLM classification with typed Verdict + calibrated confidence + deadband threshold + provider escalation"?

**Verdict: empty space (April 2026).** No TS library ships the four-way combination. Closest neighbors:

| Project | Language | Framing | What it ships | What it lacks |
|---|---|---|---|---|
| `@ax-llm/ax` | TS | DSPy port | class-typed signatures (`'review:string -> sentiment:class "a,b,c"'`) | no Uncertain<T>, no calibration, no deadband, no escalation |
| Vercel AI SDK `generateObject({output:"enum"})` | TS | Structured output | argmax string | no confidence semantics, no deadband |
| LangChain.js | TS | Generic LLM glue | `withStructuredOutput` + Zod enum (DIY) | no idiomatic classification chain |
| BAML (BoundaryML) | TS / multi | Schema-driven LLM lib | typed enum classification primitive (`enum SentimentLabel { ... }`) | no calibration, no deadband, no Uncertain |
| TypeChat | TS | Microsoft typed-LLM-output | enum mode | no Uncertain, no calibration, no deadband, no escalation |
| `irthomasthomas/llm-classify` | Python (CLI) | logprobs classifier | logprobs-based confidence | Python only |
| Instructor-Classify | Python | Fluent classify | logprobs + fluent API | Python only |
| Refuel Autolabel | Python + SaaS | "Labeling with confidence" | logprobs + threshold + reject | batch-only, single-language, only rejects (no typed Uncertain) |
| Nyckel | SaaS only | Calibrated text/image classification API | calibrated confidence + threshold | not a TS library |

**Differentiator scorecard** (T = typed Uncertain, C = calibrated, D = deadband, E = escalation):
- 4/4: nobody
- 3/4: nobody as a TS lib (Refuel covers C+D+partial-E but is SaaS without typed Verdict)
- 2/4: Refuel, Nyckel (SaaS), CascadeFlow (E + partial C, internal routing only)
- 1/4: Vercel AI SDK (T-lite, argmax), `@ax-llm/ax` (T-lite), LangChain.js (E generic), BAML (T enum), TypeChat (T enum), Instructor-Classify (C, Python)

**Adjacent crowded spaces** (do not directly overlap but worth tracking):
- Typed enum structured output: Vercel AI SDK, `@ax-llm/ax`, BAML, TypeChat, Instructor
- Generation-level cascading: CascadeFlow, LLMRouter
- Calibrated classification SaaS: Refuel, Nyckel
- Calibration recipes: Fireworks blog, Eric Jinks logprobs writeups

**Risks to monitor:**
- Vercel AI SDK could absorb classification-with-confidence into core (watch AI SDK 7).
- DSPy upstream + `@ax-llm/ax` could add typed Uncertain + Assertions-style abstain.
- A JS port of `instructor-classify` would close most of the OSS gap.
- "Calibrated" must mean *real* calibration (Platt/isotonic/temperature on held-out data), not just exposed logprobs — otherwise it equals `llm-classify` and the differentiator collapses.

**Calibration tension acknowledgment:** v0 ships calibration *infrastructure* (closed-form scaling factories — `identity`, `temperatureScaling(T)`, `plattScaling({a,b})`) without per-model fitted profiles. Users provide fit parameters from their held-out eval set. Pass 1's risk above is acknowledged and addressed by API contract, not by shipping fit data. `Calibrator.fit(eval)` arrives in v1.

**Verbalized-confidence prior art** (for v1 Anthropic adapter): Tian et al., "Just Ask for Calibration: Strategies for Eliciting Calibrated Confidence Scores from Language Models Fine-Tuned with Human Feedback" (EMNLP 2023). Canonical no-logprobs alternative — ask the model to verbalize its confidence. Realistic path for `coverageMeasurement: "approximate"` on no-logprob providers (Anthropic, hard-constraint engines).

**Conceptual ancestor** (must read): Bornholt et al., `Uncertain<T>: A First-order Type for Uncertain Data` (ASPLOS 2014). Pre-LLM type system for hypothesis-tested probability distributions. `domovoi` is essentially `Uncertain<T>` where the distribution comes from an LLM softmax over a constrained output.

---

## Pass 2 — SOTA TypeScript API design patterns

last reviewed: 2026-04

Question: what does "self-intuitive and super easy to use" look like in modern TS library APIs, and how should `domovoi` adopt those patterns?

**Survey of current SOTA (April 2026):**

| Library | Primary call | Configuration | Type inference | Failure surface |
|---|---|---|---|---|
| AI SDK 6 | `const { text } = await generateText({ model, prompt })` | per-call bag; model as **string** (`"anthropic/claude-sonnet-4.5"`); `Agent` for reusable bundles | zero generics; `Output.choice({ options: [...] as const })` narrows union | throws (`generateText`); `streamText` swallows + `onError` |
| Stripe | `await stripe.customers.create({...})` | `new Stripe(key, opts)` | generated `.d.ts` | throws `Stripe.errors.*` subclasses |
| Zod | `S.parse(x)` / `S.safeParse(x)` | schema *is* config | `z.infer<typeof S>` rare | dual: throw vs `{ success, data } \| { success: false, error }` |
| Drizzle | `db.select().from(t).where(eq(...))` | DB instance | full inference across chain | throws |
| tRPC | `trpc.userById.query('1')` | `createTRPCClient<AppRouter>()` once | end-to-end via `AppRouter` import | throws `TRPCClientError` |
| Anthropic / OpenAI / Google SDKs | `client.messages.create({...})` etc. | constructor + per-call | OpenAI's `responses.parse` narrows from Zod | all throw `APIError` subclasses by HTTP status |
| Hono | `app.get('/x', c => ...)` chained | `Hono<{Bindings,Variables}>()` | generics for env only | throws / `c.json` |
| Effect | `Effect.gen` + pipe | `Effect<A, E, R>` everywhere | full but cryptic errors | discriminated unions, `match` / `catchTag` |
| Remeda | dual data-first / data-last | none | TS-native, lazy `pipe` | throws |
| neverthrow | `Result<T, E>` wrapping | data-first FP-style | inferred | `{ ok, value } \| { ok: false, error }` Result type |

**Patterns the winners share:**

1. **One named import** for the primary call (`generateText`, `Stripe`, `z`). No `import * as`.
2. **Object-bag args past 1–2 params.** Chains only when they mirror an existing mental model (SQL → Drizzle, validation → Zod). Classification has no such mental model — config bag wins.
3. **Models / providers as imported factories**, not user-constructed classes.
4. **Inference, not generics.** `as const` on enums is the most users tolerate. **domovoi adopts this enum-as-const-array pattern** (mirrors AI SDK 6's `Output.choice({ options: [...] as const })`); anchors the design choice.
5. **Throw by default + `safe*` twin** for the careful path (Zod's model). Effect / neverthrow are minority taste. **domovoi inverts this** — default policy never throws on operational failure (returns `Unknown` variant); explicit `onErrorPolicy: "throw"` for the loud path.
6. **Discriminated unions** as the primary handling story; `match` helpers are opt-in. **domovoi commits to this** — Verdict<T> is a 3-variant union; `isClassified` / `isUncertain` / `isUnknown` type guards + `match` helper.
7. **Brand at edges, technical in middle.** Successful libraries (Zod, Drizzle, Pydantic, AI SDK, axios, tRPC) keep the brand handle decorative; the API stays technical. **domovoi follows this** — brand-flavored names limited to library handle (`domovoi`) and output type (`Verdict<T>`); everything else descriptive technical.

**Patterns the winners DON'T share** — what to avoid:
- Fluent chains for things that don't have an existing chain mental model (no `domovoi.classifier(config).withRetry(2).withTimeout(5000)`)
- Required user-written generics (`domovoi.classify<T>(...)`)
- Wrapping in Effect / Task / Result by default (Verdict is already a variant — wrapping it is two layers of variance)
- Namespace imports

**Recommendation distilled into domovoi patterns:**

```ts
// One-shot — Vercel AI SDK shape
import { domovoi } from "domovoi";
const cat = await domovoi.classify(input, ["news","sports","music"] as const);

// Reusable — Stripe + tRPC shape (callable factory)
import { openai } from "domovoi/providers";
const c = domovoi.classifier({
  space: ["news","sports","music"] as const,
  question: "Which category fits?",
  format: (x: Article) => `Title: ${x.title}\n${x.body}`,
  providers: [openai("gpt-4o-mini"), openai("gpt-4o")],
  thresholds: { high: 0.7, margin: 0.15, coverageMin: 0.5 },
});
await c(article);                    // primary: callable
await c.batch(articles);             // v0 batch

// Verdict — discriminated union first, type-guard helpers, opt-in match
if (isClassified(result)) use(result.value);                          // 80% case
match(result, { classified, uncertain, unknown });                    // exhaustive

// Errors — never throws on operational failure under default policy
const v = await domovoi.classify(...);                                // returns Verdict; Unknown { provider_failure } if all-providers-fail
const v2 = await c(item, { signal: ctrl.signal });                    // cancellable; Unknown { cancelled } on abort
```

**The one-liner test:** `domovoi.classify(input, ["a","b","c"] as const)` must autocomplete option literals on `Classified.value` with no extra imports and no user-written generics. That's the AI SDK 6 / Zod / tRPC bar.

---

## Sources

### Pass 1 — Prior art
- [Refuel Autolabel](https://github.com/refuel-ai/autolabel)
- [Refuel: Labeling with Confidence](https://www.refuel.ai/blog-posts/labeling-with-confidence)
- [Nyckel — Calibrating GPT Classifications](https://www.nyckel.com/blog/calibrating-gpt-classifications/)
- [LMQL (eth-sri)](https://github.com/eth-sri/lmql)
- [BAML (BoundaryML)](https://github.com/BoundaryML/baml)
- [TypeChat (Microsoft)](https://github.com/microsoft/TypeChat)
- [@ax-llm/ax](https://github.com/ax-llm/ax)
- [Instructor-Classify](https://jxnl.github.io/instructor-classify/installation/)
- [irthomasthomas/llm-classify](https://github.com/irthomasthomas/llm-classify)
- [RouteLLM](https://github.com/lm-sys/RouteLLM)
- [Uncertain<T> (Microsoft Research)](https://www.microsoft.com/en-us/research/publication/uncertaint-a-first-order-type-for-uncertain-data-2/)
- [Awesome LLM Uncertainty / Reliability](https://github.com/jxzhangjhu/Awesome-LLM-Uncertainty-Reliability-Robustness)
- [Tian et al. — Just Ask for Calibration (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.330/)

### Pass 2 — SOTA API patterns
- [AI SDK Core: generateText / streamText](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [AI SDK Core: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [AI SDK Core: Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/output)
- [AI SDK 6 release notes](https://vercel.com/blog/ai-sdk-6)
- [Stripe Node SDK](https://github.com/stripe/stripe-node)
- [Zod](https://zod.dev/)
- [Drizzle ORM — Select](https://orm.drizzle.team/docs/select)
- [tRPC quickstart](https://trpc.io/docs/quickstart)
- [Anthropic TS SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- [OpenAI Node SDK](https://github.com/openai/openai-node)
- [Google Gen AI JS SDK](https://github.com/googleapis/js-genai)
- [Hono](https://hono.dev/docs/api/hono)
- [Effect — Effect type](https://effect.website/docs/getting-started/the-effect-type)
- [Remeda](https://remedajs.com/)
- [neverthrow](https://github.com/supermacro/neverthrow)

### Calibration & determinism
- [Calibrating LMs with Adaptive Temperature Scaling (EMNLP 2024)](https://aclanthology.org/2024.emnlp-main.1007.pdf)
- [Calibration and Correctness of LMs for Code (ICSE 2025)](https://www.software-lab.org/publications/icse2025_calibration.pdf)
- [Calibrating Verbalized Probabilities (arXiv 2410.06707)](https://arxiv.org/html/2410.06707v1)
- [A Survey of Confidence Estimation and Calibration in LLMs (NAACL 2024)](https://aclanthology.org/2024.naacl-long.366.pdf)
- [Thinking Machines Lab: Defeating Nondeterminism in LLM Inference (Sept 2025)](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)
- [OpenAI Cookbook — Using logprobs](https://cookbook.openai.com/examples/using_logprobs)
- [Eric Jinks — Estimating LLM classification confidence with logprobs](https://ericjinks.com/blog/2025/logprobs/)
- [Tian et al. — Just Ask for Calibration (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.330/)
