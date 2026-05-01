import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProvidersEnv, resolveDefaultProviders, resolveProvidersFromEnv } from "../src/env.js";
import { ConfigError } from "../src/errors.js";

describe("parseProvidersEnv", () => {
  it("returns [] for undefined", () => {
    expect(parseProvidersEnv(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseProvidersEnv("")).toEqual([]);
  });

  it("returns [] for whitespace-only string (M2)", () => {
    expect(parseProvidersEnv("   ")).toEqual([]);
  });

  it("parses single entry", () => {
    expect(parseProvidersEnv("openai/gpt-4o-mini")).toEqual([
      { factory: "openai", model: "gpt-4o-mini" },
    ]);
  });

  it("parses multiple entries", () => {
    expect(parseProvidersEnv("openai/gpt-4o-mini,openai/gpt-4o,ollama/llama-3.1-70b")).toEqual([
      { factory: "openai", model: "gpt-4o-mini" },
      { factory: "openai", model: "gpt-4o" },
      { factory: "ollama", model: "llama-3.1-70b" },
    ]);
  });

  it("trims whitespace around entries", () => {
    expect(parseProvidersEnv("  openai/gpt-4o ,  ollama/llama  ")).toEqual([
      { factory: "openai", model: "gpt-4o" },
      { factory: "ollama", model: "llama" },
    ]);
  });

  it("skips empty entries between commas", () => {
    expect(parseProvidersEnv("openai/gpt-4o-mini,,ollama/llama")).toEqual([
      { factory: "openai", model: "gpt-4o-mini" },
      { factory: "ollama", model: "llama" },
    ]);
  });

  it("supports models with embedded slashes (openrouter-style)", () => {
    expect(parseProvidersEnv("openrouter/meta-llama/llama-3.1-70b")).toEqual([
      { factory: "openrouter", model: "meta-llama/llama-3.1-70b" },
    ]);
  });

  it("rejects entries without a slash", () => {
    expect(() => parseProvidersEnv("malformed")).toThrowError(/factory\/model/);
  });

  it("rejects entries with empty factory or model", () => {
    expect(() => parseProvidersEnv("/model")).toThrowError(/empty/);
    expect(() => parseProvidersEnv("factory/")).toThrowError(/empty/);
  });
});

describe("resolveProvidersFromEnv", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws missing_provider_config for unset/empty", () => {
    try {
      resolveProvidersFromEnv("");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("missing_provider_config");
    }
  });

  it("throws unknown_provider_factory for unrecognized factory", () => {
    try {
      resolveProvidersFromEnv("nonexistent_factory/model-x");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("unknown_provider_factory");
    }
  });

  it("resolves known factories", () => {
    const providers = resolveProvidersFromEnv("openai/gpt-4o-mini,ollama/llama");
    expect(providers).toHaveLength(2);
    expect(providers[0]?.id).toBe("openai/gpt-4o-mini");
    expect(providers[1]?.id).toBe("ollama/llama");
  });
});

describe("resolveDefaultProviders (per-classifier env override)", () => {
  beforeEach(() => {
    vi.stubEnv("DOMOVOI_PROVIDERS", "");
    vi.stubEnv("DOMOVOI_PROVIDERS_ARTICLES", "");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses DOMOVOI_PROVIDERS_<NAME> when set", () => {
    vi.stubEnv("DOMOVOI_PROVIDERS_ARTICLES", "openai/gpt-4o-mini");
    vi.stubEnv("DOMOVOI_PROVIDERS", "openai/gpt-4o");
    const providers = resolveDefaultProviders("articles");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("openai/gpt-4o-mini");
  });

  it("falls back to DOMOVOI_PROVIDERS when named is unset", () => {
    vi.stubEnv("DOMOVOI_PROVIDERS", "openai/gpt-4o");
    const providers = resolveDefaultProviders("articles");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("openai/gpt-4o");
  });

  it("throws missing_provider_config when neither is set", () => {
    try {
      resolveDefaultProviders("articles");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("missing_provider_config");
    }
  });
});
