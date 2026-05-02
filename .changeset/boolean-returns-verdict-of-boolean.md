---
"@hours/domovoi": minor
---

`domovoi.boolean(input, question)` returns `Verdict<boolean>` (idiomatic TS) instead of `Verdict<"yes" | "no">`. The engine internally still classifies over the `["yes", "no"]` string space (matches LLM first-token tokenization); a small transform at the verb boundary maps `value` / `top` / `runnerUp` to `boolean` and rekeys `distribution.probs` from `{ yes, no }` to `{ true, false }`.

`Verdict<T>`, `Classified<T>`, `Uncertain<T>`, `Unknown<T>`, `UnknownReason<T>`, `Filterable<T>`, and `Distribution<T>` widen from `T extends string` to `T extends Label` (where `Label = string | boolean` — exported from the public surface). `domovoi.classify` and `domovoi.classifier` continue to constrain `T extends string` since multi-class spaces are string-only.

User-visible change: `if (isClassified(v) && v.value)` now reads cleanly for binary classifiers, instead of `v.value === "yes"`.
