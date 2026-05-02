---
"domovoi": minor
---

Eager `Provider.validate(space)` hook — surfaces `decision_space_collision` errors at `domovoi.classifier({...})` construction time instead of lazily on first sample call. Optional on the public `Provider` interface; the hosted `openai()` adapter implements it via `cl100k_base` first-token comparison. Existing custom `Provider` implementations continue to work unchanged.
