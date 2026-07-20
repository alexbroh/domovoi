/**
 * Public Provider extension point. The built-in factories (`openai`,
 * `ollama`, `openaiCompat`) are the ergonomic path; implement this interface
 * directly to back domovoi with a custom LLM gateway or internal adapter.
 *
 * The engine merges the user signal with a per-call timeout into a single
 * `signal` and passes it to `sample()`; adapters must forward it to their
 * HTTP client.
 */

import type { Distribution, PromptTemplate, ProviderCapabilities } from "../types.js";

export type SampleOptions = {
  readonly template: PromptTemplate;
  /**
   * Sampling temperature. `undefined` means "provider-appropriate
   * default": logprobs adapters read the first-token distribution from a
   * single deterministic completion (0), while multi-sample adapters need
   * sampling variance for the disagreement signal (1). An explicit value
   * is always honored as given.
   */
  readonly temperature: number | undefined;
  readonly seed?: number;
  /**
   * Advisory timeout; the engine has already enforced it via the merged
   * `signal`. Adapters may pass this to their HTTP client as belt-and-suspenders.
   */
  readonly timeoutMs: number;
  /**
   * Merged user signal + per-call timeout. Adapters must forward this to
   * their HTTP client so cancellation aborts in-flight requests.
   */
  readonly signal?: AbortSignal;
};

/**
 * Implementations must honor `opts.temperature`, must forward `opts.signal`
 * to their HTTP client, and may use `opts.seed` when the backend supports it.
 *
 *   - `id` — unique identifier; conventionally `"factory/model"` (e.g.
 *     `"openai/gpt-4o-mini"`).
 *   - `modelId` — model identifier within the factory.
 *   - `tokenizerId` — identifier used for cache keying.
 *   - `capabilities` — discloses how the engine should route and validate.
 */
export interface Provider {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * Stable hash of provider options that change the Distribution for the
   * same `(model, input, space)` — e.g. the multi-sample count. Mixed into
   * the cache key so changing such an option is a cache miss. Omit when the
   * provider has no such options.
   */
  readonly configHash?: string;

  /**
   * Optional eager check fired once per provider during
   * `validateClassifierConfig`, before any `sample()` call. Throw
   * `ConfigError` to surface decision-space problems (e.g. first-token
   * collisions) at construction rather than on first sample.
   */
  validate?(space: readonly string[]): void;

  sample<T extends string>(
    input: string,
    space: readonly T[],
    opts: SampleOptions,
  ): Promise<Distribution<T>>;
}
