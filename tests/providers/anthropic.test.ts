/**
 * Tests for the Anthropic multi-sample adapter.
 *
 * Uses Vitest's `vi.mock` to replace the Anthropic SDK with a controllable
 * mock, letting us assert on the request shape (system prompt, temperature,
 * sample fan-out) and synthesize verbalized-confidence replies. The
 * aggregation math is covered directly through the pure functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock so the SDK constructor is replaced before anthropic() is imported.
const createMock = vi.hoisted(() => vi.fn());

const anthropicCtorArgs = vi.hoisted(() => ({ last: undefined as unknown }));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createMock };
    constructor(options: unknown) {
      anthropicCtorArgs.last = options;
    }
  }
  return { default: MockAnthropic, Anthropic: MockAnthropic };
});

import { ConfigError, ProviderError } from "../../src/errors.js";
import { defaultTemplate } from "../../src/prompt.js";
import {
  aggregateVerbalizedSamples,
  parseVerbalizedReply,
} from "../../src/providers/anthropic/aggregate.js";
import { anthropic, DEFAULT_ANTHROPIC_MODEL } from "../../src/providers/anthropic/index.js";

const SAMPLE_OPTS = {
  template: defaultTemplate,
  temperature: undefined,
  timeoutMs: 5000,
};

const SPACE = ["positive", "negative", "neutral"] as const;

function textReply(label: string, confidence: number): Record<string, unknown> {
  return {
    content: [{ type: "text", text: `{"label": "${label}", "confidence": ${confidence}}` }],
    usage: { input_tokens: 40, output_tokens: 12 },
  };
}

describe("parseVerbalizedReply", () => {
  it("parses a bare JSON reply", () => {
    expect(parseVerbalizedReply('{"label": "positive", "confidence": 92}')).toEqual({
      label: "positive",
      confidence: 92,
    });
  });

  it("parses JSON embedded after a preamble", () => {
    expect(parseVerbalizedReply('Sure: {"label": "neutral", "confidence": 60}')).toEqual({
      label: "neutral",
      confidence: 60,
    });
  });

  it.each([
    ["no JSON at all", "the sentiment is positive"],
    ["malformed JSON", '{"label": positive}'],
    ["non-string label", '{"label": 3, "confidence": 90}'],
    ["confidence out of range", '{"label": "positive", "confidence": 140}'],
    ["confidence not numeric", '{"label": "positive", "confidence": "high"}'],
  ])("returns null for %s", (_name, reply) => {
    expect(parseVerbalizedReply(reply)).toBeNull();
  });
});

describe("aggregateVerbalizedSamples", () => {
  it("preserves verbalized confidence at k=1 instead of collapsing to 1.0", () => {
    const distribution = aggregateVerbalizedSamples(SPACE, [{ label: "positive", confidence: 70 }]);
    expect(distribution.probs.positive).toBeCloseTo(0.7);
    expect(distribution.probs.negative).toBeCloseTo(0.15);
    expect(distribution.probs.neutral).toBeCloseTo(0.15);
    expect(distribution.coverage).toBe(1);
  });

  it("pulls the top probability down on sample disagreement", () => {
    const distribution = aggregateVerbalizedSamples(SPACE, [
      { label: "positive", confidence: 90 },
      { label: "positive", confidence: 90 },
      { label: "neutral", confidence: 90 },
    ]);
    // 2-of-3 split at confidence 90 lands near 0.62 — below the
    // recommended high threshold of 0.75, above the default 0.5.
    expect(distribution.probs.positive).toBeCloseTo((0.9 + 0.9 + 0.05) / 3, 5);
    expect(distribution.probs.positive).toBeLessThan(0.75);
    expect(distribution.coverage).toBe(1);
  });

  it("counts unparseable and out-of-space samples against coverage only", () => {
    const distribution = aggregateVerbalizedSamples(SPACE, [
      { label: "positive", confidence: 90 },
      null,
      { label: "sarcastic", confidence: 80 },
    ]);
    expect(distribution.coverage).toBeCloseTo(1 / 3);
    // The single in-space sample fully determines probs.
    expect(distribution.probs.positive).toBeCloseTo(0.9);
  });

  it("yields uniform probs and zero coverage with no in-space samples", () => {
    const distribution = aggregateVerbalizedSamples(SPACE, [null, null]);
    expect(distribution.probs.positive).toBeCloseTo(1 / 3);
    expect(distribution.coverage).toBe(0);
  });

  it("resolves exact-case replies to their own label in case-variant spaces", () => {
    const caseVariantSpace = ["Billing", "billing"] as const;
    const distribution = aggregateVerbalizedSamples(caseVariantSpace, [
      { label: "Billing", confidence: 90 },
      { label: "Billing", confidence: 95 },
      { label: "billing", confidence: 80 },
    ]);
    // Exact matches must not be re-routed by the case-insensitive fallback.
    expect(distribution.probs.Billing).toBeGreaterThan(distribution.probs.billing);
  });

  it("matches labels case-insensitively without widening the space", () => {
    const distribution = aggregateVerbalizedSamples(SPACE, [{ label: "Positive", confidence: 80 }]);
    expect(distribution.probs.positive).toBeCloseTo(0.8);
    expect(distribution.coverage).toBe(1);
  });

  it("spreads the remainder onto the single other label in binary spaces", () => {
    const distribution = aggregateVerbalizedSamples(["spam", "legitimate"] as const, [
      { label: "spam", confidence: 95 },
    ]);
    expect(distribution.probs.spam).toBeCloseTo(0.95);
    expect(distribution.probs.legitimate).toBeCloseTo(0.05);
  });
});

describe("anthropic adapter", () => {
  beforeEach(() => {
    createMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fans out K requests and aggregates the replies", async () => {
    createMock
      .mockResolvedValueOnce(textReply("positive", 95))
      .mockResolvedValueOnce(textReply("positive", 90))
      .mockResolvedValueOnce(textReply("neutral", 60));

    const provider = anthropic();
    const { distribution, usage } = await provider.sample("great product", SPACE, SAMPLE_OPTS);

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(distribution.coverage).toBe(1);
    expect(distribution.probs.positive).toBeGreaterThan(distribution.probs.neutral);
    // Usage sums across the three samples.
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 36 });
  });

  it("reports no usage when any sample response lacks a usage block", async () => {
    createMock
      .mockResolvedValueOnce(textReply("positive", 95))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"label": "positive", "confidence": 90}' }],
      })
      .mockResolvedValueOnce(textReply("positive", 92));
    const { usage } = await anthropic().sample("input", SPACE, SAMPLE_OPTS);
    expect(usage).toBeUndefined();
  });

  it("defaults to temperature 1 and honors an explicit temperature", async () => {
    createMock.mockResolvedValue(textReply("positive", 90));
    const provider = anthropic();

    await provider.sample("input", SPACE, SAMPLE_OPTS);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ temperature: 1 });

    createMock.mockClear();
    await provider.sample("input", SPACE, { ...SAMPLE_OPTS, temperature: 0.4 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ temperature: 0.4 });
  });

  it("appends the verbalized-confidence instruction to the system prompt", async () => {
    createMock.mockResolvedValue(textReply("positive", 90));
    await anthropic().sample("input", SPACE, SAMPLE_OPTS);

    const request = createMock.mock.calls[0]?.[0] as { system: string };
    expect(request.system).toContain('"confidence": <integer 0-100>');
    expect(request.system).toContain('"positive"');
  });

  it("constructs the SDK client with its internal retries disabled", () => {
    anthropic(DEFAULT_ANTHROPIC_MODEL, { apiKey: "test" });
    expect(anthropicCtorArgs.last).toMatchObject({ maxRetries: 0 });
  });

  it("uses the default model and exposes samples in configHash", () => {
    const provider = anthropic();
    expect(provider.modelId).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(provider.id).toBe(`anthropic/${DEFAULT_ANTHROPIC_MODEL}`);
    expect(provider.configHash).toBe("samples=3");
    expect(provider.capabilities).toEqual({
      distributionSource: "multi_sample",
      coverageMeasurement: "approximate",
      maxTopLogprobs: 0,
    });
  });

  it("respects the samples option", async () => {
    createMock.mockResolvedValue(textReply("positive", 90));
    const provider = anthropic(DEFAULT_ANTHROPIC_MODEL, { samples: 1 });
    await provider.sample("input", SPACE, SAMPLE_OPTS);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(provider.configHash).toBe("samples=1");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects samples=%s at construction", (samples) => {
    expect(() => anthropic(DEFAULT_ANTHROPIC_MODEL, { samples })).toThrow(ConfigError);
  });

  it("aggregates the survivors when one of K samples fails, penalizing coverage", async () => {
    createMock
      .mockResolvedValueOnce(textReply("positive", 95))
      .mockRejectedValueOnce(new Error("transient 500"))
      .mockResolvedValueOnce(textReply("positive", 90));

    const { distribution, usage } = await anthropic().sample("input", SPACE, SAMPLE_OPTS);
    // The failed sample counts against coverage like an unparseable reply.
    expect(distribution.coverage).toBeCloseTo(2 / 3);
    expect(distribution.probs.positive).toBeGreaterThan(0.8);
    // Usage sums the two billed survivors only.
    expect(usage).toEqual({ inputTokens: 80, outputTokens: 24 });
  });

  it("retries a transiently failing sample individually before counting it failed", async () => {
    vi.useFakeTimers();
    try {
      createMock
        .mockResolvedValueOnce(textReply("positive", 95))
        .mockRejectedValueOnce(Object.assign(new Error("hiccup"), { status: 500 }))
        .mockResolvedValueOnce(textReply("positive", 90))
        .mockResolvedValueOnce(textReply("positive", 92)); // the retry of sample 2

      const provider = anthropic(DEFAULT_ANTHROPIC_MODEL, { retries: { maxAttempts: 2 } });
      const pending = provider.sample("input", SPACE, SAMPLE_OPTS);
      await vi.runAllTimersAsync();
      const { distribution } = await pending;
      // All three samples land in-space: the failed one recovered on retry.
      expect(distribution.coverage).toBe(1);
      expect(createMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("canonicalizes SDK errors into ProviderError when every sample fails", async () => {
    createMock.mockRejectedValue(new Error("connection reset"));
    await expect(anthropic().sample("input", SPACE, SAMPLE_OPTS)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("surfaces a typed error when the reply has no text block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "tool_use" }] });
    await expect(
      anthropic(DEFAULT_ANTHROPIC_MODEL, { samples: 1 }).sample("input", SPACE, SAMPLE_OPTS),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
  });
});
