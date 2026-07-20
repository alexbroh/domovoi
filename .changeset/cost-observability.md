---
"@hourslabs/domovoi": minor
---

Cost as observability: providers accept `pricing: { inputPerMTok, outputPerMTok }` and every Verdict carries `meta.cost` — backend-reported token usage summed across all provider calls (fallbacks included), with `usd` when every usage-reporting provider has pricing; absent on pure cache hits. Spans upgrade to real usage (`gen_ai.usage.*`, estimates flagged `domovoi.usage.estimated`) and emit `gen_ai.usage.cost_usd` per priced call; the scope budget now charges real tokens when reported. Breaking for custom Provider implementations: `sample()` returns `{ distribution, usage? }` instead of a bare `Distribution`; `mockProvider` accepts both shapes.
