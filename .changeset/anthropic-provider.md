---
"@hourslabs/domovoi": minor
---

Add the Anthropic provider: `anthropic(model?, opts?)` with multi-sample verbalized-confidence distributions (default Haiku 4.5, 3 samples per call), disagreement-aware aggregation, and `samples` option. Multi-sample providers can now use non-identity calibrators (the v0 restriction is lifted), providers can contribute a `configHash` to the cache key, and sampling temperature defers to a provider-appropriate default when unset.
