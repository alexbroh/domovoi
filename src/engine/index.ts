/**
 * Engine barrel — public re-exports.
 *
 * Verbs (boolean, classify, classifier) import from here. Internal-only
 * modules (threshold, meta, abort, hooks) stay private.
 */

export {
  type DecideConfig,
  type DecideConfigInput,
  type EngineHooks,
  type OnProviderErrorHook,
  type ValidateClassifierConfigInput,
  validateClassifierConfig,
  withDefaults,
} from "./config.js";
export { decide } from "./decide.js";
