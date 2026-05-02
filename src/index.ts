/**
 * domovoi — typed-uncertainty classification for TypeScript.
 *
 * Public API entry point. Subpaths:
 *   - `@hours/domovoi/providers` — Provider factories and interface (openai, ollama, openaiCompat).
 *   - `@hours/domovoi/calibration` — Calibrator factories (identity, temperatureScaling, plattScaling).
 *   - `@hours/domovoi/testing` — mockProvider for unit tests.
 */

import { memoryCache as memoryCacheFactory } from "./cache.js";
import { boolean as booleanVerb } from "./verbs/boolean.js";
import { classifier as classifierFactory } from "./verbs/classifier.js";
import { classify as classifyVerb } from "./verbs/classify.js";

export type { Cache, CacheStats, CacheWithStats } from "./cache.js";
export {
  BudgetExhaustedError,
  ConfigError,
  DomovoiError,
  type ErrorCode,
  ProviderError,
} from "./errors.js";
export type {
  Budget,
  Classified,
  Distribution,
  Filterable,
  PromptTemplate,
  ProviderCapabilities,
  SerializableError,
  Thresholds,
  Uncertain,
  Unknown,
  UnknownReason,
  Verdict,
  VerdictMeta,
} from "./types.js";
export type { BooleanOptions } from "./verbs/boolean.js";
export type { Classifier, ClassifierConfig } from "./verbs/classifier.js";
export type { ClassifyOptions } from "./verbs/classify.js";
export { filter, isClassified, isUncertain, isUnknown, match } from "./verdict.js";

/**
 * Top-level API surface — what users primarily import.
 *
 * @example
 *   import { domovoi, isClassified } from "@hours/domovoi";
 *   const v = await domovoi.classify(input, ["a","b","c"] as const);
 *   if (isClassified(v)) console.log(v.value);
 */
export const domovoi = {
  classify: classifyVerb,
  boolean: booleanVerb,
  classifier: classifierFactory,
  memoryCache: memoryCacheFactory,
} as const;
