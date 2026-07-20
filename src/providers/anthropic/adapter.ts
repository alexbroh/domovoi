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
import type { ProviderCapabilities, TokenUsage } from "../../types.js";
import type { RequestGovernor } from "../governor.js";
import type { Provider, ProviderPricing, SampleOptions, SampleOutcome } from "../provider.js";
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
  /** Attached to the returned Provider; the engine computes USD from it. */
  readonly pricing?: ProviderPricing;
  /** Retry + rate-limit enforcement, applied per sample request. */
  readonly governor: RequestGovernor;
};

export function buildAnthropicAdapter(args: AnthropicAdapterArgs): Provider {
  return {
    id: args.id,
    modelId: args.modelId,
    tokenizerId: args.tokenizerId,
    capabilities: args.capabilities,
    configHash: `samples=${args.samples}`,
    ...(args.pricing !== undefined ? { pricing: args.pricing } : {}),

    async sample<T extends string>(
      input: string,
      space: readonly T[],
      opts: SampleOptions,
    ): Promise<SampleOutcome<T>> {
      const system = composeSystemPrompt(opts, space);
      const user = renderUserPrompt(opts.template, input, space);
      const temperature = opts.temperature ?? DEFAULT_MULTI_SAMPLE_TEMPERATURE;

      // allSettled, not all: one transient failure among K must not
      // discard the K-1 already-billed successes — the aggregation is
      // null-tolerant, so survivors still yield a (lower-coverage)
      // distribution, and a rejected sample penalizes coverage exactly
      // like an unparseable reply. All-K-failed escalates as a provider
      // error using the first rejection.
      const settled = await Promise.allSettled(
        Array.from({ length: args.samples }, () =>
          args.governor.execute(
            () =>
              requestOneReply(args.client, args.modelId, system, user, temperature, opts).catch(
                (thrown) => {
                  throw canonicalizeProviderThrow(thrown);
                },
              ),
            opts.signal,
          ),
        ),
      );
      const fulfilled = settled.filter(
        (result): result is PromiseFulfilledResult<ReplyWithUsage> => result.status === "fulfilled",
      );
      if (fulfilled.length === 0) {
        const first = settled[0] as PromiseRejectedResult | undefined;
        throw canonicalizeProviderThrow(first?.reason ?? new Error("all samples failed"));
      }

      const distribution = aggregateVerbalizedSamples(
        space,
        settled.map((result) =>
          result.status === "fulfilled" ? parseVerbalizedReply(result.value.text) : null,
        ),
      );
      const usage = sumUsage(fulfilled.map((result) => result.value));
      if (usage !== undefined) args.governor.reconcile(usage);
      return usage === undefined ? { distribution } : { distribution, usage };
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

type ReplyWithUsage = {
  readonly text: string;
  /** Absent when the backend response carried no usage block. */
  readonly usage?: TokenUsage;
};

/**
 * Sum usage across the fulfilled samples; `undefined` when any of them
 * lacked a usage block — a partial sum would under-report, so the outcome
 * reports no usage at all and the engine falls back to estimates.
 */
function sumUsage(replies: readonly ReplyWithUsage[]): TokenUsage | undefined {
  if (replies.some((reply) => reply.usage === undefined)) return undefined;
  return replies.reduce(
    (total, reply) => ({
      inputTokens: total.inputTokens + (reply.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (reply.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

async function requestOneReply(
  client: Anthropic,
  modelId: string,
  system: string,
  user: string,
  temperature: number,
  opts: SampleOptions,
): Promise<ReplyWithUsage> {
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
  // The SDK types make `usage` non-optional, but a non-compliant proxy
  // behind `baseURL` may omit or truncate it; partial usage counts as no
  // usage so a non-finite field can never reach the cost accumulator.
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;
  return {
    text: firstBlock.text,
    ...(Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
      ? { usage: { inputTokens: inputTokens as number, outputTokens: outputTokens as number } }
      : {}),
  };
}
