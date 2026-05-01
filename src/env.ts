/**
 * Environment-driven provider chain resolution.
 *
 *   DOMOVOI_PROVIDERS=openai/gpt-4o-mini,openai/gpt-4o,ollama/llama-3.1-70b
 *   DOMOVOI_PROVIDERS_ARTICLES=...   (override for `classifier({ name: "articles" })`)
 *
 * Format: `factory/model[,factory/model…]`. The first `/` separates factory
 * from model; later slashes belong to the model name (e.g.
 * `openrouter/meta-llama/llama-3.1-70b`). Whitespace is trimmed; empty
 * entries are skipped; an empty / whitespace-only value counts as unset.
 *
 * Per-provider parametric options (`multiSampleN`, custom timeouts) cannot
 * be expressed in env — drop to an explicit `providers: [...]` array for
 * those.
 */

import { ConfigError } from "./errors.js";
import { ollama, openai } from "./providers/openai/index.js";
import type { Provider } from "./providers/provider.js";

type FactoryFn = (model: string) => Provider;

/**
 * Env-resolvable factories. `openaiCompat` is omitted — it requires a
 * `baseURL` which is not expressible in the env format; callers needing
 * OpenAI-compat backends pass `providers: [...]` explicitly.
 */
const BUILTIN_FACTORIES: Record<string, FactoryFn> = {
  openai: (model: string) => openai(model),
  ollama: (model: string) => ollama(model),
};

type ParsedEntry = {
  readonly factory: string;
  readonly model: string;
};

/**
 * Parses a DOMOVOI_PROVIDERS-style string into typed entries. Throws
 * `ConfigError` with `code: "malformed_provider_config"` on a bad entry.
 * Returns `[]` for empty / whitespace-only input — callers treat that as unset.
 */
export function parseProvidersEnv(raw: string | undefined): readonly ParsedEntry[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseProviderEntry);
}

function parseProviderEntry(entry: string): ParsedEntry {
  const slashIndex = entry.indexOf("/");
  if (slashIndex < 0) {
    throw new ConfigError(
      `DOMOVOI_PROVIDERS: malformed entry ${JSON.stringify(entry)}; expected factory/model format.`,
      { code: "malformed_provider_config" },
    );
  }
  const factory = entry.slice(0, slashIndex).trim();
  const model = entry.slice(slashIndex + 1).trim();
  if (!factory || !model) {
    throw new ConfigError(
      `DOMOVOI_PROVIDERS: malformed entry ${JSON.stringify(entry)}; factory or model is empty.`,
      { code: "malformed_provider_config" },
    );
  }
  return { factory, model };
}

/**
 * Resolves a DOMOVOI_PROVIDERS-style env value into Provider instances.
 *
 * Throws `ConfigError` with `code` ∈ { `missing_provider_config`,
 * `malformed_provider_config`, `unknown_provider_factory` }. Credential
 * presence is not checked here — the underlying SDK surfaces that on first
 * call.
 */
export function resolveProvidersFromEnv(raw: string | undefined): readonly Provider[] {
  const entries = parseProvidersEnv(raw);
  if (entries.length === 0) {
    throw new ConfigError(
      "Cannot resolve provider chain: DOMOVOI_PROVIDERS is unset or empty. " +
        "Set the env variable or pass `providers` explicitly.",
      { code: "missing_provider_config" },
    );
  }
  return entries.map((entry) => {
    const factory = BUILTIN_FACTORIES[entry.factory];
    if (factory === undefined) {
      throw new ConfigError(
        `DOMOVOI_PROVIDERS: unknown factory ${JSON.stringify(entry.factory)}. Known: ${Object.keys(BUILTIN_FACTORIES).join(", ")}. For other providers, supply { providers } explicitly in code.`,
        { code: "unknown_provider_factory" },
      );
    }
    return factory(entry.model);
  });
}

/**
 * Resolves the chain for a classifier with optional `name`. Tries
 * `DOMOVOI_PROVIDERS_<NAME>` first (uppercased), then `DOMOVOI_PROVIDERS`.
 * Throws `ConfigError({ code: "missing_provider_config" })` if both are unset.
 *
 * Tests must stub env *before* the first domovoi call — env is read lazily,
 * but only once per classifier resolution.
 */
export function resolveDefaultProviders(name?: string): readonly Provider[] {
  if (name !== undefined) {
    const namedKey = `DOMOVOI_PROVIDERS_${name.toUpperCase()}`;
    const namedRaw = process.env[namedKey];
    if (namedRaw?.trim()) {
      return resolveProvidersFromEnv(namedRaw);
    }
  }
  return resolveProvidersFromEnv(process.env.DOMOVOI_PROVIDERS);
}
