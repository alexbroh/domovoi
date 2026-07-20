/**
 * Per-provider request governance: retry with exponential backoff and
 * token-bucket rate limiting, enforced around each HTTP request an adapter
 * makes (not around `sample()` — a multi-sample adapter issues several
 * requests per call, and requests are what providers meter).
 *
 * State lives on the provider instance that owns the governor. Sharing a
 * rate limit across classifiers means sharing the provider instance —
 * there is no process-global registry.
 */

import { ConfigError, DomovoiError, ProviderError } from "../errors.js";
import type { TokenUsage } from "../types.js";

export type RetryOptions = {
  /** Total attempts including the first; `1` disables retrying. */
  readonly maxAttempts: number;
  /** Base backoff delay before the first retry. Default 200 ms. */
  readonly initialDelayMs?: number;
};

export type RateLimitOptions = {
  /** Requests per minute across every call through this provider instance. */
  readonly rpm?: number;
  /**
   * Tokens per minute, enforced as a deficit model: reported usage debits
   * the bucket after each call, and a bucket in deficit delays subsequent
   * requests until refill. No pre-call estimation — the first request
   * always passes, sustained heavy usage self-throttles.
   */
  readonly tpm?: number;
};

const DEFAULT_INITIAL_DELAY_MS = 200;

// SDK convention (OpenAI/Anthropic clients retry the same classes):
// transient transport and server-side failures. Malformed responses are
// content bugs — retrying burns money for the same answer — and
// unauthorized never heals by waiting.
const RETRYABLE_CODES = new Set([
  "provider_network",
  "provider_rate_limit",
  "provider_server_error",
]);

export function validatedRetryOptions(retries: RetryOptions): RetryOptions {
  if (!Number.isInteger(retries.maxAttempts) || retries.maxAttempts < 1) {
    throw new ConfigError(
      `retries.maxAttempts must be an integer >= 1; got ${retries.maxAttempts}.`,
      { code: "malformed_provider_config" },
    );
  }
  if (
    retries.initialDelayMs !== undefined &&
    (!Number.isFinite(retries.initialDelayMs) || retries.initialDelayMs < 0)
  ) {
    throw new ConfigError(
      `retries.initialDelayMs must be a finite number >= 0; got ${retries.initialDelayMs}.`,
      { code: "malformed_provider_config" },
    );
  }
  return retries;
}

export function validatedRateLimitOptions(rateLimit: RateLimitOptions): RateLimitOptions {
  for (const [limitName, limit] of Object.entries(rateLimit)) {
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new ConfigError(`rateLimit.${limitName} must be a finite number > 0; got ${limit}.`, {
        code: "malformed_provider_config",
      });
    }
  }
  return rateLimit;
}

/**
 * Continuous-refill token bucket. `capacity` doubles as the per-minute
 * rate; `allowDeficit` buckets may go negative on `debit` and recover by
 * refill — the deficit model used for tpm.
 */
class TokenBucket {
  private level: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacityPerMinute: number,
    private readonly allowDeficit: boolean,
  ) {
    this.level = capacityPerMinute;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const refilled = ((now - this.lastRefillMs) / 60_000) * this.capacityPerMinute;
    this.level = Math.min(this.capacityPerMinute, this.level + refilled);
    this.lastRefillMs = now;
  }

  /** Milliseconds until `amount` can be taken; 0 when available now. */
  msUntilAvailable(amount: number): number {
    this.refill();
    const needed = this.allowDeficit ? -this.level + Number.EPSILON : amount - this.level;
    if ((this.allowDeficit && this.level > 0) || (!this.allowDeficit && this.level >= amount)) {
      return 0;
    }
    return Math.ceil((needed / this.capacityPerMinute) * 60_000);
  }

  take(amount: number): void {
    this.refill();
    this.level -= amount;
  }

  debit(amount: number): void {
    this.refill();
    this.level -= amount;
  }
}

/** Abortable sleep; rejects with the signal's reason on abort. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "aborted");
}

function isRetryable(thrown: unknown): boolean {
  return thrown instanceof ProviderError && RETRYABLE_CODES.has(thrown.code);
}

/**
 * Owns the retry policy and rate buckets for one provider instance.
 * `execute` runs one HTTP request under both; `reconcile` debits reported
 * usage into the tpm bucket after the fact.
 */
export class RequestGovernor {
  private readonly requestBucket: TokenBucket | undefined;
  private readonly tokenBucket: TokenBucket | undefined;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;

  constructor(retries: RetryOptions | undefined, rateLimit: RateLimitOptions | undefined) {
    this.maxAttempts = retries?.maxAttempts ?? 1;
    this.initialDelayMs = retries?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.requestBucket =
      rateLimit?.rpm !== undefined ? new TokenBucket(rateLimit.rpm, false) : undefined;
    this.tokenBucket =
      rateLimit?.tpm !== undefined ? new TokenBucket(rateLimit.tpm, true) : undefined;
  }

  /**
   * Runs `request` under the rate limits and retry policy. Waits (bounded
   * by `signal`) for bucket capacity before each attempt; retries
   * transient `ProviderError`s (`provider_network`, `provider_rate_limit`,
   * `provider_server_error`) with exponential full-jitter backoff. An
   * aborted `signal` — the engine's merged per-call timeout + caller
   * cancellation — stops everything immediately: deadlines always win,
   * and no retry ever extends them.
   */
  async execute<T>(request: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    let lastThrown: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoffCap = this.initialDelayMs * 2 ** (attempt - 1);
        await sleep(Math.random() * backoffCap, signal);
      }
      await this.waitForCapacity(signal);
      this.requestBucket?.take(1);
      try {
        return await request();
      } catch (thrown) {
        lastThrown = thrown;
        if (signal?.aborted || !isRetryable(thrown) || attempt === this.maxAttempts - 1) {
          throw thrown;
        }
      }
    }
    // Unreachable: the loop always returns or throws. Kept for the
    // compiler; a DomovoiError here would indicate a governor bug.
    throw lastThrown instanceof Error
      ? lastThrown
      : new DomovoiError("Request governor exhausted attempts without a thrown cause.", {
          code: "provider_network",
        });
  }

  /** Debits reported usage into the tpm bucket (deficit model). */
  reconcile(usage: TokenUsage): void {
    this.tokenBucket?.debit(usage.inputTokens + usage.outputTokens);
  }

  private async waitForCapacity(signal: AbortSignal | undefined): Promise<void> {
    const waits = [
      this.requestBucket?.msUntilAvailable(1) ?? 0,
      this.tokenBucket?.msUntilAvailable(0) ?? 0,
    ];
    const waitMs = Math.max(...waits);
    if (waitMs > 0) await sleep(waitMs, signal);
  }
}
