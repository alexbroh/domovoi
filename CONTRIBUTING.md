# Contributing to domovoi

Thanks for considering a contribution. domovoi aims to stay a small, focused library — the bar for additions is high, but bug fixes, doc improvements, and adapter implementations are very welcome.

## Quick start

```bash
git clone https://github.com/alexbroh/domovoi.git
cd domovoi
npm install
npm test
npm run typecheck
npm run lint
```

## What domovoi accepts

- **Bug fixes** — always welcome.
- **New `Provider` adapters** for OpenAI-compatible runtimes that don't fit the existing `openai` / `ollama` / `openaiCompat` factories. Open an issue first to discuss capabilities + naming.
- **Custom `Calibrator` implementations** of well-established methods (isotonic, vector scaling, etc.) — open an issue first.
- **Documentation, examples, JSDoc improvements.**
- **Test coverage gaps.**

## What domovoi does NOT accept

The library has a [locked design philosophy](docs/internal/PLAN.md): small core + clear extension points. Contributions that expand the public API surface require justification:

- New combinators on `Verdict` — most can be written in userspace; the library ships the minimum.
- Sugar variants of existing factories — collapse to the primitive.
- Dependencies — domovoi is dependency-light by design. New deps need strong justification.
- Features that compete with the public extension interfaces (`Provider`, `Calibrator`, `Cache`) — implement against the interface in your own package instead.

If unsure, open an issue before writing the code.

## Developer Certificate of Origin (DCO)

By contributing, you certify your contribution under the [Developer Certificate of Origin v1.1](https://developercertificate.org/). Practically, this means signing each commit with `-s`:

```bash
git commit -s -m "fix: handle empty distribution from provider"
```

The `-s` flag adds a `Signed-off-by: Your Name <your-email>` trailer to the commit message, attesting to the DCO. CI checks for the signoff.

If you forget to sign off, amend with:

```bash
git commit --amend --no-edit -s
git push --force-with-lease
```

## Pull request expectations

1. **One change per PR.** Don't bundle unrelated fixes.
2. **Include tests** for behavior changes. Bug fixes need a regression test that fails without the fix.
3. **Update docs** if user-visible behavior changes (README, JSDoc, or `docs/`).
4. **CI must pass** — lint, typecheck, tests.
5. **Conventional commit messages.** `fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `chore:`. Subject line under ~70 chars.

## Project structure

See [docs/internal/PLAN.md](docs/internal/PLAN.md) for the full architecture and locked design decisions. Key directories:

- `src/` — library source.
- `src/providers/` — Provider adapters (OpenAI, Ollama, openaiCompat).
- `src/calibration/` — Calibrator factories.
- `src/testing/` — `mockProvider` for users' tests.
- `tests/` — unit + integration + type-level tests.
- `examples/` — runnable usage examples.

## Code style

domovoi uses [Biome](https://biomejs.dev/) for lint + format. Run `npm run check:fix` before committing. CI runs `npm run check`.

TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: NodeNext`.

## Reporting bugs

Open a GitHub issue with:
- domovoi version, Node version, OS.
- Minimal reproduction (ideally a runnable code snippet).
- Expected vs actual behavior.
- Provider used (and whether it's a custom `Provider` impl).

## Security issues

Do **not** open public issues for security vulnerabilities. Use GitHub's [private vulnerability reporting](https://github.com/alexbroh/domovoi/security/advisories/new) (Security tab → "Report a vulnerability") to send a private report. We'll respond within a few business days.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to abide by its terms.
