/**
 * Verbalized-confidence parsing and multi-sample aggregation for the
 * Anthropic adapter. Pure functions — the adapter owns the network I/O.
 */

import type { Distribution } from "../../types.js";

/** One model reply, parsed. `null` when unparseable. */
export type VerbalizedSample = {
  readonly label: string;
  /** Integer 0–100 as instructed in the prompt. */
  readonly confidence: number;
} | null;

/**
 * Extract `{label, confidence}` from a model reply. The prompt instructs a
 * single-line JSON object; the first `{...}` span in the reply is parsed so
 * a stray preamble doesn't break extraction. Returns `null` on any
 * malformed reply — the aggregation counts that against coverage.
 */
export function parseVerbalizedReply(text: string): VerbalizedSample {
  const jsonSpan = text.match(/\{[^}]*\}/);
  if (jsonSpan === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSpan[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { label, confidence } = parsed as { label?: unknown; confidence?: unknown };
  if (typeof label !== "string") return null;
  const numericConfidence = Number(confidence);
  if (!Number.isFinite(numericConfidence) || numericConfidence < 0 || numericConfidence > 100) {
    return null;
  }
  return { label: label.trim(), confidence: numericConfidence };
}

/**
 * Aggregate K verbalized-confidence samples into a `Distribution`.
 *
 * Each in-space sample contributes `c/100` to its label and spreads the
 * remainder `(1 - c/100)/(|space| - 1)` uniformly over the other labels;
 * contributions are averaged over in-space samples. This preserves the
 * verbalized confidence at K = 1 (pure vote renormalization would collapse
 * to probability 1.0 there) and lets sample disagreement pull the top
 * probability below classification thresholds — the signal that flags the
 * items most likely to be wrong.
 *
 * `coverage` is the fraction of samples that answered in-space; unparseable
 * replies and out-of-space labels both count against it. Zero in-space
 * samples yield a uniform distribution with coverage 0, which the engine's
 * coverage threshold turns into an out-of-distribution Unknown.
 *
 * Label matching tries the exact label first, then falls back to
 * case-insensitive, so a model reply of `"Billing"` still lands on the
 * `"billing"` label — and in a space with case-variant labels, an exact
 * reply always resolves to its own label. Non-exact replies in such a
 * space resolve to the last case-colliding label in `space` order.
 */
export function aggregateVerbalizedSamples<T extends string>(
  space: readonly T[],
  samples: readonly VerbalizedSample[],
): Distribution<T> {
  const byLowercase = new Map<string, T>(space.map((label) => [label.toLowerCase(), label]));
  const weights = new Map<T, number>(space.map((label) => [label, 0]));
  const spreadTargets = space.length - 1;

  let inSpaceCount = 0;
  for (const sample of samples) {
    if (sample === null) continue;
    const matched = (space as readonly string[]).includes(sample.label)
      ? (sample.label as T)
      : byLowercase.get(sample.label.toLowerCase());
    if (matched === undefined) continue;
    inSpaceCount += 1;
    const own = sample.confidence / 100;
    for (const label of space) {
      const contribution = label === matched ? own : (1 - own) / spreadTargets;
      weights.set(label, (weights.get(label) ?? 0) + contribution);
    }
  }

  const probs = Object.fromEntries(
    space.map((label) => [
      label,
      inSpaceCount === 0 ? 1 / space.length : (weights.get(label) ?? 0) / inSpaceCount,
    ]),
  ) as Distribution<T>["probs"];

  return {
    probs,
    coverage: samples.length === 0 ? 0 : inSpaceCount / samples.length,
  };
}
