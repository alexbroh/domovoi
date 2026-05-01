/**
 * Tokenizer abstraction (internal — not exported from the public surface).
 *
 * Supports first-token-id resolution for decision-space collision detection
 * and logit_bias construction. Backed by tiktoken (`cl100k_base` for OpenAI
 * models in v0). Adapters that need different tokenizers can build their own
 * implementation of the same internal interface.
 *
 * Contract:
 *   - `encode(label)` returns the token ids for the leading whitespace + label
 *     (matches OpenAI's tokenization of an emitted output token).
 *   - `firstTokenId(label)` returns the first token id of the encoded label.
 *
 * Note: OpenAI's tokenizer often prepends a leading space to emitted tokens
 * (`" yes"` vs `"yes"`). We detect first-token id with the leading-space
 * variant since that's what the model emits at the first content position.
 */

import { get_encoding, type Tiktoken } from "tiktoken";

type TokenizerId = "openai/cl100k_base";

export interface Tokenizer {
  readonly id: TokenizerId;
  /** Token ids for `label` as it would appear at a generation boundary. */
  encode(label: string): number[];
  /** First token id of `label` at a generation boundary. */
  firstTokenId(label: string): number;
}

let cl100kSingleton: Tokenizer | undefined;

/**
 * cl100k_base tokenizer, used by GPT-4o family + most OpenAI Chat models.
 * Lazy-initialized; the underlying tiktoken native module is heavy.
 */
export function cl100kTokenizer(): Tokenizer {
  if (cl100kSingleton !== undefined) return cl100kSingleton;
  const enc: Tiktoken = get_encoding("cl100k_base");
  cl100kSingleton = {
    id: "openai/cl100k_base",
    encode(label: string): number[] {
      // Models typically emit labels with a leading space at the first content
      // position (e.g., the model writes " yes" not "yes"). Encode with that
      // convention so first-token detection matches what we'd see in logprobs.
      const withLeadingSpace = label.startsWith(" ") ? label : ` ${label}`;
      const ids = enc.encode(withLeadingSpace);
      return Array.from(ids);
    },
    firstTokenId(label: string): number {
      const ids = this.encode(label);
      const first = ids[0];
      if (first === undefined) {
        throw new Error(`Tokenizer produced empty encoding for label ${JSON.stringify(label)}`);
      }
      return first;
    },
  };
  return cl100kSingleton;
}

/**
 * Detect first-token-id collisions across a decision space. Returns the
 * conflicting label pair if any two labels resolve to the same first token,
 * or `undefined` if the space is collision-free.
 *
 * Used by the OpenAI adapter (and other tokenizer-aware adapters) at
 * construction time to throw `ConfigError({ code: "decision_space_collision" })`
 * before any network I/O.
 *
 * Imperative form (rather than `reduce`) chosen for readability: the early
 * return on first collision short-circuits naturally without the bookkeeping
 * that a `reduce` accumulator would require.
 */
export function findFirstTokenCollision(
  tokenizer: Tokenizer,
  space: readonly string[],
): { a: string; b: string; tokenId: number } | undefined {
  const seenByTokenId = new Map<number, string>();
  for (const label of space) {
    const tokenId = tokenizer.firstTokenId(label);
    const priorLabel = seenByTokenId.get(tokenId);
    if (priorLabel !== undefined && priorLabel !== label) {
      return { a: priorLabel, b: label, tokenId };
    }
    seenByTokenId.set(tokenId, label);
  }
  return undefined;
}

/**
 * Build a logit_bias map for OpenAI Chat Completions:
 *   - +bias on each in-space first-token id.
 *
 * S8 lock: `+100` for in-space; no negative biases (keeps coverage measurement
 * honest — positive bias nudges, doesn't force).
 */
export function buildLogitBias(
  tokenizer: Tokenizer,
  space: readonly string[],
  bias = 100,
): Record<string, number> {
  return Object.fromEntries(
    space.map((label) => [String(tokenizer.firstTokenId(label)), bias] as const),
  );
}
