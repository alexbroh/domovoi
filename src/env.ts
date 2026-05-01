/**
 * Environment-driven provider chain resolution.
 *
 * Locked env contract (#5):
 *   DOMOVOI_PROVIDERS=openai/gpt-4o-mini,openai/gpt-4o,ollama/llama-3.1-70b
 *   DOMOVOI_PROVIDERS_ARTICLES=...   (per-classifier override; classifier with name: "articles")
 *
 * Format: factory/model[,factory/model...]. First `/` separates factory from
 * model; remaining slashes are part of the model name (e.g.,
 * `openrouter/meta-llama/llama-3.1-70b`). Whitespace trimmed; empty entries
 * skipped; empty/all-whitespace env value treated as unset (M2).
 *
 * Per-provider parametric config (multiSampleN, custom timeouts) is NOT
 * expressible in env — users with such needs drop to in-code `providers: [...]`.
 */

import { ConfigError } from "./errors.js";
import { ollama, openai } from "./providers/openai-chat.js";
import type { Provider } from "./providers/provider.js";

// ─── Factory registry ───────────────────────────────────────────────

type FactoryFn = (model: string) => Provider;

/**
 * Built-in factory registry. New factories can be added in two ways:
 *   - Library version: edit this object.
 *   - Userspace: pass explicit `providers: [...]` instead of env.
 *
 * `openaiCompat` is intentionally not env-resolvable: it requires a baseURL
 * which is not expressible in the env format.
 */
const BUILTIN_FACTORIES: Record<string, FactoryFn> = {
  openai: (model: string) => openai(model),
  ollama: (model: string) => ollama(model),
};

// ─── Parser ─────────────────────────────────────────────────────────

type ParsedEntry = {
  readonly factory: string;
  readonly model: string;
};

/**
 * Parse a DOMOVOI_PROVIDERS-style value into typed entries. Throws ConfigError
 * with `code: "malformed_provider_config"` on parse failure.
 *
 * Returns an empty array for empty/whitespace-only input (engine treats this
 * as unset → MissingProviderConfigError per M2).
 */
export function parseProvidersEnv(raw: string | undefined): ReadonlyArray<ParsedEntry> {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const entries: ParsedEntry[] = [];
  const parts = trimmed.split(",");
  for (const part of parts) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const slash = entry.indexOf("/");
    if (slash < 0) {
      throw new ConfigError(
        `DOMOVOI_PROVIDERS: malformed entry ${JSON.stringify(entry)}; expected factory/model format.`,
        { code: "malformed_provider_config" },
      );
    }
    const factory = entry.slice(0, slash).trim();
    const model = entry.slice(slash + 1).trim();
    if (factory.length === 0 || model.length === 0) {
      throw new ConfigError(
        `DOMOVOI_PROVIDERS: malformed entry ${JSON.stringify(entry)}; factory or model is empty.`,
        { code: "malformed_provider_config" },
      );
    }
    entries.push({ factory, model });
  }
  return entries;
}

// ─── Resolve env to Providers ───────────────────────────────────────

/**
 * Resolve a DOMOVOI_PROVIDERS-style env value into actual Provider instances.
 *
 * Throws ConfigError on:
 *   - Unset / empty env value with no fallback ("missing_provider_config", M2)
 *   - Malformed entry shape ("malformed_provider_config")
 *   - Unknown factory ("unknown_provider_factory")
 *   - (Credential checks deferred to actual provider call; the SDK validates.)
 */
export function resolveProvidersFromEnv(raw: string | undefined): ReadonlyArray<Provider> {
  const entries = parseProvidersEnv(raw);
  if (entries.length === 0) {
    throw new ConfigError(
      "Cannot resolve provider chain: DOMOVOI_PROVIDERS is unset or empty. " +
        "Set the env variable or pass `providers` explicitly.",
      { code: "missing_provider_config" },
    );
  }
  const out: Provider[] = [];
  for (const entry of entries) {
    const factory = BUILTIN_FACTORIES[entry.factory];
    if (factory === undefined) {
      throw new ConfigError(
        `DOMOVOI_PROVIDERS: unknown factory ${JSON.stringify(entry.factory)}. Known: ${Object.keys(BUILTIN_FACTORIES).join(", ")}. For other providers, supply { providers } explicitly in code.`,
        { code: "unknown_provider_factory" },
      );
    }
    out.push(factory(entry.model));
  }
  return out;
}

// ─── Per-classifier resolution ──────────────────────────────────────

/**
 * Resolve the env-driven chain for a classifier with optional `name`.
 *
 * Lookup order:
 *   1. If `name` is provided: try `DOMOVOI_PROVIDERS_<NAME>` (uppercased).
 *   2. Fall back to `DOMOVOI_PROVIDERS`.
 *   3. If both unset/empty → ConfigError("missing_provider_config").
 *
 * Engine reads env once on first call (G12); subsequent env mutations don't
 * propagate. Tests should stub env before any domovoi call or use explicit
 * `{ providers }` per call.
 */
export function resolveDefaultProviders(name?: string): ReadonlyArray<Provider> {
  if (name !== undefined) {
    const namedKey = `DOMOVOI_PROVIDERS_${name.toUpperCase()}`;
    const namedRaw = process.env[namedKey];
    if (namedRaw !== undefined && namedRaw.trim().length > 0) {
      return resolveProvidersFromEnv(namedRaw);
    }
  }
  return resolveProvidersFromEnv(process.env.DOMOVOI_PROVIDERS);
}
