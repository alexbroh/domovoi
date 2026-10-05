---
"@hourslabs/domovoi": minor
---

Per-provider retries and rate limiting: factories accept `retries: { maxAttempts, initialDelayMs? }` (exponential full-jitter backoff on transient failures only) and `rateLimit: { rpm?, tpm? }` (token buckets on the provider instance; tpm uses a post-hoc deficit model). Enforcement is per HTTP request — multi-sample providers meter and retry each sample individually. All waits are bounded by the engine's per-call deadline and caller AbortSignal. Provider SDK errors now canonicalize with status-aware codes (401/403 → provider_unauthorized, 429 → provider_rate_limit, 5xx → provider_server_error).
