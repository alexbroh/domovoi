/**
 * Error class taxonomy for domovoi.
 *
 * 4-class taxonomy with a `code` field for fine-grained discrimination.
 * All errors use ES2022 `Error.cause` chaining for debugging context.
 *
 * The engine canonicalizes any non-DomovoiError thrown from `Provider.sample`
 * into `ProviderError({ cause })` so callers always see a known error type.
 *
 * Under default `onErrorPolicy: "fallback"`, operational errors (ProviderError,
 * BudgetExhaustedError, AbortError) are converted into `Unknown` Verdict variants
 * rather than thrown. Construction errors (ConfigError) always throw.
 */

// ─── Error code enum (string union) ─────────────────────────────────

/**
 * Stable error codes for `ConfigError` and other DomovoiError subtypes.
 * Carry these in `error.code` for fine-grained discrimination instead of
 * `instanceof` checks (since C5 collapses former subclasses into one class).
 */
export type ErrorCode =
  // Construction-time configuration errors (all surface as ConfigError)
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
  // Runtime provider-call errors
  | "provider_network"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_unauthorized"
  | "provider_server_error"
  | "provider_malformed_response"
  | "invalid_distribution"
  // Runtime budget errors
  | "per_call_timeout"
  | "chain_timeout"
  | "max_calls";

// ─── Base error class ───────────────────────────────────────────────

export class DomovoiError extends Error {
  readonly code: string;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DomovoiError";
    this.code = options?.code ?? "unspecified";
  }
}

// ─── Provider errors (runtime, wrap external SDK / network failures) ──

export class ProviderError extends DomovoiError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
  }
}

// ─── Configuration errors (construction-time) ───────────────────────

export class ConfigError extends DomovoiError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

// ─── Budget errors (runtime, user-imposed limits hit) ───────────────

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

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Engine canonicalization: wrap any non-DomovoiError thrown value into a
 * ProviderError with `cause` chained. UmbraError subtypes (and ProviderError
 * subclasses from external Provider impls) pass through unchanged.
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
 * Convert any Error (or DomovoiError) into the JSON-safe SerializableError
 * shape used in Verdict.meta.providerErrors.
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
