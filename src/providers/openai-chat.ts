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
 *
 * Cancellation: opts.signal forwarded to the OpenAI SDK call.
 * Tokenization + collision check: deferred to engine layer (uses tiktoken).
 */

import OpenAI from "openai";
import { ProviderError, canonicalizeProviderThrow } from "../errors.js";
import { renderSystemPrompt, renderUserPrompt } from "../prompt.js";
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

// ─── Internal: build a Provider backed by OpenAI Chat Completions ───

type AdapterArgs = {
  readonly id: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: OpenAI;
};

/**
 * Build a Provider that calls OpenAI Chat Completions and reads first-token
 * logprobs to construct a Distribution. Used by all three factories below.
 *
 * Note on logit_bias: this adapter does NOT yet apply per-token bias because
 * the engine owns first-token resolution + tokenizer setup. The plan is for
 * the engine to compute logit_bias and pass it via `SampleOptions`; for now
 * the adapter relies on the prompt's "Output exactly one of:" instruction
 * + the model's natural compliance. Engine integration will add logit_bias.
 *
 * Returns a Distribution by reading `top_logprobs` at the first content
 * position and aggregating in-space first-token logprobs.
 */
function buildAdapter(args: AdapterArgs): Provider {
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
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      const system = renderSystemPrompt(opts.template, space);
      if (system !== undefined) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: renderUserPrompt(opts.template, input, space) });

      let response: OpenAI.Chat.ChatCompletion;
      try {
        // Build params; only include `seed` if defined (exactOptionalPropertyTypes).
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
          model: args.modelId,
          messages,
          temperature: opts.temperature,
          logprobs: true,
          top_logprobs: Math.min(args.capabilities.maxTopLogprobs, space.length * 2),
          // Generate just enough tokens for a single label; cap at 16 to be safe.
          max_completion_tokens: 16,
        };
        if (opts.seed !== undefined) params.seed = opts.seed;
        const requestOpts: { signal?: AbortSignal; timeout?: number } = {
          timeout: opts.timeoutMs,
        };
        if (opts.signal !== undefined) requestOpts.signal = opts.signal;
        response = await args.client.chat.completions.create(params, requestOpts);
      } catch (err) {
        // Engine canonicalizes; provider may also wrap to add domain-specific code.
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

      // Construct Distribution from top-K logprobs.
      // Strategy: for each in-space label, find the highest-logprob top-K entry
      // whose token (after trimming) starts with the label's first character(s).
      // Engine will eventually pre-compute first-token IDs via tokenizer for
      // exact matching; this string-based approximation is the bootstrap form.
      const inSpace = new Map<string, number>(); // label → exp(logprob)
      let inSpaceMass = 0;

      for (const label of space) {
        const trimmed = label.trim();
        // Find the best matching top-logprob entry.
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

      // Coverage = sum of in-space mass before renormalization.
      const coverage = Math.min(1, inSpaceMass);

      // Renormalize over surviving in-space mass; missing labels → 0 (G2).
      const probs: Record<string, number> = {};
      for (const label of space) {
        const raw = inSpace.get(label) ?? 0;
        probs[label] = inSpaceMass > 0 ? raw / inSpaceMass : 0;
      }

      return {
        probs: probs as Distribution<T>["probs"],
        coverage,
      };
    },
  };
}

// ─── Factory: openai(model, opts?) ──────────────────────────────────

/**
 * Hosted OpenAI provider. Defaults to `process.env.OPENAI_API_KEY` and
 * `https://api.openai.com/v1`.
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
  });
}

// ─── Factory: ollama(model, opts?) — local convenience ──────────────

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_DEFAULT_API_KEY = "ollama";

/**
 * Local Ollama provider via OpenAI-compatible endpoint.
 * Defaults to `http://localhost:11434/v1` with apiKey `"ollama"`.
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
    // Tokenizer id is best-effort for cache-key composition; Ollama backends
    // run various tokenizers depending on the model. Users who need exact
    // collision detection across Ollama models can provide a custom Provider.
    tokenizerId: `ollama/${model}`,
    capabilities: LOGPROBS_CAPABILITIES,
    client,
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
  return buildAdapter({
    id: inferredId,
    modelId: model,
    tokenizerId: opts.tokenizerId ?? `compat/${model}`,
    capabilities,
    client,
  });
}
