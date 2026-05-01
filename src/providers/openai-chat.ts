/**
 * OpenAI Chat Completions adapter — and OpenAI-compat factories for local
 * runtimes (Ollama, vLLM, LM Studio, Together, Fireworks, OpenRouter, …).
 *
 * Three factories — all backed by the same internal adapter, differing in
 * default base URL, default `apiKey`, and whether a tokenizer is wired up
 * for first-token collision detection and logit_bias construction:
 *
 *   - `openai(model, opts?)` — hosted OpenAI; uses `cl100k_base`.
 *   - `ollama(model, opts?)` — local Ollama; defaults to `localhost:11434`.
 *   - `openaiCompat(model, opts)` — generic; requires explicit `baseURL`.
 *
 * Without a tokenizer the adapter falls back to string-based logprob matching.
 */

import OpenAI from "openai";
import { ConfigError, ProviderError, canonicalizeProviderThrow } from "../errors.js";
import { renderSystemPrompt, renderUserPrompt } from "../prompt.js";
import {
  type Tokenizer,
  buildLogitBias,
  cl100kTokenizer,
  findFirstTokenCollision,
} from "../tokenizer.js";
import type { Distribution, ProviderCapabilities } from "../types.js";
import type { Provider, SampleOptions } from "./provider.js";

/**
 * The known-models list provides autocomplete; the `(string & {})` member is
 * an escape hatch so new models work without a library release.
 */
export type OpenAIModel =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "o1"
  | "o1-mini"
  | "o1-preview"
  | "gpt-3.5-turbo"
  // biome-ignore lint/complexity/noBannedTypes: escape hatch idiom for autocomplete + free-form
  | (string & {});

export type OpenAIProviderOptions = {
  /** Default: `"https://api.openai.com/v1"`. */
  readonly baseURL?: string;
  /**
   * Default: `process.env.OPENAI_API_KEY`. For Ollama / LM Studio /
   * compat backends, pass any non-empty string the SDK will accept.
   */
  readonly apiKey?: string;
  /** SDK-level request timeout. Independent of the engine's own budget. */
  readonly timeout?: number;
};

const LOGPROBS_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  // OpenAI hosted caps top_logprobs at 20; most OpenAI-compat backends match.
  maxTopLogprobs: 20,
};

// Positive bias on in-space first-tokens only. Nudges the model toward
// in-space output without forcing — keeps the coverage signal honest.
const LOGIT_BIAS_VALUE = 100;

type AdapterArgs = {
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

function buildAdapter(args: AdapterArgs): Provider {
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
          temperature: opts.temperature,
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

type TopLogprobEntry = OpenAI.Chat.Completions.ChatCompletionTokenLogprob.TopLogprob;

/**
 * Tokenizer-aware distribution construction. Re-encodes each top-K entry's
 * surface-form string to get its first token id, then maps that to an
 * in-space label. The encoding fallback (instead of reading the SDK's
 * `bytes` array) is reliable across SDK versions and handles
 * whitespace-padded variants.
 */
function buildDistributionByTokenId<T extends string>(
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

/**
 * String-based fallback when no tokenizer is wired up. Matches by trimmed
 * equality or label-prefix.
 */
function buildDistributionByStringMatch<T extends string>(
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

/**
 * Hosted OpenAI provider. Defaults to `process.env.OPENAI_API_KEY` and
 * `https://api.openai.com/v1`. Uses the cl100k_base tokenizer for exact
 * first-token-id resolution + logit_bias on the request.
 *
 * @example
 * const cloud = openai("gpt-4o-mini");
 */
export function openai(model: OpenAIModel, opts?: OpenAIProviderOptions): Provider {
  const client = new OpenAI({
    apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: opts?.baseURL,
    timeout: opts?.timeout,
  });
  return buildAdapter({
    id: `openai/${model}`,
    modelId: model,
    tokenizerId: "openai/cl100k_base",
    capabilities: LOGPROBS_CAPABILITIES,
    client,
    tokenizer: cl100kTokenizer(),
  });
}

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_DEFAULT_API_KEY = "ollama";

/**
 * Local Ollama provider via OpenAI-compatible endpoint.
 * Defaults to `http://localhost:11434/v1` with apiKey `"ollama"`.
 *
 * Ollama backends run various tokenizers depending on the model; the
 * adapter falls back to string-based logprob matching by default. Users
 * who need exact collision detection can supply a custom Provider
 * implementing the public Provider interface.
 *
 * @example
 * const local = ollama("llama-3.1-70b");
 */
export function ollama(model: string, opts?: OpenAIProviderOptions): Provider {
  const client = new OpenAI({
    apiKey: opts?.apiKey ?? OLLAMA_DEFAULT_API_KEY,
    baseURL: opts?.baseURL ?? OLLAMA_DEFAULT_BASE_URL,
    timeout: opts?.timeout,
  });
  return buildAdapter({
    id: `ollama/${model}`,
    modelId: model,
    // Tokenizer id for cache-key composition; treated opaquely.
    tokenizerId: `ollama/${model}`,
    capabilities: LOGPROBS_CAPABILITIES,
    client,
    // No tokenizer — string-based fallback matches Ollama's varied tokenizers.
  });
}

export type OpenAICompatOptions = OpenAIProviderOptions & {
  /** Required for openaiCompat — caller must specify the endpoint. */
  readonly baseURL: string;
  /** Optional override of the tokenizer identifier (used in cache keys). */
  readonly tokenizerId?: string;
  /** Optional override of the provider id (used in cache keys + meta.providerUsed). */
  readonly providerId?: string;
  /** Override capabilities (e.g., higher maxTopLogprobs than 20 if backend supports). */
  readonly capabilities?: Partial<ProviderCapabilities>;
  /**
   * Opt into cl100k_base tokenizer (use only when backend's tokenizer matches
   * OpenAI's cl100k_base — e.g., vLLM running an OpenAI-compatible model).
   * Default: false (string-based fallback).
   */
  readonly useCl100kTokenizer?: boolean;
};

/**
 * Generic OpenAI-compatible provider. Use for vLLM, LM Studio, Together,
 * Fireworks, OpenRouter, or any backend that speaks the OpenAI Chat
 * Completions wire format.
 *
 * @example
 * const fireworks = openaiCompat("accounts/fireworks/models/llama-3", {
 *   baseURL: "https://api.fireworks.ai/inference/v1",
 *   apiKey: process.env.FIREWORKS_API_KEY,
 * });
 */
export function openaiCompat(model: string, opts: OpenAICompatOptions): Provider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    timeout: opts.timeout,
  });
  const capabilities: ProviderCapabilities = {
    ...LOGPROBS_CAPABILITIES,
    ...opts.capabilities,
  };
  // Derive an id from baseURL host if not explicitly overridden.
  const inferredId =
    opts.providerId ??
    (() => {
      try {
        const host = new URL(opts.baseURL).host;
        return `${host}/${model}`;
      } catch {
        return `compat/${model}`;
      }
    })();
  const args: AdapterArgs = {
    id: inferredId,
    modelId: model,
    tokenizerId: opts.tokenizerId ?? `compat/${model}`,
    capabilities,
    client,
  };
  if (opts.useCl100kTokenizer === true) {
    return buildAdapter({ ...args, tokenizer: cl100kTokenizer() });
  }
  return buildAdapter(args);
}
