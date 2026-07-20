/**
 * RequestGovernor: retry policy, rate buckets, deadline interaction, and
 * the status-code canonicalization the retry policy discriminates on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, canonicalizeProviderThrow, ProviderError } from "../../src/errors.js";
import {
  RequestGovernor,
  validatedRateLimitOptions,
  validatedRetryOptions,
} from "../../src/providers/governor.js";

function providerError(code: string): ProviderError {
  return new ProviderError("boom", { code });
}

describe("canonicalizeProviderThrow status mapping", () => {
  it.each([
    [401, "provider_unauthorized"],
    [403, "provider_unauthorized"],
    [429, "provider_rate_limit"],
    [500, "provider_server_error"],
    [503, "provider_server_error"],
    [404, "provider_network"],
  ])("maps HTTP %s to %s", (status, expected) => {
    const sdkError = Object.assign(new Error("api error"), { status });
    expect(canonicalizeProviderThrow(sdkError).code).toBe(expected);
  });

  it("maps status-less errors to provider_network", () => {
    expect(canonicalizeProviderThrow(new Error("socket hang up")).code).toBe("provider_network");
  });
});

describe("RequestGovernor retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries transient failures and returns the eventual success", async () => {
    const governor = new RequestGovernor({ maxAttempts: 3 }, undefined);
    const request = vi
      .fn()
      .mockRejectedValueOnce(providerError("provider_rate_limit"))
      .mockRejectedValueOnce(providerError("provider_server_error"))
      .mockResolvedValueOnce("ok");

    const pending = governor.execute(request, undefined);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable codes", async () => {
    const governor = new RequestGovernor({ maxAttempts: 3 }, undefined);
    const request = vi.fn().mockRejectedValue(providerError("provider_malformed_response"));

    await expect(governor.execute(request, undefined)).rejects.toMatchObject({
      code: "provider_malformed_response",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("throws the last failure once attempts are exhausted", async () => {
    const governor = new RequestGovernor({ maxAttempts: 2 }, undefined);
    const request = vi.fn().mockRejectedValue(providerError("provider_network"));

    const pending = governor.execute(request, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ code: "provider_network" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops retrying the moment the signal aborts — deadlines win", async () => {
    const governor = new RequestGovernor({ maxAttempts: 5, initialDelayMs: 1000 }, undefined);
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(providerError("provider_network"));

    const pending = governor.execute(request, controller.signal);
    const assertion = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("deadline"));
    await vi.runAllTimersAsync();
    await assertion;
    // Aborted during the first backoff sleep — no second attempt fired.
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("RequestGovernor rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays requests past the rpm capacity until refill", async () => {
    const limited = new RequestGovernor(undefined, { rpm: 2 });
    const request = vi.fn().mockResolvedValue("ok");

    await limited.execute(request, undefined);
    await limited.execute(request, undefined);
    expect(request).toHaveBeenCalledTimes(2);

    // Third request must wait ~30s (refill rate 2/min).
    const third = limited.execute(request, undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(third).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("tpm deficit lets the first call pass and throttles after heavy usage", async () => {
    const limited = new RequestGovernor(undefined, { tpm: 6000 });
    const request = vi.fn().mockResolvedValue("ok");

    // First call passes untouched (no pre-call estimation).
    await limited.execute(request, undefined);
    // Heavy reported usage puts the bucket deep into deficit.
    limited.reconcile({ inputTokens: 11_000, outputTokens: 1000 });

    const second = limited.execute(request, undefined);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(1);
    // Deficit of 6000 refills at 6000/min → ~60s until level > 0.
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(second).resolves.toBe("ok");
  });

  it("paces a concurrent burst instead of letting it race past the bucket", async () => {
    const limited = new RequestGovernor(undefined, { rpm: 1 }); // single-slot bucket
    const order: number[] = [];
    const request = (id: number) => () => {
      order.push(id);
      return Promise.resolve("ok");
    };

    // Fired in the same tick — the race the atomic turn queue prevents:
    // before the fix, all three read the same pre-commit bucket level and
    // passed immediately, driving a "hard" bucket to -2.
    const burst = [
      limited.execute(request(0), undefined),
      limited.execute(request(1), undefined),
      limited.execute(request(2), undefined),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]); // only the first slot is free immediately
    await vi.advanceTimersByTimeAsync(61_000);
    expect(order).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(order).toEqual([0, 1, 2]);
    await Promise.all(burst);
  });

  it("fails fast with provider_timeout when the wait can never fit the deadline", async () => {
    const limited = new RequestGovernor(undefined, { rpm: 1 });
    const request = vi.fn().mockResolvedValue("ok");

    await limited.execute(request, undefined, 10_000);
    // Next slot needs ~60s; the 10s deadline can never cover it.
    await expect(limited.execute(request, undefined, 10_000)).rejects.toMatchObject({
      code: "provider_timeout",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("abort during a rate-limit wait rejects immediately", async () => {
    const limited = new RequestGovernor(undefined, { rpm: 1 });
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue("ok");

    await limited.execute(request, undefined);
    const second = limited.execute(request, controller.signal);
    const assertion = expect(second).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("option validation", () => {
  it.each([0, -1, 2.5, Number.NaN])("rejects maxAttempts=%s", (maxAttempts) => {
    expect(() => validatedRetryOptions({ maxAttempts })).toThrow(ConfigError);
  });

  it("rejects negative initialDelayMs", () => {
    expect(() => validatedRetryOptions({ maxAttempts: 2, initialDelayMs: -5 })).toThrow(
      ConfigError,
    );
  });

  it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])("rejects rpm=%s", (rpm) => {
    expect(() => validatedRateLimitOptions({ rpm })).toThrow(ConfigError);
  });

  it("accepts a well-formed combination", () => {
    expect(validatedRetryOptions({ maxAttempts: 3, initialDelayMs: 100 })).toEqual({
      maxAttempts: 3,
      initialDelayMs: 100,
    });
    expect(validatedRateLimitOptions({ rpm: 100, tpm: 50_000 })).toEqual({
      rpm: 100,
      tpm: 50_000,
    });
  });
});
