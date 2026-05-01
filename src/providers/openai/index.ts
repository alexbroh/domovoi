/**
 * Internal barrel for the OpenAI Chat Completions backend.
 * Public consumers import from `domovoi/providers` (src/providers/index.ts).
 */

export {
  type OpenAICompatOptions,
  type OpenAIModel,
  type OpenAIProviderOptions,
  ollama,
  openai,
  openaiCompat,
} from "./factory.js";
