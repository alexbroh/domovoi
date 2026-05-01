/**
 * domovoi.classifier({...}) — reusable configured classifier factory.
 *
 * Returns a `Classifier<T, I>`: a callable that takes an input, returns
 * `Promise<Verdict<T>>`. Also exposes `.batch(items, opts?)` and `.classify`
 * alias for discoverability.
 *
 * Validates configuration at construction time (validate.ts) and resolves
 * env-driven providers if `providers` is omitted (env.ts).
 *
 * Note: full callable+method shape requires assigning methods to a function
 * object. We use `Object.assign` to achieve this with type safety.
 */

import { type Cache, memoryCache } from "../cache.js";
import { type Calibrator, identity } from "../calibration/index.js";
import { decide, validateClassifierConfig, withDefaults } from "../engine/index.js";
import { resolveDefaultProviders } from "../env.js";
import { defaultTemplate } from "../prompt.js";
import type { Provider } from "../providers/provider.js";
import type { Budget, PromptTemplate, Thresholds, Verdict } from "../types.js";

/**
 * Configuration accepted by `domovoi.classifier({...})`.
 *
 * `format` is required when `I` is not assignable to `string`. When `I = string`
 * (default), `format` is optional and defaults to identity.
 */
export type ClassifierConfig<T extends string, I> = {
  /** /^[a-z][a-z0-9_]*$/; uppercased for env-binding lookup. */
  readonly name?: string;
  readonly space: readonly [T, ...T[]];
  readonly question?: string;
  readonly format?: (x: I) => string;
  readonly thresholds: Thresholds<readonly [T, ...T[]]>;
  readonly providers?: readonly Provider[];
  readonly calibrator?: Calibrator;
  readonly cache?: Cache;
  readonly budget?: Budget;
  readonly template?: PromptTemplate;
  readonly hooks?: {
    onCall?: (...args: unknown[]) => void | Promise<void>;
    onResult?: (...args: unknown[]) => void | Promise<void>;
  };
  readonly onProviderError?: (
    err: Error,
    ctx: { providerId: string; attempt: number },
  ) => void | Promise<void>;
  readonly onErrorPolicy?: "fallback" | "throw";
};

/**
 * The configured runtime instance. Callable with an input; returns
 * `Promise<Verdict<T>>`.
 *
 * Methods:
 *   - `.batch(items, opts?)`: per-item Verdicts in input order.
 */
export interface Classifier<T extends string, I> {
  (input: I, opts?: { signal?: AbortSignal }): Promise<Verdict<T>>;
  batch(
    items: readonly I[],
    opts?: { concurrency?: number; signal?: AbortSignal },
  ): Promise<Verdict<T>[]>;
}

const DEFAULT_BATCH_CONCURRENCY = 5;

export function classifier<const T extends string, I = string>(
  config: ClassifierConfig<T, I>,
): Classifier<T, I> {
  // Resolve providers: explicit overrides env.
  const providers =
    config.providers !== undefined && config.providers.length > 0
      ? config.providers
      : resolveDefaultProviders(config.name);

  const calibrator = config.calibrator ?? identity;
  const cache = config.cache ?? memoryCache();
  const template = config.template ?? defaultTemplate;

  // Validate at construction.
  validateClassifierConfig({
    ...(config.name !== undefined ? { name: config.name } : {}),
    space: config.space,
    thresholds: config.thresholds,
    providers,
    calibrator,
  });

  // Default `format` to identity if I is string-typed (caller didn't supply).
  // We can't enforce I = string at the type level here (it's a generic param),
  // so we accept the slight runtime cost: if no format, treat input as string.
  const format = config.format ?? ((x: I) => x as unknown as string);

  const decideConfig = withDefaults<T>({
    space: config.space,
    thresholds: config.thresholds,
    providers,
    calibrator,
    cache,
    template,
    ...(config.question !== undefined ? { question: config.question } : {}),
    ...(config.budget !== undefined ? { budget: config.budget } : {}),
    ...(config.onErrorPolicy !== undefined ? { onErrorPolicy: config.onErrorPolicy } : {}),
    ...(config.onProviderError !== undefined
      ? { onProviderError: config.onProviderError as never }
      : {}),
    ...(config.hooks !== undefined ? { hooks: config.hooks } : {}),
  });

  // Single-item callable.
  const single = async (input: I, opts?: { signal?: AbortSignal }): Promise<Verdict<T>> => {
    const formatted = format(input);
    return decide(formatted, decideConfig, opts?.signal);
  };

  // Batch callable.
  const batch = async (
    items: readonly I[],
    opts?: { concurrency?: number; signal?: AbortSignal },
  ): Promise<Verdict<T>[]> => {
    const concurrency = opts?.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
    const results: Verdict<T>[] = new Array(items.length);
    let next = 0;

    async function worker(): Promise<void> {
      while (true) {
        const idx = next++;
        if (idx >= items.length) return;
        const item = items[idx] as I;
        // Per G15: signal-already-aborted produces Unknown { cancelled }.
        // The single() call handles abort discrimination internally.
        results[idx] = await single(
          item,
          opts?.signal !== undefined ? { signal: opts.signal } : {},
        );
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  };

  // Callable function with a `.batch` method attached.
  const callable = single as Classifier<T, I>;
  return Object.assign(callable, { batch });
}
