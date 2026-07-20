/**
 * Public test helpers exposed via `@hourslabs/domovoi/testing` subpath.
 *
 * Two primitives:
 *
 *   - `mockProvider({ behavior })` — Provider stub for unit tests of engine
 *     logic without hitting a real LLM.
 *   - `distribution(fn, { n })` — distribution-shaped assertions on AI
 *     behavior, with Wilson confidence intervals.
 */

import type {
  Provider,
  ProviderPricing,
  SampleOptions,
  SampleOutcome,
} from "../providers/provider.js";
import type { Distribution, ProviderCapabilities, TokenUsage } from "../types.js";

export {
  type ConfidenceLevel,
  type DistributionOptions,
  distribution,
  type Samples,
  type StabilityAssertion,
  wilsonInterval,
} from "./distribution.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  // Higher than OpenAI's 20 so users don't trip the chain-min cap unexpectedly
  // in tests of large decision spaces.
  maxTopLogprobs: 100,
};

/** What `mockProvider`'s behavior may return: a bare Distribution (the
 * common case) or a full SampleOutcome when a test needs to exercise
 * usage/cost paths. */
export type MockBehaviorResult<T extends string> = Distribution<T> | SampleOutcome<T>;

export type MockProviderOptions<T extends string = string> = {
  /**
   * Function that produces the Distribution (or full SampleOutcome, to
   * exercise usage/cost paths) for a given input + space + opts. May be
   * sync or async; engine awaits the result.
   */
  readonly behavior: (
    input: string,
    space: readonly T[],
    opts: SampleOptions,
  ) => MockBehaviorResult<T> | Promise<MockBehaviorResult<T>>;
  /** Usage attached to every outcome whose behavior didn't supply one. */
  readonly usage?: TokenUsage;
  /** Pricing surfaced on the mock Provider (engine computes USD from it). */
  readonly pricing?: ProviderPricing;
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
    s: readonly string[],
    o: SampleOptions,
  ) => MockBehaviorResult<string> | Promise<MockBehaviorResult<string>>;
  const erased = options.behavior as unknown as AnyBehavior;
  const defaultUsage = options.usage;

  return {
    id,
    modelId,
    tokenizerId,
    capabilities,
    ...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
    async sample<U extends string>(
      input: string,
      space: readonly U[],
      opts: SampleOptions,
    ): Promise<SampleOutcome<U>> {
      // Pre-aborted check: producers should respect cancellation.
      if (opts.signal?.aborted) {
        const reason = opts.signal.reason;
        if (reason instanceof Error) throw reason;
        throw new Error(typeof reason === "string" ? reason : "aborted");
      }
      const result = await erased(input, space as readonly string[], opts);
      const outcome: SampleOutcome<string> =
        "distribution" in result ? result : { distribution: result };
      if (outcome.usage === undefined && defaultUsage !== undefined) {
        return { ...outcome, usage: defaultUsage } as SampleOutcome<U>;
      }
      return outcome as SampleOutcome<U>;
    },
  };
}
