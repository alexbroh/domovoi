/**
 * Cost observability: reported usage flowing into `Verdict.meta.cost`,
 * USD computation from provider pricing, and the cache-hit / partial-pricing
 * omission rules.
 */

import { describe, expect, it } from "vitest";
import { domovoi } from "../src/index.js";
import { mockProvider } from "../src/testing/index.js";

const SPACE = ["a", "b", "c"] as const;
const STRONG = { probs: { a: 0.9, b: 0.05, c: 0.05 }, coverage: 1 };
const WEAK = { probs: { a: 0.55, b: 0.35, c: 0.1 }, coverage: 1 };

function classifierWith(providers: Parameters<typeof domovoi.classifier>[0]["providers"]) {
  return domovoi.classifier({
    name: "cost_test",
    space: SPACE,
    thresholds: { high: 0.7, coverageMin: 0.5 },
    providers,
  });
}

describe("Verdict.meta.cost", () => {
  it("carries reported usage and USD when the provider has pricing", async () => {
    const verdict = await classifierWith([
      mockProvider({
        behavior: () => STRONG,
        usage: { inputTokens: 1000, outputTokens: 200 },
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
      }),
    ])("input-a");

    expect(verdict.meta.cost).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      usd: (1000 * 1 + 200 * 5) / 1e6,
    });
  });

  it("omits usd when pricing is absent but still reports tokens", async () => {
    const verdict = await classifierWith([
      mockProvider({ behavior: () => STRONG, usage: { inputTokens: 500, outputTokens: 50 } }),
    ])("input-b");

    expect(verdict.meta.cost).toEqual({ inputTokens: 500, outputTokens: 50 });
  });

  it("is absent entirely when no usage was reported", async () => {
    const verdict = await classifierWith([mockProvider({ behavior: () => STRONG })])("input-c");
    expect(verdict.meta.cost).toBeUndefined();
  });

  it("sums across escalation — the uncertain first provider still cost money", async () => {
    const verdict = await classifierWith([
      mockProvider({
        id: "mock/weak",
        behavior: () => WEAK,
        usage: { inputTokens: 100, outputTokens: 10 },
        pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      }),
      mockProvider({
        id: "mock/strong",
        behavior: () => STRONG,
        usage: { inputTokens: 300, outputTokens: 30 },
        pricing: { inputPerMTok: 10, outputPerMTok: 10 },
      }),
    ])("input-d");

    expect(verdict.kind).toBe("classified");
    expect(verdict.meta.providerUsed).toBe("mock/strong");
    expect(verdict.meta.cost).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      usd: (100 * 1 + 10 * 1) / 1e6 + (300 * 10 + 30 * 10) / 1e6,
    });
  });

  it("omits usd when any usage-reporting provider lacks pricing", async () => {
    const verdict = await classifierWith([
      mockProvider({
        id: "mock/unpriced",
        behavior: () => WEAK,
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      mockProvider({
        id: "mock/priced",
        behavior: () => STRONG,
        usage: { inputTokens: 300, outputTokens: 30 },
        pricing: { inputPerMTok: 10, outputPerMTok: 10 },
      }),
    ])("input-e");

    expect(verdict.meta.cost).toEqual({ inputTokens: 400, outputTokens: 40 });
  });

  it("withholds usd when a priced provider's real call reported no usage", async () => {
    const verdict = await classifierWith([
      mockProvider({
        id: "mock/silent",
        behavior: () => WEAK,
        // No usage: a real, billed call whose spend is unknowable.
        pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      }),
      mockProvider({
        id: "mock/reporting",
        behavior: () => STRONG,
        usage: { inputTokens: 300, outputTokens: 30 },
        pricing: { inputPerMTok: 10, outputPerMTok: 10 },
      }),
    ])("input-g");

    // Tokens cover reported usage only; usd is withheld because a partial
    // sum would silently under-report the silent provider's spend.
    expect(verdict.meta.cost).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it("attributes in-flight-deduped spend to the initiating caller only", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classify = classifierWith([
      mockProvider({
        behavior: async () => {
          await gate;
          return STRONG;
        },
        usage: { inputTokens: 1000, outputTokens: 200 },
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
      }),
    ]);

    const first = classify("input-h");
    const second = classify("input-h");
    release();
    const [initiator, rider] = await Promise.all([first, second]);

    expect(initiator.kind).toBe("classified");
    expect(rider.kind).toBe("classified");
    const costs = [initiator.meta.cost, rider.meta.cost];
    // Exactly one of the two verdicts carries the (single) spend.
    expect(costs.filter((cost) => cost !== undefined)).toHaveLength(1);
    expect(costs.find((cost) => cost !== undefined)).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      usd: (1000 * 1 + 200 * 5) / 1e6,
    });
  });

  it("is absent on a pure cache hit — nothing was spent", async () => {
    const classify = classifierWith([
      mockProvider({
        behavior: () => STRONG,
        usage: { inputTokens: 1000, outputTokens: 200 },
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
      }),
    ]);

    const first = await classify("input-f");
    expect(first.meta.cacheHit).toBe(false);
    expect(first.meta.cost).toBeDefined();

    const second = await classify("input-f");
    expect(second.meta.cacheHit).toBe(true);
    expect(second.meta.cost).toBeUndefined();
  });
});

describe("pricing validation", () => {
  it.each([
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
  ])("rejects inputPerMTok=%s at construction", (rate) => {
    expect(() => mockProviderWithFactoryPricing(rate)).toThrow(/pricing\.inputPerMTok/);
  });
});

// The factories share validatedPricing; exercise it through the anthropic
// factory (SDK construction is lazy enough not to need a key).
import { anthropic } from "../src/providers/index.js";

function mockProviderWithFactoryPricing(inputPerMTok: number) {
  return anthropic("claude-haiku-4-5-20251001", {
    apiKey: "test",
    pricing: { inputPerMTok, outputPerMTok: 1 },
  });
}
