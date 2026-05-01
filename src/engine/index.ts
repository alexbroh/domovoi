/**
 * Engine barrel. Verbs (`boolean` / `classify` / `classifier`) import from
 * here; threshold / meta / abort / hooks stay module-private.
 */

export { validateClassifierConfig, withDefaults } from "./config.js";
export { decide } from "./decide.js";
