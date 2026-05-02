---
"domovoi": minor
---

Tokenizer-aware OpenAI adapter: `cl100k_base` via `tiktoken` for first-token collision detection at `domovoi.classifier({...})` construction time, plus `+100` `logit_bias` for in-space label steering on every sample. Ollama keeps a string-prefix fallback (per-model tokenizer variance). `openaiCompat` exposes `useCl100kTokenizer: boolean` for backends with OpenAI-compatible tokenization (vLLM, Together, Fireworks).

Four runnable examples: `sentiment` (3-class multi), `binary-toxic` (deadband), `video-canonicalization` (typed input + format callback + chain fallback), `local-ollama` (local-first hybrid).
