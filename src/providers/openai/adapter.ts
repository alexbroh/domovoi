/**
 * The internal `buildAdapter` that all three openai-flavored factories
 * (`openai`, `ollama`, `openaiCompat`) share. Wires up the OpenAI Chat
 * Completions request, translates its top-K logprobs into a `Distribution<T>`,
 * and exposes the eager `validate(space)` hook when a tokenizer is available
 * for first-token collision detection.
 */

import type OpenAI from "openai";
import { ConfigError, canonicalizeProviderThrow, ProviderError } from "../../errors.js";
import { renderSystemPrompt, renderUserPrompt } from "../../prompt.js";
import { buildLogitBias, findFirstTokenCollision, type Tokenizer } from "../../tokenizer.js";
import type { Distribution, ProviderCapabilities } from "../../types.js";
import type { Provider, SampleOptions } from "../provider.js";
import { buildDistributionByStringMatch, buildDistributionByTokenId } from "./distribution.js";

// Positive bias on in-space first-tokens only. Nudges the model toward
// in-space output without forcing — keeps the coverage signal honest.
const LOGIT_BIAS_VALUE = 100;

export type AdapterArgs = {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: OpenAI;
  /**
   * Tokenizer for first-token-id resolution and logit_bias construction.
   * When omitted, the adapter falls back to string-based logprob matching.
   */
  readonly tokenizer?: Tokenizer;
};

export function buildAdapter(args: AdapterArgs): Provider {
  // Memo of spaces already checked, shared by the eager validate hook and
  // the per-call defense-in-depth check, so repeat passes are zero-cost.
  const collisionMemo = new Set<string>();
  const tokenizer = args.tokenizer;

  // The eager `validate` hook is exposed only when a tokenizer is available;
  // backends without tokenizer info (e.g. default Ollama) skip it.
  const eagerValidate =
    tokenizer === undefined
      ? {}
      : {
          validate: (space: readonly string[]): void => {
            ensureNoCollisions(tokenizer, space, collisionMemo);
          },
        };

  return {
    id: args.id,
    modelId: args.modelId,
    tokenizerId: args.tokenizerId,
    capabilities: args.capabilities,
    ...eagerValidate,

    async sample<T extends string>(
      input: string,
      space: readonly T[],
      opts: SampleOptions,
    ): Promise<Distribution<T>> {
      // Defense-in-depth: catches callers that bypassed `validateClassifierConfig`.
      let logitBias: Record<string, number> | undefined;
      let inSpaceFirstTokenIds: Map<number, T> | undefined;
      if (tokenizer !== undefined) {
        ensureNoCollisions(tokenizer, space, collisionMemo);
        logitBias = buildLogitBias(tokenizer, space, LOGIT_BIAS_VALUE);
        inSpaceFirstTokenIds = mapFirstTokenIds(tokenizer, space);
      }

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      const system = renderSystemPrompt(opts.template, space);
      if (system !== undefined) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: renderUserPrompt(opts.template, input, space) });

      let response: OpenAI.Chat.ChatCompletion;
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
          model: args.modelId,
          messages,
          // Deferred default resolves to 0: logprobs adapters read the
          // first-token distribution, which needs no sampling variance.
          temperature: opts.temperature ?? 0,
          logprobs: true,
          top_logprobs: Math.min(args.capabilities.maxTopLogprobs, Math.max(space.length * 2, 5)),
          // One label is one short word; 16 tokens is enough headroom.
          max_completion_tokens: 16,
        };
        if (opts.seed !== undefined) params.seed = opts.seed;
        if (logitBias !== undefined) params.logit_bias = logitBias;

        const requestOpts: { signal?: AbortSignal; timeout?: number } = {
          timeout: opts.timeoutMs,
        };
        if (opts.signal !== undefined) requestOpts.signal = opts.signal;
        response = await args.client.chat.completions.create(params, requestOpts);
      } catch (err) {
        throw canonicalizeProviderThrow(err);
      }

      const choice = response.choices[0];
      if (choice === undefined) {
        throw new ProviderError("OpenAI response had no choices.", {
          code: "provider_malformed_response",
        });
      }
      const tokenLogprobs = choice.logprobs?.content?.[0]?.top_logprobs;
      if (tokenLogprobs === undefined || tokenLogprobs.length === 0) {
        throw new ProviderError("OpenAI response missing first-token logprobs.", {
          code: "provider_malformed_response",
        });
      }

      return tokenizer !== undefined && inSpaceFirstTokenIds !== undefined
        ? buildDistributionByTokenId(space, tokenLogprobs, inSpaceFirstTokenIds, tokenizer)
        : buildDistributionByStringMatch(space, tokenLogprobs);
    },
  };
}

function ensureNoCollisions<T extends string>(
  tokenizer: Tokenizer,
  space: readonly T[],
  memo: Set<string>,
): void {
  const memoKey = JSON.stringify(space);
  if (memo.has(memoKey)) return;
  const collision = findFirstTokenCollision(tokenizer, space);
  if (collision !== undefined) {
    throw new ConfigError(
      `Decision space contains first-token collision: ${JSON.stringify(collision.a)} and ${JSON.stringify(collision.b)} both encode to token id ${collision.tokenId}. Prefix-disambiguate the labels (e.g., 'A_yes' / 'A_no') or pick alternatives.`,
      { code: "decision_space_collision" },
    );
  }
  memo.add(memoKey);
}

function mapFirstTokenIds<T extends string>(
  tokenizer: Tokenizer,
  space: readonly T[],
): Map<number, T> {
  const map = new Map<number, T>();
  for (const label of space) {
    map.set(tokenizer.firstTokenId(label), label);
  }
  return map;
}
