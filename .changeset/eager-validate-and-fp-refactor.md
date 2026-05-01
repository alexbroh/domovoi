---
"domovoi": minor
---

Eager `Provider.validate(space)` hook + FP-style refactor.

- **`Provider.validate?(space)` extension point** — optional hook on the public
  Provider interface; engine calls it from `validateClassifierConfig` for every
  provider in the chain. Surfaces `decision_space_collision` errors at
  `domovoi.classifier({...})` construction time rather than lazily on first
  sample call. Tokenizer-aware adapters (hosted `openai()` factory) implement
  it; `ollama()` and default `openaiCompat()` omit it (no tokenizer).
  Backward-compatible: existing custom Provider implementations don't need
  changes.
- OpenAI adapter exposes the eager hook + retains the `sample()`-time
  collision check as defense-in-depth (memoized; zero cost on repeat).
- 2 new tests verifying eager validation: `validate(space)` throws on
  collision; sample() also catches (defense-in-depth path).

FP-style refinements (with the user's "readability and correctness win"
guardrail): array methods for *value construction* / *transformations*;
for-of for *side-effect iteration*. Modern TS (2022+) prefers for-of for the
latter — better V8 perf, async-correctness, cleaner stack traces, Biome's
default.

- `src/hash.ts`: canonicalize via `Object.fromEntries(.sort().filter().map())`.
- `src/calibration/index.ts`: temperatureScaling uses `.map()` + `.reduce()`
  + `Object.fromEntries(.map())` for the two-pass scale-then-renormalize.
- `src/env.ts`: provider entry parsing as `.split().map().filter(Boolean).map()`
  pipeline; resolveProvidersFromEnv uses `.map()` directly.
- `src/tokenizer.ts`: buildLogitBias as `Object.fromEntries(.map())`.
  findFirstTokenCollision deliberately kept as for-of — the early-return
  on first hit is clearer than reduce with accumulator bookkeeping.
- `src/engine/config.ts`: provider validate hook iteration is for-of with
  side-effect throw semantics — array method would obscure intent.

String-falsy idiom applied (per user directive):
- `!str` over `str.length === 0`; `str` over `str.length > 0`
- `.filter(Boolean)` over `.filter((s) => s)` or `.filter((s) => !!s)`
- `?.trim()` optional chaining where applicable
- Array emptiness checks (`arr.length === 0`) NOT changed — arrays are
  truthy in JS even when empty.

135/135 tests passing across 9 suites; typecheck clean; biome clean
(1 harmless warning on the (string & {}) escape-hatch suppression);
attw esm-only profile clean.
