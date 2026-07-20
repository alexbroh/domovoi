/**
 * Factory for the Anthropic Messages backend. Unlike the OpenAI-flavored
 * factories there is no tokenizer wiring — the Anthropic tokenizer is not
 * public, so there is no first-token collision check and the model id
 * doubles as the cache-keying tokenizer id (matching the `ollama/<model>`
 * precedent).
 */

import Anthropic from "@anthropic-ai/sdk";
import { ConfigError } from "../../errors.js";
import type { ProviderCapabilities } from "../../types.js";
import { validatedPricing } from "../pricing.js";
import type { Provider, ProviderPricing } from "../provider.js";
import { buildAnthropicAdapter } from "./adapter.js";

/**
 * The known-models list provides autocomplete; the `(string & {})` member is
 * an escape hatch so new models work without a library release.
 */
export type AnthropicModel =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-5"
  | "claude-opus-4-8"
  | (string & {});

/**
 * Haiku 4.5. Eval-backed: statistical parity with Sonnet 5 on short
 * embedded-decision tasks at roughly a third the price — and the sample
 * count multiplies every call, so the default model choice carries that
 * multiple.
 */
export const DEFAULT_ANTHROPIC_MODEL: AnthropicModel = "claude-haiku-4-5-20251001";

const DEFAULT_SAMPLES = 3;

export type AnthropicProviderOptions = {
  /** Default: `process.env.ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Default: the SDK's `https://api.anthropic.com`. */
  readonly baseURL?: string;
  /** SDK-level request timeout. Independent of the engine's own budget. */
  readonly timeout?: number;
  /**
   * Samples per classify call. Default 3. Each sample is a full API call,
   * so cost and latency scale linearly. `1` is the cheap mode: pure
   * single-shot verbalized confidence, which loses the sample-disagreement
   * signal that flags likely-wrong classifications.
   */
  readonly samples?: number;
  /**
   * USD per million tokens, used for `Verdict.meta.cost.usd` and the
   * `gen_ai.usage.cost_usd` span attribute. Omit to not emit USD. Reported
   * usage (and therefore cost) sums across all `samples` calls.
   */
  readonly pricing?: ProviderPricing;
};

const MULTI_SAMPLE_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "multi_sample",
  coverageMeasurement: "approximate",
  maxTopLogprobs: 0,
};

/**
 * Hosted Anthropic provider. Defaults to `process.env.ANTHROPIC_API_KEY`
 * and Haiku 4.5 (the model argument is optional — a deliberate asymmetry
 * with `openai(model)`, since the default here is eval-backed).
 *
 * Multi-sample providers dilute unanimity less than logprobs providers
 * sharpen it: a 2-of-3 split lands near 0.62 top-probability. Pair with
 * `thresholds: { high: 0.75 }` so splits — which measure far less accurate
 * than unanimous answers — route to `uncertain` instead of `classified`.
 *
 * @example
 * const cloud = anthropic();                       // Haiku 4.5, 3 samples
 * const strong = anthropic("claude-sonnet-5", { samples: 5 });
 */
export function anthropic(
  model: AnthropicModel = DEFAULT_ANTHROPIC_MODEL,
  opts?: AnthropicProviderOptions,
): Provider {
  const samples = opts?.samples ?? DEFAULT_SAMPLES;
  if (!Number.isInteger(samples) || samples < 1) {
    throw new ConfigError(
      `anthropic(model, { samples }): samples must be an integer >= 1; got ${samples}.`,
      { code: "malformed_provider_config" },
    );
  }

  const client = new Anthropic({
    apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    ...(opts?.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });

  return buildAnthropicAdapter({
    id: `anthropic/${model}`,
    modelId: model,
    tokenizerId: `anthropic/${model}`,
    capabilities: MULTI_SAMPLE_CAPABILITIES,
    client,
    samples,
    ...(opts?.pricing !== undefined ? { pricing: validatedPricing(opts.pricing) } : {}),
  });
}
