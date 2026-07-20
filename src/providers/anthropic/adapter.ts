/**
 * Multi-sample Anthropic Messages adapter. The Anthropic API exposes no
 * logprobs and no logit bias, so the Distribution is built from K
 * independent samples that each verbalize a label plus a 0–100 confidence
 * (see `aggregate.ts` for the aggregation semantics). Capabilities declare
 * `multi_sample` / `approximate` accordingly.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { canonicalizeProviderThrow, ProviderError } from "../../errors.js";
import { renderSystemPrompt, renderUserPrompt } from "../../prompt.js";
import type { Distribution, ProviderCapabilities } from "../../types.js";
import type { Provider, SampleOptions } from "../provider.js";
import { aggregateVerbalizedSamples, parseVerbalizedReply } from "./aggregate.js";

// Multi-sample needs sampling variance: identical samples carry no
// disagreement signal, and disagreement is what flags the items the model
// gets wrong (split samples measured 20–50% accurate vs 93–95% unanimous).
const DEFAULT_MULTI_SAMPLE_TEMPERATURE = 1;

// One short JSON object; 64 tokens is generous headroom.
const MAX_REPLY_TOKENS = 64;

export type AnthropicAdapterArgs = {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: Anthropic;
  /** Samples per classify call; ≥ 1, validated by the factory. */
  readonly samples: number;
};

export function buildAnthropicAdapter(args: AnthropicAdapterArgs): Provider {
  return {
    id: args.id,
    modelId: args.modelId,
    tokenizerId: args.tokenizerId,
    capabilities: args.capabilities,
    configHash: `samples=${args.samples}`,

    async sample<T extends string>(
      input: string,
      space: readonly T[],
      opts: SampleOptions,
    ): Promise<Distribution<T>> {
      const system = composeSystemPrompt(opts, space);
      const user = renderUserPrompt(opts.template, input, space);
      const temperature = opts.temperature ?? DEFAULT_MULTI_SAMPLE_TEMPERATURE;

      let replies: string[];
      try {
        replies = await Promise.all(
          Array.from({ length: args.samples }, () =>
            requestOneReply(args.client, args.modelId, system, user, temperature, opts),
          ),
        );
      } catch (thrown) {
        throw canonicalizeProviderThrow(thrown);
      }

      return aggregateVerbalizedSamples(space, replies.map(parseVerbalizedReply));
    },
  };
}

function composeSystemPrompt(opts: SampleOptions, space: readonly string[]): string {
  const templateSystem = renderSystemPrompt(opts.template, space);
  const confidenceInstruction = [
    `Answer with a single line of JSON: {"label": <one of ${JSON.stringify(space)}>, "confidence": <integer 0-100>}.`,
    `"confidence" is the probability (as a percentage) that your label is correct.`,
    `If none of the labels fit, you may use a different short label of your own.`,
  ].join(" ");
  return templateSystem === undefined
    ? confidenceInstruction
    : `${templateSystem}\n\n${confidenceInstruction}`;
}

async function requestOneReply(
  client: Anthropic,
  modelId: string,
  system: string,
  user: string,
  temperature: number,
  opts: SampleOptions,
): Promise<string> {
  const requestOpts: { signal?: AbortSignal; timeout: number } = {
    timeout: opts.timeoutMs,
  };
  if (opts.signal !== undefined) requestOpts.signal = opts.signal;

  const response = await client.messages.create(
    {
      model: modelId,
      max_tokens: MAX_REPLY_TOKENS,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    },
    requestOpts,
  );

  const firstBlock = response.content[0];
  if (firstBlock === undefined || firstBlock.type !== "text") {
    throw new ProviderError("Anthropic response had no text content.", {
      code: "provider_malformed_response",
    });
  }
  return firstBlock.text;
}
