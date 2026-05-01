/**
 * Stable canonical hashing for cache keys.
 *
 * - SHA-256 from `node:crypto` (stdlib only; cross-process stable for v1
 *   persistent backends).
 * - Canonical JSON serialization with lexicographically sorted object keys.
 * - NFC normalization + trim for input string hashing.
 */

import { createHash } from "node:crypto";

/** SHA-256 hex digest of the given string. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Canonicalize a JSON-serializable value into a deterministic string:
 * - Object keys sorted lexicographically.
 * - Arrays preserve order (for decision-space ordering in cache keys: K3 — user-given).
 * - undefined values are omitted (matches JSON.stringify semantics for object values).
 *
 * Throws on non-JSON-serializable inputs (functions, symbols, circular refs).
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

/**
 * Normalize an input string for hashing: NFC normalization + trim.
 * Used to compute `input_hash` in the cache key composition.
 */
export function normalizeInput(input: string): string {
  return input.normalize("NFC").trim();
}
