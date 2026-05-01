/**
 * OpenAI Chat Completions adapter — and OpenAI-compat factories for local
 * runtimes (Ollama, vLLM, LM Studio, Together, Fireworks, OpenRouter, etc.).
 *
 * Three factories:
 *   - `openai(model, opts?)`: hosted OpenAI; typed model union with escape hatch.
 *   - `ollama(model, opts?)`: local Ollama convenience; defaults to localhost:11434.
 *   - `openaiCompat(model, opts)`: generic OpenAI-compatible; explicit baseURL required.
 *
 * All three return `Provider` instances backed by the same Chat Completions
 * adapter. Distinction is in:
 *   - `id` (semantically honest about what backend this targets)
 *   - default baseURL / apiKey
 *   - default capabilities (especially maxTopLogprobs)
 *   - whether tokenizer-aware logit_bias / collision detection is enabled
 *
 * Tokenizer integration: the OpenAI hosted factory uses `cl100k_base` for
 * exact first-token-id resolution + logit_bias construction. Custom backends
 * (Ollama, openaiCompat) may run any tokenizer; they fall back to string-based
 * logprob matching unless the user supplies a tokenizer override.
 *
 * Cancellation: opts.signal forwarded to the OpenAI SDK call.
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

// ─── OpenAI hosted: typed model union with escape hatch ─────────────

/**
 * Known OpenAI hosted model identifiers as of April 2026, plus an escape
 * hatch (`(string & {})`) so new models work without a library release.
 *
 * Autocomplete shows the known models; arbitrary strings are still accepted.
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

// ─── Common provider options ────────────────────────────────────────

export type OpenAIProviderOptions = {
  /** Override the OpenAI base URL. Default: "https://api.openai.com/v1". */
  readonly baseURL?: string;
  /**
   * API key for this provider. Default: `process.env.OPENAI_API_KEY`.
   * For Ollama / LM Studio / etc., pass any non-empty string the SDK accepts.
   */
  readonly apiKey?: string;
  /** Optional request timeout (ms) at the SDK level. Engine also enforces budget separately. */
  readonly timeout?: number;
};

// ─── Adapter capabilities ───────────────────────────────────────────

const LOGPROBS_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  // OpenAI hosted hard cap is 20; OpenAI-compat backends vary but most match.
  // Custom adapters can override via opts if their backend supports more.
  maxTopLogprobs: 20,
};

// S8 lock: positive bias only on in-space first-tokens; no negative biases.
const LOGIT_BIAS_VALUE = 100;

// ─── Internal: build a Provider backed by OpenAI Chat Completions ───

type AdapterArgs = {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: OpenAI;
  /**
   * Optional tokenizer for first-token-id resolution + logit_bias.
   * When provided, the adapter:
   *   - Detects first-token collisions on first sample call (lazy, since
   *     the space is per-call, not per-factory).
   *   - Builds a per-call logit_bias map from the in-space first-token ids.
   *   - Falls back to string-based logprob matching only when an in-space
   *     label's first-token id isn't in the returned top-K.
   * Without it: pure string-based logprob matching (the bootstrap form).
   */
  readonly tokenizer?: Tokenizer;
};

function buildAdapter(args: AdapterArgs): Provider {
  // Cache collision check per (provider × space identity) since space is
  // per-call. Using JSON-canonicalized space as a memo key.
  const collisionMemo = new Set<string>();

  return {
    id: args.id,
    modelId: args.modelId,
    tokenizerId: args.tokenizerId,
    capabilities: args.capabilities,

    async sample<T extends string>(
      input: string,
      space: readonly T[],
      opts: SampleOptions,
    ): Promise<Distribution<T>> {
      // Tokenizer-aware path: first-token collision check + logit_bias.
      const tokenizer = args.tokenizer;
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
          // Generate just enough tokens for a single label; cap at 16 to be safe.
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

// ─── Distribution construction ──────────────────────────────────────

type TopLogprobEntry = OpenAI.Chat.Completions.ChatCompletionTokenLogprob.TopLogprob;

/**
 * Tokenizer-aware distribution construction (preferred when a tokenizer is
 * available). Each top-K entry's `bytes` array is hashed back to a token id
 * via the tokenizer, and matched against the in-space first-token id map.
 *
 * If the OpenAI SDK doesn't expose token bytes (older API versions), falls
 * back to encoding the entry's `token` string and comparing first-id —
 * this is exact when the model emitted the token at a generation boundary.
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
    // Re-tokenize the emitted string to get its first token id. The OpenAI
    // SDK's `bytes` array would be more direct, but isn't always present
    // across SDK versions; encoding the surface-form string is a reliable
    // fallback that also handles whitespace-padded variants.
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
 * String-based fallback used when no tokenizer is available (Ollama, generic
 * openaiCompat). Matches by trimmed string equality or label-prefix.
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
      if (tok === trimmed || (tok.length > 0 && trimmed.startsWith(tok))) {
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

// ─── Tokenizer-aware helpers ────────────────────────────────────────

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

// ─── Factory: openai(model, opts?) ──────────────────────────────────

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

// ─── Factory: ollama(model, opts?) — local convenience ──────────────

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

// ─── Factory: openaiCompat(model, opts) — generic ───────────────────

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
