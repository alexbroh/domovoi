---
"domovoi": minor
---

Tokenizer integration + examples + adapter tests.

- New `src/tokenizer.ts` (internal): cl100k_base via tiktoken; first-token-id
  resolution; `findFirstTokenCollision` for decision_space_collision detection;
  `buildLogitBias` for +100 in-space biasing per S8.
- OpenAI adapter wired to use cl100k_base on the hosted `openai()` factory:
  collision check fires on first sample call (memoized), logit_bias sent on
  every request, distribution constructed by token-id matching when
  available. Ollama keeps string-prefix fallback (varied tokenizers per model).
  `openaiCompat` exposes `useCl100kTokenizer: boolean` opt-in for backends
  known to use OpenAI-compatible tokenization (vLLM, Together, Fireworks).
- 4 runnable examples: sentiment (3-class multi), binary-toxic (deadband),
  video-canonicalization (typed input + format callback + chain fallback),
  local-ollama (local-first hybrid).
- `tests/tokenizer.test.ts` (8) + `tests/providers/openai-chat.test.ts` (14)
  with hoisted `vi.mock("openai")` — covers logit_bias, signal forwarding,
  distribution construction, malformed responses, collision detection.
- biome overrides: examples allow console.log, tests allow non-null
  assertions (testing patterns commonly need `!`).
- 124/124 tests, typecheck clean, attw esm-only profile clean, publint clean.
