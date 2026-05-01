/**
 * Public Provider interface for domovoi.
 *
 * Per C6, this interface is exported as type-only — users implement it for
 * custom backends (third-party LLM gateways, internal-org adapters, niche
 * providers). Built-in factories (`openai`, `ollama`, `openaiCompat`) are the
 * ergonomic primary path; this interface is the extension point.
 *
 * ProviderOptions is open: adapters can define provider-specific opts
 * (multiSampleN, custom timeouts, etc.) and document them. Engine plumbs
 * `signal` and `timeoutMs` (already merged via AbortSignal.any per K2) — adapters
 * forward `signal` to their HTTP client.
 */

import type { Distribution, PromptTemplate, ProviderCapabilities } from "../types.js";

export type SampleOptions = {
  readonly template: PromptTemplate;
  readonly temperature: number;
  readonly seed?: number;
  /** Hint timeout; engine has already merged this into `signal` via AbortSignal.any. */
  readonly timeoutMs: number;
  /** Merged signal (user signal + AbortSignal.timeout). Provider should forward this to its HTTP client. */
  readonly signal?: AbortSignal;
};

/**
 * Public Provider interface. Implementations contract:
 *   - `id`: unique identifier; "factory/model" format conventional (e.g., "openai/gpt-4o-mini").
 *   - `modelId`: model identifier within the factory (e.g., "gpt-4o-mini").
 *   - `tokenizerId`: identifier used for cache keying and collision detection.
 *   - `capabilities`: discloses distributionSource + coverageMeasurement +
 *     maxTopLogprobs to the engine for routing/validation.
 *   - `sample(input, space, opts)`: takes a prompt input string + the decision
 *     space (in user-given order) + opts; returns Distribution<T>.
 *
 * Provider implementations MUST honor `temperature` (engine sends 0 in v0 for
 * determinism); MUST plumb `signal` to their HTTP client (cancellation is a
 * first-class contract); MAY use `seed` if supported.
 */
export interface Provider {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;

  sample<T extends string>(
    input: string,
    space: ReadonlyArray<T>,
    opts: SampleOptions,
  ): Promise<Distribution<T>>;
}
