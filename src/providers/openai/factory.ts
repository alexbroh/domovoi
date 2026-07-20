/**
 * Three factories for OpenAI Chat Completions backends — hosted, local
 * Ollama, and generic OpenAI-compatible (vLLM, LM Studio, Together,
 * Fireworks, OpenRouter, …). All share the internal adapter; they differ
 * only in default base URL, default API key, and whether a tokenizer is
 * wired up for first-token collision detection and logit_bias construction.
 */

import OpenAI from "openai";
import { cl100kTokenizer } from "../../tokenizer.js";
import type { ProviderCapabilities } from "../../types.js";
import { validatedPricing } from "../pricing.js";
import type { Provider, ProviderPricing } from "../provider.js";
import { type AdapterArgs, buildAdapter } from "./adapter.js";

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
  /**
   * USD per million tokens, used for `Verdict.meta.cost.usd` and the
   * `gen_ai.usage.cost_usd` span attribute. Omit to not emit USD.
   */
  readonly pricing?: ProviderPricing;
};

function pricingArg(
  pricing: ProviderPricing | undefined,
): { pricing: ProviderPricing } | Record<string, never> {
  return pricing === undefined ? {} : { pricing: validatedPricing(pricing) };
}

const LOGPROBS_CAPABILITIES: ProviderCapabilities = {
  distributionSource: "logprobs",
  coverageMeasurement: "exact",
  // OpenAI hosted caps top_logprobs at 20; most OpenAI-compat backends match.
  maxTopLogprobs: 20,
};

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
    ...pricingArg(opts?.pricing),
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
    ...pricingArg(opts?.pricing),
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
    ...pricingArg(opts.pricing),
  };
  if (opts.useCl100kTokenizer === true) {
    return buildAdapter({ ...args, tokenizer: cl100kTokenizer() });
  }
  return buildAdapter(args);
}
