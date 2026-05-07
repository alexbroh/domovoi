/**
 * Error taxonomy for domovoi.
 *
 * Four classes (`DomovoiError` base + `ProviderError`, `ConfigError`,
 * `BudgetExhaustedError`) with a stable `code` field for fine-grained
 * discrimination. All accept `{ cause }` for ES2022 chaining.
 *
 * The engine canonicalizes anything thrown from `Provider.sample` that isn't
 * already a `DomovoiError` into `ProviderError({ cause })`, so callers always
 * see a known error type. Under the default `onErrorPolicy: "fallback"`,
 * runtime errors become `Unknown` Verdict variants rather than throw;
 * `ConfigError` always throws.
 */

/**
 * Stable error codes carried in `error.code`. Discriminate on these rather
 * than on `instanceof` of removed-historical subclasses.
 */
export type ErrorCode =
  // ConfigError — construction-time
  | "decision_space_collision"
  | "decision_space_too_large"
  | "missing_provider_config"
  | "malformed_provider_config"
  | "unknown_provider_factory"
  | "missing_credential"
  | "incompatible_calibrator"
  | "invalid_classifier_name"
  | "invalid_thresholds"
  | "invalid_space"
  | "empty_providers"
  // ProviderError — runtime
  | "provider_network"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_unauthorized"
  | "provider_server_error"
  | "provider_malformed_response"
  | "invalid_distribution"
  // BudgetExhaustedError — runtime (operational: time / call-count)
  | "per_call_timeout"
  | "chain_timeout"
  | "max_calls"
  // BudgetExceededError — runtime (scope token budget)
  | "tokens_exceeded"
  // ConfigError — scope budget validation
  | "invalid_scope_budget";

export class DomovoiError extends Error {
  readonly code: string;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DomovoiError";
    this.code = options?.code ?? "unspecified";
  }
}

export class ProviderError extends DomovoiError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export class ConfigError extends DomovoiError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export class BudgetExhaustedError extends DomovoiError {
  readonly attemptedProviders: readonly string[];
  readonly elapsedMs: number;
  readonly scope: "per_call_timeout" | "chain_timeout" | "max_calls";

  constructor(
    message: string,
    options: {
      scope: "per_call_timeout" | "chain_timeout" | "max_calls";
      attemptedProviders: readonly string[];
      elapsedMs: number;
      cause?: unknown;
    },
  ) {
    super(message, { code: options.scope, cause: options.cause });
    this.name = "BudgetExhaustedError";
    this.scope = options.scope;
    this.attemptedProviders = options.attemptedProviders;
    this.elapsedMs = options.elapsedMs;
  }
}

/**
 * Thrown when scope token budget is exceeded under `onExceeded: "throw"` mode.
 * Distinct from `BudgetExhaustedError` (operational time / call-count budgets):
 * this is the cost ceiling for a `domovoi.scope({ budget: { tokens } })` block.
 *
 * Default mode is `"graceful"` — classify returns
 * `Unknown { reason: { type: "budget_exceeded", spent, limit } }` instead.
 */
export class BudgetExceededError extends DomovoiError {
  readonly spent: number;
  readonly limit: number;

  constructor(options: { spent: number; limit: number; cause?: unknown }) {
    super(`Scope budget exceeded: ${options.spent} / ${options.limit} tokens`, {
      code: "tokens_exceeded",
      cause: options.cause,
    });
    this.name = "BudgetExceededError";
    this.spent = options.spent;
    this.limit = options.limit;
  }
}

/**
 * Wraps any non-DomovoiError thrown value in `ProviderError({ cause })`.
 * `DomovoiError` subtypes — including `ProviderError` subclasses defined by
 * external Provider implementations — pass through unchanged.
 */
export function canonicalizeProviderThrow(thrown: unknown): DomovoiError {
  if (thrown instanceof DomovoiError) return thrown;
  if (thrown instanceof Error) {
    return new ProviderError(thrown.message || "Provider call failed", {
      code: "provider_network",
      cause: thrown,
    });
  }
  return new ProviderError(String(thrown), {
    code: "provider_network",
    cause: thrown,
  });
}

/**
 * Convert an Error to the JSON-safe shape stored in
 * `Verdict.meta.providerErrors`. Cause chains are preserved recursively.
 */
export function serializeError(err: unknown): {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: ReturnType<typeof serializeError>;
  readonly stack?: string;
} {
  if (!(err instanceof Error)) {
    return { name: "Error", message: String(err) };
  }
  const code = err instanceof DomovoiError ? err.code : undefined;
  const cause = err.cause !== undefined ? serializeError(err.cause) : undefined;
  return {
    name: err.name,
    message: err.message,
    ...(code !== undefined ? { code } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(err.stack !== undefined ? { stack: err.stack } : {}),
  };
}
