/**
 * Two paths from OpenAI's `top_logprobs` array to a `Distribution<T>` over
 * the in-space labels:
 *
 *   - `buildDistributionByTokenId` — preferred path when a tokenizer is
 *     wired up (hosted OpenAI's cl100k_base, or `openaiCompat` with
 *     `useCl100kTokenizer: true`). Each top-K entry's surface-form string
 *     is re-encoded to its first token id, then matched against the
 *     in-space first-token id map. Reliable across SDK versions and
 *     handles whitespace-padded variants.
 *   - `buildDistributionByStringMatch` — fallback when no tokenizer is
 *     available (Ollama with arbitrary models). Matches by trimmed string
 *     equality or label-prefix.
 *
 * Both end with `renormalize` over the in-space mass to produce a proper
 * probability distribution; the pre-renormalization in-space mass is
 * preserved as `coverage`.
 */

import type OpenAI from "openai";
import type { Tokenizer } from "../../tokenizer.js";
import type { Distribution } from "../../types.js";

type TopLogprobEntry = OpenAI.Chat.Completions.ChatCompletionTokenLogprob.TopLogprob;

export function buildDistributionByTokenId<T extends string>(
  space: readonly T[],
  tokenLogprobs: readonly TopLogprobEntry[],
  inSpaceIds: Map<number, T>,
  tokenizer: Tokenizer,
): Distribution<T> {
  const inSpace = new Map<T, number>();
  let inSpaceMass = 0;

  for (const entry of tokenLogprobs) {
    const ids = tokenizer.encode(entry.token);
    const firstId = ids[0];
    if (firstId === undefined) continue;
    const label = inSpaceIds.get(firstId);
    if (label === undefined) continue;
    const prob = Math.exp(entry.logprob);
    const previous = inSpace.get(label) ?? 0;
    if (prob > previous) {
      inSpace.set(label, prob);
      inSpaceMass += prob - previous;
    }
  }

  return renormalize(space, inSpace, inSpaceMass);
}

export function buildDistributionByStringMatch<T extends string>(
  space: readonly T[],
  tokenLogprobs: readonly TopLogprobEntry[],
): Distribution<T> {
  const inSpace = new Map<T, number>();
  let inSpaceMass = 0;

  for (const label of space) {
    const trimmed = label.trim();
    let bestProb = 0;
    for (const entry of tokenLogprobs) {
      const tok = entry.token.trim();
      // `startsWith("")` is trivially true; require a non-empty token first.
      if (tok === trimmed || (tok && trimmed.startsWith(tok))) {
        const prob = Math.exp(entry.logprob);
        if (prob > bestProb) bestProb = prob;
      }
    }
    if (bestProb > 0) {
      inSpace.set(label, bestProb);
      inSpaceMass += bestProb;
    }
  }

  return renormalize(space, inSpace, inSpaceMass);
}

function renormalize<T extends string>(
  space: readonly T[],
  inSpace: Map<T, number>,
  inSpaceMass: number,
): Distribution<T> {
  const coverage = Math.min(1, inSpaceMass);
  const probs: Record<string, number> = {};
  for (const label of space) {
    const raw = inSpace.get(label) ?? 0;
    probs[label] = inSpaceMass > 0 ? raw / inSpaceMass : 0;
  }
  return {
    probs: probs as Distribution<T>["probs"],
    coverage,
  };
}
