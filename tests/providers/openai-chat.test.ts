/**
 * Tests for the OpenAI Chat adapter.
 *
 * Uses Vitest's `vi.mock` to replace the OpenAI SDK with a controllable mock,
 * letting us assert on the request shape (logit_bias, messages, temperature,
 * top_logprobs) and synthesize representative logprob responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock so the SDK constructor is replaced before openai() is imported.
const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: createMock } };
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

import { ConfigError } from "../../src/errors.js";
import { defaultTemplate } from "../../src/prompt.js";
import { ollama, openai, openaiCompat } from "../../src/providers/openai-chat.js";

const SAMPLE_OPTS = {
  template: defaultTemplate,
  temperature: 0,
  timeoutMs: 5000,
};

function logprobResponse(
  topLogprobs: Array<{ token: string; logprob: number }>,
): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: topLogprobs[0]?.token ?? "" },
        finish_reason: "stop",
        logprobs: {
          content: [
            {
              token: topLogprobs[0]?.token ?? "",
              logprob: topLogprobs[0]?.logprob ?? 0,
              bytes: null,
              top_logprobs: topLogprobs.map((tl) => ({ ...tl, bytes: null })),
            },
          ],
        },
      },
    ],
  };
}

describe("openai adapter (cl100k tokenizer-aware)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Provider with logprobs capabilities + cl100k tokenizer id", () => {
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    expect(provider.id).toBe("openai/gpt-4o-mini");
    expect(provider.modelId).toBe("gpt-4o-mini");
    expect(provider.tokenizerId).toBe("openai/cl100k_base");
    expect(provider.capabilities.distributionSource).toBe("logprobs");
    expect(provider.capabilities.coverageMeasurement).toBe("exact");
    expect(provider.capabilities.maxTopLogprobs).toBe(20);
  });

  it("sends logit_bias with +100 on each in-space first-token id", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " yes", logprob: -0.1 },
        { token: " no", logprob: -2.3 },
        { token: " maybe", logprob: -3.5 },
      ]),
    );
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    await provider.sample("Is the sky blue?", ["yes", "no"], SAMPLE_OPTS);
    expect(createMock).toHaveBeenCalledOnce();
    const params = createMock.mock.calls[0]?.[0];
    expect(params).toBeDefined();
    expect(params.logit_bias).toBeDefined();
    expect(Object.values(params.logit_bias)).toEqual([100, 100]);
    expect(params.temperature).toBe(0);
    expect(params.logprobs).toBe(true);
    expect(params.top_logprobs).toBeGreaterThanOrEqual(4);
  });

  it("forwards signal to the SDK", async () => {
    createMock.mockResolvedValue(logprobResponse([{ token: " yes", logprob: -0.1 }]));
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    const ctrl = new AbortController();
    await provider.sample("hi", ["yes", "no"], { ...SAMPLE_OPTS, signal: ctrl.signal });
    const requestOpts = createMock.mock.calls[0]?.[1];
    expect(requestOpts.signal).toBe(ctrl.signal);
    expect(requestOpts.timeout).toBe(SAMPLE_OPTS.timeoutMs);
  });

  it("constructs a Distribution from top-K logprobs (tokenizer-id matching)", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " yes", logprob: Math.log(0.7) },
        { token: " no", logprob: Math.log(0.2) },
        { token: " maybe", logprob: Math.log(0.05) },
      ]),
    );
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    const dist = await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    // In-space mass = 0.7 + 0.2 = 0.9; renormalized: yes=0.78, no=0.22
    expect(dist.coverage).toBeCloseTo(0.9, 6);
    expect(dist.probs.yes).toBeCloseTo(0.7 / 0.9, 6);
    expect(dist.probs.no).toBeCloseTo(0.2 / 0.9, 6);
  });

  it("returns coverage near 0 when no in-space tokens are in top-K", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " maybe", logprob: -0.5 },
        { token: " perhaps", logprob: -1.0 },
      ]),
    );
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    const dist = await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    expect(dist.coverage).toBe(0);
    expect(dist.probs.yes).toBe(0);
    expect(dist.probs.no).toBe(0);
  });

  it("throws ConfigError on first-token collision (decision_space_collision) — eagerly via validate(space)", () => {
    // 'yes' and 'yes2' both encode to the same first token in cl100k_base
    // (the leading-space-prefixed " yes" token). The eager validate hook
    // should detect this without ever calling sample().
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    expect(provider.validate).toBeDefined();
    try {
      provider.validate?.(["yes", "yes2"]);
      expect.fail("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("decision_space_collision");
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("validate(space) is a no-op for collision-free spaces", () => {
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    expect(() => provider.validate?.(["yes", "no"])).not.toThrow();
    expect(() => provider.validate?.(["news", "sports", "music"])).not.toThrow();
  });

  it("sample() also catches collisions (defense-in-depth)", async () => {
    createMock.mockResolvedValue(logprobResponse([{ token: " yes", logprob: 0 }]));
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    try {
      await provider.sample("input", ["yes", "yes2"], SAMPLE_OPTS);
      expect.fail("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("decision_space_collision");
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws ProviderError on malformed response (no choices)", async () => {
    createMock.mockResolvedValue({ choices: [] });
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    await expect(provider.sample("input", ["yes", "no"], SAMPLE_OPTS)).rejects.toThrow(
      /OpenAI response had no choices/,
    );
  });

  it("throws ProviderError on missing logprobs", async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: " yes" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    });
    const provider = openai("gpt-4o-mini", { apiKey: "sk-test" });
    await expect(provider.sample("input", ["yes", "no"], SAMPLE_OPTS)).rejects.toThrow(
      /missing first-token logprobs/,
    );
  });
});

describe("ollama adapter (string-based fallback)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns a Provider with id 'ollama/<model>' and no logit_bias on requests", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " yes", logprob: Math.log(0.6) },
        { token: " no", logprob: Math.log(0.4) },
      ]),
    );
    const provider = ollama("llama-3.1-70b");
    expect(provider.id).toBe("ollama/llama-3.1-70b");
    await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    const params = createMock.mock.calls[0]?.[0];
    expect(params.logit_bias).toBeUndefined();
  });

  it("constructs a Distribution via string-prefix matching", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " yes", logprob: Math.log(0.6) },
        { token: " no", logprob: Math.log(0.4) },
      ]),
    );
    const provider = ollama("llama-3.1-70b");
    const dist = await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    expect(dist.coverage).toBeCloseTo(1.0, 6);
    expect(dist.probs.yes).toBeCloseTo(0.6, 6);
    expect(dist.probs.no).toBeCloseTo(0.4, 6);
  });
});

describe("openaiCompat adapter", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("requires baseURL", () => {
    const provider = openaiCompat("model-x", {
      baseURL: "https://example.com/v1",
      apiKey: "k",
    });
    expect(provider.id).toBe("example.com/model-x");
  });

  it("respects providerId override", () => {
    const provider = openaiCompat("model-x", {
      baseURL: "https://example.com/v1",
      apiKey: "k",
      providerId: "fireworks/llama",
    });
    expect(provider.id).toBe("fireworks/llama");
  });

  it("opt-in to cl100k tokenizer enables logit_bias on requests", async () => {
    createMock.mockResolvedValue(
      logprobResponse([
        { token: " yes", logprob: Math.log(0.6) },
        { token: " no", logprob: Math.log(0.4) },
      ]),
    );
    const provider = openaiCompat("model-x", {
      baseURL: "https://example.com/v1",
      apiKey: "k",
      useCl100kTokenizer: true,
    });
    await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    const params = createMock.mock.calls[0]?.[0];
    expect(params.logit_bias).toBeDefined();
    expect(Object.values(params.logit_bias)).toEqual([100, 100]);
  });

  it("default (no tokenizer) does NOT send logit_bias", async () => {
    createMock.mockResolvedValue(logprobResponse([{ token: " yes", logprob: 0 }]));
    const provider = openaiCompat("model-x", {
      baseURL: "https://example.com/v1",
      apiKey: "k",
    });
    await provider.sample("input", ["yes", "no"], SAMPLE_OPTS);
    const params = createMock.mock.calls[0]?.[0];
    expect(params.logit_bias).toBeUndefined();
  });
});
