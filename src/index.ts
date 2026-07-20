/**
 * domovoi — typed-uncertainty classification for TypeScript.
 *
 * Public API entry point. Subpaths:
 *   - `@hourslabs/domovoi/providers` — Provider factories and interface (openai, ollama, openaiCompat, anthropic).
 *   - `@hourslabs/domovoi/calibration` — Calibrator factories (identity, temperatureScaling, plattScaling).
 *   - `@hourslabs/domovoi/testing` — mockProvider for unit tests.
 */

import { memoryCache as memoryCacheFactory } from "./cache.js";
import { bind as bindFn, currentScope as currentScopeFn, scope as scopeFn } from "./scope.js";
import { boolean as booleanVerb } from "./verbs/boolean.js";
import { classifier as classifierFactory } from "./verbs/classifier.js";
import { classify as classifyVerb } from "./verbs/classify.js";

export type { BudgetMode, BudgetSnapshot, ScopeBudget } from "./budget-tracker.js";
export type { Cache, CacheStats, CacheWithStats } from "./cache.js";
export type { ContextStorage } from "./context-storage.js";
export { configureContextStorage, resetContextStorage } from "./context-storage.js";
export {
  BudgetExceededError,
  BudgetExhaustedError,
  ConfigError,
  DomovoiError,
  type ErrorCode,
  ProviderError,
} from "./errors.js";
export type { ResolvedScope, ScopeOptions } from "./scope.js";
export type { AttributeValue, Span, Tracer } from "./tracer.js";
export type {
  Budget,
  Classified,
  Distribution,
  Filterable,
  Label,
  PromptTemplate,
  ProviderCapabilities,
  SerializableError,
  Thresholds,
  TokenUsage,
  Uncertain,
  Unknown,
  UnknownVerdictCause,
  Verdict,
  VerdictCost,
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
 *   import { domovoi, isClassified } from "@hourslabs/domovoi";
 *   const v = await domovoi.classify(input, ["a","b","c"] as const);
 *   if (isClassified(v)) console.log(v.value);
 *
 * @example v0.2 ambient context
 *   await domovoi.scope({ budget: { tokens: 10_000 } }, async () => {
 *     const v = await domovoi.classify(input, ["a","b","c"]);
 *     // v0.2: classify call inherits budget enforcement from scope
 *   });
 */
export const domovoi = {
  classify: classifyVerb,
  boolean: booleanVerb,
  classifier: classifierFactory,
  memoryCache: memoryCacheFactory,
  scope: scopeFn,
  bind: bindFn,
  currentScope: currentScopeFn,
} as const;
