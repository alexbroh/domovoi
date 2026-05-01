---
name: doc-review
description: Review TypeScript JSDoc and inline comments for consumer-focus, encapsulation, and resilience to implementation changes. Flags comments that state the obvious, leak internal details, or omit information consumers genuinely need (throws, async cancel-safety, mutation, ordering, side effects).
---

# Doc Review

You are reviewing TypeScript comments and JSDoc. The reviewer's job is to surface three failure modes:

1. **Obvious-stating** — repeats what the signature, type, or name already conveys.
2. **Leaky** — exposes internal mechanism that will rot when the implementation changes.
3. **Incomplete** — omits information consumers must know to use the item correctly.

## Invocation

Args may specify a path, a diff target, or a glob:

- No args → review comments in the diff between `HEAD` and the upstream branch (or staged changes if no upstream).
- A file or directory path → review every public JSDoc and meaningful inline comment under it.
- A PR identifier (e.g. `#42`) → fetch the diff with `gh` and review changed comments only.

For diffs, focus on:
- **Added** comments — review them as new content.
- **Modified** comments — review them in their final state, plus check that the change still matches the (possibly changed) item.
- **Items whose signature changed without a corresponding doc update** — flag the doc as stale.

## Three failure modes

### 1. Obvious-stating

Flag when removing the comment loses no information.

```ts
// BAD: signature already says this
/** Returns the user. */
function getUser(): User { ... }

// BAD: name says this
/** Sets the timeout. */
function setTimeout(t: number): void { ... }

// BAD: type says this
/** A readonly array of strings. */
readonly tags: readonly string[];

// BAD: parameter restates types
/**
 * @param input The input string
 * @param options The options object
 */
function classify(input: string, options: Options) { ... }
```

Acceptable when the doc adds *constraints*, *units*, *ownership semantics*, or *invariants* the signature can't express:

```ts
// OK: clarifies units, range, normalization
/** Probability ∈ [0, 1] post-calibration. NaN never returned. */
readonly probability: number;

// OK: clarifies ordering invariant the type doesn't capture
/** Decision space in user-given order; not sorted. */
readonly space: readonly string[];
```

### 2. Leaky / will-rot

Flag references to:
- **Private fields, methods, or internal modules** the consumer can't import.
- **Specific data structures or libraries** ("uses Map with insertion-order iteration", "implemented via OpenAI SDK") unless the consumer's behavior depends on it.
- **Caller identity** ("used by `Engine.decide`") — couples doc to caller, breaks on rename or new caller.
- **Refactor history** ("was renamed from `parse`", "since v0.4 this method...") — belongs in CHANGELOG / commit / PR.
- **Adjacent line numbers** ("see line 42", "the function above") — fragile.
- **Internal lock identifiers** ("per G15 lock", "matches R9") — fine in `docs/internal/PLAN.md`, NOT in user-facing JSDoc.
- **TODOs about the comment itself** ("TODO: rewrite this once tokenizer ships").

Also flag *invariants stated in prose* that the type system already enforces (e.g. "this is non-empty" on a `readonly [T, ...T[]]` tuple, or "must be a string" on `string`).

Exception: when the value-class invariant is enforced *at construction* but the doc on a downstream method references it, that's load-bearing — keep it.

### 3. Incomplete — what consumers care about

JSDoc tags consumers rely on, in this order when present:

- `@throws` — every error path. Name each error class or condition. Don't say "throws if something goes wrong."
- `@returns` — only when the meaning isn't obvious from the type. Skip for `: User` returns; required for `: number` (units? range?) or `: Promise<T | undefined>` (when undefined?).
- `@param` — only when name + type don't convey it. Skip `@param name string The name.`; required for `@param signal AbortSignal — cancellation; engine merges with per-call timeout`.
- `@example` — for non-trivial APIs only. Skip when the example would just call the function with obvious args.
- `@deprecated` — required on anything still exported but slated for removal; include the migration target.

Additional categories consumers rely on, often missing in TS code:

| Category | When to require | Why consumers care |
|---|---|---|
| **Promise rejection** | `async` functions or `Promise<T>` returns that can reject | Without `.catch`, unhandled rejection. |
| **Async cancel-safety** | Functions accepting `AbortSignal` | Consumers need to know what state changes are atomic across abort. |
| **Mutation** | Functions that mutate inputs (rare in idiomatic TS but happens) | Caller may pass a shared reference. |
| **Ordering / determinism** | Iteration over Map/Set, JSON serialization, async resolution | Consumers may rely on stable order — say so or refute it. |
| **Side effects** | Filesystem writes, env mutation, global state, `console.*`, hooks | Consumers writing tests need to know. |
| **Time complexity** | When non-linear or surprising | `O(n²)` lookups are footguns. |
| **Type narrowing** | Functions that narrow union types via type guards (`v is X`) | Consumers compose these — clarity matters. |
| **Default values** | Optional config fields with non-trivial defaults | Surprising defaults cause silent bugs. |
| **Closed sets** | When a `string` parameter is actually a finite enum and TS hasn't expressed it | Document the legal values. |

## Item-kind checklist

### File-level header (first comment in a file)

Should answer **why this module exists** and **what role it plays in the package** — not list its contents (the exports do that). One short paragraph explaining the responsibility boundary, plus invariants that span the module.

Flag file headers that:
- List exported symbols (the export list does this).
- Recite the public API surface item-by-item.
- Describe the module's history.
- Reference internal lock identifiers (`G15`, `R9`, `K2`) — those go in `docs/internal/`, not user-facing source.

### Type / interface docs

Document the *concept* the type represents, not its field layout. The TypeScript type *is* the layout.

For discriminated unions: per-variant docs should explain when the variant is produced, not just what it holds. The discriminator field documents the structural shape; the variant doc explains the *meaning*.

For value-class branded types: document the invariant enforced at construction and what makes the type meaningful.

### Function docs

**Tier 1** (always, public exports): one-line summary in active voice, third person. "Returns…", "Builds…", "Asserts…".

**Tier 2** (when applicable): `@throws`, async-cancel-safety, side effects, complexity.

**Tier 3** (non-trivial APIs): `@example`.

Flag function docs that:
- Mirror the signature in prose ("Takes a `string` and returns a `Promise<Verdict>`").
- Reference the call site or caller.
- Document parameters that are self-explanatory from name + type.
- Use future tense ("will return" vs "returns").

### Const / enum docs

Document the *meaning*, not the value. `const TIMEOUT_MS = 5000;` doesn't need "5000 milliseconds". It needs *why* 5000 — the consumer cost of changing it.

### Inline comments (`//`)

Flag inline comments that:
- Restate the line of code (`i++ // increment i`).
- Explain a function's intent better than the function name does → rename the function instead.
- Document a workaround without linking the cause (issue, PR, ticket).
- Apologize for code (`// hack:`, `// not great but`) without pointing to the fix path.

Acceptable inline comments:
- Why a non-obvious choice was made (with the *why*, not the *what*).
- Reference to a spec section or RFC the line implements.
- Warning about a non-obvious side effect.
- Explanation of a deliberate violation of a local convention.

## Style rules

- **Active voice, third person.** "Returns the cached value", not "This function returns" or "Will return".
- **Present tense.** "Acquires the lock", not "Will acquire" / "Acquired".
- **No "simply", "just", "obviously".** Either the thing is obvious (delete the doc) or it isn't (these words mislead).
- **Backtick code identifiers.** `` `Verdict<T>` ``, `` `domovoi.classify` ``. Improves readability.
- **No emoji, no marketing.** Reference docs, not pitch.
- **No multi-paragraph docstrings on simple items.** One short line max for accessors and trivial helpers.
- **JSDoc `@param`/`@returns` only when adding non-trivial info.** Empty `@param x — the x` lines are clutter.
- **No internal lock IDs** (`G15`, `R9`, `S3`) in user-facing JSDoc. Those belong in `docs/internal/PLAN.md`.

## Output format

Number findings (`R1`, `R2`, ...). Each finding includes:

- **Severity**: `blocker` (misleading or wrong), `major` (incomplete in a way consumers will hit), `minor` (style or scope drift), `nit` (preference).
- **Location**: `path:line` of the comment, plus the item it documents.
- **Failure mode**: which of the three (obvious / leaky / incomplete) and which sub-rule.
- **Concrete suggested rewrite** — actual replacement text, not a directive. Match the surrounding house style.

End with a one-line verdict: `ship` / `ship-with-nits` / `fix-before-ship`.

Keep findings terse. A finding that takes more than 5 lines to explain is probably two findings.

## Anti-patterns to specifically watch for

1. **The "obvious wrapper" comment.** `/** Returns the inner value. */` on a getter named `inner()`.
2. **The "history scar".** `/** Renamed from `foo` in v0.3 because... */`. Belongs in CHANGELOG.
3. **The "internal cross-reference".** `/** See `engine/decide.ts` for details. */` — if important, restate; if not, drop.
4. **The "future plan".** `/** Will eventually support X. */`. Roadmaps belong in issues, not docs.
5. **The "fearful disclaimer".** `/** May or may not throw. */`. State which, or omit.
6. **The "tautological @throws".** `@throws Error if the operation fails.` Name the conditions and which class.
7. **The "private field exposure".** `/** The internal `state` field tracks... */` — readers can't see `state`.
8. **The "TODO disguised as doc".** `/** TODO: document this */` shipped to production.
9. **The "JSDoc on a non-public function" that reads like public API.** Either lift the item to public or convert `/** */` to `//`.
10. **The "version smell".** `/** In version 0.5 we changed this to... */`. The doc reflects the *current* contract.
11. **The "internal-lock-ID leak".** `/** Per G15, this returns Unknown { cancelled }. */` — in user-facing JSDoc; the lock IDs only mean something to project maintainers reading `docs/internal/PLAN.md`.
12. **The "ASCII art separator with no info".** `// ─── Section ───` adds value when the file is long *and* the sections aren't already obvious from the code grouping. Otherwise noise.

## Encapsulation litmus test

Before flagging or accepting a doc, ask: **if the implementation changes in a backwards-compatible way, does this doc still hold?**

- "Returns the calibrated probability of `value`" — survives a rewrite from temperature scaling to Platt scaling. ✓
- "Returns `temperatureScaling(0.85).apply(...)` of the raw probability" — breaks on the rewrite. ✗
- "Lookup is `O(1) expected`" — survives if we promise that performance class. ✓ (and consumers care)
- "Lookup uses a Map with insertion-order iteration" — implementation detail that rots. ✗

If the doc fails this test, it's leaky.

## Consumer-focus litmus test

Ask: **if a consumer skips this doc, what could go wrong?**

- Nothing → the doc is noise, delete or compress it.
- Wrong assumption about behavior → the doc is load-bearing, keep and possibly expand.
- Silent runtime error / data loss / unhandled rejection → the doc is critical, ensure it's prominent (`@throws`, async-cancel-safety note, side-effect call-out).

The point of a doc is to prevent a future bug. If it doesn't, it's clutter.

## Project-specific extensions for domovoi

When reviewing this codebase specifically, also enforce:

- **No internal lock IDs in JSDoc.** Strings like `(G15)`, `per S3`, `R9 says` are useful in `docs/internal/PLAN.md` but pollute user-facing source. Move them to `docs/internal/` or delete.
- **Brand voice stays in README + JSDoc on top-level entries.** `domovoi`, `Verdict<T>`, "household spirit" framing — fine on `domovoi.classify`, `Classifier<T, I>`, the union type. Keep technical/neutral on internal helpers (`computeCacheKey`, `applyThresholds`, etc.).
- **Architectural prose on internal modules is welcome** but should describe *what role this file plays* — not retell `PLAN.md`.
- **Prefer the public type over a comment.** If a comment says "must be in [0,1]," ask whether a branded `Probability` type or a runtime validator would express it better. Comments are fallback for what types can't say.
