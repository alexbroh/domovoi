/**
 * Public test helpers exposed via `domovoi/testing` subpath.
 *
 * `mockProvider({ behavior, capabilities?, id? })` builds a Provider for tests
 * without hitting a real LLM. Defaults work out-of-the-box for unit tests
 * of engine logic, threshold semantics, fallback chains, etc. (S10).
 */

import type { Provider, SampleOptions } from "../providers/provider.js";
import type { Distribution, ProviderCapabilities } from "../types.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  // Higher than OpenAI's 20 so users don't trip the chain-min cap unexpectedly
  // in tests of large decision spaces.
  maxTopLogprobs: 100,
};

export type MockProviderOptions<T extends string = string> = {
  /**
   * Function that produces the Distribution for a given input + space + opts.
   * May be sync or async; engine awaits the result.
   */
  readonly behavior: (
    input: string,
    space: ReadonlyArray<T>,
    opts: SampleOptions,
  ) => Distribution<T> | Promise<Distribution<T>>;
  /** Override default capabilities (for testing capability-mismatch logic). */
  readonly capabilities?: ProviderCapabilities;
  /** Override the provider id; defaults to "mock/test". */
  readonly id?: string;
  /** Override the model id; defaults to "test". */
  readonly modelId?: string;
  /** Override the tokenizer id; defaults to "mock". */
  readonly tokenizerId?: string;
};

/**
 * Construct a mock Provider for testing.
 *
 * @example
 *   const c = domovoi.classifier({
 *     space: ["a","b","c"] as const,
 *     thresholds: { high: 0.7, coverageMin: 0.5 },
 *     providers: [
 *       mockProvider({
 *         behavior: () => ({ probs: { a: 0.8, b: 0.1, c: 0.1 }, coverage: 0.95 }),
 *       }),
 *     ],
 *   });
 */
export function mockProvider<T extends string = string>(options: MockProviderOptions<T>): Provider {
  const id = options.id ?? "mock/test";
  const modelId = options.modelId ?? "test";
  const tokenizerId = options.tokenizerId ?? "mock";
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;

  // Cast the behavior to the generic Provider.sample shape. Tests typically
  // pin `T` via the classifier they pass the mock to, so the type erasure here
  // is safe in practice.
  type AnyBehavior = (
    i: string,
    s: ReadonlyArray<string>,
    o: SampleOptions,
  ) => Distribution<string> | Promise<Distribution<string>>;
  const erased = options.behavior as unknown as AnyBehavior;

  return {
    id,
    modelId,
    tokenizerId,
    capabilities,
    async sample<U extends string>(
      input: string,
      space: ReadonlyArray<U>,
      opts: SampleOptions,
    ): Promise<Distribution<U>> {
      // Pre-aborted check: producers should respect cancellation.
      if (opts.signal?.aborted) {
        const reason = opts.signal.reason;
        if (reason instanceof Error) throw reason;
        throw new Error(typeof reason === "string" ? reason : "aborted");
      }
      const result = await erased(input, space as ReadonlyArray<string>, opts);
      return result as Distribution<U>;
    },
  };
}
