import { describe, expect, it, vi } from "vitest";
import type { Distribution } from "../src/index.js";
import { mockProvider } from "../src/testing/index.js";

const SAMPLE_OPTS = {
  template: { templateHash: "test", userTemplate: () => "" },
  temperature: 0,
  timeoutMs: 5000,
};

describe("mockProvider", () => {
  it("constructs a Provider with sensible defaults", () => {
    const p = mockProvider({
      behavior: () => ({ probs: { a: 0.6, b: 0.4 }, coverage: 0.9 }),
    });
    expect(p.id).toBe("mock/test");
    expect(p.modelId).toBe("test");
    expect(p.tokenizerId).toBe("mock");
    expect(p.capabilities.distributionSource).toBe("logprobs");
    expect(p.capabilities.coverageMeasurement).toBe("exact");
    expect(p.capabilities.maxTopLogprobs).toBe(100);
  });

  it("respects id, modelId, and tokenizerId overrides", () => {
    const p = mockProvider({
      id: "custom/provider",
      modelId: "custom-model",
      tokenizerId: "custom-tokenizer",
      behavior: () => ({ probs: { yes: 1, no: 0 }, coverage: 1 }),
    });
    expect(p.id).toBe("custom/provider");
    expect(p.modelId).toBe("custom-model");
    expect(p.tokenizerId).toBe("custom-tokenizer");
  });

  it("respects capabilities overrides", () => {
    const p = mockProvider({
      capabilities: {
        distributionSource: "multi_sample",
        coverageMeasurement: "approximate",
        maxTopLogprobs: 0,
      },
      behavior: () => ({ probs: { a: 0.5, b: 0.5 }, coverage: 0.8 }),
    });
    expect(p.capabilities.distributionSource).toBe("multi_sample");
    expect(p.capabilities.coverageMeasurement).toBe("approximate");
    expect(p.capabilities.maxTopLogprobs).toBe(0);
  });

  it("forwards input + space + opts to the behavior callback", async () => {
    const behavior = vi.fn(
      (_input: string, _space: readonly string[]): Distribution<string> => ({
        probs: { a: 1, b: 0 },
        coverage: 1,
      }),
    );
    const p = mockProvider({ behavior });
    await p.sample("the input", ["a", "b"] as const, SAMPLE_OPTS);
    expect(behavior).toHaveBeenCalledOnce();
    const [input, space, opts] = behavior.mock.calls[0] ?? [];
    expect(input).toBe("the input");
    expect(space).toEqual(["a", "b"]);
    expect(opts).toBe(SAMPLE_OPTS);
  });

  it("returns the Distribution produced by the behavior callback", async () => {
    const distribution: Distribution<"yes" | "no"> = {
      probs: { yes: 0.92, no: 0.08 },
      coverage: 0.97,
    };
    const p = mockProvider<"yes" | "no">({
      behavior: () => distribution,
    });
    const result = await p.sample("ignored", ["yes", "no"] as const, SAMPLE_OPTS);
    expect(result).toEqual(distribution);
  });

  it("supports an async behavior callback", async () => {
    const p = mockProvider({
      behavior: async () => {
        await Promise.resolve();
        return { probs: { a: 0.7, b: 0.3 }, coverage: 0.85 };
      },
    });
    const result = await p.sample("input", ["a", "b"] as const, SAMPLE_OPTS);
    expect(result.probs).toEqual({ a: 0.7, b: 0.3 });
    expect(result.coverage).toBe(0.85);
  });

  it("throws synchronously if signal is pre-aborted with a string reason", async () => {
    const controller = new AbortController();
    controller.abort("user-cancelled");
    const p = mockProvider({
      behavior: () => ({ probs: { a: 1, b: 0 }, coverage: 1 }),
    });
    await expect(
      p.sample("input", ["a", "b"] as const, { ...SAMPLE_OPTS, signal: controller.signal }),
    ).rejects.toThrow("user-cancelled");
  });

  it("throws synchronously if signal is pre-aborted with an Error reason", async () => {
    const controller = new AbortController();
    const reason = new Error("operation aborted");
    controller.abort(reason);
    const p = mockProvider({
      behavior: () => ({ probs: { a: 1, b: 0 }, coverage: 1 }),
    });
    await expect(
      p.sample("input", ["a", "b"] as const, { ...SAMPLE_OPTS, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("does not invoke the behavior callback when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort("nope");
    const behavior = vi.fn(() => ({ probs: { a: 1, b: 0 }, coverage: 1 }));
    const p = mockProvider({ behavior });
    await p
      .sample("input", ["a", "b"] as const, { ...SAMPLE_OPTS, signal: controller.signal })
      .catch(() => {});
    expect(behavior).not.toHaveBeenCalled();
  });

  it("does not define an eager validate hook", () => {
    // mockProvider intentionally has no `.validate` — it's a generic test
    // double, not a tokenizer-aware adapter. Engine treats undefined validate
    // as "skip eager check."
    const p = mockProvider({
      behavior: () => ({ probs: { a: 1, b: 0 }, coverage: 1 }),
    });
    expect(p.validate).toBeUndefined();
  });
});
