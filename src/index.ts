/**
 * domovoi — typed-uncertainty classification for TypeScript.
 *
 * Public API entry point. Subpaths:
 *   - `domovoi/providers` — Provider factories and interface (openai, ollama, openaiCompat).
 *   - `domovoi/calibration` — Calibrator factories (identity, temperatureScaling, plattScaling).
 *   - `domovoi/testing` — mockProvider for unit tests.
 */

import { memoryCache as memoryCacheFactory } from "./cache.js";
import { boolean as booleanVerb } from "./verbs/boolean.js";
import { classifier as classifierFactory } from "./verbs/classifier.js";
import { classify as classifyVerb } from "./verbs/classify.js";

export type {
  Verdict,
  Classified,
  Uncertain,
  Unknown,
  Filterable,
  UnknownReason,
  Distribution,
  VerdictMeta,
  SerializableError,
  Thresholds,
  Budget,
  PromptTemplate,
  ProviderCapabilities,
} from "./types.js";

export type { Classifier, ClassifierConfig } from "./verbs/classifier.js";
export type { ClassifyOptions } from "./verbs/classify.js";
export type { BooleanOptions } from "./verbs/boolean.js";
export type { Cache, CacheStats, CacheWithStats } from "./cache.js";

export { match, isClassified, isUncertain, isUnknown, filter } from "./verdict.js";

export {
  DomovoiError,
  ProviderError,
  ConfigError,
  BudgetExhaustedError,
  type ErrorCode,
} from "./errors.js";

/**
 * Top-level API surface — what users primarily import.
 *
 * @example
 *   import { domovoi, isClassified } from "domovoi";
 *   const v = await domovoi.classify(input, ["a","b","c"] as const);
 *   if (isClassified(v)) console.log(v.value);
 */
export const domovoi = {
  classify: classifyVerb,
  boolean: booleanVerb,
  classifier: classifierFactory,
  memoryCache: memoryCacheFactory,
} as const;
